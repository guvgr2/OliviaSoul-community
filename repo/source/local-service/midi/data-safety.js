// 数据安全：数据库备份与恢复 + 用户数据导出/迁移（g14）
//
// 背景：程序在写库前一直会生成 backup-*.sqlite（改时段、写曲名、社区比对），但没有任何"从备份恢复"
// 的入口 —— 备份只写不读，出事时用户只能看着文件干瞪眼。这里把闭环补齐，并加了两道防线。
//
// 三条设计约束（都是踩过的坑）：
//   1. 恢复不热执行：主连接是长期持有的（server.js 启动时 open、退出时才 close），Windows 上文件被占用
//      无法覆盖。所以「恢复」只写一个待恢复标记，由下次启动在打开连接之前应用 —— 那时没有任何连接，
//      最安全。界面上明确写"重启程序后生效"。
//   2. 任何恢复/导入之前，先把当前库整体留档（连 WAL 一起改名），永远留一条退路。
//   3. 导出包一律脱敏（清空 API Key 等凭据）：备份留完整是给本机回滚用的，导出包是可能被分享出去的。
import { copyFile, mkdir, readdir, rename, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import { makeZip } from "./diagnostic-package.js";

const MB = 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * MB;      // 导出包上限（数据库 + 歌词，正常远小于此）
const MAX_IMPORT_BYTES = 1024 * MB;     // 导入包上限
const MAX_LYRIC_BYTES = 256 * 1024;     // 单个歌词文件上限（与歌词功能一致）

// ---------------------------------------------------------------- 基础工具

function httpError(status, message, code = "DATA_SAFETY_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** 与 time-of-day.js 的 stamp() 保持一致，备份文件名风格统一。 */
export function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function backupDirOf(databasePath) { return dirname(databasePath); }
export function userDataDirOf(databasePath) { return dirname(dirname(databasePath)); }
function versionFileOf(databasePath) { return join(userDataDirOf(databasePath), "last-run-version.txt"); }
function pendingFileOf(databasePath) { return join(backupDirOf(databasePath), "pending-restore.json"); }
function exportsDirOf(databasePath) { return join(userDataDirOf(databasePath), "exports"); }

function openReadOnly(path) { return new DatabaseSync(path, { readOnly: true }); }

async function exists(path) { try { await stat(path); return true; } catch { return false; } }

/** 备份种类 → 人话（界面上直接显示这个）。 */
const BACKUP_KINDS = [
  ["backup-tod-", "改时段前的自动备份"],
  ["backup-listen-", "写曲名前（命名）的自动备份"],
  ["backup-community-", "社区名单比对前的自动备份"],
  ["backup-before-migrate-", "数据搬家前的自动备份"],
  ["backup-manual-", "你手动备份的"],
  ["upgrade-backup-", "程序升级前的自动备份"],
  ["before-restore-", "恢复前留的当前库"],
  ["import-", "从导出包导入时的副本"],
  ["upload-", "从导出包导入时的副本"],
];
function kindLabel(name) {
  for (const [prefix, label] of BACKUP_KINDS) if (name.startsWith(prefix)) return label;
  return "其它备份";
}

// ---------------------------------------------------------------- 备份

/**
 * 用 SQLite 自己的备份 API 生成一致快照（直接 copy 一个开着 WAL 的库会丢已提交事务）。
 * 备份 API 不可用时退回文件复制。
 */
export async function backupSqlite(databasePath, target) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  try { await unlink(temporary); } catch { /* 不存在正常 */ }
  let done = false;
  try {
    const source = openReadOnly(databasePath);
    try {
      if (typeof source.backup === "function") { await source.backup(temporary); done = true; }
    } finally { source.close(); }
  } catch { done = false; }
  if (!done) await copyFile(databasePath, temporary);
  await rename(temporary, target);
  return target;
}

/** 备份列表（含当前库本身的信息）。 */
export async function listBackups(databasePath, { limit = 60 } = {}) {
  const dir = backupDirOf(databasePath);
  const items = [];
  let names = [];
  try { names = await readdir(dir); } catch { /* 目录还没有 */ }
  for (const name of names) {
    if (!name.endsWith(".sqlite")) continue;
    if (name === basename(databasePath)) continue;   // 当前库单独返回
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info) continue;
    items.push({
      file: name,
      bytes: info.size,
      at: info.mtime.toISOString(),
      label: kindLabel(name),
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));

  const currentInfo = await stat(databasePath).catch(() => null);
  return {
    dir,
    database: currentInfo
      ? { file: basename(databasePath), bytes: currentInfo.size, at: currentInfo.mtime.toISOString() }
      : null,
    total: items.length,
    items: items.slice(0, limit),
    pending: await readPendingRestore(databasePath),
  };
}

/** 某个备份里有什么 —— 恢复之前先让人看清楚，别恢复错。 */
export async function inspectBackup(file) {
  const info = await stat(file).catch(() => null);
  if (!info) throw httpError(404, "找不到这个备份文件", "BACKUP_NOT_FOUND");
  const db = openReadOnly(file);
  try {
    let integrity = "unknown";
    try { integrity = String(db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown"); }
    catch { integrity = "unreadable"; }
    const count = (sql) => { try { return Number(db.prepare(sql).get()?.c ?? 0); } catch { return null; } };
    return {
      file: basename(file),
      bytes: info.size,
      at: info.mtime.toISOString(),
      integrity,
      valid: integrity === "ok",
      counts: {
        songs: count("SELECT COUNT(*) AS c FROM user_songs WHERE removed_at IS NULL"),
        named: count("SELECT COUNT(*) AS c FROM user_songs WHERE removed_at IS NULL AND custom_name IS NOT NULL AND custom_name <> ''"),
        timeOfDay: count("SELECT COUNT(*) AS c FROM user_songs WHERE removed_at IS NULL AND time_of_day_mapping IS NOT NULL AND time_of_day_mapping <> ''"),
        letters: count("SELECT COUNT(*) AS c FROM letters"),
      },
    };
  } finally { db.close(); }
}

/** 立刻手动备份一份当前库。 */
export async function manualBackup(databasePath) {
  if (!(await exists(databasePath))) throw httpError(404, "数据库还不存在，没什么可备份的", "DATABASE_MISSING");
  const target = join(backupDirOf(databasePath), `backup-manual-${stamp()}.sqlite`);
  await backupSqlite(databasePath, target);
  const info = await stat(target).catch(() => null);
  return { file: basename(target), bytes: info?.size ?? 0, dir: backupDirOf(databasePath) };
}

// ---------------------------------------------------------------- 恢复（写标记，下次启动生效）

export async function readPendingRestore(databasePath) {
  try {
    const raw = await readFile(pendingFileOf(databasePath), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      file: String(parsed.file ?? ""),
      source: String(parsed.source ?? "restore"),
      label: String(parsed.label ?? ""),
      createdAt: String(parsed.createdAt ?? ""),
    };
  } catch { return null; }
}

/**
 * 安排一次恢复：校验来源 → 落一个待恢复标记。真正的替换发生在下次启动、打开连接之前。
 * 前端必须把"重启程序后生效"讲清楚。
 */
export async function arrangeRestore(databasePath, file, { source = "restore", label = "" } = {}) {
  const info = await stat(file).catch(() => null);
  if (!info) throw httpError(404, "找不到这个备份文件", "BACKUP_NOT_FOUND");
  const summary = await inspectBackup(file);
  if (!summary.valid)
    throw httpError(400, `这个备份读不出来（完整性检查：${summary.integrity}），换一个再试`, "BACKUP_INVALID");
  await mkdir(backupDirOf(databasePath), { recursive: true });
  const pending = {
    file: basename(file),
    fullPath: file,
    source,
    label,
    createdAt: new Date().toISOString(),
    summary,
  };
  await writeFile(pendingFileOf(databasePath), JSON.stringify(pending, null, 2), "utf8");
  return {
    pending: true,
    file: basename(file),
    needsRestart: true,
    summary,
  };
}

export async function cancelRestore(databasePath) {
  try { await unlink(pendingFileOf(databasePath)); } catch { /* 没有就算了 */ }
  return { pending: false };
}

/**
 * 启动时应用待恢复（必须在 initDatabase 之前调用，此时没有任何连接）。
 * 当前库连 WAL/SHM 一起改名留档，永远留一条退路。
 */
export async function applyPendingRestore({ databasePath, log = () => {} }) {
  const pending = await readPendingRestore(databasePath);
  if (!pending) return null;
  const source = String(pending.fullPath || join(backupDirOf(databasePath), pending.file));
  const clear = async () => { try { await unlink(pendingFileOf(databasePath)); } catch { /* 忽略 */ } };

  if (!(await exists(source))) {
    log(`[data-safety] 待恢复的备份已不在了，取消恢复：${pending.file}`);
    await clear();
    return { applied: false, reason: "missing" };
  }

  const kept = `${join(backupDirOf(databasePath), `before-restore-${stamp()}.sqlite`)}`;
  let keptFile = "";
  if (await exists(databasePath)) {
    // 三个文件一起改名，保留的是完整状态（含 WAL 里尚未 checkpoint 的部分）
    try { await rename(databasePath, kept); keptFile = basename(kept); } catch { /* 改不动就继续，下面复制会覆盖 */ }
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${databasePath}${suffix}`;
      if (await exists(side)) { try { await rename(side, `${kept}${suffix}`); } catch { /* 忽略 */ } }
    }
  }
  await copyFile(source, databasePath);
  // 恢复进来的是一份干净快照，旧的 WAL/SHM 不能再留（否则会拿旧日志套新库）
  for (const suffix of ["-wal", "-shm"]) {
    try { await unlink(`${databasePath}${suffix}`); } catch { /* 不存在正常 */ }
  }
  await clear();
  log(`[data-safety] 已应用恢复：${pending.file}（恢复前的库留档为 ${keptFile || "无"}）`);
  return { applied: true, from: pending.file, kept: keptFile, source: pending.source };
}

/**
 * 程序版本变化时自动备份旧库 —— 覆盖安装/换便携包是最容易出事的一步，
 * 不能只靠安装向导里一句"建议先备份 UserData"。
 */
export async function backupBeforeUpgrade({ databasePath, version, log = () => {} }) {
  const versionFile = versionFileOf(databasePath);
  let previous = "";
  try { previous = String(await readFile(versionFile, "utf8")).trim(); } catch { previous = ""; }
  const current = String(version ?? "").trim();
  if (!current) return null;
  if (!previous) {
    // 首次运行（或老版本没写过这个文件）：只记下来，不备份
    try { await mkdir(dirname(versionFile), { recursive: true }); await writeFile(versionFile, current, "utf8"); } catch { /* 忽略 */ }
    return { first: true };
  }
  if (previous === current) return null;
  if (!(await exists(databasePath))) {
    try { await writeFile(versionFile, current, "utf8"); } catch { /* 忽略 */ }
    return null;
  }
  const short = value => String(value).replace(/[^\w.-]+/gu, "_");
  const target = join(backupDirOf(databasePath), `upgrade-backup-${short(previous)}-to-${short(current)}-${stamp()}.sqlite`);
  try {
    await backupSqlite(databasePath, target);
    log(`[data-safety] 检测到程序从 ${previous} 升到 ${current}，已自动备份升级前的数据库：${basename(target)}`);
  } catch (error) {
    log(`[data-safety] 升级前自动备份失败（不影响启动）：${error.message}`);
  }
  try { await writeFile(versionFile, current, "utf8"); } catch { /* 忽略 */ }
  return { previous, current, file: basename(target) };
}

/** server.js 在 initDatabase 之前调用：先应用待恢复，再做升级前备份。 */
export async function prepareDatabaseBeforeOpen({ databasePath, version, log = () => {} }) {
  const restored = await applyPendingRestore({ databasePath, log });
  const upgraded = await backupBeforeUpgrade({ databasePath, version, log });
  return { restored, upgraded };
}

// ---------------------------------------------------------------- 导出 / 导入（换电脑、留底）

/** 导出包一律脱敏：清空 settings 里各种形态的凭据（导出包是可能被分享出去的）。 */
function scrubCredentials(target) {
  const db = new DatabaseSync(target);
  let scrubbed = 0;
  try {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const update = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    for (const row of rows) {
      const value = String(row?.value ?? "");
      if (!value) continue;
      const next = value
        .replace(/("apiKey"\s*:\s*")[^"]*(")/gu, "$1$2")
        .replace(/((?:API_KEY|api_key|apiKey)\s*[=:]\s*)[^\s;,"'}]+/gu, "$1")
        .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/gu, "<已移除>")
        .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gu, "$1<已移除>");
      if (next !== value) { update.run(next, row.key); scrubbed += 1; }
    }
  } catch { /* 老库没有 settings 表就算了 */ }
  finally { db.close(); }
  return scrubbed;
}

async function collectLyrics(databasePath) {
  const dir = join(userDataDirOf(databasePath), "lyrics");
  const entries = [];
  let names = [];
  try { names = await readdir(dir); } catch { return { entries, skipped: 0 }; }
  let skipped = 0;
  for (const name of names) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > MAX_LYRIC_BYTES) { skipped += 1; continue; }
    try { entries.push({ name: `lyrics/${name}`, data: await readFile(file) }); } catch { skipped += 1; }
  }
  return { entries, skipped };
}

/**
 * 把用户数据打成 zip：数据库（已脱敏）+ 歌词 + 说明。
 * 不含任何音视频、不含 API Key —— 换电脑导入后只需重填一次模型配置。
 */
export async function exportUserData({ databasePath, version } = {}) {
  if (!(await exists(databasePath))) throw httpError(404, "数据库还不存在，没有可导出的数据", "DATABASE_MISSING");
  const outDir = exportsDirOf(databasePath);
  await mkdir(outDir, { recursive: true });
  const snapshot = join(outDir, `.snapshot-${stamp()}.sqlite`);
  await backupSqlite(databasePath, snapshot);
  const scrubbed = scrubCredentials(snapshot);
  const summary = await inspectBackup(snapshot);
  const lyrics = await collectLyrics(databasePath);
  const buffer = await readFile(snapshot);
  await unlink(snapshot).catch(() => {});

  const manifest = {
    kind: "olivia-userdata",
    version: String(version ?? ""),
    exportedAt: new Date().toISOString(),
    counts: summary.counts,
    lyrics: lyrics.entries.length,
    lyricsSkipped: lyrics.skipped,
    credentialsRemoved: scrubbed,
    note: "只含用户数据（曲库命名/时段/歌词关联/信件记忆/设置），不含音视频，不含 API Key。",
  };
  const readme = [
    "Olivia Soul 用户数据导出包",
    "",
    `· 导出时间：${manifest.exportedAt}`,
    `· 程序版本：${manifest.version || "（未记录）"}`,
    `· 曲库记录：${summary.counts.songs ?? "?"} 条（已命名 ${summary.counts.named ?? "?"}，已设时段 ${summary.counts.timeOfDay ?? "?"}）`,
    `· 信件：${summary.counts.letters ?? "?"} 封`,
    `· 歌词文件：${lyrics.entries.length} 个${lyrics.skipped ? `（另有 ${lyrics.skipped} 个超出大小限制未包含）` : ""}`,
    `· 已移除的凭据：${scrubbed} 处（API Key 等不会进这个包，新机器请重新填写）`,
    "",
    "怎么用：",
    "  1. 在新机器上装好本程序，先不要开始整理数据；",
    "  2. 打开「高级设置 → 诊断 → 数据备份与恢复」，点「从导出包导入」选这个 zip；",
    "  3. 按提示重启程序，数据就回来了（导入前会自动把新机器上的当前库留档）。",
    "",
    "不含什么：音视频文件（仍在原目录）、API Key 等凭据。",
    "提醒：这个包里有你的曲名/时段/信件，等同于隐私数据，请勿随意外发。",
    "",
  ].join("\r\n");

  const entries = [
    { name: "README.txt", data: readme },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "database/olivia-local.sqlite", data: buffer },
    ...lyrics.entries,
  ];
  const zip = makeZip(entries);
  if (zip.length > MAX_EXPORT_BYTES) throw httpError(413, "数据太大，导出包超过上限", "EXPORT_TOO_LARGE");
  const target = join(outDir, `olivia-userdata-${String(version || "unknown").replace(/[^\w.-]+/gu, "_")}-${stamp()}.zip`);
  await writeFile(target, zip);
  return {
    file: target,
    name: basename(target),
    bytes: zip.length,
    counts: summary.counts,
    lyrics: lyrics.entries.length,
    credentialsRemoved: scrubbed,
  };
}

// ---------------------------------------------------------------- 最小 zip 读取（只取需要的条目）

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xFFFF);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 解出 zip 里所有条目（我们自己写的包用 deflateRaw / store，够用）。 */
export function unzipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw httpError(400, "这不是一个有效的 zip 文件", "ZIP_INVALID");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      try { out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw)); }
      catch { /* 单个条目坏了就跳过 */ }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!out.size) throw httpError(400, "zip 里没有可用的文件", "ZIP_EMPTY");
  return out;
}

/**
 * 从导出包导入：取出库 → 校验 → 落成待恢复。换电脑时就是"导入 + 重启"。
 * 导入前同样会把当前库留档（走同一条 applyPendingRestore）。
 */
export async function importUserData({ databasePath, file, name } = {}) {
  const info = await stat(file).catch(() => null);
  if (!info) throw httpError(404, "找不到这个文件", "IMPORT_FILE_MISSING");
  if (info.size > MAX_IMPORT_BYTES) throw httpError(413, "文件太大，不像是导出包", "IMPORT_TOO_LARGE");
  const buffer = await readFile(file);
  const entries = unzipEntries(buffer);
  const entry = entries.get("database/olivia-local.sqlite");
  if (!entry) throw httpError(400, "这个 zip 里没有 database/olivia-local.sqlite，可能不是本程序导出的包", "IMPORT_LAYOUT_INVALID");

  const staging = join(backupDirOf(databasePath), `import-${stamp()}.sqlite`);
  await mkdir(backupDirOf(databasePath), { recursive: true });
  await writeFile(staging, entry);
  let manifest = null;
  try { manifest = JSON.parse(entries.get("manifest.json")?.toString("utf8") ?? "null"); } catch { manifest = null; }

  const arranged = await arrangeRestore(databasePath, staging, {
    source: "import",
    label: manifest?.exportedAt ? `导出包（${manifest.exportedAt}）` : "导入的导出包",
  });
  return { ...arranged, name: String(name || basename(file)), manifest };
}

// ---------------------------------------------------------------- 路由

export async function createDataSafetyRoutes({ databasePath } = {}) {
  const log = (message) => { try { console.log(String(message)); } catch { /* 忽略 */ } };
  const dbPath = () => {
    const value = String(databasePath ?? "").trim();
    if (!value) throw httpError(500, "服务没有配置数据库路径", "DATABASE_PATH_MISSING");
    return value;
  };
  /** 只接受备份目录里的 .sqlite，避免被拿来读任意文件。 */
  const backupPath = (name) => {
    const clean = basename(String(name ?? "").trim());
    if (!clean || !clean.endsWith(".sqlite")) throw httpError(400, "备份文件名无效", "BACKUP_NAME_INVALID");
    return join(backupDirOf(dbPath()), clean);
  };

  return async function handleDataSafetyRoute(req, url) {
    const path = String(url?.pathname ?? "").replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (!path.startsWith("/listen-naming/data/")) return null;

    if (req.method === "GET" && path === "/listen-naming/data/status")
      return await listBackups(dbPath());

    if (req.method === "POST" && path === "/listen-naming/data/backup")
      return await manualBackup(dbPath());

    if (req.method === "GET" && path === "/listen-naming/data/inspect")
      return await inspectBackup(backupPath(url.searchParams.get("file")));

    if (req.method === "POST" && path === "/listen-naming/data/restore") {
      const body = await readJsonBody(req);
      const file = backupPath(body.file);
      if (body.confirm !== true) throw httpError(400, "请先确认要恢复这一个备份", "RESTORE_NOT_CONFIRMED");
      return await arrangeRestore(dbPath(), file, { source: "restore", label: "备份恢复" });
    }

    if (req.method === "POST" && path === "/listen-naming/data/cancel-restore")
      return await cancelRestore(dbPath());

    if (req.method === "POST" && path === "/listen-naming/data/reveal") {
      const dir = backupDirOf(dbPath());
      await mkdir(dir, { recursive: true });
      try { spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref(); }
      catch (error) { log(`[data-safety] 打开备份目录失败：${error.message}`); }
      return { opened: dir };
    }

    if (req.method === "POST" && path === "/listen-naming/data/export")
      return await exportUserData({ databasePath: dbPath(), version: url.searchParams.get("version") ?? "" });

    if (req.method === "POST" && path === "/listen-naming/data/import") {
      const contentType = String(req.headers?.["content-type"] ?? "");
      if (contentType.includes("application/octet-stream")) {
        // 前端选文件时浏览器只给内容、不给真实路径，所以这里直接收字节落成暂存包
        const name = String(url.searchParams.get("name") ?? "export.zip");
        if (!/\.zip$/iu.test(name)) throw httpError(400, "请选择导出包（.zip 文件）", "IMPORT_NAME_INVALID");
        const buffer = await readRawBody(req, MAX_IMPORT_BYTES);
        await mkdir(backupDirOf(dbPath()), { recursive: true });
        const staged = join(backupDirOf(dbPath()), `upload-${stamp()}.zip`);
        await writeFile(staged, buffer);
        return await importUserData({ databasePath: dbPath(), file: staged, name });
      }
      const body = await readJsonBody(req);
      const file = String(body.file ?? "").trim();
      if (!file) throw httpError(400, "请选择要导入的 zip", "IMPORT_FILE_REQUIRED");
      if (body.confirm !== true) throw httpError(400, "请先确认要导入", "IMPORT_NOT_CONFIRMED");
      return await importUserData({ databasePath: dbPath(), file });
    }

    return null;
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1 * MB) throw httpError(413, "请求体过大", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; }
  catch { throw httpError(400, "请求内容不是合法 JSON", "BODY_INVALID"); }
}

/** 收原始字节（前端上传导出包用；浏览器不给真实路径，只能这样）。 */
async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "文件太大，不像是导出包", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!size) throw httpError(400, "没有收到文件内容", "BODY_EMPTY");
  return Buffer.concat(chunks);
}
