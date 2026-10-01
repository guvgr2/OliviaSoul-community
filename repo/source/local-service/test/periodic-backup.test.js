// 周期自动备份（1.0.5，任务书第 7 节）。
//
// 为什么要有它：程序原来只在**事件触发**时留备份（改时段前、写曲名前、升级前、导入前……），
// 于是一个「整理完就只是每天开着听」的用户可能一份备份都没有 —— 断电、强杀进程、
// 杀毒软件删文件、磁盘写满，任何一种都能让整理成果一次性消失且退不回去。
//
// 本套件按任务书要求的五类行为组织，另加两条我主动钉死的安全约束：
//   ① 未到间隔不备份 ② 到间隔备份一次 ③ 超过保留份数清理最旧 ④ 关闭后不备份
//   ⑤ 备份失败不清理旧备份
//   ⑥ 【安全】新备份没有真的落盘时，旧备份一份都不许动（先落盘、再清理）
//   ⑦ 【安全】清理只碰 backup-periodic-*，手动备份/升级前备份绝不受影响
//
// 三层证据：真实文件（真库 + 真复制）× 真实 HTTP（真服务 + 真设置存储）× 源码/界面钉死。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOliviaService } from "../server.js";
import {
  DEFAULT_PERIODIC_BACKUP_DAYS,
  DEFAULT_PERIODIC_BACKUP_KEEP,
  PERIODIC_BACKUP_PREFIX,
  PERIODIC_BACKUP_TICK_MS,
  createDataSafetyRoutes,
  listPeriodicBackups,
  parsePeriodicBackupInput,
  periodicBackupStatus,
  prunePeriodicBackups,
  readPeriodicBackupConfig,
  runPeriodicBackupIfDue,
  startPeriodicBackup,
} from "../midi/data-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");
const serverSource = read("server.js");
const safetySource = read("midi/data-safety.js");
const panelSource = read("public/diagnostics-panel.js");
const stylesSource = read("public/styles.css");
const packageJson = JSON.parse(read("package.json"));

const DAY = 24 * 60 * 60 * 1000;

/** 建一个真库（周期备份走的是真复制，所以目录里得有真文件）。 */
function makeDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)");
  db.exec("INSERT INTO settings(key, value) VALUES('demo', 'x') ON CONFLICT(key) DO NOTHING");
  db.close();
  return file;
}

async function makeDir(t, label) {
  const dir = await mkdtemp(join(tmpdir(), `olivia-periodic-${label}-`));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return dir;
}

/** 把文件时间改老 N 毫秒 —— 用真实 mtime 表示"上次备份是多久以前"，不造假时钟。 */
async function age(file, ms) {
  const when = new Date(Date.now() - ms);
  await utimes(file, when, when);
  return file;
}

/** 造一份"已有备份"（内容随便写，周期备份的判定只看文件时间与种类）。 */
async function oldBackup(databasePath, name, ageMs) {
  const file = join(dirname(databasePath), name);
  await writeFile(file, "sqlite-bytes");
  await age(file, ageMs);
  return file;
}

const periodicNames = async (databasePath) => (await readdir(dirname(databasePath)))
  .filter(name => name.startsWith(PERIODIC_BACKUP_PREFIX) && name.endsWith(".sqlite"))
  .sort();

/** 比文件集合（不依赖 readdir 的顺序）。 */
function assertSameFiles(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

// ---------------------------------------------------------------- 五类行为

test("① 未到间隔：不备份（reason=too-soon，目录里一份都不多）", async t => {
  const dir = await makeDir(t, "too-soon");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  // 1 小时前刚备过，间隔 1 天 → 不该再备
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250101-000000.sqlite`, 60 * 60 * 1000);
  const before = await readdir(dir);

  const result = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1 });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "too-soon");
  assert.ok(result.dueAt, "要告诉界面/日志「什么时候该备」");
  assert.deepEqual(await readdir(dir), before, "未到间隔不得产生任何文件");
});

test("② 到间隔：备份一次（新文件存在、非空、内容是当前库）", async t => {
  const dir = await makeDir(t, "due");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250101-000000.sqlite`, 2 * DAY);
  const dbBytes = (await stat(db)).size;

  const result = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1 });

  assert.equal(result.ran, true);
  assert.equal(result.reason, "done");
  assert.equal(result.first, false, "目录里本来就有备份，不是首次");
  assert.match(result.file, /^backup-periodic-\d{8}-\d{6}\.sqlite$/u);
  const info = await stat(join(dir, result.file));
  assert.ok(info.size > 0, "备份文件不能是空的");
  assert.equal(info.size, dbBytes, "周期备份 = 当前库的一份完整快照");
  assert.equal(result.bytes, info.size);
  // 落盘时间在刚刚，所以紧接着再检查一次应该是 too-soon（不是又备一份）
  const again = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1 });
  assert.equal(again.reason, "too-soon");
  assertSameFiles(await periodicNames(db), [result.file, "backup-periodic-20250101-000000.sqlite"]);
});

test("③ 首次（一份备份都没有）：立刻留一份，并在日志里说明是首次", async t => {
  const dir = await makeDir(t, "first");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const logs = [];

  const result = await runPeriodicBackupIfDue({ databasePath: db, log: message => logs.push(String(message)) });

  assert.equal(result.ran, true);
  assert.equal(result.first, true);
  assert.equal((await periodicNames(db)).length, 1);
  assert.ok(logs.some(line => line.includes("之前没有任何备份")), `日志要能解释"为什么现在备"：${logs.join(" / ")}`);
});

test("④ 关闭后：不备份（reason=disabled）", async t => {
  const dir = await makeDir(t, "disabled");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250101-000000.sqlite`, 10 * DAY);
  const before = await readdir(dir);

  const result = await runPeriodicBackupIfDue({ databasePath: db, enabled: false, intervalDays: 1 });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.deepEqual(await readdir(dir), before);
});

test("⑤ 备份失败：不备份、更不清理旧备份（旧退路必须留着）", async t => {
  const dir = await makeDir(t, "failed");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const old = [];
  for (let index = 0; index < 5; index += 1)
    old.push(await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}2025010${index + 1}-000000.sqlite`, (5 + index) * DAY));
  const logs = [];

  const result = await runPeriodicBackupIfDue({
    databasePath: db, intervalDays: 1, keep: 2, log: message => logs.push(String(message)),
    backup: async () => { throw new Error("磁盘已满"); },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "failed");
  assert.match(result.error, /磁盘已满/u);
  for (const file of old) assert.ok(await stat(file), `备份失败竟然删了旧备份：${file}`);
  assert.equal((await periodicNames(db)).length, 5, "keep=2 也不许在失败路径上清理");
  assert.ok(logs.some(line => line.includes("周期自动备份失败")), "失败必须留下日志（能定位、但不当弹窗）");
  const status = periodicBackupStatus(db);
  assert.match(status.lastError, /磁盘已满/u, "失败要暴露在诊断状态里");
});

test("⑥ 安全：新备份没有真的落盘，就一份旧的都不许动", async t => {
  const dir = await makeDir(t, "not-landed");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const old = [];
  for (let index = 0; index < 5; index += 1)
    old.push(await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}2025010${index + 1}-000000.sqlite`, (5 + index) * DAY));

  // 备份函数"假装成功"但什么都没写（真实的可能成因：坏盘、被安全软件拦截、写到别处去了）
  const result = await runPeriodicBackupIfDue({
    databasePath: db, intervalDays: 1, keep: 2,
    backup: async () => {},
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "failed");
  assert.match(result.error, /没有落盘/u);
  assert.equal((await periodicNames(db)).length, 5, "「先确认落盘、再清理」被破坏了：旧备份被删了");
  for (const file of old) await stat(file);
});

test("⑦ 安全：清理只碰周期备份，手动/升级前备份一份不动", async t => {
  const dir = await makeDir(t, "prune-scope");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  for (let index = 0; index < 8; index += 1)
    await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}2025010${index + 1}-000000.sqlite`, (3 + index) * DAY);
  const manual = await oldBackup(db, "backup-manual-20250101-000000.sqlite", 30 * DAY);
  const upgrade = await oldBackup(db, "upgrade-backup-2000-1-to-2000-2-20250101-000000.sqlite", 40 * DAY);

  const result = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1, keep: 7 });

  assert.equal(result.ran, true);
  assert.equal(result.removed.length, 2, `8 份旧 + 1 份新、keep=7 → 该清理 2 份，实际 ${result.removed.length}`);
  const left = await periodicNames(db);
  assert.equal(left.length, 7);
  assert.ok(left.includes(result.file), "刚备份的那份必须在（protect）");
  assert.ok(!left.includes("backup-periodic-20250109-000000.sqlite"), "最旧的周期备份该被清理");
  assert.ok(!left.includes("backup-periodic-20250110-000000.sqlite"), "次旧的周期备份也该被清理");
  await stat(manual);
  await stat(upgrade);
  assert.ok((await readdir(dir)).includes("backup-manual-20250101-000000.sqlite"), "手动备份绝不能被清理");
});

test("⑧ 同一秒内连续备份不会互相覆盖（每次都是独立的一份退路）", async t => {
  const dir = await makeDir(t, "unique");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250101-000000.sqlite`, 5 * DAY);

  const first = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1 });
  await age(join(dir, first.file), 5 * DAY); // 手动"弄老"，制造同一秒内再次到点的场景
  const second = await runPeriodicBackupIfDue({ databasePath: db, intervalDays: 1 });

  assert.equal(second.ran, true);
  assert.notEqual(second.file, first.file, "文件名相同时必须追加序号，不能覆盖");
  assertSameFiles(await periodicNames(db), [
    first.file, second.file, "backup-periodic-20250101-000000.sqlite",
  ]);
  await stat(join(dir, first.file));
  await stat(join(dir, second.file));
});

// ---------------------------------------------------------------- 配置读取与校验

test("配置读取：默认开启/每天；只有明确的关闭值才算关闭；垃圾与越界回落默认", () => {
  const config = values => readPeriodicBackupConfig(key => values[key]);
  assert.deepEqual(config({}), { enabled: true, intervalDays: DEFAULT_PERIODIC_BACKUP_DAYS, keep: DEFAULT_PERIODIC_BACKUP_KEEP },
    "没设置过 = 开启 + 每 1 天（这是这个功能的默认承诺）");
  for (const value of ["0", "false", "off", "no", " OFF "]) {
    assert.equal(config({ periodic_backup_enabled: value }).enabled, false, `${value} 应视为关闭`);
  }
  for (const value of ["1", "true", "yes", ""]) {
    assert.equal(config({ periodic_backup_enabled: value }).enabled, true, `${value} 应视为开启`);
  }
  assert.equal(config({ periodic_backup_interval_days: "7" }).intervalDays, 7, "7 天是任务书要求支持的第二档");
  for (const value of ["0", "-1", "31", "abc", "1.5", ""]) {
    assert.equal(config({ periodic_backup_interval_days: value }).intervalDays, DEFAULT_PERIODIC_BACKUP_DAYS,
      `${value} 不是合法间隔 → 回落到默认 1 天（宁多备一次，不要静默失效）`);
  }
  assert.equal(DEFAULT_PERIODIC_BACKUP_KEEP, 7, "默认最多留 7 份");
  assert.equal(PERIODIC_BACKUP_TICK_MS, 30 * 60 * 1000, "常驻兜底是低频检查（30 分钟）");
});

test("配置写入校验：非法开关/间隔给 400 与可读原因，空请求也 400", () => {
  assert.deepEqual(parsePeriodicBackupInput({ enabled: false }), { enabled: false });
  assert.deepEqual(parsePeriodicBackupInput({ intervalDays: 7 }), { intervalDays: 7 });
  for (const bad of [{ enabled: "yes" }, { enabled: 1 }, { intervalDays: 0 }, { intervalDays: 31 }, { intervalDays: "三天" }]) {
    assert.throws(() => parsePeriodicBackupInput(bad), error => {
      assert.equal(error.status, 400, `${JSON.stringify(bad)} 应该被拒`);
      assert.ok(error.message, "必须给出人能看懂的原因");
      return true;
    });
  }
  assert.throws(() => parsePeriodicBackupInput({}), /没有要修改的设置项/u);
});

test("保留策略直接调用：keep 下限是 1、protect 指定的那份永不删", async t => {
  const dir = await makeDir(t, "prune-api");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  for (let index = 0; index < 4; index += 1)
    await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}2025010${index + 1}-000000.sqlite`, (1 + index) * DAY);

  const removed = await prunePeriodicBackups(db, { keep: 0, protect: "backup-periodic-20250101-000000.sqlite" });

  assert.equal(removed.length, 3, "keep=0 也要至少留 1 份（下限保护），protect 的那份不删");
  assert.deepEqual(await periodicNames(db), ["backup-periodic-20250101-000000.sqlite"]);
  const items = await listPeriodicBackups(db);
  assert.equal(items[0].file, "backup-periodic-20250101-000000.sqlite");
  assert.ok(items[0].bytes > 0);
});

test("列表只认周期备份，且新的在前", async t => {
  const dir = await makeDir(t, "list");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250101-000000.sqlite`, 9 * DAY);
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250102-000000.sqlite`, 3 * DAY);
  await oldBackup(db, "backup-manual-20250101-000000.sqlite", 1 * DAY);
  await oldBackup(db, `${PERIODIC_BACKUP_PREFIX}20250103-000000.sqlite`, 5 * DAY);

  const items = await listPeriodicBackups(db);

  assert.deepEqual(items.map(item => item.file), [
    "backup-periodic-20250102-000000.sqlite",
    "backup-periodic-20250103-000000.sqlite",
    "backup-periodic-20250101-000000.sqlite",
  ], "手动备份不得混进周期备份列表，且按时间从新到旧");
});

// ---------------------------------------------------------------- 常驻兜底

test("启动即检查一次；定时器低频兜底；stop 之后不再检查；unref 不拦退出", async t => {
  const dir = await makeDir(t, "timer");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const seen = [];

  const runner = startPeriodicBackup({
    databasePath: db, readSetting: () => undefined, tickMs: 40,
    log: message => seen.push(String(message)),
  });
  // 传入的 tickMs 有下限保护（100ms），避免被误配成忙轮询
  assert.equal(runner.intervalMs, 100);
  await waitFor(() => periodicBackupStatus(db)?.lastCheckSource === "startup", { timeoutMs: 3000 });
  assert.equal(periodicBackupStatus(db).lastCheckSource, "startup", "启动时必须先查一次（用户可能整天不开程序）");
  assert.equal((await periodicNames(db)).length, 1, "首次启动就该留一份");

  // 定时器兜底：把刚备份的那份弄老，等下一次低频检查自己再备一次
  const [name] = await periodicNames(db);
  await age(join(dir, name), 5 * DAY);
  const viaTimer = await waitFor(
    async () => (periodicBackupStatus(db)?.lastCheckSource === "timer" ? true : null),
    { timeoutMs: 3000 },
  );
  assert.ok(viaTimer, "常驻兜底定时器没有触发（服务整天开着时就得靠它）");
  assert.equal((await periodicNames(db)).length, 2);

  await runner.stop();
  const stopped = await runner.runOnce("test");
  assert.equal(stopped, null, "stop 之后不许再动备份目录");
  assert.equal(runner.status().lastCheckSource, "timer");
});

test("stop() 会等正在写的那份备份收尾（否则 close 之后清理数据目录会撞上写了一半的 .tmp）", async t => {
  const dir = await makeDir(t, "stop-wait");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const steps = [];
  const runner = startPeriodicBackup({
    databasePath: db, readSetting: () => undefined,
    backup: async (_databasePath, target) => {
      steps.push("start");
      await new Promise(resolve => setTimeout(resolve, 80));
      await writeFile(target, "fake-sqlite");
      steps.push("done");
    },
  });

  await runner.stop();

  assert.deepEqual(steps, ["start", "done"], "stop() 返回时那份备份必须已经写完（Windows 上不然就是 EBUSY/ENOTEMPTY）");
  assert.equal(await runner.runOnce("test"), null, "stop() 之后不再动任何文件");
});

test("读设置失败/设置表坏掉时：按默认（开启 + 每天）继续，不抛错、不影响启动", async t => {
  const dir = await makeDir(t, "throws");
  const db = makeDatabase(join(dir, "olivia-local.sqlite"));
  const runner = startPeriodicBackup({
    databasePath: db, readSetting: () => { throw new Error("设置表坏了"); },
  });

  const result = await runner.runOnce("startup");

  // 设计取向：读不出用户设置时按默认继续备一份 —— 宁可多留一份备份，
  // 也不要因为"读设置失败"就让用户的退路静默消失（关闭必须由明确的设置值表达）。
  assert.equal(result.ran, true);
  assert.equal(result.first, true);
  assert.equal((await periodicNames(db)).length, 1);
  // 备份目录坏掉（备份真的做不成）时，也只是记日志 + 返回 failed，绝不抛到启动流程
  const broken = startPeriodicBackup({ databasePath: join(dir, "没有这个目录", "olivia-local.sqlite"), readSetting: () => undefined });
  await broken.runOnce("startup");
  assert.equal(periodicBackupStatus(join(dir, "没有这个目录", "olivia-local.sqlite"))?.lastCheck.reason, "no-database");
  await runner.stop();
  await broken.stop();
});

// ---------------------------------------------------------------- 真实服务（设置持久化 + 真接线）

/** 起真实服务（真设置存储、真数据库、真 listen）。 */
async function boot(root, open) {
  const service = await createOliviaService({
    root, dataDir: join(root, "data"),
    worker: false, runMemoryRefresh: false, delaySeconds: 300,
  });
  const address = await service.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  async function request(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  const instance = { service, request, async close() { await service.close(); } };
  open.push(instance);
  return instance;
}

/**
 * 临时 root + 统一收尾：**先关服务、再删目录**（反过来会 EBUSY，且同一个数据目录不能同时开两个服务）。
 */
async function makeRoot(t, label) {
  const root = await mkdtemp(join(tmpdir(), `olivia-periodic-svc-${label}-`));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
  const open = [];
  t.after(async () => {
    for (const instance of [...open].reverse()) {
      try { await instance.close(); } catch { /* 可能已手动关过 */ }
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, open };
}

async function waitFor(check, { timeoutMs = 8000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

/**
 * 直接读设置表 —— 周期备份的设置存的就是这里。
 * 为什么不用「再起一个服务读一遍」来自证重启后还在：server.js 里各模块的路由是
 * **模块级缓存**（`let dataSafetyRoutesPromise = null`，全仓库 12 个模块同款写法），
 * 同一个进程里第二个服务实例会复用第一个实例的闭包（绑定的是第一个实例的库与设置读写），
 * 所以"同进程开两个服务"证明不了重启行为。这里改成直接看设置表这个真正的事实来源。
 */
function readSettingRow(databasePath, key) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null; }
  finally { db.close(); }
}

test("真实服务：启动就留一份；默认值 / 保存立刻生效 / 非法值被拒 / 设置真的落盘", async t => {
  const { root, open } = await makeRoot(t, "service");
  const db = join(root, "data", "olivia-local.sqlite");
  const { request } = await boot(root, open);

  // ① 接线：listen() 之后自动留一份（真服务、真数据目录、真复制）
  const created = await waitFor(async () => {
    const names = await periodicNames(db);
    return names.length ? names : null;
  });
  assert.ok(created, "服务启动后应自动留一份周期备份（listen() 里的接线）");
  assert.ok((await stat(join(root, "data", created[0]))).size > 0, "周期备份不能是空文件");

  const status = await request("/toy/listen-naming/data/status");
  assert.equal(status.status, 200);
  const item = status.body.data.items.find(entry => entry.file === created[0]);
  assert.ok(item, `周期备份必须出现在「数据备份与恢复」的列表里：期望 ${created[0]}，实际 ${JSON.stringify(status.body.data.items?.map(entry => entry.file))}`);
  assert.equal(item.label, "周期自动备份", "列表里要能看出这是自动留的还是手动点的");

  // ② 默认值：开启、每 1 天、最多 7 份
  const initial = await request("/toy/listen-naming/data/periodic-backup");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.enabled, true, "默认必须是开启的（否则等于没做这个功能）");
  assert.equal(initial.body.data.intervalDays, 1);
  assert.equal(initial.body.data.keep, 7);
  assert.equal(initial.body.data.status.lastCheckSource, "startup", "启动那次检查的状态要暴露给界面");
  assert.ok(initial.body.data.backups.some(entry => entry.file === created[0]), "界面要能看到已有的周期备份");

  // ③ 保存立刻生效（不用重启）
  const off = await request("/toy/listen-naming/data/periodic-backup", {
    method: "POST", body: JSON.stringify({ enabled: false }),
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.enabled, false, "保存后要立刻看到新值");
  const week = await request("/toy/listen-naming/data/periodic-backup", {
    method: "POST", body: JSON.stringify({ intervalDays: 7 }),
  });
  assert.equal(week.body.data.enabled, false);
  assert.equal(week.body.data.intervalDays, 7, "7 天这一档要能存下来");

  // ④ 非法值被拒。
  // 注意项目约定：/toy/* 下的错误统一走 HTTP 200 + code≠0（游戏端才不会把业务报错当网络故障），
  // 所以这里断言的是 code 与 message，不是 HTTP 状态码。
  for (const [bad, pattern] of [
    [{ intervalDays: 0 }, /间隔天数/u],
    [{ intervalDays: "每天" }, /间隔天数/u],
    [{ enabled: "yes" }, /开关/u],
    [{}, /没有要修改的设置项/u],
  ]) {
    const rejected = await request("/toy/listen-naming/data/periodic-backup", {
      method: "POST", body: JSON.stringify(bad),
    });
    assert.equal(rejected.status, 200);
    assert.notEqual(rejected.body.code, 0, `${JSON.stringify(bad)} 必须被拒（不能让坏设置静默落盘）`);
    assert.match(rejected.body.message, pattern, `${JSON.stringify(bad)} 的提示要说清哪里不对`);
  }
  const stillWeek = await request("/toy/listen-naming/data/periodic-backup");
  assert.equal(stillWeek.body.data.intervalDays, 7, "被拒的请求不得改动已保存的设置");
  assert.equal(stillWeek.body.data.enabled, false);

  // ⑤ 持久化：设置表里真有这两行 —— 换个进程重新起服务读到的就是它们
  assert.equal(readSettingRow(db, "periodic_backup_enabled"), "0");
  assert.equal(readSettingRow(db, "periodic_backup_interval_days"), "7");
  // 并且拿这份设置重新装配一次模块路由（= 重启后新进程的读法），读出来仍是关闭 + 7 天
  const again = await createDataSafetyRoutes({
    databasePath: db, getSetting: key => readSettingRow(db, key), setSetting: () => {},
  });
  const report = await again(
    { method: "GET", headers: {} },
    new URL("http://127.0.0.1/toy/listen-naming/data/periodic-backup"),
  );
  assert.equal(report.enabled, false, "重启后必须还是关闭状态");
  assert.equal(report.intervalDays, 7);

  // ⑥ 关闭是真的关：用同一份已保存的设置跑一次检查 → disabled，且目录一份都不多
  const before = await periodicNames(db);
  const skipped = await runPeriodicBackupIfDue({
    databasePath: db, ...readPeriodicBackupConfig(key => readSettingRow(db, key)),
  });
  assert.equal(skipped.reason, "disabled", "关掉之后不许偷偷备份");
  assertSameFiles(await periodicNames(db), before);
});

// ---------------------------------------------------------------- 源码/界面钉死（防漂移）

test("界面：既有设置页里有这一个设置行，且真的会调这两个接口", () => {
  assert.match(panelSource, /periodic-backup/u, "界面必须走 /data/periodic-backup 接口");
  assert.match(panelSource, /loadPeriodicBackup/u);
  assert.match(panelSource, /savePeriodicBackup/u);
  assert.match(panelSource, /periodicSelect/u, "设置行要有下拉框（关闭 / 每天 / 每 7 天）");
  assert.match(panelSource, /"7", "每 7 天"/u, "7 天这一档要在界面上可选");
  assert.match(panelSource, /只保留最近/u, "界面要说明保留份数，否则用户不知道旧备份会没");
  assert.match(stylesSource, /\.ln-diagPeriodic/u, "样式要跟着补，不然这一行是裸的");
  // 装配本身也要钉住：节点没 append / 没进 ui，界面就是死的（只匹配字符串会漏掉这种"写好了但没接上"）
  assert.match(panelSource, /box\.append\([\s\S]{0,600}?periodicRow, periodicHint, periodicStatus,[\s\S]{0,200}?transferHead/u,
    "这一行必须真的装配进「数据备份与恢复」面板，且在导出/导入之前");
  assert.match(panelSource, /periodicSelect, periodicHint, periodicStatus,/u, "三个节点都要进 ui 对象，否则渲染与保存时拿不到元素");
  assert.match(panelSource, /periodicSelect\.addEventListener\("change"/u, "改下拉框要真的触发保存");
  assert.match(panelSource, /void loadPeriodicBackup\(\);/u, "面板渲染时要主动拉一次，不然用户看不到当前档位");
});

test("接线与依赖：server.js 传入设置存储、关服务时停掉定时器、不引入新依赖", () => {
  assert.match(serverSource, /startPeriodicBackup\(\{/u);
  assert.match(serverSource, /createDataSafetyRoutes\(\{ databasePath, getSetting, setSetting \}\)/u,
    "周期备份的设置要复用本机 settings（不新造存储）");
  assert.match(serverSource, /await periodicBackup\.stop\(\)/u, "close() 里必须停掉定时器并等它收尾，否则进程退不掉/清理目录会撞上 .tmp");
  assert.match(serverSource, /readSetting: getSetting/u);

  const imported = [...safetySource.matchAll(/^import .*?from "([^"]+)";$/gmu)].map(match => match[1]);
  assert.ok(imported.length >= 5, "import 解析失败说明源码结构变了，需要人看");
  for (const specifier of imported)
    assert.ok(specifier.startsWith("node:") || specifier.startsWith("."), `data-safety 引入了一个新依赖：${specifier}`);
  assert.match(safetySource, /timer\.unref\?\.\(\)/u, "定时器必须 unref，否则会拦着进程退出");
  assert.match(safetySource, /backup-periodic-/u);
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).filter(name => /cron|schedule/iu.test(name)), [],
    "不许为了周期备份引入计划任务类依赖");
});
