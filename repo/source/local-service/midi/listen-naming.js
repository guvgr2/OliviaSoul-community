// 「试听起名」后端模块（OliviaSoul 内嵌功能）
//
// 设计约定（与仓库既有代码保持一致）：
//   * 模块风格：ESM（package.json 里 "type": "module"），同目录其他 midi/*.js 一致。
//   * 路由风格：导出一个 async (req, url) => data | null 的处理函数；
//     返回 null 表示"不是我的路由"，交给 server.js 继续往下走。
//     JSON 结果由 server.js 用 ok() 包一层 { code, message, data }。
//     音频响应自己直接写 res，返回带 mediaResponse:true 的对象让 server.js 跳过包信封。
//   * 进程调用：复用仓库自带的 ./process-runner.js（和 media-probe.js 一样）。
//   * ffmpeg 定位：优先用应用自带的 runtime/ffmpeg/bin/ffmpeg.exe
//     （transcription.js 里 TranscriptionEngine.ffmpegPath 就是这么取的），
//     找不到再退回系统 PATH 里的 ffmpeg。
//   * 写曲名：完全沿用应用自己的 SQL 与 key 规则
//     custom_name_key = name.normalize("NFKC").toLocaleLowerCase()
//     写完 #bumpLibraryRevision() 的等价语句：
//       UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1
//
// 本文件是"加法式"新增，不修改、不覆盖任何既有函数。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runProcess } from "./process-runner.js";
import { logInfo, logWarn } from "./logs.js";

function routePathOf(url) {
  // 调用方可能传 URL 对象，也可能直接传字符串路径；两种都要能处理，否则会抛
  // "Cannot read properties of undefined (reading 'pathname')"。
  if (typeof url === "string") return url;
  if (url && typeof url.pathname === "string") return url.pathname;
  return "";
}


const here = dirname(fileURLToPath(import.meta.url));

// 安装版布局：<安装目录>\\app\\midi\\listen-naming.js
// 宿主把耐久数据固定在 <安装目录>\\UserData（见 native-host 与 test/runtime-bootstrap.test.js），
// 所以这里从模块自身位置向上两级推导即可，无需写死盘符。
const INSTALL_ROOT = resolve(here, "..", "..");
const DEFAULT_DATA_DIR = join(INSTALL_ROOT, "UserData");
const DEFAULT_DATABASE_PATH = join(DEFAULT_DATA_DIR, "database", "olivia-local.sqlite");
const DEFAULT_CLIPS_DIR = join(DEFAULT_DATA_DIR, "listen-clips");

// ---------------------------------------------------------------- 路径常量

// 应用数据目录（安装版固定在这个位置；可用环境变量覆盖，方便测试）
// ------------------------------------------------ 路径解析（发布版：不写死任何本机路径）
// 约定：数据目录由宿主固定为 <安装目录>\\UserData（见 native-host 与 test/runtime-bootstrap.test.js），
// 曲库根目录存在应用数据库的 settings.midi_library_root。
// 因此本模块一律不写具体盘符，改由 server.js 通过 configure() 注入，环境变量供测试覆盖。
let USER_DATA_DIR = process.env.OLIVIA_USER_DATA || "";
let DATABASE_PATH = process.env.OLIVIA_LISTEN_DB || DEFAULT_DATABASE_PATH;
let BACKUP_DIR = process.env.OLIVIA_LISTEN_BACKUP || join(DEFAULT_DATA_DIR, "database");
let CLIPS_DIR = process.env.OLIVIA_LISTEN_CLIPS || DEFAULT_CLIPS_DIR;
let LIBRARY_ROOT = process.env.OLIVIA_LISTEN_LIBRARY_ROOT || "";
let FEATURE_CSV = process.env.OLIVIA_LISTEN_FEATURE_CSV || "";
let GROUP_CSV = process.env.OLIVIA_LISTEN_GROUP_CSV || "";
let LOG_CSV = process.env.OLIVIA_LISTEN_LOG_CSV || "";

/** 由 server.js 注入本机路径；注入值优先于环境变量，缺项保持原值。 */
export function configure(options = {}) {
  const pick = (value, current) => (typeof value === "string" && value.trim() ? resolve(value.trim()) : current);
  USER_DATA_DIR = pick(options.dataDir, USER_DATA_DIR);
  if (USER_DATA_DIR && !DATABASE_PATH) DATABASE_PATH = join(USER_DATA_DIR, "database", "olivia-local.sqlite");
  DATABASE_PATH = pick(options.databasePath, DATABASE_PATH);
  BACKUP_DIR = pick(options.backupDir, BACKUP_DIR || (DATABASE_PATH ? dirname(DATABASE_PATH) : ""));
  CLIPS_DIR = pick(options.clipsDir, CLIPS_DIR || (USER_DATA_DIR ? join(USER_DATA_DIR, "listen-clips") : ""));
  LIBRARY_ROOT = pick(options.libraryRoot, LIBRARY_ROOT);
  FEATURE_CSV = pick(options.featureCsv, FEATURE_CSV);
  GROUP_CSV = pick(options.groupCsv, GROUP_CSV);
  LOG_CSV = pick(options.logCsv, LOG_CSV);
  return { USER_DATA_DIR, DATABASE_PATH, BACKUP_DIR, CLIPS_DIR, LIBRARY_ROOT, FEATURE_CSV, GROUP_CSV, LOG_CSV };
}

/** 需要路径时统一在这里报错，导入模块本身不抛错。 */
function requirePath(value, what, hint) {
  if (!value) throw new Error(`未配置${what}：${hint}`);
  return value;
}

// 应用自带的 ffmpeg（安装版的 runtime 目录在安装根目录下）。
// 这里两个候选都试：<app>/runtime/... 和 <app>/../runtime/...，哪个存在用哪个。
const BUNDLED_FFMPEG_CANDIDATES = [
  join(here, "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
  join(here, "..", "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
];

const FOLDER_PATTERN = /^midi_\d+_\d+$/u;
// 切片缓存上限（默认 500 MB，可用 OLIVIA_CLIP_CACHE_MB 覆盖；0 表示不清理）
const CLIP_CACHE_MAX_BYTES = Math.max(0, Number(process.env.OLIVIA_CLIP_CACHE_MB ?? 500) || 0) * 1024 * 1024;
// 一次预取最多同时生成几个片段，避免用户机器被 ffmpeg 占满
const CLIP_WARM_CONCURRENCY = 1;

const SEGMENT_SECONDS = 15;
const SEGMENT_START = 20;
const MAX_SEGMENTS = 6;
const CLIP_TIMEOUT_MS = 120_000;
const MIN_CLIP_BYTES = 2_000;

// ---------------------------------------------------------------- 小工具

function httpError(status, message, code = "LISTEN_NAMING_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 从 video_path 里抽出 midi_<数字>_<时间戳> 文件夹名，和 Python 版 kid() 一致。 */
export function folderFromPath(value) {
  const match = /(midi_\d+_\d+)/u.exec(String(value ?? ""));
  return match ? match[1] : "";
}

/** 文件夹名里的数字编号，用于按"数字 id 排序"。 */
export function songNumber(folder) {
  const match = /^midi_(\d+)_/u.exec(String(folder ?? ""));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** 时间戳，用于备份文件与 CSV 记录名。 */
function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function logStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 极简 CSV 解析：支持双引号包裹与 "" 转义，够读工具自己写出来的文件。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; }
        else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\r") continue;
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(items => items.some(value => value.trim() !== ""));
}

/** 把一行字段写成 CSV 行（含引号转义）。 */
export function csvLine(values) {
  return `${values.map(value => {
    const text = String(value ?? "");
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",")}\r\n`;
}

/** 带 mtime 缓存地读取一个 CSV 表（表很大，避免每次请求都重新解析）。 */
function createCsvTable(path, { keyColumn }) {
  let cache = { signature: "", table: new Map() };
  async function load() {
    let info = null;
    try { info = await stat(path); } catch { info = null; }
    const signature = info ? `${info.size}:${info.mtimeMs}` : "missing";
    if (signature === cache.signature) return cache.table;
    const table = new Map();
    if (info) {
      try {
        const rows = parseCsv(await readFile(path, "utf8"));
        const header = rows.shift()?.map(value => value.trim()) ?? [];
        for (const items of rows) {
          const record = {};
          header.forEach((name, index) => { record[name] = (items[index] ?? "").trim(); });
          const key = record[keyColumn];
          if (key) table.set(key, record);
        }
      } catch { table.clear(); }
    }
    cache = { signature, table };
    return table;
  }
  return { load, path };
}

/** 读"同款群"：文件夹 -> 同群其他文件夹（音频实锤是同一个录音）。 */
function createGroupIndex(csv) {
  return {
    csv,
    async load() {
      const table = await csv.load();
      const groups = new Map();
      for (const record of table.values()) {
        const group = record["群号"];
        if (!group) continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(record["文件夹"]);
      }
      const index = new Map();
      for (const members of groups.values()) {
        const unique = [...new Set(members.filter(Boolean))];
        if (unique.length < 2) continue;
        for (const member of unique) index.set(member, unique.filter(value => value !== member));
      }
      return index;
    },
  };
}

/** 读"歌曲特征"：文件夹 -> { bpm, key, seconds }。 */
function createFeatureIndex(csv) {
  return {
    csv,
    async load() {
      const table = await csv.load();
      const index = new Map();
      for (const [folder, record] of table) {
        const bpm = Number(record["BPM"]);
        const seconds = Number(record["时长"]);
        index.set(folder, {
          bpm: Number.isFinite(bpm) ? bpm : null,
          key: record["调性"] || "",
          seconds: Number.isFinite(seconds) ? seconds : null,
        });
      }
      return index;
    },
  };
}

// ---------------------------------------------------------------- ffmpeg 定位

let cachedFfmpeg = "";

/** 在 PATH 里找可执行文件（Windows 上按 PATHEXT 补扩展名）。和 media-probe 一样只用系统能力，不引新依赖。 */
function searchOnPath(command) {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    const trimmed = directory.trim().replace(/^"|"$/gu, "");
    if (!trimmed) continue;
    for (const extension of extensions) {
      const candidate = join(trimmed, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * 解析 ffmpeg 可执行文件路径：
 *   1. options.ffmpegPath（显式指定，测试用）
 *   2. 应用自带的 <app>/runtime/ffmpeg/bin/ffmpeg.exe（优先复用应用自己的定位逻辑）
 *   3. 系统 PATH 里的 ffmpeg
 *   4. 直接返回 "ffmpeg"，让 spawn 自己去 PATH 里找
 */
export function bundledFfmpegPath() {
  return BUNDLED_FFMPEG_CANDIDATES.find(candidate => existsSync(candidate)) ?? "";
}

export function resolveFfmpegPath(explicit = "") {
  if (explicit) return explicit;
  if (cachedFfmpeg) return cachedFfmpeg;
  cachedFfmpeg = bundledFfmpegPath() || searchOnPath("ffmpeg.exe") || searchOnPath("ffmpeg") || "ffmpeg";
  return cachedFfmpeg;
}

// ---------------------------------------------------------------- 数据库

function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function openWritable(path) {
  const db = new DatabaseSync(path);
  // 与 server.js 的 initDatabase 保持一致，保证能和正在运行的 OliviaSoul 共用同一个库。
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

// ---------------------------------------------------------------- 主体

/**
 * 创建「试听起名」路由处理函数。
 *
 * @param {object} options
 * @param {string} [options.databasePath] 数据库路径（默认安装版的 UserData 库）
 * @param {string} [options.libraryRoot]  曲库根目录（由 configure() 注入或读数据库 midi_library_root）
 * @param {string} [options.clipsDir]     切片缓存目录
 * @param {string} [options.ffmpegPath]   指定 ffmpeg
 * @returns {Promise<(req: import('node:http').IncomingMessage, url: URL) => Promise<object|null>>}
 */
export async function createListenNamingRoutes(options = {}) {
  const databasePath = resolve(options.databasePath ?? DATABASE_PATH);
  const MIDI_LIBRARY_ROOT_SETTING_LOCAL = "midi_library_root";
  let libraryRootValue = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRootValue) {
    // 可移植兜底：曲库根目录本来就存在应用数据库的 settings 表里
    try {
      const probe = openReadOnly(databasePath);
      libraryRootValue = String(probe.prepare("SELECT value FROM settings WHERE key = ?").get(MIDI_LIBRARY_ROOT_SETTING_LOCAL)?.value ?? "").trim();
      if (!libraryRootValue) {
        libraryRootValue = String(probe.prepare("SELECT value FROM settings WHERE key = ?").get("last_song_storage_path")?.value ?? "").trim();
      }
      probe.close();
    } catch { /* 读不到就让下面统一报错 */ }
  }
  const libraryRoot = libraryRootValue ? resolve(libraryRootValue) : "";


  // ---- 路径自动检查：设置读不到时，直接从库里的 video_path 反推曲库根目录 ----

  // 库里每条记录都是 external:E:\<曲库根>\midi_xxx_yyy\文件.mp4，父目录的父目录就是曲库根。

  if (!libraryRootValue) {

    try {

      const probe = openReadOnly(databasePath);

      const rows = probe.prepare("SELECT video_path FROM user_songs WHERE removed_at IS NULL AND video_path LIKE '%midi_%' LIMIT 40").all();

      probe.close();

      const roots = new Map();

      for (const row of rows) {

        const raw = String(row?.video_path ?? "").replace(/^external:/iu, "");

        const match = /^(.*)[\\/]midi_\d+_\d+[\\/]/u.exec(raw);

        if (match && match[1]) roots.set(match[1], (roots.get(match[1]) ?? 0) + 1);

      }

      const best = [...roots.entries()].sort((a, b) => b[1] - a[1])[0];

      if (best && existsSync(best[0])) {

        libraryRootValue = best[0];

        logInfo("曲库目录自动探测成功", `从 ${rows.length} 条记录推出：${best[0]}`);

      } else if (best) {

        logWarn("曲库目录自动探测到了但目录不存在", best[0]);

      }

    } catch (error) {

      logWarn("曲库目录自动探测失败", String(error && error.message ? error.message : error));

    }

  }
  const clipsDir = resolve(options.clipsDir ?? CLIPS_DIR);
  // 启动时后台清一次超额缓存：不 await，绝不拖慢程序启动
  setTimeout(() => { pruneClipCache().catch(() => {}); }, 5000);
  const backupDir = resolve(options.backupDir ?? BACKUP_DIR);
  const featurePath = options.featurePath ?? FEATURE_CSV;
  const groupPath = options.groupPath ?? GROUP_CSV;
  const logPath = options.logPath ?? LOG_CSV;
  const run = options.runProcess ?? runProcess;

  // 曲库目录尚未设置（新装用户就是这种状态）：绝不抛错 —— 抛错会让 /admin 界面整个 500。
  // 这里只对本功能的端点返回明确提示，其它请求返回 null 交回 server.js 正常处理。
  if (!libraryRoot) {
    return async function handleWithoutLibrary(req, res, url) {
    // 兼容两种调用写法：(req, res, url) 与旧的 (req, url)——只传两个参数时 res 其实是 URL。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
      const path = routePathOf(url).replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
      const OWNED = ["/listen-naming/list", "/listen-naming/clip", "/listen-naming/name", "/listen-naming/status"];
      if (path.startsWith("/listen-naming/migrate/")) return null;   // 数据搬家与曲库无关，交给后面的挂载点
      if (OWNED.includes(path)) {
        return { needsLibrary: true, message: "还没设置曲目存储路径。请到「基础设置」里设置后，再回来使用本功能。" };
      }
      return null;
    };
  }

  const features = createFeatureIndex(createCsvTable(featurePath, { keyColumn: "文件夹" }));
  const groups = createGroupIndex(createCsvTable(groupPath, { keyColumn: "文件夹" }));

  // 一次会话（= 一次服务进程）只备份一次数据库
  const session = { backupFile: "", named: 0, namedFolders: new Set() };

  function ffmpegPath() {
    return resolveFfmpegPath(options.ffmpegPath ?? "");
  }

  // ------------------------------------------------------------ 列表

  async function existingFolders() {
    try {
      const entries = await readdir(libraryRoot, { withFileTypes: true });
      return new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
    } catch {
      return new Set();
    }
  }

  function readSongRows() {
    const db = openReadOnly(databasePath);
    try {
      return db.prepare(
        "SELECT id, video_path, custom_name FROM user_songs WHERE removed_at IS NULL",
      ).all();
    } finally {
      db.close();
    }
  }

  async function buildList() {
    const [rows, folders, featureIndex, groupIndex] = await Promise.all([
      Promise.resolve().then(readSongRows),
      existingFolders(),
      features.load(),
      groups.load(),
    ]);

    // 同编号提示：同一个 midi_<id>_ 前缀下已经有曲名的歌
    const namedByNumber = new Map();
    for (const row of rows) {
      const folder = folderFromPath(row.video_path);
      const name = String(row.custom_name ?? "").trim();
      if (!folder || !name) continue;
      const number = String(songNumber(folder));
      if (!namedByNumber.has(number)) namedByNumber.set(number, []);
      namedByNumber.get(number).push({ folder, name });
    }

    const songs = [];
    for (const row of rows) {
      const videoPath = String(row.video_path ?? "");
      if (!videoPath.toLowerCase().endsWith(".mp4")) continue;
      const folder = folderFromPath(videoPath);
      if (!folder || !FOLDER_PATTERN.test(folder)) continue;
      if (String(row.custom_name ?? "").trim()) continue;
      // 没有实际文件夹就听不了，直接跳过（和 Python 版一致）
      if (!folders.has(folder)) continue;
      const twins = (groupIndex.get(folder) ?? []).filter(twin => folders.has(twin));
      const feature = featureIndex.get(folder) ?? null;
      songs.push({
        folder,
        number: songNumber(folder),
        twins,
        feature,
        sameNumber: (namedByNumber.get(String(songNumber(folder))) ?? []).slice(0, 5),
      });
    }
    songs.sort((left, right) => left.number - right.number || left.folder.localeCompare(right.folder, "en"));

    return {
      songs,
      total: songs.length,
      named: session.named,
      namedFolders: [...session.namedFolders],
      backupFile: session.backupFile,
      libraryRoot,
      clipsDir,
      segmentSeconds: SEGMENT_SECONDS,
      segmentStart: SEGMENT_START,
      maxSegments: MAX_SEGMENTS,
      hasFeatureCsv: featureIndex.size > 0,
      hasGroupCsv: groupIndex.size > 0,
      databasePath,
    };
  }

  // ------------------------------------------------------------ 切片

  function clipPath(folder, segment) {
    return join(clipsDir, `${folder}__${segment}.mp3`);
  }

  async function usableClip(path) {
    try {
      const info = await stat(path);
      return info.isFile() && info.size > MIN_CLIP_BYTES ? path : "";
    } catch {
      return "";
    }
  }

  async function firstVideo(folder) {
    try {
      const entries = await readdir(join(libraryRoot, folder));
      const videos = entries.filter(name => name.toLowerCase().endsWith(".mp4")).sort();
      return videos.length ? join(libraryRoot, folder, videos[0]) : "";
    } catch {
      return "";
    }
  }

  /** 切片缓存现状：文件数、占用字节、最旧/最新时间。 */
  async function clipCacheStats() {
    let files = [];
    try {
      files = await readdir(clipsDir, { withFileTypes: true });
    } catch {
      return { files: 0, bytes: 0, oldest: "", newest: "", limitBytes: CLIP_CACHE_MAX_BYTES, clipsDir };
    }
    let bytes = 0;
    let oldest = 0;
    let newest = 0;
    let count = 0;
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".mp3")) continue;
      try {
        const info = await stat(join(clipsDir, entry.name));
        bytes += info.size;
        count += 1;
        const at = info.mtimeMs;
        if (!oldest || at < oldest) oldest = at;
        if (at > newest) newest = at;
      } catch { /* 文件刚被删掉就算了 */ }
    }
    return {
      files: count,
      bytes,
      oldest: oldest ? new Date(oldest).toISOString() : "",
      newest: newest ? new Date(newest).toISOString() : "",
      limitBytes: CLIP_CACHE_MAX_BYTES,
      clipsDir,
    };
  }

  /**
   * 缓存超限时按"最久没用过"删到上限的 80%。
   * 只动 .mp3 文件，不碰目录里其它东西；返回删除统计。
   */
  async function pruneClipCache(limitBytes = CLIP_CACHE_MAX_BYTES) {
    const stats = await clipCacheStats();
    if (!limitBytes || stats.bytes <= limitBytes) return { removed: 0, freedBytes: 0, ...stats };
    const target = Math.floor(limitBytes * 0.8);
    let entries = [];
    try {
      entries = await readdir(clipsDir, { withFileTypes: true });
    } catch {
      return { removed: 0, freedBytes: 0, ...stats };
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mp3")) continue;
      try {
        const info = await stat(join(clipsDir, entry.name));
        files.push({ name: entry.name, size: info.size, atime: info.atimeMs || info.mtimeMs });
      } catch { /* 忽略 */ }
    }
    files.sort((a, b) => a.atime - b.atime);
    let bytes = stats.bytes;
    let removed = 0;
    let freed = 0;
    for (const file of files) {
      if (bytes <= target) break;
      try {
        await rm(join(clipsDir, file.name), { force: true });
        bytes -= file.size;
        freed += file.size;
        removed += 1;
      } catch { /* 被占用就跳过 */ }
    }
    logInfo("清理切片缓存", `删除 ${removed} 个文件，释放 ${(freed / 1048576).toFixed(1)} MB`);
    return { removed, freedBytes: freed, bytes, files: stats.files - removed, limitBytes, clipsDir };
  }

  /** 预取：把片段生成好但不返回音频（前端"听这首时顺手把下一首切好"）。 */
  async function warmClip(folder, segment) {
    if (!FOLDER_PATTERN.test(folder)) return { warmed: false, reason: "文件夹名无效" };
    const path = await makeClip(folder, segment);
    if (!path) return { warmed: false, reason: "取不到片段" };
    let bytes = 0;
    try { bytes = (await stat(path)).size; } catch { /* 忽略 */ }
    return { warmed: true, folder, segment, bytes };
  }

  async function makeClip(folder, segment) {
    const output = clipPath(folder, segment);
    const cached = await usableClip(output);
    if (cached) return cached;
    const video = await firstVideo(folder);
    if (!video) return "";
    await mkdir(clipsDir, { recursive: true });
    const start = SEGMENT_START + segment * SEGMENT_SECONDS;
    const args = seconds => [
      "-v", "quiet", "-y", "-ss", String(seconds), "-t", String(SEGMENT_SECONDS),
      "-i", video, "-vn", "-ac", "1", "-ar", "32000", "-b:a", "56k", output,
    ];
    // ffmpeg 用 -v quiet，失败信息为空；靠"文件够不够大"判断即可，和 Python 版一致。
    await run(ffmpegPath(), args(start), { timeoutMs: CLIP_TIMEOUT_MS }).catch(() => {});
    if (await usableClip(output)) return output;
    // 第 0 段失败（视频比 20 秒还短）时，从第 5 秒再取一次
    if (segment === 0) {
      await run(ffmpegPath(), args(5), { timeoutMs: CLIP_TIMEOUT_MS }).catch(() => {});
      if (await usableClip(output)) return output;
    }
    return "";
  }

  // ------------------------------------------------------------ 写库

  /** 写库前把数据库整体复制一份（一次会话只做一次，和 Python 版一致）。 */
  async function ensureSessionBackup() {
    if (session.backupFile) return session.backupFile;
    await mkdir(backupDir, { recursive: true });
    const target = join(backupDir, `backup-listen-${stamp()}.sqlite`);
    if (existsSync(target)) { session.backupFile = target; return target; }
    // 先用 SQLite 自己的备份 API 生成一份一致的快照到临时文件，
    // 避免直接 copy 一个正在被 OliviaSoul 写入（WAL）的库。
    const temporary = `${target}.tmp`;
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
    session.backupFile = target;
    return target;
  }

  /** 找出该文件夹下所有"还没曲名"的行，返回 [{ id }]。 */
  function unnamedRowsInFolder(db, folder) {
    return db.prepare(
      "SELECT id FROM user_songs WHERE removed_at IS NULL "
      + "AND (custom_name IS NULL OR custom_name = '') "
      + "AND video_path LIKE ? ESCAPE '\\'",
    ).all(`%${folder.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }

  /**
   * 写曲名（含同款群连带命名）。
   * 沿用应用自己的 SQL 与 key 规则，并在最后 bump 曲库 revision。
   */
  function writeNames(folder, name, targets) {
    const nameKey = name.normalize("NFKC").toLocaleLowerCase();
    const updatedAt = nowSeconds();
    const db = openWritable(databasePath);
    const written = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      const update = db.prepare(
        "UPDATE user_songs SET custom_name=?, custom_name_key=?, corrected_name=?, "
        + "corrected_name_key=?, time_of_day_mapping=?, updated_at=? WHERE id=?",
      );
      for (const target of targets) {
        for (const row of unnamedRowsInFolder(db, target)) {
          update.run(name, nameKey, name, nameKey, null, updatedAt, row.id);
          written.push({ folder: target, id: row.id });
        }
      }
      // 等价于 store.js 里的 #bumpLibraryRevision()
      db.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 已经回滚或事务未开始 */ }
      throw error;
    } finally {
      db.close();
    }
    return written;
  }

  async function appendLog({ folder, name, twins, backupFile }) {
    try {
      await mkdir(dirname(logPath), { recursive: true });
      const line = csvLine([
        logStamp(),
        folder,
        name,
        twins.length ? `连带:${twins.join(",")}` : "",
        backupFile || "(未写库)",
      ]);
      const head = existsSync(logPath) ? "" : "\uFEFF时间,文件夹,曲名,连带,备份\r\n";
      await appendFile(logPath, head + line, "utf8");
    } catch {
      // 记日志失败不影响命名结果
    }
  }

  // ------------------------------------------------------------ 路由

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw httpError(413, "请求体过大", "LISTEN_NAMING_TOO_LARGE");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError(400, "请求 JSON 无效", "LISTEN_NAMING_JSON_INVALID");
    }
  }

  // 列表结果短时缓存：同一份曲库在 20 秒内重复进页面/切页签不必重扫。
  // 任何写库动作（命名、时段写入）都会 bump listCacheEpoch 让缓存立刻失效。
  let listCache = { at: 0, payload: null, epoch: -1 };
  let listCacheEpoch = 0;
  const LIST_CACHE_TTL_MS = 20_000;

  async function cachedBuildList() {
    const now = Date.now();
    if (listCache.payload && listCache.epoch === listCacheEpoch && now - listCache.at < LIST_CACHE_TTL_MS) {
      return listCache.payload;
    }
    const payload = await buildList();
    listCache = { at: now, payload, epoch: listCacheEpoch };
    return payload;
  }

  function invalidateListCache() {
    listCacheEpoch += 1;
    listCache = { at: 0, payload: null, epoch: -1 };
  }

  // ---------------------------------------------------------------- 数据搬家（g05）
  // 只读探测本机其它 OliviaSoul / linli 安装的数据目录；apply 只允许复制"探测到的候选"，
  // 复制前先备份当前数据库。绝不移动、绝不删除对方目录里的任何东西。

  function fixedDrives() {
    const list = [];
    for (const letter of "CDEFGHIJ") {
      try { if (existsSync(letter + ":\\")) list.push(letter + ":\\"); } catch { /* 忽略 */ }
    }
    return list;
  }

  function currentUserDataDir() {
    return resolve(USER_DATA_DIR || DEFAULT_DATA_DIR);
  }

  async function describeCandidate(candidatePath) {
    const dir = resolve(candidatePath);
    const databasePath = join(dir, "database", "olivia-local.sqlite");
    const info = {
      path: dir,
      databasePath,
      exists: existsSync(databasePath),
      sizeBytes: 0,
      songCount: 0,
      namedCount: 0,
      libraryRoot: "",
      isCurrent: dir.toLowerCase() === currentUserDataDir().toLowerCase(),
    };
    if (!info.exists) return info;
    try { info.sizeBytes = (await stat(databasePath)).size; } catch { /* 忽略 */ }
    try {
      const db = openReadOnly(databasePath);
      try {
        info.songCount = Number(db.prepare("SELECT COUNT(*) AS c FROM user_songs WHERE removed_at IS NULL").get()?.c ?? 0);
        info.namedCount = Number(db.prepare(
          "SELECT COUNT(*) AS c FROM user_songs WHERE removed_at IS NULL AND custom_name IS NOT NULL AND custom_name <> ''"
        ).get()?.c ?? 0);
        try {
          info.libraryRoot = String(db.prepare("SELECT value FROM settings WHERE key = 'midi_library_root'").get()?.value ?? "");
        } catch { info.libraryRoot = ""; }
      } finally { db.close(); }
    } catch (error) {
      info.error = String(error?.message ?? error).slice(0, 120);
    }
    return info;
  }

  /** 只扫"盘根下一层"，不递归全盘；命中 OliviaSoul / linli 之类的目录名再看它的 UserData。 */
  async function detectCandidates(budgetMs = 1500) {
    const started = Date.now();
    const found = new Map();
    const interesting = /(olivia|linli|soul)/iu;
    for (const root of fixedDrives()) {
      if (Date.now() - started > budgetMs) break;
      let entries = [];
      try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (Date.now() - started > budgetMs) break;
        if (!entry.isDirectory()) continue;
        if (entry.name === "UserData") { found.set(join(root, entry.name), join(root, entry.name)); continue; }
        if (!interesting.test(entry.name)) continue;
        const base = join(root, entry.name);
        for (const sub of ["UserData", ""]) {
          const candidate = sub ? join(base, sub) : base;
          const databasePath = join(candidate, "database", "olivia-local.sqlite");
          try { if (existsSync(databasePath)) found.set(resolve(candidate), candidate); } catch { /* 忽略 */ }
        }
      }
    }
    const items = [];
    for (const candidate of found.values()) items.push(await describeCandidate(candidate));
    logInfo("扫描本机其它安装的数据", `发现 ${items.length} 个候选目录，用时 ${Date.now() - started} 毫秒`);
    items.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || b.songCount - a.songCount);
    return { items, scannedMs: Date.now() - started, current: currentUserDataDir() };
  }

  /** 只允许复制"探测到的候选"里的数据库文件；复制前把当前库另存一份。 */
  async function applyMigration(sourcePath) {
    const wanted = String(sourcePath ?? "").trim();
    if (!wanted) throw httpError(400, "请指定要搬过来的数据目录", "MIGRATE_SOURCE_REQUIRED");
    const detected = await detectCandidates(3000);
    const match = detected.items.find((item) => resolve(item.path).toLowerCase() === resolve(wanted).toLowerCase() && item.exists);
    if (!match) throw httpError(400, "这个目录不在本机探测结果里，拒绝复制（防止路径穿越）", "MIGRATE_SOURCE_NOT_DETECTED");
    if (match.isCurrent) throw httpError(400, "这就是当前正在使用的数据目录", "MIGRATE_SOURCE_IS_CURRENT");

    const targetDir = join(currentUserDataDir(), "database");
    await mkdir(targetDir, { recursive: true });
    const targetDb = join(targetDir, "olivia-local.sqlite");
    const backup = join(targetDir, `backup-before-migrate-${stamp()}.sqlite`);
    if (existsSync(targetDb)) await copyFile(targetDb, backup);

    const copied = [];
    for (const name of ["olivia-local.sqlite", "olivia-local.sqlite-wal", "olivia-local.sqlite-shm"]) {
      const from = join(match.path, "database", name);
      if (!existsSync(from)) continue;
      await copyFile(from, join(targetDir, name));
      copied.push(name);
    }
    if (!copied.length) throw httpError(400, "对方目录里没有可复制的数据库文件", "MIGRATE_NOTHING_TO_COPY");
    logInfo("数据搬家完成", `从候选目录复制 ${copied.length} 个数据库文件（${match.songCount} 首，已命名 ${match.namedCount}），旧库已备份`);
    return {
      copied, backup, source: match.path, target: currentUserDataDir(),
      songCount: match.songCount, namedCount: match.namedCount, restartRequired: true,
    };
  }

  async function handleList(req, res, url) {
    const payload = await cachedBuildList();
    const cursor = Math.max(0, Math.trunc(Number(url.searchParams.get("cursor") ?? 0)) || 0);
    const pageSize = Math.min(5000, Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize") ?? 200)) || 200));
    const slice = payload.songs.slice(cursor, cursor + pageSize);
    void req; void res;
    return {
      ...payload,
      songs: slice,
      list: slice,
      cursor,
      pageSize,
      hasMore: cursor + pageSize < payload.songs.length,
      nextCursor: cursor + pageSize < payload.songs.length ? cursor + pageSize : 0,
    };
  }

  async function handleClip(req, res, url) {
    const folder = String(url.searchParams.get("folder") ?? "").trim();
    const segment = Math.max(0, Math.min(MAX_SEGMENTS - 1, Math.trunc(Number(url.searchParams.get("seg") ?? 0)) || 0));
    if (!FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
    // warm=1：只把片段生成好放进缓存，不返回音频（前端用来预取下一首）
    if (String(url.searchParams.get("warm") ?? "") === "1") {
      const warmed = await warmClip(folder, segment);
      return { ...warmed, cache: await clipCacheStats() };
    }
    const path = await makeClip(folder, segment);
    if (!path) throw httpError(404, "取不到音频片段，请检查曲库文件和 ffmpeg", "LISTEN_NAMING_CLIP_UNAVAILABLE");
    const data = await readFile(path);
    const headers = {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(data.length),
      // 切片内容按"文件夹 + 段号"固定，可以放心缓存
      "Cache-Control": "private, max-age=86400",
      ...(req.method === "HEAD" ? {} : {}),
    };
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
    return { mediaResponse: true, handled: true, bytes: data.length };
  }

  async function handleName(req, res, url) {
    void res;
    const body = req.method === "POST" ? await readJson(req) : {};
    const folder = String(body.folder ?? url.searchParams.get("folder") ?? "").trim();
    const name = String(body.name ?? url.searchParams.get("name") ?? "").trim();
    if (!FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
    if (!name) throw httpError(400, "曲名不能为空", "LISTEN_NAMING_NAME_INVALID");
    if ([...name].length > 200 || /\p{Cc}/u.test(name))
      throw httpError(400, "曲名须为 1–200 个字符，不能包含控制字符", "LISTEN_NAMING_NAME_INVALID");

    const groupIndex = await groups.load();
    const twins = (groupIndex.get(folder) ?? []).filter(value => value !== folder);
    // 连带命名只补空，不覆盖已有曲名（unnamedRowsInFolder 已经带了这个条件）
    const targets = [folder, ...twins];

    const backupFile = await ensureSessionBackup();
    const written = writeNames(folder, name, targets);

    const writtenFolders = [...new Set(written.map(item => item.folder))];
    const twinWritten = writtenFolders.filter(value => value !== folder);
    session.named += written.length || 1;
    session.namedFolders.add(folder);
    await appendLog({ folder, name, twins: twinWritten, backupFile });

    return {
      folder,
      name,
      written: written.length,
      twins: twinWritten,
      ids: written.map(item => item.id),
      named: session.named,
      backupFile,
    };
  }

  /**
   * 路由入口。返回 null = 不是本模块的请求；返回对象 = JSON 结果（server.js 用 ok() 包信封）；
   * 返回 { mediaResponse: true } = 响应已经由本模块直接写进 res。
   */
  return async function handleListenNamingRoute(req, res, url) {
    // server.js 历史上有两种调用写法：(req, res, url) 与 (req, url)。
    // 只传两个参数时 res 其实是 URL 对象——必须认出来，否则路径变空串，所有接口都会 404「接口不存在」。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
    const rawPath = routePathOf(url);
    const path = rawPath.replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (!path.startsWith("/listen-naming/")) return null;
    if (req.method === "GET" && path === "/listen-naming/list") return await handleList(req, res, url);
    if ((req.method === "GET" || req.method === "HEAD") && path === "/listen-naming/clip")
      return await handleClip(req, res, url);
    if (req.method === "POST" && path === "/listen-naming/name") return await handleName(req, res, url);
    if (req.method === "GET" && path === "/listen-naming/migrate/detect")
      return await detectCandidates();
    if (req.method === "POST" && path === "/listen-naming/migrate/apply") {
      const body = await readJson(req);
      return await applyMigration(body?.path);
    }
    if (req.method === "GET" && path === "/listen-naming/clips/stats")
      return { ...(await clipCacheStats()) };
    if (req.method === "POST" && path === "/listen-naming/clips/prune")
      return { ...(await pruneClipCache(Number(url.searchParams.get("limitMb") ?? 0) * 1024 * 1024 || undefined)) };
    if (req.method === "GET" && path === "/listen-naming/status")
      return { named: session.named, backupFile: session.backupFile, databasePath, libraryRoot, clipsDir, ffmpeg: ffmpegPath() };
    // 不是本模块的接口：必须 return null 交回给后面的挂载点。
    // 依赖自检（/listen-naming/dependencies）、画面识别（/listen-naming/time-of-day/*）、
    // 社区名单（/listen-naming/community/*）都与本模块共用 /listen-naming/ 前缀，
    // 这里一旦抛 404，就会把它们的请求全部截胡（表现为「检查失败：接口不存在」）。
    return null;
  };
}

export const LISTEN_NAMING_DEFAULTS = Object.freeze({
  get databasePath() { return DATABASE_PATH; },
  libraryRoot: LIBRARY_ROOT,
  clipsDir: CLIPS_DIR,
  backupDir: BACKUP_DIR,
  featureCsv: FEATURE_CSV,
  groupCsv: GROUP_CSV,
  logCsv: LOG_CSV,
  ffmpegCandidates: BUNDLED_FFMPEG_CANDIDATES,
  segmentSeconds: SEGMENT_SECONDS,
  segmentStart: SEGMENT_START,
  maxSegments: MAX_SEGMENTS,
});
