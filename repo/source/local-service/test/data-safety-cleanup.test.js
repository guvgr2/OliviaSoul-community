// C2「备份可视化与清理」：删单份备份 + 保留份数可配置 + 确认清理。
//
// 为什么要有它：这一批给「高级设置 → 数据备份与恢复」补了两件会**真删文件**的能力
// （删一份备份、按保留份数清理旧周期备份）。删数据的功能不能只靠界面点得通 ——
// 必须钉死四类防护与两条语义：
//   ① 文件名必须是备份目录里的单个 .sqlite（`..`、子目录、别的扩展名一律拒）
//   ② 当前正在用的库、以及"等待重启恢复"的那一份，绝不能删
//   ③ 必须显式 `confirm: true` 才动手（前端二次确认之外，服务端也要拦一道）
//   ④ 保留份数改小**不立刻删**：先在返回值里给 removable，界面点「确认清理」才真删
//   ⑤ 清理只碰周期备份，手动备份/升级前备份/恢复前备份绝不受影响
// 三层证据：真实文件（真 sqlite + 真伴生文件）× 真实 HTTP（真服务 + 真设置存储）× 源码/界面钉死。
//
// 注意：server.js 里各模块的路由是**模块级缓存**（`let dataSafetyRoutesPromise = null`），
// 同一个进程里第二个服务实例会复用第一个实例的闭包（绑定第一个实例已关闭的库，
// 报 `database is not open`）—— 所以需要真 HTTP 的用例必须共用**一个**服务实例，
// 不要按用例各起一个。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOliviaService } from "../server.js";
import { DEFAULT_PERIODIC_BACKUP_KEEP, listBackups } from "../midi/data-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");
const panelSource = read("public/diagnostics-panel.js");
const safetySource = read("midi/data-safety.js");

/**
 * 起真实服务（真设置存储、真数据库、真 listen）+ 临时 root。
 * **一个测试文件只调一次**（理由见文件头）。
 */
async function bootOnce(t) {
  const root = await mkdtemp(join(tmpdir(), "olivia-cleanup-"));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
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
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, service, request, databasePath: join(root, "data", "olivia-local.sqlite") };
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

/** 造一份"像真备份"的文件：真是 sqlite（有表），另有 -wal/-shm 伴生文件。 */
async function seedBackup(databasePath, name, { ageMs = 0, sidecars = true } = {}) {
  const file = join(dirname(databasePath), name);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS demo(key TEXT PRIMARY KEY)");
  db.close();
  if (sidecars) {
    await writeFile(`${file}-wal`, "wal-bytes");
    await writeFile(`${file}-shm`, "shm-bytes");
  }
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  return file;
}

/** 只数 .sqlite —— 备份的伴生文件（-wal/-shm）也在同一目录，不能混进份数。 */
const periodicFiles = async databasePath => (await readdir(dirname(databasePath))).filter(name => name.startsWith("backup-periodic-") && name.endsWith(".sqlite")).sort();
const manualFiles = async databasePath => (await readdir(dirname(databasePath))).filter(name => name.startsWith("backup-manual-") && name.endsWith(".sqlite")).sort();

async function waitFor(check, { timeoutMs = 8000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

/** 直接读设置表 —— 设置的真正事实来源（同进程再开一个服务证明不了持久化）。 */
function readSettingRow(databasePath, key) {
  const db = new DatabaseSync(databasePath);
  try { return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null; }
  finally { db.close(); }
}

// ---------------------------------------------------------------- 真 HTTP：删单份 + 保留份数

test("真服务：删单份的四道防护、真删（含伴生文件）、保留份数改小不立刻删 + 确认清理", async t => {
  const { root, request, databasePath } = await bootOnce(t);

  // 启动时那一次周期备份是**异步**接线的，先等它落盘，后面的份数才是确定的
  assert.ok(await waitFor(async () => (await periodicFiles(databasePath)).length ? true : null), "服务启动后应自动留一份周期备份");
  const disabled = await request("/toy/listen-naming/data/periodic-backup", { method: "POST", body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.body.code, 0, `关掉周期备份失败：${disabled.body.message}`);

  // ------------------------------------------------ ① 删单份：先钉住列表字段
  const target = await seedBackup(databasePath, "backup-manual-20200101-000000.sqlite");
  const victim = await seedBackup(databasePath, "backup-manual-20200202-000000.sqlite");
  const size = (await stat(victim)).size;

  const status = await request("/toy/listen-naming/data/status");
  assert.equal(status.status, 200);
  const entry = status.body.data.items.find(item => item.file === "backup-manual-20200202-000000.sqlite");
  assert.ok(entry, "刚造的备份必须出现在 /data/status 的列表里");
  assert.equal(entry.label, "手动备份", "列表里要能看出这是手动点的还是自动留的");
  assert.equal(entry.bytes, size, "大小要给界面用");
  assert.ok(status.body.data.summary?.count >= 2, "汇总要有份数（界面「共 N 份」靠它）");
  assert.ok(Array.isArray(status.body.data.summary?.kinds), "汇总要按类型拆开（手动 / 周期 / 升级前 …）");

  // ------------------------------------------------ ② 没确认不许删
  for (const body of [{ file: "backup-manual-20200202-000000.sqlite" }, { file: "backup-manual-20200202-000000.sqlite", confirm: false }]) {
    const rejected = await request("/toy/listen-naming/data/backup/delete", { method: "POST", body: JSON.stringify(body) });
    assert.equal(rejected.status, 200, "/toy/* 下的业务错误统一 HTTP 200 + code≠0");
    assert.notEqual(rejected.body.code, 0, "没确认就要删，必须被拒");
    assert.ok(await exists(victim), "被拒的请求不许碰文件");
  }

  // ------------------------------------------------ ③ 路径类防护：不许出备份目录
  for (const bad of [
    "..\\backup-manual-20200202-000000.sqlite",
    "../backup-manual-20200202-000000.sqlite",
    "sub/backup-manual-20200202-000000.sqlite",
    "notes.txt",
    "",
  ]) {
    const rejected = await request("/toy/listen-naming/data/backup/delete", {
      method: "POST", body: JSON.stringify({ file: bad, confirm: true }),
    });
    assert.notEqual(rejected.body.code, 0, `${JSON.stringify(bad)} 必须被拒（basename 校验）`);
    assert.ok(await exists(victim), "越界尝试不许碰真文件");
  }

  // ------------------------------------------------ ④ 当前库 / 不存在的备份
  const live = await request("/toy/listen-naming/data/backup/delete", {
    method: "POST", body: JSON.stringify({ file: "olivia-local.sqlite", confirm: true }),
  });
  assert.equal(live.body.code, "BACKUP_IS_LIVE_DATABASE", "当前库必须用专门的拒绝码挡住");
  assert.ok(await exists(databasePath), "当前库必须还在");

  const missing = await request("/toy/listen-naming/data/backup/delete", {
    method: "POST", body: JSON.stringify({ file: "backup-manual-19990101-000000.sqlite", confirm: true }),
  });
  assert.notEqual(missing.body.code, 0, "删不存在的备份要报错（不能假装删了）");

  // ------------------------------------------------ ⑤ 待恢复的那一份不能删
  const arranged = await request("/toy/listen-naming/data/restore", {
    method: "POST", body: JSON.stringify({ file: "backup-manual-20200101-000000.sqlite", confirm: true }),
  });
  assert.equal(arranged.body.code, 0, `安排恢复失败：${arranged.body.message}`);
  assert.ok(await exists(join(root, "data", "pending-restore.json")), "pending-restore.json 要真写出来");
  const guarded = await request("/toy/listen-naming/data/backup/delete", {
    method: "POST", body: JSON.stringify({ file: "backup-manual-20200101-000000.sqlite", confirm: true }),
  });
  assert.equal(guarded.body.code, "BACKUP_PENDING_RESTORE", "已安排恢复的那一份不能删（删了重启就没得恢复了）");
  assert.ok(await exists(target), "待恢复的备份必须还在");

  // ------------------------------------------------ ⑥ 真删：文件 + 伴生文件一起清掉
  const totalBefore = status.body.data.total;
  const removed = await request("/toy/listen-naming/data/backup/delete", {
    method: "POST", body: JSON.stringify({ file: "backup-manual-20200202-000000.sqlite", confirm: true }),
  });
  assert.equal(removed.body.code, 0, `删除失败：${removed.body.message}`);
  assert.equal(removed.body.data.removed, "backup-manual-20200202-000000.sqlite");
  assert.equal(removed.body.data.freedBytes, size, "要给界面一个准确的释放空间");
  assert.equal(removed.body.data.total, totalBefore - 1, "剩余份数要跟着少一份");
  assert.equal(await exists(victim), false, "文件该没了");
  assert.equal(await exists(`${victim}-wal`), false, "伴生 -wal 也要清掉（只删 .sqlite 会留下垃圾）");
  assert.equal(await exists(`${victim}-shm`), false, "伴生 -shm 也要清掉");

  // 同一个接口在 /admin/api 下也通（程序端与游戏端同源，两种前缀都认）
  const alias = await request("/admin/api/listen-naming/data/status");
  assert.equal(alias.status, 200);
  assert.equal(alias.body.code, 0);

  // ------------------------------------------------ ⑦ 保留份数：改小不立刻删
  for (let index = 0; index < 4; index += 1)
    await seedBackup(databasePath, `backup-periodic-2020010${index + 1}-000000.sqlite`, { ageMs: (5 - index) * 60_000 });
  await seedBackup(databasePath, "backup-manual-20200303-000000.sqlite", { sidecars: false });

  const initial = await request("/toy/listen-naming/data/periodic-backup");
  assert.equal(initial.body.data.keep, DEFAULT_PERIODIC_BACKUP_KEEP, "默认保留份数要跟后端常量一致");
  assert.deepEqual(initial.body.data.keepRange, { min: 1, max: 60 }, "输入框上下限由后端下发（前端不许再抄一份）");

  const before = await periodicFiles(databasePath);
  assert.ok(before.length >= 5, `周期备份应有启动那份 + 造的 4 份，实际 ${JSON.stringify(before)}`);
  // 期望值用**服务端自己看到的份数**算，不靠我这边的目录扫描：
  // 服务会顺带生成 -wal/-shm 之类的伴生文件，"将会清理几份"本来就该等于 backups.length - keep。
  const serverPeriodic = initial.body.data.backups.length;
  assert.equal(serverPeriodic, before.length, "服务端与我看到的周期备份份数要一致");
  const smaller = await request("/toy/listen-naming/data/periodic-backup", { method: "POST", body: JSON.stringify({ keep: 2 }) });
  assert.equal(smaller.body.code, 0, `保存保留份数失败：${smaller.body.message}`);
  assert.equal(smaller.body.data.keep, 2);
  assert.equal(smaller.body.data.cleanup.removable, serverPeriodic - 2, "要告诉界面将会清理几份");
  assert.deepEqual(await periodicFiles(databasePath), before, "改小保留份数**不能**顺手删文件（调大即可撤销）");

  // ------------------------------------------------ ⑧ 非法值被拒、且不落盘
  for (const bad of [0, 61, "3", 2.5]) {
    const rejected = await request("/toy/listen-naming/data/periodic-backup", { method: "POST", body: JSON.stringify({ keep: bad }) });
    assert.notEqual(rejected.body.code, 0, `keep=${JSON.stringify(bad)} 必须被拒`);
    assert.match(rejected.body.message, /保留/u, "提示要说清是保留份数不对");
  }
  assert.equal((await request("/toy/listen-naming/data/periodic-backup")).body.data.keep, 2, "被拒的请求不得改动已保存的设置");
  assert.equal(readSettingRow(databasePath, "periodic_backup_keep"), "2", "保留份数要真落进 settings 表");

  // ------------------------------------------------ ⑨ 清理必须确认；确认后只清最旧的周期备份
  const notConfirmed = await request("/toy/listen-naming/data/periodic-backup/cleanup", { method: "POST", body: JSON.stringify({}) });
  assert.notEqual(notConfirmed.body.code, 0, "没确认不能清理");
  assert.deepEqual(await periodicFiles(databasePath), before, "没确认时文件不许动");

  const cleaned = await request("/toy/listen-naming/data/periodic-backup/cleanup", { method: "POST", body: JSON.stringify({ confirm: true }) });
  assert.equal(cleaned.body.code, 0, `清理失败：${cleaned.body.message}`);
  assert.equal(cleaned.body.data.removed.length, before.length - 2, "清掉的份数要等于「将会清理」那个数字");
  assert.equal(cleaned.body.data.keep, 2);
  assert.equal((await periodicFiles(databasePath)).length, 2, "清完只剩保留份数");
  // 手动备份一份都不能少：20200101 那份是「已安排恢复、重启才会动」的目标，20200303 是刚造的普通手动备份
  assert.deepEqual(
    await manualFiles(databasePath),
    ["backup-manual-20200101-000000.sqlite", "backup-manual-20200303-000000.sqlite"],
    "手动备份（含待恢复那份）绝不能被周期清理带走",
  );
  assert.ok(await exists(databasePath), "当前库当然还在");
  for (const name of cleaned.body.data.removed) assert.ok(before.includes(name), `${name} 应该是清理前就存在的周期备份`);
});

// ---------------------------------------------------------------- 汇总统计（不经过服务）

test("汇总：summary 按全部备份统计，不受列表 limit 截断", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-cleanup-summary-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });
  const databasePath = join(root, "olivia-local.sqlite");
  const live = new DatabaseSync(databasePath);
  live.exec("CREATE TABLE demo(key TEXT PRIMARY KEY)");
  live.close();
  for (let index = 0; index < 5; index += 1)
    await seedBackup(databasePath, `backup-manual-2020010${index + 1}-000000.sqlite`, { sidecars: false });

  const report = await listBackups(databasePath, { limit: 2 });
  assert.equal(report.items.length, 2, "列表按 limit 截断");
  assert.equal(report.total, 5, "总数是全部备份");
  assert.equal(report.summary.count, 5, "汇总必须按全部备份算（界面「共 N 份 · X GB」靠它）");
  assert.equal(report.summary.kinds.reduce((sum, kind) => sum + kind.count, 0), 5, "按类型拆分的份数加起来要等于总数");
  assert.deepEqual(report.summary.kinds.map(kind => kind.label), ["手动备份"], "5 份都是手动备份");
  assert.ok(report.summary.bytes >= report.items.reduce((sum, item) => sum + item.bytes, 0), "汇总字节数至少包含已列出的这几份");
});

// ---------------------------------------------------------------- 界面/源码钉死（防漂移）

test("界面：删除与保留份数两条链路都接在既有设置页上", () => {
  assert.match(panelSource, /"\/data\/backup\/delete"/u, "删除要走服务端接口，不能只在前端骗自己");
  assert.match(panelSource, /confirm: true/u, "删除必须带上 confirm");
  assert.match(panelSource, /deleteBackupFlow/u);
  assert.match(panelSource, /askNotice/u, "删除前要二次确认（noticeDialog）");
  assert.match(panelSource, /"compact danger"/u, "删除按钮要有危险色样式");
  assert.match(panelSource, /keepInput/u, "保留份数要有输入框");
  assert.match(panelSource, /keepCleanup/u, "改小之后要出现「确认清理」");
  assert.match(panelSource, /cleanupPeriodicBackups/u);
  assert.match(panelSource, /removable/u, "「将清理几份」要用服务端给的数字，不能前端自己算");
  assert.match(panelSource, /keepRange/u, "输入框上下限由后端下发");
  // 回归：保存成功后必须无条件写「✓ 已保存：…」——之前写成 if(!textContent) 判断，
  //   renderPeriodicBackup 只更新既有节点、不回填，界面就永远停在「正在保存…」（真实浏览器踩到过）。
  assert.match(panelSource, /✓ 已保存：周期备份最多留/u, "保存成功的回显不能被条件挡住");
  assert.match(safetySource, /BACKUP_DELETE_NOT_CONFIRMED/u);
  assert.match(safetySource, /BACKUP_PENDING_RESTORE/u, "待恢复那一份必须有专门的拒绝码");
  assert.match(safetySource, /BACKUP_IS_LIVE_DATABASE/u);
  assert.match(safetySource, /PERIODIC_BACKUP_CLEANUP_NOT_CONFIRMED/u);
});
