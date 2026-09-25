// 「社区曲目名单」后端模块（OliviaSoul 内嵌功能）
//
// 解决什么问题：OliviaSoul 曲库里的社区作品代号是 midi_<编号>_<上传时间戳>，服务器没保存过曲名，
// 所以每个用户的曲库里都是几百上千首"无名歌"。本模块做三件事：
//   1. 从社区仓库拉「音乐指纹 → 曲名」名单（data/catalog.json），本地缓存，断网也能用；
//   2. 对本机曲库算音乐指纹，和社区名单做**多段校验**（至少 2 段 ≥ 0.90 且没有一段 < 0.70）后自动命名；
//   3. 把本机已有的曲名 + 指纹汇总成投稿文件，放进本地上传队列，等用户自己点提交（绝不自动上传）。
//
// 设计约定（与同目录 listen-naming.js / time-of-day.js 一致）：
//   * ESM；路由是 async 工厂返回的 (req, url) => Promise<object|null>，返回 null 表示"不是我的路由"。
//   * 指纹算法与前端、与 tools/fingerprint.js 共用同一份实现（./fingerprint.js），避免两份算法漂移。
//   * 不写死任何本机盘符 / 用户名：数据目录由宿主固定为 <安装目录>\UserData，曲库根目录读数据库
//     settings.midi_library_root，全部可用 configure() 或环境变量覆盖。
//   * 写库完全沿用应用自己的 SQL 与 key 规则：
//       UPDATE user_songs SET custom_name=?, custom_name_key=?, corrected_name=?, corrected_name_key=?,
//                             time_of_day_mapping=?, updated_at=? WHERE id=?
//       UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1
//   * 写库前先备份数据库；**只补空值**，绝不覆盖用户已经填好的任何曲名。
//   * 投稿人名字只能来自调用参数或 OLIVIA_GITHUB_USER 环境变量，**绝不从系统用户名推断**。
//
// 本文件是"加法式"新增，不修改、不覆盖任何既有函数。

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { get as httpGetRaw } from "node:http";
import { get as httpsGetRaw } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {


  FP_ALGO, FP_VERSION, FP_SEGMENTS, FP_SIMILARITY_THRESHOLD, verifyMatch, fingerprintFolder,
} from "./fingerprint.js";

const here = dirname(fileURLToPath(import.meta.url));

// 安装版布局：<安装目录>\app\midi\community-catalog.js
// 宿主把耐久数据固定在 <安装目录>\UserData（见 native-host 与 test/runtime-bootstrap.test.js）。
const INSTALL_ROOT = resolve(here, "..", "..");
const DEFAULT_DATA_DIR = join(INSTALL_ROOT, "UserData");
const DEFAULT_DATABASE_PATH = join(DEFAULT_DATA_DIR, "database", "olivia-local.sqlite");

// ---------------------------------------------------------------- 配置

// 社区仓库地址：发布版已填好；以后换仓库只改这一行。
// 换仓库只改这一行；改完记得同步 public/listen-naming-feedback.js 与 server.js 里的同名字段。
export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/guvgr2/OliviaSoul-community/main/data/catalog.json";

export const CATALOG_VERSION = 1;
export const CATALOG_FILENAME = "community-catalog.json";
export const FINGERPRINT_CACHE_FILENAME = "fingerprints.json";
export const UPLOAD_QUEUE_FILENAME = "community-upload-queue.json";
export const SETTINGS_FILENAME = "listen-naming-settings.json";
export const BACKUP_PREFIX = "backup-community-";

// 「一键投稿」：投稿文件固定写到 <UserData>\community-outbox\，本机"已投稿"记录单独一份。
export const OUTBOX_DIRNAME = "community-outbox";
export const CONTRIBUTION_LOG_FILENAME = "community-contributions.json";
export const CONTRIBUTION_LOG_VERSION = 1;
// 提交入口：仓库固定为 guvgr2/OliviaSoul-community，走 Issue 模板；用户自己点开、自己贴内容，程序绝不自动上传。
export const CONTRIBUTION_TEMPLATE_URL = "https://github.com/guvgr2/OliviaSoul-community/issues/new?template=song_title.md";

const HTTP_TIMEOUT_MS = 30_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
// 算指纹要逐首解码音频（每首 3 段 × 60 秒），很慢：一次请求只补算一小批，剩下的由前端再叫一次。
const CONTRIBUTION_BATCH_LIMIT = 20;
const CONTRIBUTION_BUDGET_MS = 20_000;
// 生成投稿文件时给指纹留的最大时间：正常路径下预览已经把指纹算好，这里只是兜底。
const CONTRIBUTION_BUILD_BUDGET_MS = 120_000;

let USER_DATA_DIR = process.env.OLIVIA_USER_DATA || DEFAULT_DATA_DIR;
let DATABASE_PATH = process.env.OLIVIA_COMMUNITY_DB || process.env.OLIVIA_LISTEN_DB || DEFAULT_DATABASE_PATH;
let BACKUP_DIR = process.env.OLIVIA_COMMUNITY_BACKUP || join(DEFAULT_DATA_DIR, "database");
let LIBRARY_ROOT = process.env.OLIVIA_COMMUNITY_LIBRARY_ROOT || process.env.OLIVIA_LISTEN_LIBRARY_ROOT || "";
let CATALOG_URL = process.env.OLIVIA_CATALOG_URL || DEFAULT_CATALOG_URL;
let FFMPEG_PATH = process.env.OLIVIA_FFMPEG || "";

// 内存缓存：一次进程内不重复读盘 / 重复拉网
const memory = {
  catalog: null,          // { entries, updatedAt, stale, source, etag, lastModified }
  fingerprints: null,     // { version, algo, entries: { folder: {key, fp, fps, name, updatedAt} } }
  settings: null,         // listen-naming-settings.json 的内容
  contributions: null,    // community-contributions.json 的内容（本机"已投稿"记录）
  sessionBackup: "",      // 一次进程只备份一次数据库
};

/**
 * 由 server.js 注入本机路径与仓库地址；注入值优先于环境变量，缺项保持原值。
 * 注意：catalogUrl 是外部数据源，只接受 http(s)。
 */
export function configure(options = {}) {
  const pick = (value, current) => (typeof value === "string" && value.trim() ? resolve(value.trim()) : current);
  USER_DATA_DIR = pick(options.dataDir, USER_DATA_DIR);
  if (USER_DATA_DIR && !DATABASE_PATH) DATABASE_PATH = join(USER_DATA_DIR, "database", "olivia-local.sqlite");
  DATABASE_PATH = pick(options.databasePath, DATABASE_PATH);
  BACKUP_DIR = pick(options.backupDir, BACKUP_DIR || (DATABASE_PATH ? dirname(DATABASE_PATH) : ""));
  LIBRARY_ROOT = pick(options.libraryRoot, LIBRARY_ROOT);
  if (typeof options.catalogUrl === "string" && /^https?:\/\//iu.test(options.catalogUrl.trim())) {
    CATALOG_URL = options.catalogUrl.trim();
  }
  if (typeof options.ffmpegPath === "string" && options.ffmpegPath.trim()) FFMPEG_PATH = options.ffmpegPath.trim();
  return { USER_DATA_DIR, DATABASE_PATH, BACKUP_DIR, LIBRARY_ROOT, CATALOG_URL, FFMPEG_PATH };
}

export function catalogUrl() {
  return CATALOG_URL;
}

export const COMMUNITY_DEFAULTS = Object.freeze({
  catalogUrl: DEFAULT_CATALOG_URL,
  catalogFilename: CATALOG_FILENAME,
  fingerprintCacheFilename: FINGERPRINT_CACHE_FILENAME,
  uploadQueueFilename: UPLOAD_QUEUE_FILENAME,
  settingsFilename: SETTINGS_FILENAME,
  similarityThreshold: FP_SIMILARITY_THRESHOLD,
  fingerprintAlgo: FP_ALGO,
  fingerprintVersion: FP_VERSION,
  get databasePath() { return DATABASE_PATH; },
  dataDir: DEFAULT_DATA_DIR,
});

function httpError(status, message, code = "COMMUNITY_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 时间戳，用于备份文件名。 */
export function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function userDataDir(options = {}) {
  const value = String(options.dataDir ?? USER_DATA_DIR ?? "").trim();
  if (!value) {
    throw new Error("未配置数据目录：请由 server.js 传入 dataDir（安装版固定为 <安装目录>\\UserData）");
  }
  return resolve(value);
}

function databasePathOf(options = {}) {
  return resolve(String(options.databasePath ?? DATABASE_PATH ?? ""));
}

// ---------------------------------------------------------------- 数据库

export function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export function openWritable(path) {
  const db = new DatabaseSync(path);
  // 与 server.js 的 initDatabase 保持一致，保证能和正在运行的 OliviaSoul 共用同一个库。
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

/** 写库前备份数据库（SQLite 备份 API 优先，退回 copyFile）。 */
export async function backupDatabase(databasePath, target) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  try { await unlink(temporary); } catch { /* 不存在正常 */ }
  let done = false;
  try {
    const source = openReadOnly(databasePath);
    try {
      if (typeof source.backup === "function") {
        await source.backup(temporary);
        done = true;
      }
    } finally {
      source.close();
    }
  } catch {
    done = false;
  }
  if (!done) await copyFile(databasePath, temporary);
  await rename(temporary, target);
  return target;
}

// ---------------------------------------------------------------- 小工具

/** 从 video_path 里抽出 midi_<数字>_<时间戳> 文件夹名（与 listen-naming.js 的 folderFromPath 一致）。 */
export function folderFromPath(value) {
  const match = /(midi_\d+_\d+)/u.exec(String(value ?? ""));
  return match ? match[1] : "";
}

/** 去掉应用自己加的 external: 前缀。 */
export function stripExternalPrefix(value) {
  return String(value ?? "").trim().replace(/^external:/iu, "");
}

/** 从数据库 settings 里读曲库根目录。 */
export function readLibraryRootFromDatabase(databasePath) {
  try {
    const db = openReadOnly(databasePath);
    try {
      return String(db.prepare("SELECT value FROM settings WHERE key = ?").get("midi_library_root")?.value ?? "").trim();
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

/**
 * 曲名脱敏门禁（与 tools/sanitize.js 同一套规则，本文件自带一份，
 * 免得应用运行时依赖仓库里的维护者工具）。任何看起来像个人信息的曲名一律拒绝写入。
 */
const NAME_MAX_LENGTH = 80;
const FORBIDDEN_NAME_PATTERNS = [
  [/[A-Za-z]:[\\/]/u, "包含盘符绝对路径"],
  [/\\\\[^\\\s]/u, "包含 UNC 网络路径"],
  [/\bUsers\b/iu, "包含 Windows 用户目录"],
  [/\bAppData\b/iu, "包含 AppData 路径"],
  [/\bUserData\b/iu, "包含 UserData 路径"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, "包含邮箱地址"],
  [/https?:\/\//iu, "包含网址"],
  [/\b\d{7,}\b/u, "包含超长数字（UID/设备号/时间戳）"],
  [/[\u0000-\u001f\u007f]/u, "包含控制字符"],
];

export function sanitizeName(raw) {
  const text = String(raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) return { ok: false, reason: "曲名为空" };
  if ([...text].length > NAME_MAX_LENGTH) return { ok: false, reason: `曲名超过 ${NAME_MAX_LENGTH} 字` };
  for (const [pattern, reason] of FORBIDDEN_NAME_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason };
  }
  return { ok: true, name: text };
}

/** 条目校验哈希：sha256(folder + "\n" + name) 前 16 位（与 tools/sanitize.js 的 entryHash 一致）。 */
export function entryHash(folder, name) {
  return createHash("sha256").update(`${folder}\n${name}`, "utf8").digest("hex").slice(0, 16);
}

function safeJson(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

// ---------------------------------------------------------------- 本地设置（分享意愿）

function settingsPathOf(options = {}) {
  return join(userDataDir(options), String(options.settingsFilename ?? SETTINGS_FILENAME));
}

/** 读 listen-naming-settings.json（读不到就当空配置，不抛错）。 */
export async function readSettings(options = {}) {
  if (memory.settings && !options.force) return memory.settings;
  const path = settingsPathOf(options);
  let value = {};
  try {
    const parsed = safeJson(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
  } catch { value = {}; }
  memory.settings = value;
  return value;
}

/** 写 listen-naming-settings.json（合并写，不丢别的键）。 */
export async function writeSettings(patch, options = {}) {
  const path = settingsPathOf(options);
  const current = await readSettings({ ...options, force: true });
  const next = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  memory.settings = next;
  return next;
}

/** 当前分享意愿：默认 false（默认什么都不上传）。 */
export async function shareConsent(options = {}) {
  const settings = await readSettings(options);
  return settings.shareNames === true;
}

// ---------------------------------------------------------------- 拉取社区名单

/** 极简 HTTP GET（只认 http/https，带超时与体积上限；支持 304 与一次重定向）。 */
function httpGet(url, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      rejectPromise(new Error("社区名单地址无效"));
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      rejectPromise(new Error("社区名单地址必须是 http(s)"));
      return;
    }
    const transport = parsed.protocol === "https:" ? httpsGetRaw : httpGetRaw;
    const request = transport(parsed, {
      headers: { "User-Agent": "OliviaSoul-CommunityKit", Accept: "application/json", ...headers },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status === 304) { response.resume(); resolvePromise({ status, body: "", headers: response.headers }); return; }
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolvePromise(httpGet(new URL(response.headers.location, parsed).toString(), headers));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_CATALOG_BYTES) { request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolvePromise({ status, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
      response.on("error", rejectPromise);
    });
    request.setTimeout(HTTP_TIMEOUT_MS, () => request.destroy(new Error("拉取社区名单超时")));
    request.on("error", rejectPromise);
  });
}

/**
 * 把任意形状的 catalog.json 规范化成 { entries: { folder: {name, fps, hash} }, updatedAt }。
 * 只收合法条目：编号必须像 midi_数字_数字，且至少带 2 段指纹（多段校验至少要比 2 段）。
 */
export function normalizeCatalog(document) {
  const entries = {};
  const source = document && typeof document === "object" ? document.entries : null;
  let rejected = 0;
  if (!source || typeof source !== "object") return { entries, updatedAt: "", rejected };
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const folder = String(rawKey ?? "").trim();
    if (!/^midi_\d+_\d+$/u.test(folder)) { rejected += 1; continue; }
    const record = typeof rawValue === "string" ? { name: rawValue } : (rawValue ?? {});
    const name = String(record.name ?? "").trim();
    if (!name) { rejected += 1; continue; }
    // 多段校验至少要比 2 段：只有 1 段指纹的条目一律不收（宁可不用，也不许填错）
    const fps = (Array.isArray(record.fps) ? record.fps : []).map(value => String(value ?? "")).filter(Boolean);
    if (fps.length < 2) { rejected += 1; continue; }
    entries[folder] = {
      name,
      fps,
      hash: String(record.hash ?? "").trim() || entryHash(folder, name),
    };
  }
  return {
    entries,
    updatedAt: String(document?.updatedAt ?? "").trim(),
    rejected,
  };
}

function catalogCachePath(options = {}) {
  return join(userDataDir(options), String(options.catalogFilename ?? CATALOG_FILENAME));
}

/**
 * 拉取社区曲目名单。
 *   * 带 If-None-Match / If-Modified-Since，缓存到 <UserData>\community-catalog.json
 *   * 网络失败时用缓存并标注 stale:true，**不抛错**阻塞其它功能
 *   * 返回 { entries, updatedAt, stale, source, count }
 *
 * @param {object} [options]
 * @param {boolean} [options.force] 忽略内存缓存，真的去拉一次
 */
export async function fetchCatalog(options = {}) {
  const cachePath = catalogCachePath(options);
  const url = String(options.catalogUrl ?? CATALOG_URL);
  const fresh = options.force !== true;

  // 读盘上的缓存（含 HTTP 校验头）
  let cache = null;
  try {
    const parsed = safeJson(await readFile(cachePath, "utf8"));
    if (parsed && typeof parsed === "object") cache = parsed;
  } catch { cache = null; }

  const cachedEntries = cache?.entries && typeof cache.entries === "object" ? cache.entries : null;

  // 命中内存缓存且不是强制刷新：直接用
  if (memory.catalog && !options.force && memory.catalog.source === url) return { ...memory.catalog };
  // 非强制模式下，盘上有缓存就先用缓存（避免每次请求都打网）
  if (fresh && cachedEntries && Object.keys(cachedEntries).length) {
    const result = {
      entries: cachedEntries,
      updatedAt: String(cache.updatedAt ?? ""),
      stale: true,
      source: url,
      count: Object.keys(cachedEntries).length,
    };
    memory.catalog = result;
    return { ...result };
  }

  const headers = {};
  if (cache?.etag) headers["If-None-Match"] = String(cache.etag);
  if (cache?.lastModified) headers["If-Modified-Since"] = String(cache.lastModified);

  let response = null;
  let failure = "";
  try {
    response = await httpGet(url, headers);
  } catch (error) {
    failure = error?.message ?? String(error);
  }

  if (response && response.status === 304 && cachedEntries) {
    const result = {
      entries: cachedEntries,
      updatedAt: String(cache.updatedAt ?? ""),
      stale: false,
      source: url,
      count: Object.keys(cachedEntries).length,
      notModified: true,
    };
    memory.catalog = result;
    return { ...result };
  }

  if (response && response.status >= 200 && response.status < 300) {
    const parsed = safeJson(response.body);
    if (parsed) {
      const normalized = normalizeCatalog(parsed);
      const document = {
        version: Number(parsed.version ?? CATALOG_VERSION) || CATALOG_VERSION,
        updatedAt: normalized.updatedAt || new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        source: url,
        algo: parsed.fingerprint?.algo ?? FP_ALGO,
        algoVersion: Number(parsed.fingerprint?.version ?? FP_VERSION) || FP_VERSION,
        threshold: Number(parsed.fingerprint?.threshold ?? FP_SIMILARITY_THRESHOLD) || FP_SIMILARITY_THRESHOLD,
        entries: normalized.entries,
        etag: response.headers?.etag ?? "",
        lastModified: response.headers?.["last-modified"] ?? "",
      };
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      const result = {
        entries: document.entries,
        updatedAt: document.updatedAt,
        stale: false,
        source: url,
        count: Object.keys(document.entries).length,
        rejected: normalized.rejected,
      };
      memory.catalog = result;
      return { ...result };
    }
    failure = "社区名单不是合法 JSON";
  } else if (response) {
    failure = `拉取社区名单失败：HTTP ${response.status}`;
  }
  if (!failure) failure = "拉取社区名单失败";

  // 失败：用缓存兜底，明确标注 stale
  if (cachedEntries) {
    const result = {
      entries: cachedEntries,
      updatedAt: String(cache.updatedAt ?? ""),
      stale: true,
      source: url,
      count: Object.keys(cachedEntries).length,
      error: failure,
    };
    memory.catalog = result;
    return { ...result };
  }
  // 连缓存都没有：返回空名单 + stale，不抛错
  const result = { entries: {}, updatedAt: "", stale: true, source: url, count: 0, error: failure };
  memory.catalog = result;
  return { ...result };
}

// ---------------------------------------------------------------- 指纹缓存

function fingerprintCachePath(options = {}) {
  return join(userDataDir(options), String(options.fingerprintFilename ?? FINGERPRINT_CACHE_FILENAME));
}

/**
 * 把文件夹 + 文件大小 + mtime 合成缓存键：文件换了（换歌 / 重录）就得重新算指纹。
 * 因为 fingerprint.js 自己挑"文件名排序第一个 mp4"，这里也按同样规则取那一个来算键。
 */
export async function folderSignature(folder) {
  try {
    const entries = (await readdir(folder)).filter(name => name.toLowerCase().endsWith(".mp4")).sort();
    if (!entries.length) return "";
    const info = await stat(join(folder, entries[0]));
    return `${entries[0]}:${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return "";
  }
}

/** 读本机指纹缓存 <UserData>\fingerprints.json。 */
export async function loadFingerprintCache(options = {}) {
  if (memory.fingerprints) return memory.fingerprints;
  let cache = { version: 1, algo: FP_ALGO, algoVersion: FP_VERSION, entries: {} };
  try {
    const parsed = safeJson(await readFile(fingerprintCachePath(options), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      // 算法版本变了就整体作废，避免拿旧指纹做判断
      if (Number(parsed.algoVersion ?? 0) === FP_VERSION && String(parsed.algo ?? FP_ALGO) === FP_ALGO) cache = parsed;
    }
  } catch { /* 没有缓存正常 */ }
  memory.fingerprints = cache;
  return cache;
}

export async function saveFingerprintCache(cache, options = {}) {
  const path = fingerprintCachePath(options);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  memory.fingerprints = cache;
  return path;
}

/**
 * 取某个文件夹的指纹：优先用缓存，缓存里没有（或文件变了）才算。
 * @returns {Promise<{fps:string[], fp:string, fromCache:boolean}|null>} null = 算不出来
 */
export async function fingerprintFolderCached(folder, context) {
  const cache = context.cache;
  const signature = await folderSignature(folder);
  if (!signature) return null;
  const hit = cache.entries[folder];
  if (hit && hit.signature === signature && Array.isArray(hit.fps) && hit.fps.length >= 2) {
    return { fps: hit.fps, fp: hit.fps[0], fromCache: true };
  }
  const result = await fingerprintFolder(folder);
  if (!result || !result.fps?.length) return null;
  cache.entries[folder] = {
    signature,
    fps: result.fps,
    segments: result.segments,
    updatedAt: nowSeconds(),
  };
  return { fps: result.fps, fp: result.fps[0], fromCache: false };
}

// ---------------------------------------------------------------- 自动命名

/** 读"还没有曲名"的行（以及全部行，用来统计）。 */
export function readLocalRows(databasePath) {
  const db = openReadOnly(databasePath);
  try {
    return db.prepare(
      "SELECT id, video_path, custom_name, corrected_name, time_of_day_mapping FROM user_songs "
      + "WHERE removed_at IS NULL ORDER BY updated_at DESC, id",
    ).all();
  } finally {
    db.close();
  }
}

/** 写曲名：只补 emptyWhere 命中的行，绝不覆盖已有曲名。 */
function writeNames(databasePath, plan, { allowExisting = false } = {}) {
  const updatedAt = nowSeconds();
  const db = openWritable(databasePath);
  const written = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    const read = db.prepare(
      "SELECT id, custom_name, corrected_name, corrected_name_key, time_of_day_mapping FROM user_songs WHERE id = ?",
    );
    const update = db.prepare(
      "UPDATE user_songs SET custom_name=?, custom_name_key=?, corrected_name=?, "
      + "corrected_name_key=?, time_of_day_mapping=?, updated_at=? WHERE id=?",
    );
    for (const item of plan) {
      for (const songId of item.songIds) {
        const row = read.get(songId);
        if (!row) continue;
        const existing = String(row.custom_name ?? "").trim();
        if (existing && !allowExisting) continue;
        const nameKey = item.name.normalize("NFKC").toLocaleLowerCase();
        update.run(
          item.name,
          nameKey,
          row.corrected_name ?? null,
          row.corrected_name_key ?? null,
          row.time_of_day_mapping ?? null,
          updatedAt,
          songId,
        );
        written.push({ songId, folder: item.folder, name: item.name });
      }
    }
    if (written.length) {
      // 等价于 store.js 里的 #bumpLibraryRevision()
      db.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 已经回滚或事务未开始 */ }
    throw error;
  } finally {
    db.close();
  }
  return written;
}

/**
 * 按社区名单自动给本机"还没曲名"的歌填名。
 *
 * 命中条件（绝不放宽）：verifyMatch(本机.fps, 社区.fps).ok
 *   = 至少 2 段相似度 ≥ 0.90，且没有任何一段低于 0.70。
 *
 * @param {object} [options]
 * @param {number} [options.limit]   这一批最多处理几首（分批跑用）
 * @param {number} [options.offset]  从第几首开始
 * @param {string} [options.libraryRoot]
 * @param {boolean} [options.dryRun] true = 只算不写（不备份数据库）
 * @param {Function} [options.onProgress] 每处理一首回调一次 ({done, total, folder, matched})
 * @returns {Promise<{checked, matched, applied, skippedExisting, stale, total, offset, limit, hasMore, backupFile, details, errors}>}
 */
export async function autoNameLocal(options = {}) {
  const databasePath = databasePathOf(options);
  if (!existsSync(databasePath)) throw new Error(`未找到 OliviaSoul 数据库：${databasePath}`);
  let libraryRoot = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRoot) libraryRoot = readLibraryRootFromDatabase(databasePath);
  if (!libraryRoot) throw new Error("未配置曲库目录：请在 OliviaSoul 里设置曲目存储路径，或由 server.js 传入 libraryRoot");
  libraryRoot = resolve(libraryRoot);

  const catalog = await fetchCatalog(options);
  const entries = catalog.entries ?? {};
  const catalogFolders = Object.keys(entries);

  const rows = readLocalRows(databasePath);
  // 只处理"还没有曲名"的行
  const unnamed = rows.filter(row => !String(row.custom_name ?? "").trim());
  const skippedExisting = rows.length - unnamed.length;

  // 同一首歌可能有多行（每个视频一行）：按文件夹合并
  const groups = new Map();
  for (const row of unnamed) {
    const folder = folderFromPath(row.video_path);
    if (!folder) continue;
    if (!groups.has(folder)) groups.set(folder, { folder, songIds: [], videoPath: stripExternalPrefix(row.video_path) });
    groups.get(folder).songIds.push(String(row.id));
  }
  const folders = [...groups.values()]
    .sort((left, right) => left.folder.localeCompare(right.folder, "en"));

  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.trunc(Number(options.limit)) : 0;
  const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) > 0 ? Math.trunc(Number(options.offset)) : 0;
  const page = limit ? folders.slice(offset, offset + limit) : folders.slice(offset);
  const errors = [];
  const details = [];
  const nearest = [];
  const plan = [];
  const cache = await loadFingerprintCache(options);
  let cacheDirty = false;
  let checked = 0;

  for (const group of page) {
    checked += 1;
    const absolute = join(libraryRoot, group.folder);
    if (!existsSync(absolute)) {
      errors.push({ folder: group.folder, reason: "曲库里找不到这个文件夹" });
      options.onProgress?.({ done: checked, total: page.length, folder: group.folder, matched: false });
      continue;
    }
    let local = null;
    try {
      local = await fingerprintFolderCached(absolute, { cache, options });
    } catch (error) {
      errors.push({ folder: group.folder, reason: `算指纹失败：${error?.message ?? error}` });
    }
    if (local && !local.fromCache) cacheDirty = true;
    if (!local) {
      if (!errors.some(item => item.folder === group.folder)) errors.push({ folder: group.folder, reason: "取不到音频，算不出指纹" });
      options.onProgress?.({ done: checked, total: page.length, folder: group.folder, matched: false });
      continue;
    }
    // 和社区条目逐个做多段校验（entries 就是 { folder: {name, fps} }）
    let matched = null;
    let bestWorst = -1;
    let hit = false;
    for (const folder of catalogFolders) {
      const entry = entries[folder];
      if (!Array.isArray(entry?.fps) || entry.fps.length < 2) continue;
      const verdict = verifyMatch(local.fps, entry.fps);
      if (verdict.worst > bestWorst) bestWorst = verdict.worst;
      if (!verdict.ok) continue;
      matched = { folder, entry, verdict };
      break;
    }
    if (matched) {
      const cleaned = sanitizeName(matched.entry.name);
      if (!cleaned.ok) {
        errors.push({ folder: group.folder, reason: `社区条目的曲名没通过脱敏检查（${cleaned.reason}）` });
      } else {
        details.push({
          folder: group.folder,
          name: cleaned.name,
          scores: matched.verdict.scores,
          worst: matched.verdict.worst,
          matchedFolder: matched.folder,
          songIds: group.songIds,
        });
        plan.push({ folder: group.folder, name: cleaned.name, songIds: group.songIds });
        hit = true;
      }
    } else if (catalogFolders.length) {
      // 没命中不是错误，但把最接近的一段分数记下来，方便排查"为什么没认出来"
      if (bestWorst >= 0) nearest.push({ folder: group.folder, bestWorst: Math.round(bestWorst * 1000) / 1000 });
    }
    options.onProgress?.({ done: checked, total: page.length, folder: group.folder, matched: hit });
  }

  if (cacheDirty) await saveFingerprintCache(cache, options);

  let backupFile = "";
  let applied = 0;
  if (plan.length && options.dryRun !== true) {
    // 写库前先备份一次（一次进程一次）
    if (!memory.sessionBackup) {
      const backupDir = resolve(String(options.backupDir ?? BACKUP_DIR ?? dirname(databasePath)));
      memory.sessionBackup = await backupDatabase(databasePath, join(backupDir, `${BACKUP_PREFIX}${stamp()}.sqlite`));
    }
    backupFile = memory.sessionBackup;
    applied = writeNames(databasePath, plan).length;
  }

  return {
    checked,
    matched: plan.length,
    applied,
    skippedExisting,
    skippedNoFingerprint: errors.length,
    stale: catalog.stale === true,
    catalogCount: catalog.count ?? catalogFolders.length,
    catalogUpdatedAt: catalog.updatedAt ?? "",
    total: folders.length,
    offset,
    limit,
    hasMore: limit ? offset + limit < folders.length : false,
    nextOffset: limit && offset + limit < folders.length ? offset + limit : 0,
    libraryRoot,
    backupFile,
    dryRun: options.dryRun === true,
    details,
    nearest: nearest.slice(0, 50),
    errors,
  };
}

// ---------------------------------------------------------------- 投稿文件

/**
 * 生成投稿文件（不自动上传）：把本机**已有曲名**的歌 + 音乐指纹汇总成
 *   { version: 1, contributor, entries: { folder: { name, fps, hash } } }
 * 写到 <UserData>\community-upload-queue.json，等用户自己点提交。
 *
 * @param {object} [options]
 * @param {string} [options.contributor] GitHub 用户名；缺省读 OLIVIA_GITHUB_USER。
 *        **绝不从系统用户名推断**（隐私：本机用户名不能离开电脑）。
 * @param {number} [options.limit] 最多攒几首（0 = 全部）
 * @param {Function} [options.onProgress]
 */
export async function buildContribution(options = {}) {
  const databasePath = databasePathOf(options);
  if (!existsSync(databasePath)) throw new Error(`未找到 OliviaSoul 数据库：${databasePath}`);
  let libraryRoot = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRoot) libraryRoot = readLibraryRootFromDatabase(databasePath);
  if (!libraryRoot) throw new Error("未配置曲库目录：请在 OliviaSoul 里设置曲目存储路径，或由 server.js 传入 libraryRoot");
  libraryRoot = resolve(libraryRoot);

  const rawContributor = String(options.contributor ?? process.env.OLIVIA_GITHUB_USER ?? "").trim();
  const contributor = rawContributor.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 39);
  if (!contributor) {
    throw httpError(400, "缺少投稿人：请传 contributor 或设置 OLIVIA_GITHUB_USER 环境变量（不从系统用户名推断）", "COMMUNITY_CONTRIBUTOR_REQUIRED");
  }
  if (contributor !== rawContributor) {
    throw httpError(400, "投稿人只能填 GitHub 用户名（字母、数字、连字符）", "COMMUNITY_CONTRIBUTOR_INVALID");
  }

  const rows = readLocalRows(databasePath);
  const named = rows.filter(row => String(row.custom_name ?? "").trim());
  const groups = new Map();
  for (const row of named) {
    const folder = folderFromPath(row.video_path);
    if (!folder || groups.has(folder)) continue;
    groups.set(folder, { folder, name: String(row.custom_name).trim() });
  }

  const cache = await loadFingerprintCache(options);
  let cacheDirty = false;
  const entries = {};
  const skipped = [];
  let done = 0;
  for (const group of groups.values()) {
    done += 1;
    const cleaned = sanitizeName(group.name);
    if (!cleaned.ok) { skipped.push({ folder: group.folder, reason: `曲名没通过脱敏检查（${cleaned.reason}）` }); continue; }
    const absolute = join(libraryRoot, group.folder);
    if (!existsSync(absolute)) { skipped.push({ folder: group.folder, reason: "曲库里找不到这个文件夹" }); continue; }
    let local = null;
    try {
      local = await fingerprintFolderCached(absolute, { cache, options });
    } catch (error) {
      skipped.push({ folder: group.folder, reason: `算指纹失败：${error?.message ?? error}` });
    }
    if (local && !local.fromCache) cacheDirty = true;
    if (!local) {
      if (!skipped.some(item => item.folder === group.folder)) skipped.push({ folder: group.folder, reason: "取不到音频，算不出指纹" });
      continue;
    }
    entries[group.folder] = { name: cleaned.name, fps: local.fps, hash: entryHash(group.folder, cleaned.name) };
    options.onProgress?.({ done, total: groups.size, folder: group.folder });
  }
  if (cacheDirty) await saveFingerprintCache(cache, options);

  const document = {
    version: CATALOG_VERSION,
    contributor,
    generatedAt: new Date().toISOString(),
    algo: FP_ALGO,
    algoVersion: FP_VERSION,
    entries,
  };
  const queuePath = join(userDataDir(options), String(options.queueFilename ?? UPLOAD_QUEUE_FILENAME));
  await mkdir(dirname(queuePath), { recursive: true });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(queuePath, text, "utf8");

  return {
    queuePath,
    contributor,
    count: Object.keys(entries).length,
    bytes: Buffer.byteLength(text, "utf8"),
    namedTotal: groups.size,
    skipped,
    uploaded: false,
  };
}

// ---------------------------------------------------------------- 一键投稿

// 与上面的 buildContribution（要填 GitHub 用户名、写 community-upload-queue.json）的区别：
// 「一键投稿」按更严的隐私口径出文件 —— 文件里**只有** 文件夹编号 / 曲名 / 3 段指纹 / 校验哈希，
// 没有 contributor、没有任何路径、没有设备信息；只写本机 <UserData>\community-outbox\，绝不自动上传。

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/** 投稿文件目录 <UserData>\community-outbox。 */
export function outboxDirOf(options = {}) {
  return join(userDataDir(options), String(options.outboxDir ?? OUTBOX_DIRNAME));
}

/** 本机"已投稿"记录 <UserData>\community-contributions.json。 */
export function contributionLogPathOf(options = {}) {
  return join(userDataDir(options), String(options.contributionLogFilename ?? CONTRIBUTION_LOG_FILENAME));
}

/** 读本机"已投稿"记录（读不到就是空记录，不抛错）。 */
export async function readContributionLog(options = {}) {
  if (memory.contributions && !options.force) return memory.contributions;
  let value = { version: CONTRIBUTION_LOG_VERSION, updatedAt: "", submitted: {} };
  try {
    const parsed = safeJson(await readFile(contributionLogPathOf(options), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.submitted && typeof parsed.submitted === "object") {
      value = {
        version: CONTRIBUTION_LOG_VERSION,
        updatedAt: String(parsed.updatedAt ?? ""),
        submitted: parsed.submitted,
      };
    }
  } catch { /* 还没投过稿，正常 */ }
  memory.contributions = value;
  return value;
}

/** 把这些曲目记成"已投稿"（合并写，只加不删；记录里同样不放路径）。 */
export async function markContributionSubmitted(items, meta = {}, options = {}) {
  const path = contributionLogPathOf(options);
  const current = await readContributionLog({ ...options, force: true });
  const submitted = { ...current.submitted };
  const at = new Date().toISOString();
  for (const item of items) {
    const folder = String(item?.folder ?? "").trim();
    if (!/^midi_\d+_\d+$/u.test(folder)) continue;
    const name = String(item?.name ?? "").trim();
    submitted[folder] = {
      name,
      hash: String(item?.hash ?? "").trim() || entryHash(folder, name),
      file: String(meta.file ?? ""),
      at,
    };
  }
  const next = { version: CONTRIBUTION_LOG_VERSION, updatedAt: at, submitted };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  memory.contributions = next;
  return { path, submitted, count: Object.keys(submitted).length };
}

/** 旧版投稿文件 community-upload-queue.json 里的条目也算"已投稿"，免得重复投。 */
async function submittedFromUploadQueue(options = {}) {
  const folders = new Set();
  try {
    const parsed = safeJson(await readFile(
      join(userDataDir(options), String(options.queueFilename ?? UPLOAD_QUEUE_FILENAME)),
      "utf8",
    ));
    for (const folder of Object.keys(parsed?.entries ?? {})) folders.add(folder);
  } catch { /* 没有旧投稿文件，正常 */ }
  return folders;
}

/** 攒投稿要用的原料：本机已命名的作品、本机"已投稿"记录、指纹缓存。 */
async function contributionContext(options = {}) {
  const databasePath = databasePathOf(options);
  if (!existsSync(databasePath)) {
    throw httpError(500, `未找到 OliviaSoul 数据库：${databasePath}`, "COMMUNITY_DATABASE_MISSING");
  }
  let libraryRoot = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRoot) libraryRoot = readLibraryRootFromDatabase(databasePath);
  if (!libraryRoot) {
    throw httpError(409, "还没设置曲目存储路径：请到「基础设置」里设置后再回来投稿", "COMMUNITY_LIBRARY_MISSING");
  }
  libraryRoot = resolve(libraryRoot);

  // 同一首歌可能有多行（每个视频一行）：按文件夹合并，第一个曲名为准（与 buildContribution 一致）
  const named = new Map();
  for (const row of readLocalRows(databasePath)) {
    const name = String(row.custom_name ?? "").trim();
    if (!name) continue;
    const folder = folderFromPath(row.video_path);
    if (!folder || named.has(folder)) continue;
    named.set(folder, name);
  }

  const submitted = new Map();
  for (const folder of await submittedFromUploadQueue(options)) submitted.set(folder, { at: "", name: "" });
  const log = await readContributionLog(options);
  for (const [folder, record] of Object.entries(log.submitted ?? {})) {
    submitted.set(folder, { at: String(record?.at ?? ""), name: String(record?.name ?? "") });
  }

  return {
    databasePath,
    libraryRoot,
    named,
    submitted,
    cache: await loadFingerprintCache(options),
    outboxDir: outboxDirOf(options),
    logPath: contributionLogPathOf(options),
  };
}

/**
 * 逐个确认"这首能不能凑齐 3 段指纹"。
 * 先看本机指纹缓存（快，只比 文件名+大小+mtime），缓存没有才真的解码音频算（慢）。
 * 真的算受 limit / budgetMs 限制：这一轮算不完的记成 status:"unmeasured"，前端再叫一次接着算。
 */
async function resolveContributionFingerprints(context, options = {}) {
  const batchLimit = positiveInt(options.limit, CONTRIBUTION_BATCH_LIMIT);
  const budgetMs = positiveInt(options.budgetMs, CONTRIBUTION_BUDGET_MS);
  const compute = options.compute !== false;      // false = 只看缓存，绝不起 ffmpeg
  const startedAt = Date.now();
  const ready = [];
  const pending = [];
  let computed = 0;
  let attempted = 0;
  let cacheDirty = false;

  const folders = [...context.named.keys()].sort((left, right) => left.localeCompare(right, "en"));
  for (const folder of folders) {
    const name = String(context.named.get(folder));
    const record = context.submitted.get(folder);
    const base = { folder, name, alreadySubmitted: Boolean(record), submittedAt: record?.at ?? "" };
    const absolute = join(context.libraryRoot, folder);

    let fps = null;
    const hit = context.cache.entries?.[folder];
    if (hit && Array.isArray(hit.fps) && hit.fps.length) {
      // 缓存键含文件大小与 mtime：文件换了就重算，绝不拿旧指纹顶替
      const signature = await folderSignature(absolute);
      if (signature && hit.signature === signature) fps = hit.fps;
    }
    if (!fps) {
      // 真算很慢（每首要起 3 次 ffmpeg），所以批量与时间都封顶；算失败的也算一次，
      // 免得 ffmpeg 坏掉时一个请求把几百首都试一遍。
      if (!compute || attempted >= batchLimit || Date.now() - startedAt >= budgetMs) {
        pending.push({ ...base, fingerprintReady: false, status: "unmeasured", segments: 0, reason: "指纹还没校验（再来一次继续）" });
        continue;
      }
      attempted += 1;
      if (!existsSync(absolute)) {
        pending.push({ ...base, fingerprintReady: false, status: "unavailable", segments: 0, reason: "曲库里找不到这个文件夹" });
        continue;
      }
      let local = null;
      try {
        local = await fingerprintFolderCached(absolute, { cache: context.cache, options });
      } catch (error) {
        pending.push({ ...base, fingerprintReady: false, status: "unavailable", segments: 0, reason: `算指纹失败：${error?.message ?? error}` });
        continue;
      }
      if (local && !local.fromCache) { computed += 1; cacheDirty = true; }
      fps = local?.fps ?? null;
      if (!fps) {
        pending.push({ ...base, fingerprintReady: false, status: "unavailable", segments: 0, reason: "取不到音频，算不出指纹" });
        continue;
      }
    }

    const segments = Array.isArray(fps) ? fps.length : 0;
    if (segments < FP_SEGMENTS) {
      pending.push({ ...base, fingerprintReady: false, status: "unavailable", segments, reason: `只算到 ${segments} 段指纹（需要 ${FP_SEGMENTS} 段）` });
      continue;
    }
    const cleaned = sanitizeName(name);
    if (!cleaned.ok) {
      pending.push({ ...base, fingerprintReady: false, status: "unavailable", segments, reason: `曲名没通过脱敏检查（${cleaned.reason}）` });
      continue;
    }
    ready.push({
      ...base,
      name: cleaned.name,
      fingerprintReady: true,
      segments,
      hash: entryHash(folder, cleaned.name),
      fps: fps.slice(0, FP_SEGMENTS),
    });
  }

  if (cacheDirty) await saveFingerprintCache(context.cache, options);
  return { ready, pending, computed, attempted, cacheDirty, elapsedMs: Date.now() - startedAt };
}

/**
 * 「可以投稿的曲目」清单 = 已命名 + 能算出 3 段指纹 + 曲名通过脱敏检查。
 *
 * @param {object} [options]
 * @param {number}  [options.limit]    这一轮最多补算几首指纹（默认 20）
 * @param {number}  [options.budgetMs] 这一轮最多花多少毫秒算指纹（默认 20000）
 * @param {boolean} [options.compute]  false = 只看缓存（界面刚打开时用，不惊动 ffmpeg）
 * @returns {Promise<{items,pending,totals,unsent,remaining,computed,elapsedMs,libraryRoot,outboxDir,logFile,openUrl,fingerprint}>}
 */
export async function previewContribution(options = {}) {
  const context = await contributionContext(options);
  const resolved = await resolveContributionFingerprints(context, options);
  const submittedCount = [...context.named.keys()].filter(folder => context.submitted.has(folder)).length;
  const readySubmitted = resolved.ready.filter(item => item.alreadySubmitted).length;

  return {
    // 清单只收"可以投稿的"（已命名 + 3 段指纹 + 曲名合规）；指纹本身不放进预览，生成投稿文件时才写盘
    items: resolved.ready.map(item => ({
      folder: item.folder,
      name: item.name,
      fingerprintReady: item.fingerprintReady,
      alreadySubmitted: item.alreadySubmitted,
      submittedAt: item.submittedAt,
      segments: item.segments,
      hash: item.hash,
    })),
    pending: resolved.pending,
    totals: {
      ready: resolved.ready.length,
      pending: resolved.pending.length,
      submitted: submittedCount,
      total: context.named.size,
    },
    unsent: Math.max(0, resolved.ready.length - readySubmitted),
    remaining: resolved.pending.filter(item => item.status === "unmeasured").length,
    computed: resolved.computed,
    attempted: resolved.attempted,
    elapsedMs: resolved.elapsedMs,
    libraryRoot: context.libraryRoot,
    outboxDir: context.outboxDir,
    logFile: context.logPath,
    openUrl: CONTRIBUTION_TEMPLATE_URL,
    fingerprint: { algo: FP_ALGO, version: FP_VERSION, segments: FP_SEGMENTS },
  };
}

/**
 * 生成投稿文件（一键投稿的第二步）。
 *
 * 文件内容只有：文件夹编号 → { 曲名, 3 段指纹, 校验哈希 }；顶层只有 schema 版本与算法标识。
 * **绝不写** contributor / 路径 / 用户名 / 设备信息。写到 <UserData>\community-outbox\，
 * 并在本机记录 community-contributions.json 里标记这些曲目为"已投稿"。
 *
 * @param {object}  [options]
 * @param {boolean} [options.includeSubmitted] true = 连已投稿的一起重写一份（默认只写新的）
 * @returns {Promise<{file,fileName,count,bytes,openUrl,outboxDir,skipped,skippedSubmitted,remaining,totals,fingerprint}>}
 */
export async function buildContributionFile(options = {}) {
  const context = await contributionContext(options);
  const resolved = await resolveContributionFingerprints(context, {
    ...options,
    limit: positiveInt(options.limit, Number.MAX_SAFE_INTEGER),
    budgetMs: positiveInt(options.budgetMs, CONTRIBUTION_BUILD_BUDGET_MS),
  });
  const includeSubmitted = options.includeSubmitted === true;
  const chosen = resolved.ready.filter(item => includeSubmitted || !item.alreadySubmitted);

  const entries = {};
  for (const item of chosen) {
    entries[item.folder] = {
      name: item.name,
      fps: item.fps.slice(0, FP_SEGMENTS),
      hash: item.hash,
    };
  }
  const count = Object.keys(entries).length;
  if (!count) {
    const reason = resolved.pending.some(item => item.status === "unmeasured")
      ? "还有曲目的指纹没校验完，请再点一次「生成投稿文件」继续"
      : (resolved.ready.length
        ? "这些曲目都已经生成过投稿文件了（本地记录里已标记为已投稿）"
        : "本机还没有「已命名 + 能算出 3 段指纹」的曲目");
    throw httpError(409, `没有可投稿的内容：${reason}`, "COMMUNITY_NOTHING_TO_SUBMIT");
  }

  const document = {
    version: CATALOG_VERSION,
    algo: FP_ALGO,
    algoVersion: FP_VERSION,
    segments: FP_SEGMENTS,
    entries,
  };
  const fileName = `contribution-${stamp()}.json`;
  const file = join(context.outboxDir, fileName);
  await mkdir(context.outboxDir, { recursive: true });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(file, text, "utf8");

  // 本机记录：这些编号已经投稿（只是本地标记，用户随时可以再生成一份）
  await markContributionSubmitted(chosen, { file: fileName }, options);

  return {
    file,
    fileName,
    count,
    bytes: Buffer.byteLength(text, "utf8"),
    openUrl: CONTRIBUTION_TEMPLATE_URL,
    outboxDir: context.outboxDir,
    skipped: resolved.pending.map(item => ({ folder: item.folder, name: item.name, reason: item.reason })),
    skippedSubmitted: resolved.ready.length - chosen.length,
    remaining: resolved.pending.filter(item => item.status === "unmeasured").length,
    totals: {
      written: count,
      ready: resolved.ready.length,
      skipped: resolved.pending.length,
      submitted: chosen.filter(item => item.alreadySubmitted).length,
    },
    fingerprint: { algo: FP_ALGO, version: FP_VERSION, segments: FP_SEGMENTS },
  };
}

// ---------------------------------------------------------------- 路由

/**
 * 创建「社区曲目名单」路由处理函数。
 *
 * @param {object} options 见 configure()
 * @returns {Promise<(req, url) => Promise<object|null>>}
 */
export async function createCommunityRoutes(options = {}) {
  const databasePath = databasePathOf(options);
  if (!existsSync(databasePath)) throw new Error(`未找到 OliviaSoul 数据库：${databasePath}`);
  let libraryRoot = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRoot) libraryRoot = readLibraryRootFromDatabase(databasePath);
  libraryRoot = libraryRoot ? resolve(libraryRoot) : "";
  // 曲库目录尚未设置（新装用户就是这种状态）：绝不抛错 —— 抛错会让 /admin 界面整个 500。
  if (!libraryRoot) {
    return async function handleWithoutLibrary(req, res, url) {
    // 兼容两种调用写法：(req, res, url) 与旧的 (req, url)——只传两个参数时 res 其实是 URL。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
      const path = (typeof url === "string" ? url : (url && url.pathname) || "").replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
      if (path.startsWith("/listen-naming/community")) {
        return { needsLibrary: true, message: "还没设置曲目存储路径。请到「基础设置」里设置后，再回来使用本功能。" };
      }
      return null;
    };
  }
  const shared = { ...options, databasePath, libraryRoot };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw httpError(413, "请求体过大", "COMMUNITY_TOO_LARGE");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError(400, "请求 JSON 无效", "COMMUNITY_JSON_INVALID");
    }
  }

  async function handleStatus(req, res, url) {
    void req; void res;
    const catalog = await fetchCatalog(shared);
    const rows = readLocalRows(databasePath);
    const unnamed = rows.filter(row => !String(row.custom_name ?? "").trim()).length;
    let fingerprinted = 0;
    try {
      const cache = await loadFingerprintCache(shared);
      fingerprinted = Object.keys(cache.entries ?? {}).length;
    } catch { fingerprinted = 0; }
    return {
      catalog: {
        count: catalog.count ?? Object.keys(catalog.entries ?? {}).length,
        updatedAt: catalog.updatedAt ?? "",
        stale: catalog.stale === true,
        source: catalog.source ?? String(options.catalogUrl ?? CATALOG_URL),
        error: catalog.error ?? null,
      },
      local: {
        unnamed,
        named: rows.length - unnamed,
        fingerprinted,
        libraryRoot,
      },
      consent: await shareConsent(shared),
      settingsPath: settingsPathOf(shared),
      queuePath: join(userDataDir(shared), String(options.queueFilename ?? UPLOAD_QUEUE_FILENAME)),
      catalogUrl: String(options.catalogUrl ?? CATALOG_URL),
      ffmpeg: FFMPEG_PATH || null,
      offsetHint: url?.searchParams?.get("offset") ?? null,
    };
  }

  async function handleRefresh() {
    const catalog = await fetchCatalog({ ...shared, force: true });
    return {
      count: catalog.count ?? Object.keys(catalog.entries ?? {}).length,
      updatedAt: catalog.updatedAt ?? "",
      stale: catalog.stale === true,
      source: catalog.source ?? "",
      error: catalog.error ?? null,
    };
  }

  async function handleAutoName(req) {
    const body = req.method === "POST" ? await readJson(req) : {};
    const limit = Number(body.limit ?? 0);
    const offset = Number(body.offset ?? 0);
    return await autoNameLocal({
      ...shared,
      limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0,
      offset: Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0,
      dryRun: body.dryRun === true,
      onProgress: typeof body.onProgress === "function" ? body.onProgress : undefined,
    });
  }

  async function handleBuildContribution(req) {
    const body = req.method === "POST" ? await readJson(req) : {};
    return await buildContribution({ ...shared, contributor: body.contributor });
  }

  /** GET /listen-naming/community/contribution/preview?limit=&budgetMs=&cacheOnly=1 */
  async function handleContributionPreview(req, res, url) {
    void req; void res;
    const params = url?.searchParams ?? new URLSearchParams();
    return await previewContribution({
      ...shared,
      limit: params.get("limit") ?? 0,
      budgetMs: params.get("budgetMs") ?? 0,
      compute: params.get("cacheOnly") === "1" ? false : true,
    });
  }

  /** POST /listen-naming/community/contribution/build { includeSubmitted?, limit?, budgetMs? } */
  async function handleContributionBuild(req) {
    const body = req.method === "POST" ? await readJson(req) : {};
    return await buildContributionFile({
      ...shared,
      includeSubmitted: body.includeSubmitted === true,
      limit: body.limit ?? 0,
      budgetMs: body.budgetMs ?? 0,
    });
  }

  async function handleConsent(req) {
    const body = req.method === "POST" ? await readJson(req) : {};
    if (typeof body.share !== "boolean") throw httpError(400, "share 必须是 true 或 false", "COMMUNITY_CONSENT_INVALID");
    const settings = await writeSettings({ shareNames: body.share, consentAt: new Date().toISOString() }, shared);
    return { share: settings.shareNames === true, settingsPath: settingsPathOf(shared) };
  }

  /** 路由入口。返回 null = 不是本模块的请求。 */
  return async function handleCommunityRoute(req, res, url) {
    // server.js 历史上有两种调用写法：(req, res, url) 与 (req, url)。
    // 只传两个参数时 res 其实是 URL 对象——必须认出来，否则路径变空串，所有接口都会 404「接口不存在」。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
    const rawPath = (typeof url === "string" ? url : (url && url.pathname) || "");
    const path = rawPath.replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (!path.startsWith("/listen-naming/community/")) return null;
    if (req.method === "GET" && path === "/listen-naming/community/status") return await handleStatus(req, res, url);
    if (req.method === "POST" && path === "/listen-naming/community/refresh") return await handleRefresh();
    if (req.method === "POST" && path === "/listen-naming/community/auto-name") return await handleAutoName(req);
    if (req.method === "POST" && path === "/listen-naming/community/build-contribution") return await handleBuildContribution(req);
    if (req.method === "GET" && path === "/listen-naming/community/contribution/preview") return await handleContributionPreview(req, res, url);
    if (req.method === "POST" && path === "/listen-naming/community/contribution/build") return await handleContributionBuild(req);
    if (req.method === "POST" && path === "/listen-naming/community/consent") return await handleConsent(req);
    if (req.method === "GET" && path === "/listen-naming/community/consent") {
      return { share: await shareConsent(shared), settingsPath: settingsPathOf(shared) };
    }
    // 不是本模块的接口 → 交回给后面的挂载点（不要抛 404 截胡）。
    return null;
  };
}
