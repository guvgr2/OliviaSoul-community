// C2「备份可视化与清理」的后端防护（删除 + 保留份数 + 确认清理）。
//
// 为什么单独一套：删除备份是**不可撤销**的破坏性操作 —— 路径校验一旦写松，
// 一个被构造的文件名就能删掉备份目录之外的文件，甚至正在使用的库。
// 所以这里把三道防线逐条钉死：
//   ① 只接受文件名本身（basename 后必须与入参一致）；
//   ② 解析成绝对路径后必须仍在备份目录内（path.relative 判定，不靠字符串前缀）；
//   ③ 正在使用的库、等待重启恢复的那一份不许删。
// 另钉一个安全属性：改小保留份数只记设置、不删文件，必须用户点「确认清理」才真删。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PERIODIC_BACKUP_KEEP,
  MAX_PERIODIC_BACKUP_KEEP,
  MIN_PERIODIC_BACKUP_KEEP,
  PERIODIC_BACKUP_KEEP_SETTING,
  PERIODIC_BACKUP_PREFIX,
  arrangeRestore,
  createDataSafetyRoutes,
  deleteBackup,
  listBackups,
  parsePeriodicBackupInput,
  readPeriodicBackupConfig,
} from "../midi/data-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const safetySource = readFileSync(join(here, "..", "midi", "data-safety.js"), "utf8");
const DAY = 24 * 60 * 60 * 1000;

/** 建一个真库（arrangeRestore 会做完整性检查，所以备份必须是真 sqlite）。 */
function makeDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)");
  db.exec("INSERT INTO settings(key, value) VALUES('demo', 'x') ON CONFLICT(key) DO NOTHING");
  db.close();
  return file;
}

async function makeDir(t, label) {
  const dir = await mkdtemp(join(tmpdir(), `olivia-delete-${label}-`));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return dir;
}

/** 造一份**内容是真库字节**的备份（arrangeRestore 的完整性检查要能过）。 */
async function copyBackup(databasePath, name, ageMs = 0) {
  const file = join(dirname(databasePath), name);
  await writeFile(file, await readFile(databasePath));
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  return file;
}

const periodicNames = async (dir) => (await readdir(dir))
  .filter(name => name.startsWith(PERIODIC_BACKUP_PREFIX) && name.endsWith(".sqlite"))
  .sort();

/** 直接调路由：把 body 变成能被 readJsonBody 消费的异步可迭代请求。 */
function post(path, body) {
  return {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}

const urlOf = path => new URL(`http://127.0.0.1/toy${path}`);

async function routeFor(databasePath, store = new Map()) {
  return await createDataSafetyRoutes({
    databasePath,
    getSetting: key => store.get(key),
    setSetting: (key, value) => store.set(key, value),
  });
}

/** 拿到被拒的原因，而不是让测试在抛错处断掉。 */
async function reasonOf(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

test("删除一份备份：文件真的没了，WAL/SHM 伴生文件一起清掉，并回报释放的字节与剩余份数", async t => {
  const dir = await makeDir(t, "ok");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const target = await copyBackup(db, "backup-manual-20250101-000000.sqlite");
  await writeFile(`${target}-wal`, "wal");
  await writeFile(`${target}-shm`, "shm");
  const bytes = (await stat(target)).size;

  const result = await deleteBackup(db, basename(target));

  assert.equal(result.removed, basename(target));
  assert.equal(result.freedBytes, bytes, "要报告释放了多少字节（界面要显示）");
  assert.equal(result.total, 0, "删完只剩当前库，备份数为 0");
  await assert.rejects(() => stat(target), "备份文件必须真的被删掉");
  await assert.rejects(() => stat(`${target}-wal`), "WAL 伴生文件要一起清");
  await assert.rejects(() => stat(`${target}-shm`), "SHM 伴生文件要一起清");
});

test("路径校验：带目录、带 ..、带盘符的名字一律拒绝，目录外的文件一个字节都不能动", async t => {
  const dir = await makeDir(t, "escape");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const inside = await copyBackup(db, "backup-manual-20250101-000000.sqlite");
  // 目录外放一个 .sqlite：如果校验写松（只判后缀、或只做一次 basename 就去拼路径），它就会遭殃
  const outside = join(dirname(dir), `${basename(dir)}-outside.sqlite`);
  await writeFile(outside, "secret");
  t.after(async () => { await rm(outside, { force: true }).catch(() => {}); });

  const bad = [
    join("..", basename(outside)),
    `..\\${basename(outside)}`,
    "../olivia-local.sqlite",
    "sub/dir.sqlite",
    "C:\\Windows\\evil.sqlite",
    "backup.txt",
    "",
    "..",
  ];
  for (const name of bad) {
    const error = await reasonOf(deleteBackup(db, name));
    assert.ok(error, `${JSON.stringify(name)} 必须被拒（不能靠"文件不存在"当挡箭牌）`);
    assert.equal(error.status, 400, `${JSON.stringify(name)} 应该是 400，而不是内部错误或 404`);
  }
  assert.ok((await stat(outside)).size > 0, "目录外的文件必须原样在");
  await stat(inside);

  // 只有「文件名」能过第 ① 关：直接拿目录外那份的名字（备份目录里不存在同名文件）→ 404，绝不越界
  const error = await reasonOf(deleteBackup(db, basename(outside)));
  assert.equal(error?.status, 404, "同名但不在备份目录里 → 只会在备份目录里找不到，不会去删目录外那个");
  await stat(outside);
});

test("拒删正在使用的库，以及「等待重启恢复」的那一份", async t => {
  const dir = await makeDir(t, "protected");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const backup = await copyBackup(db, "backup-manual-20250101-000000.sqlite");

  const live = await reasonOf(deleteBackup(db, basename(db)));
  assert.equal(live?.status, 400, "正在使用的数据库不能删");
  await stat(db);

  await arrangeRestore(db, backup, { source: "restore", label: "测试恢复" });
  const pending = await reasonOf(deleteBackup(db, basename(backup)));
  assert.equal(pending?.status, 400, "待恢复的那一份不能在重启前被删掉");
  await stat(backup);
});

test("找不到就是 404（不是 500，也不许静默成功）", async t => {
  const dir = await makeDir(t, "missing");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));

  const error = await reasonOf(deleteBackup(db, "backup-manual-20990101-000000.sqlite"));

  assert.equal(error?.status, 404);
});

test("路由：没有 confirm 不许删；confirm 之后按文件名删除并回报释放字节", async t => {
  const dir = await makeDir(t, "route");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const target = await copyBackup(db, "backup-manual-20250101-000000.sqlite");
  const size = (await stat(target)).size;
  const route = await routeFor(db);

  const rejected = await reasonOf(route(
    post("/listen-naming/data/backup/delete", { file: basename(target) }),
    urlOf("/listen-naming/data/backup/delete"),
  ));
  assert.equal(rejected?.status, 400, "删除备份必须显式确认（不可撤销的操作不能一键完成）");
  await stat(target);

  const result = await route(
    post("/listen-naming/data/backup/delete", { file: basename(target), confirm: true }),
    urlOf("/listen-naming/data/backup/delete"),
  );
  assert.equal(result.removed, basename(target));
  assert.equal(result.freedBytes, size);
  await assert.rejects(() => stat(target));
});

test("备份列表带汇总：份数与占用按全部备份算，不受列表条数上限影响", async t => {
  const dir = await makeDir(t, "summary");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  await copyBackup(db, "backup-manual-20250101-000000.sqlite");
  await copyBackup(db, `${PERIODIC_BACKUP_PREFIX}20250102-000000.sqlite`);
  await copyBackup(db, "upgrade-backup-2000-1-to-2000-2-20250103-000000.sqlite");

  const data = await listBackups(db, { limit: 1 });

  assert.equal(data.total, 3);
  assert.equal(data.items.length, 1, "列表按 limit 截断（界面能少画几行）");
  assert.equal(data.summary.count, 3, "汇总必须按全部备份算，不能只看 items");
  assert.equal(data.summary.kinds.length, 3, "三种来源各一条");
  for (const kind of data.summary.kinds) {
    assert.equal(kind.count, 1);
    assert.ok(kind.bytes > 0);
    assert.ok(kind.label, "每一类都要有人话名字");
  }
  const kindBytes = data.summary.kinds.reduce((sum, kind) => sum + kind.bytes, 0);
  assert.equal(data.summary.bytes, kindBytes, "总占用 = 各类型之和");
});

test("保留份数可配置：范围 1~60，垃圾值回落默认，越界给 400", () => {
  const config = values => readPeriodicBackupConfig(key => values[key]);

  assert.equal(MIN_PERIODIC_BACKUP_KEEP, 1, "下限 1：不能把退路全删了");
  assert.equal(MAX_PERIODIC_BACKUP_KEEP, 60, "上限 60：再多就是把磁盘当仓库");
  assert.equal(config({}).keep, DEFAULT_PERIODIC_BACKUP_KEEP, "没设置过 = 默认 7 份");
  assert.equal(config({ [PERIODIC_BACKUP_KEEP_SETTING]: "3" }).keep, 3, "设置里存的是字符串，要能读出来");
  for (const value of ["0", "-1", "61", "abc", "7.5", ""]) {
    assert.equal(config({ [PERIODIC_BACKUP_KEEP_SETTING]: value }).keep, DEFAULT_PERIODIC_BACKUP_KEEP,
      `${value} 不是合法份数 → 回落默认（宁多留一份，也不要静默删光）`);
  }

  assert.deepEqual(parsePeriodicBackupInput({ keep: 3 }), { keep: 3 });
  for (const bad of [{ keep: 0 }, { keep: 61 }, { keep: "三份" }, { keep: 2.5 }]) {
    assert.throws(() => parsePeriodicBackupInput(bad), error => {
      assert.equal(error.status, 400, `${JSON.stringify(bad)} 应该被拒`);
      assert.ok(error.message, "必须给出人能看懂的原因");
      return true;
    });
  }
});

test("改小保留份数只记设置、不删文件；点「确认清理」才真删（可撤销）", async t => {
  const dir = await makeDir(t, "keep-clean");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  for (let index = 0; index < 5; index += 1)
    await copyBackup(db, `${PERIODIC_BACKUP_PREFIX}2025010${index + 1}-000000.sqlite`, (5 - index) * DAY);
  const store = new Map();
  const route = await routeFor(db, store);

  const saved = await route(
    post("/listen-naming/data/periodic-backup", { keep: 2 }),
    urlOf("/listen-naming/data/periodic-backup"),
  );
  assert.equal(saved.keep, 2, "保存后立刻能看到新值");
  assert.equal(saved.cleanup.removable, 3, "要先把「将清理 3 份」告诉界面");
  assert.equal((await periodicNames(dir)).length, 5, "改小保留份数不许立刻删文件（调大即可撤销）");
  assert.equal(store.get(PERIODIC_BACKUP_KEEP_SETTING), "2", "设置真的落进设置存储");

  const rejected = await reasonOf(route(
    post("/listen-naming/data/periodic-backup/cleanup", {}),
    urlOf("/listen-naming/data/periodic-backup/cleanup"),
  ));
  assert.equal(rejected?.status, 400, "清理同样要显式确认");
  assert.equal((await periodicNames(dir)).length, 5, "被拒的清理不许动任何文件");

  const cleaned = await route(
    post("/listen-naming/data/periodic-backup/cleanup", { confirm: true }),
    urlOf("/listen-naming/data/periodic-backup/cleanup"),
  );
  assert.equal(cleaned.removed.length, 3);
  assert.equal(cleaned.keep, 2);
  assert.equal((await periodicNames(dir)).length, 2, "keep=2 → 只留最近 2 份周期备份");
});

test("源码钉死：删除路径用 path.relative 判定、删除与清理都要 confirm、改小不立刻删", () => {
  assert.match(safetySource, /relative\(dir, target\)/u, "参考路径必须用 path.relative 判定（红线）");
  assert.match(safetySource, /isAbsolute\(inside\)/u, "relative 的结果还要挡住绝对路径");
  assert.match(safetySource, /BACKUP_DELETE_NOT_CONFIRMED/u, "删除接口必须要求显式确认");
  assert.match(safetySource, /PERIODIC_BACKUP_CLEANUP_NOT_CONFIRMED/u, "清理接口必须要求显式确认");
  assert.match(safetySource, /BACKUP_IS_LIVE_DATABASE/u, "正在使用的库不许删");
  assert.match(safetySource, /BACKUP_PENDING_RESTORE/u, "待恢复的那一份不许删");
  assert.match(safetySource, /cleanSidecars\(target\)/u, "删完要清 WAL/SHM 伴生文件");
  // #70（第四轮 · 审-1 §2.1）：份数必须在删除**之前**数好。原实现是删完再 listBackups() 一次，
  // 那一步抛错会让调用方收到「删除失败」—— 可文件已经删了，用户再点一次只会得到「找不到这个备份文件」。
  const deleteBody = /export async function deleteBackup\([\s\S]*?\n\}/u.exec(safetySource);
  assert.ok(deleteBody, "没能从 midi/data-safety.js 切出 deleteBackup（改名了？）");
  assert.match(deleteBody[0], /const before = await listBackups\(databasePath\);[\s\S]{0,80}?await unlink\(target\);/u,
    "deleteBackup 要先 listBackups 拿份数、再 unlink");
  assert.doesNotMatch(deleteBody[0], /const after = await listBackups\(databasePath\);/u,
    "删完之后不许再列举一次：那一步抛错会把「已删成功」报成「删除失败」");
  assert.match(deleteBody[0], /total: Math\.max\(0, before\.total - 1\)/u, "剩余份数用删除前的份数减一");
  assert.match(safetySource, /removable: Math\.max\(0, report\.backups\.length - report\.keep\)/u,
    "改小保留份数只回报「将清理几份」，不许直接删（可撤销）");
});
