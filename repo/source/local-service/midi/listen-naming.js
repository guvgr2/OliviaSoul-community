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
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runProcess } from "./process-runner.js";
import { logInfo, logWarn } from "./logs.js";
import { fingerprintFile, verifyMatch } from "./fingerprint.js";

/** 命名动作的撤回缓冲文件名 / 数量上限（目录在运行时才确定，见 undoFilePath()）。 */
const UNDO_FILE_NAME = "listen-naming-undo.json";
const UNDO_LIMIT = 20;
/** 命名进度：上次听到哪、今天命名了多少。 */
const PROGRESS_FILE_NAME = "listen-naming-progress.json";
/** 标签（待定/存疑/喜欢）：放在服务端，各处都能看到。 */
const TAGS_FILE_NAME = "listen-naming-tags.json";
/** 每首的"智能起点"缓存（用 ffmpeg silencedetect 找非静音区，见 smartStartOf）。 */
const STARTS_FILE_NAME = "listen-naming-starts.json";
const TAG_NAMES = Object.freeze(["later", "doubt", "like"]);
/** 同款群索引文件名（表头：文件夹,群号）与选项文件（连带命名开关）。 */
const GROUPS_FILE_NAME = "listen-naming-groups.csv";
const OPTIONS_FILE_NAME = "listen-naming-options.json";
/** 一个群最多几首；超过就标成"可疑"，不参与连带（误判往往表现为畸大的群）。 */
const TWIN_GROUP_MAX = 6;
/** 判定依据的阈值，与 fingerprint.js 保持一致（这里只用于展示与复核）。 */
const TWIN_MIN_PASSED = 2;
const TWIN_THRESHOLD = 0.9;
const TWIN_FLOOR = 0.7;

function routePathOf(url) {
  // 调用方可能传 URL 对象，也可能直接传字符串路径；两种都要能处理，否则会抛
  // "Cannot read properties of undefined (reading 'pathname')"。
  if (typeof url === "string") return url;
  if (url && typeof url.pathname === "string") return url.pathname;
  return "";
}

/** 本地日期（用于"今天命名了多少"的跨天归零）。 */
function localDayKey(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  // 状态文件（撤回/进度/标签/智能起点/同款群/启动日志）都放 <安装目录>\UserData 下。
  // 注意：server.js 调用本模块时只注入 libraryRoot，USER_DATA_DIR 通常是空的，
  // 这时必须回退到 DEFAULT_DATA_DIR（= <安装目录>\UserData），不能回退到 BACKUP_DIR
  // （那是 UserData\database，runtime.log 并不在那里）。
  // 必须定义在所有用到它的地方之前（否则 const 的暂时性死区会抛 "Cannot access before initialization"）。
  const userDataDir = () => String(USER_DATA_DIR || "").trim() || DEFAULT_DATA_DIR;
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
  // g12：同款群索引没有显式指定时，默认读 <UserData>\listen-naming-groups.csv
  // （「同款群核对」面板采纳建议后写的就是这个文件；文件 mtime 变了索引会自动重新加载）
  const groupPath = options.groupPath ?? (String(GROUP_CSV || "").trim() || join(userDataDir(), GROUPS_FILE_NAME));
  const optionsFile = () => resolve(options.optionsFile ?? join(userDataDir(), OPTIONS_FILE_NAME));
  const logPath = options.logPath ?? LOG_CSV;
  const run = options.runProcess ?? runProcess;

  // 曲库目录尚未设置（新装用户就是这种状态）：绝不抛错 —— 抛错会让 /admin 界面整个 500。
  // 这里只对本功能的端点返回明确提示，其它请求返回 null 交回 server.js 正常处理。
  if (!libraryRoot) {
    return async function handleWithoutLibrary(req, res, url) {
    // 兼容两种调用写法：(req, res, url) 与旧的 (req, url)——只传两个参数时 res 其实是 URL。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
      const path = routePathOf(url).replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
      const OWNED = ["/listen-naming/list", "/listen-naming/clip", "/listen-naming/name", "/listen-naming/status",
        "/listen-naming/undo", "/listen-naming/progress", "/listen-naming/position"];
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

  // ------------------------------------------------------------ 撤回 / 进度（g11）
  // 撤回缓冲：每条记录一次命名写库（含连带命名的 twin），撤销时把 custom_name 清回 NULL。
  // 只清"当前值仍等于当初写入的名字"的行 —— 撤销之后你又改过的，不动。
  const state = { undo: [], undoLoaded: false, progressLoaded: false, progress: null };
  // 路径在运行时才定得下来：USER_DATA_DIR 是 configure() 注入的，模块顶层还是空串。
  const undoFile = () => resolve(options.undoFile ?? join(userDataDir(), UNDO_FILE_NAME));
  const progressFile = () => resolve(options.progressFile ?? join(userDataDir(), PROGRESS_FILE_NAME));
  const tagsFile = () => resolve(options.tagsFile ?? join(userDataDir(), TAGS_FILE_NAME));
  const startsFile = () => resolve(options.startsFile ?? join(userDataDir(), STARTS_FILE_NAME));

  // ------------------------------------------------------------ 标签（g12）

  const tagState = { loaded: false, tags: {} };

  async function loadTags() {
    if (tagState.loaded) return tagState.tags;
    tagState.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(tagsFile(), "utf8"));
      const tags = {};
      for (const [folder, value] of Object.entries(parsed?.tags ?? {})) {
        if (!isPlainObject(value)) continue;
        const kept = {};
        for (const name of TAG_NAMES) if (value[name] === true) kept[name] = true;
        if (Object.keys(kept).length) tags[folder] = kept;
      }
      tagState.tags = tags;
    } catch { tagState.tags = {}; }
    return tagState.tags;
  }

  async function saveTags() {
    try {
      const target = tagsFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tags: tagState.tags }, null, 2), "utf8");
    } catch (error) {
      logWarn("标签写盘失败", String(error?.message ?? error));
    }
  }

  function tagCounts() {
    const counts = { later: 0, doubt: 0, like: 0 };
    for (const value of Object.values(tagState.tags)) {
      for (const name of TAG_NAMES) if (value[name]) counts[name] += 1;
    }
    return counts;
  }

  function tagList(tag) {
    const wanted = TAG_NAMES.includes(tag) ? tag : "";
    return Object.entries(tagState.tags)
      .filter(([, value]) => (wanted ? value[wanted] : Object.keys(value).length > 0))
      .map(([folder, value]) => ({ folder, number: songNumber(folder), tags: Object.keys(value) }))
      .sort((left, right) => left.number - right.number || left.folder.localeCompare(right.folder, "en"));
  }

  async function setTag(folder, tag, value) {
    if (!FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
    if (!TAG_NAMES.includes(tag)) throw httpError(400, `标签只能是 ${TAG_NAMES.join(" / ")}`, "LISTEN_NAMING_TAG_INVALID");
    await loadTags();
    const current = { ...(tagState.tags[folder] ?? {}) };
    if (value === false) delete current[tag];
    else current[tag] = true;
    if (Object.keys(current).length) tagState.tags[folder] = current;
    else delete tagState.tags[folder];
    await saveTags();
    return { folder, tags: Object.keys(current), counts: tagCounts() };
  }

  // ------------------------------------------------------------ 智能起点（g12）

  const startState = { loaded: false, starts: {} };

  async function loadStarts() {
    if (startState.loaded) return startState.starts;
    startState.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(startsFile(), "utf8"));
      if (isPlainObject(parsed?.starts)) startState.starts = parsed.starts;
    } catch { startState.starts = {}; }
    return startState.starts;
  }

  async function saveStarts() {
    try {
      const target = startsFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ version: 1, starts: startState.starts }, null, 2), "utf8");
    } catch { /* 缓存写不了不影响使用 */ }
  }

  /**
   * 用一次 ffmpeg silencedetect 找"最长的非静音区间"，把试听起点挪过去，
   * 免得开头几秒是空白/前奏导致听不出来。失败就返回 0（用原来的固定起点）。
   */
  async function smartStartOf(folder, video) {
    const starts = await loadStarts();
    if (Object.hasOwn(starts, folder)) return Number(starts[folder]) || 0;
    let offset = 0;
    try {
      const output = await run(ffmpegPath(), [
        "-v", "info", "-nostdin", "-i", video,
        "-af", "silencedetect=noise=-35dB:d=1.2",
        "-f", "null", "-",
      ], { timeoutMs: 8000, captureOutput: true });
      const text = String(output?.stderr ?? output?.stdout ?? "");
      const events = [...text.matchAll(/silence_(start|end):\s*([0-9.]+)/gu)]
        .map(match => ({ kind: match[1], at: Number(match[2]) }));
      // 找出最长的"有声"区间
      let cursor = 0;
      let best = { start: 0, length: 0 };
      for (const event of events) {
        if (event.kind === "start") {
          const length = event.at - cursor;
          if (length > best.length) best = { start: cursor, length };
          cursor = event.at;
        } else {
          cursor = Math.max(cursor, event.at);
        }
      }
      if (best.length >= SEGMENT_SECONDS) {
        // 落在有声区中间，但不要比原来的起点更早（保持"从第 20 秒起"的下限）
        const middle = best.start + best.length / 2;
        offset = Math.max(0, Math.round(Math.max(SEGMENT_START, middle - SEGMENT_SECONDS / 2) - SEGMENT_START));
        offset = Math.min(offset, 600);   // 最多挪 10 分钟，防止异常值
      }
    } catch { offset = 0; }
    starts[folder] = offset;
    await saveStarts();
    return offset;
  }


  async function loadUndo() {
    if (state.undoLoaded) return state.undo;
    state.undoLoaded = true;
    try {
      const parsed = JSON.parse(await readFile(undoFile(), "utf8"));
      if (Array.isArray(parsed?.entries)) state.undo = parsed.entries.filter(isPlainObject).slice(-UNDO_LIMIT);
    } catch { state.undo = []; }
    return state.undo;
  }

  async function saveUndo() {
    try {
      const target = undoFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ version: 1, entries: state.undo.slice(-UNDO_LIMIT) }), "utf8");
    } catch (error) {
      logWarn("命名撤回缓冲写盘失败", String(error?.message ?? error));
    }
  }

  async function pushUndo(entry) {
    await loadUndo();
    state.undo.push(entry);
    if (state.undo.length > UNDO_LIMIT) state.undo = state.undo.slice(-UNDO_LIMIT);
    await saveUndo();
  }

  function emptyProgress() {
    return { lastFolder: "", lastAt: 0, day: localDayKey(), today: 0, session: 0 };
  }

  /** 给前端的进度快照（附上"今天"是否已翻篇）。 */
  function snapshotProgress(progress) {
    const value = progress ?? emptyProgress();
    return {
      today: value.today,
      session: value.session,
      day: value.day,
      lastFolder: value.lastFolder,
      lastAt: value.lastAt,
    };
  }

  async function loadProgress() {
    if (state.progressLoaded) return state.progress;
    state.progressLoaded = true;
    let saved = null;
    try { saved = JSON.parse(await readFile(progressFile(), "utf8")); } catch { saved = null; }
    const progress = { ...emptyProgress(), ...(isPlainObject(saved) ? saved : {}) };
    if (progress.day !== localDayKey()) { progress.day = localDayKey(); progress.today = 0; }
    progress.session = 0;
    state.progress = progress;
    return progress;
  }

  async function saveProgress() {
    if (!state.progress) return;
    try {
      const target = progressFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(state.progress, null, 2), "utf8");
    } catch (error) {
      logWarn("命名进度写盘失败", String(error?.message ?? error));
    }
  }

  /** 撤回一条：把 custom_name/corrected_name 清回 NULL，只清仍然是当初那个名字的行。
      一条里可能是单次命名（name + rows），也可能是整批导入（groups: [{name, rows}]）。 */
  function revertEntries(entries) {
    const reverted = [];
    const db = openWritable(databasePath);
    try {
      db.exec("BEGIN IMMEDIATE");
      const clear = db.prepare(
        "UPDATE user_songs SET custom_name=NULL, custom_name_key=NULL, corrected_name=NULL, "
        + "corrected_name_key=NULL, time_of_day_mapping=NULL, updated_at=? WHERE id=? "
        + "AND custom_name = ?",
      );
      for (const entry of entries) {
        const groups = Array.isArray(entry?.groups)
          ? entry.groups
          : [{ name: entry?.name, rows: entry?.rows }];
        for (const group of groups) {
          for (const row of Array.isArray(group?.rows) ? group.rows : []) {
            const result = clear.run(nowSeconds(), row.id, group.name);
            if (Number(result?.changes ?? 0) > 0) {
              reverted.push({ id: row.id, folder: row.folder ?? entry?.folder ?? "", name: group.name });
            }
          }
        }
      }
      db.prepare("UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1").run();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* 已经回滚或事务未开始 */ }
      throw error;
    } finally {
      db.close();
    }
    return reverted;
  }

  async function handleUndo(req, res) {
    void req; void res;
    const entries = await loadUndo();
    const last = entries[entries.length - 1];
    if (!last) return { undone: false, reason: "没有可撤回的命名", remaining: 0 };
    const reverted = revertEntries([last]);
    entries.pop();
    await saveUndo();
    const progress = await loadProgress();
    progress.today = Math.max(0, progress.today - reverted.length);
    progress.session = Math.max(0, progress.session - reverted.length);
    await saveProgress();
    invalidateListCache();
    logInfo("撤回命名", `${last.name ?? ""} → ${reverted.length} 行`);
    return {
      undone: reverted.length > 0,
      name: last.name ?? "",
      folder: last.folder ?? "",
      reverted: reverted.length,
      folders: [...new Set(reverted.map(item => item.folder).filter(Boolean))],
      remaining: entries.length,
      reason: reverted.length ? "" : "这条命名之后又被改过，未撤回",
    };
  }

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
        "SELECT id, video_path, custom_name, corrected_name, duration_us FROM user_songs WHERE removed_at IS NULL",
      ).all();
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------ 启动耗时报表（g12）

  /**
   * 读 <UserData>\runtime.log（必要时连上一份）里的 startup-stage 行，按"宿主进程 pid"分组，
   * 返回最近若干次启动的分段耗时。原生宿主与 node 宿主都会打这些行（g11 加的埋点）。
   */
  async function startupReport(limit = 3) {
    const stages = [];
    const nodeStartedAt = new Map();   // 宿主 pid → node 在宿主的第几毫秒启动
    const files = [
      join(userDataDir(), "runtime.previous.log"),
      join(userDataDir(), "runtime.log"),
    ];
    for (const file of files) {
      let text = "";
      try { text = await readFile(file, "utf8"); } catch { continue; }
      // 只保留最后 4000 行，避免把几 MB 的日志全解析一遍
      const lines = text.split(/\r?\n/u).slice(-4000);
      for (const line of lines) {
        // 宿主启动 node 的那一行：拿到"node 是在宿主第几毫秒起来的"，用来把 node 自己的阶段对齐到宿主时间线
        const bootLine = /desktop=(\d+)\s+.*?node started.*?sinceProcessStartMs=(\d+)/u.exec(line);
        if (bootLine) {
          nodeStartedAt.set(bootLine[1], Number(bootLine[2]));
          continue;
        }
        const match = /desktop=(\d+)\s+.*?startup-stage=(\S+)(.*)$/u.exec(line);
        if (!match) continue;
        const stamp = line.slice(0, 23);
        const elapsed = /elapsedMs=(\d+)/u.exec(match[3]);
        const sinceProcess = /sinceProcessStartMs=(\d+)/u.exec(match[3]);
        const sinceNode = /sinceNodeStartMs=(\d+)/u.exec(match[3]);
        stages.push({
          host: match[1],
          stage: match[2],
          at: stamp,
          elapsedMs: elapsed ? Number(elapsed[1]) : null,
          sinceProcessStartMs: sinceProcess ? Number(sinceProcess[1]) : null,
          sinceNodeStartMs: sinceNode ? Number(sinceNode[1]) : null,
        });
      }
    }
    // 按宿主 pid 归组（同一 pid 的一次启动 = 一条时间线），取每组最早出现的时间做排序键
    const boots = new Map();
    for (const item of stages) {
      if (!boots.has(item.host)) boots.set(item.host, { host: item.host, first: item.at, stages: [] });
      boots.get(item.host).stages.push(item);
    }
    const list = [...boots.values()]
      .sort((left, right) => String(left.first).localeCompare(String(right.first)))
      .slice(-limit)
      .reverse();
    for (const boot of list) {
      // 同一阶段可能被打印多次（重启），保留各阶段的最小 elapsedMs
      const merged = new Map();
      const base = nodeStartedAt.get(boot.host) ?? 0;
      for (const item of boot.stages) {
        // node 自己的阶段只有 sinceNodeStartMs（相对 node 启动），换算到宿主时间线，
        // 这样"node 起来 → 服务就绪 → 界面可见"能在同一把尺子上比较。
        if (item.sinceProcessStartMs == null && item.sinceNodeStartMs != null) {
          item.sinceProcessStartMs = base + item.sinceNodeStartMs;
        }
        const key = item.stage;
        const current = merged.get(key);
        const value = item.sinceProcessStartMs ?? item.elapsedMs ?? 0;
        if (!current || value < (current.sinceProcessStartMs ?? current.elapsedMs ?? Infinity)) merged.set(key, item);
      }
      boot.stages = [...merged.values()].sort((left, right) => (left.elapsedMs ?? 0) - (right.elapsedMs ?? 0));
      const total = boot.stages.reduce((max, item) => Math.max(max, item.sinceProcessStartMs ?? item.elapsedMs ?? 0), 0);
      boot.totalMs = total;
      // "最慢的一段"要按**相邻阶段的差值**算（累计值最大的永远是最后一段，没有信息量）
      const ordered = [...boot.stages].sort((left, right) =>
        (left.sinceProcessStartMs ?? 0) - (right.sinceProcessStartMs ?? 0));
      let worst = null;
      let previous = 0;
      for (const item of ordered) {
        const at = item.sinceProcessStartMs ?? item.elapsedMs ?? 0;
        const delta = Math.max(0, at - previous);
        if (!worst || delta > worst.deltaMs) worst = { stage: item.stage, at, deltaMs: delta };
        previous = Math.max(previous, at);
      }
      boot.slowest = worst;
    }
    return {
      boots: list,
      logFile: join(userDataDir(), "runtime.log"),
      note: "sinceProcessStartMs = 从宿主进程启动算起（含 WebView2 装载）；elapsedMs = 从窗体构造算起",
    };
  }

  // ------------------------------------------------------------ 批量命名表（g12）

  const TABLE_HEADER = ["编号", "文件夹", "曲名（在这一列填）", "线索", "同编号已有曲名", "同款群"];

  /** 导出待命名清单为 CSV（用 Excel/记事本一次填多首，再导入写库）。 */
  async function nameTable() {
    const payload = await cachedBuildList();
    const lines = [csvLine(TABLE_HEADER)];
    for (const song of payload.songs) {
      const feature = song.feature ?? {};
      const clue = [
        feature.bpm != null ? `${Math.round(feature.bpm * 10) / 10} BPM` : "",
        feature.key ?? "",
        feature.seconds != null ? `${Math.round(feature.seconds)} 秒` : "",
      ].filter(Boolean).join(" · ");
      lines.push(csvLine([
        song.number,
        song.folder,
        "",
        clue,
        (song.sameNumber ?? []).map(item => item.name).join(" / "),
        (song.twins ?? []).join(" / "),
      ]));
    }
    const stamp2 = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, "-");
    return {
      fileName: `olivia-命名表-${stamp2}.csv`,
      count: payload.songs.length,
      csv: "\uFEFF" + lines.join(""),
      hint: "只填「曲名」那一列（第 3 列）；留空的行会被忽略。导入时先自动备份数据库，"
        + "整批可以用 Ctrl+Z 一次性撤回。",
    };
  }

  /**
   * 导入命名表：逐行把「曲名」写库（同款群同样只补空位），整批记成一条撤回记录。
   * @param {string} csv 文本
   * @param {boolean} dryRun true = 只校验不写库
   */
  async function importNameTable(csv, dryRun = false) {
    const rows = parseCsv(csv);
    if (rows.length < 2) throw httpError(400, "表里没有数据行（需要表头 + 至少一行）", "LISTEN_NAMING_TABLE_EMPTY");
    const header = rows[0].map(value => String(value ?? "").trim());
    const folderAt = header.findIndex(value => value === "文件夹" || value.toLowerCase() === "folder");
    const nameAt = header.findIndex(value => value.startsWith("曲名"));
    if (folderAt < 0 || nameAt < 0)
      throw httpError(400, "表头必须包含「文件夹」和「曲名（在这一列填）」两列", "LISTEN_NAMING_TABLE_HEADER");

    const groupIndex = await groups.load();
    const plan = [];
    const skipped = [];
    const seen = new Set();
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      const folder = String(row[folderAt] ?? "").trim();
      const name = String(row[nameAt] ?? "").trim();
      if (!name) continue;                                   // 没填 = 跳过
      if (!FOLDER_PATTERN.test(folder)) { skipped.push({ line: index + 1, folder, reason: "文件夹名无效" }); continue; }
      if (seen.has(folder)) { skipped.push({ line: index + 1, folder, reason: "同一文件夹重复出现" }); continue; }
      if ([...name].length > 200 || /\p{Cc}/u.test(name)) { skipped.push({ line: index + 1, folder, reason: "曲名不合法" }); continue; }
      seen.add(folder);
      const twins = (groupIndex.get(folder) ?? []).filter(value => value !== folder && !seen.has(value));
      plan.push({ folder, name, targets: [folder, ...twins] });
    }
    if (!plan.length) return { dryRun, planned: 0, written: 0, skipped, message: "表里没有填写的曲名" };

    if (dryRun) return { dryRun: true, planned: plan.length, written: 0, skipped, sample: plan.slice(0, 10).map(item => ({ folder: item.folder, name: item.name, twins: item.targets.length - 1 })) };

    const backupFile = await ensureSessionBackup();
    const groupsForUndo = [];
    const results = [];
    for (const item of plan) {
      const written = writeNames(item.folder, item.name, item.targets);
      if (written.length) {
        groupsForUndo.push({ name: item.name, rows: written.map(row => ({ id: row.id, folder: row.folder })) });
      }
      results.push({ folder: item.folder, name: item.name, written: written.length, twins: [...new Set(written.map(row => row.folder))].filter(f => f !== item.folder) });
    }
    const totalWritten = results.reduce((sum, item) => sum + item.written, 0);
    if (groupsForUndo.length) {
      await pushUndo({
        at: nowSeconds(),
        folder: "(批量导入)",
        name: `批量导入 ${groupsForUndo.length} 首`,
        backupFile,
        groups: groupsForUndo,
      });
      const progress = await loadProgress();
      progress.today += totalWritten;
      progress.session += totalWritten;
      await saveProgress();
      invalidateListCache();
      await appendLog({
        folder: "(批量导入)",
        name: `${groupsForUndo.length} 首`,
        twins: [],
        backupFile,
      });
    }
    logInfo("批量导入命名表", `计划 ${plan.length} 首，写入 ${totalWritten} 行`);
    return {
      dryRun: false,
      planned: plan.length,
      written: totalWritten,
      applied: results.filter(item => item.written > 0).length,
      backupFile,
      skipped,
      results: results.slice(0, 50),
      undoable: (await loadUndo()).length,
      progress: snapshotProgress(await loadProgress()),
    };
  }

  // ------------------------------------------------------------ 同款群核对（g12）
  //
  // 思路：用程序自带的指纹引擎（midi/fingerprint.js，多段严格校验）在后台慢慢算每个文件夹的指纹，
  // 把"判定为同一录音"的文件夹聚成群，**只生成建议**，交人在「同款群核对」面板里逐群确认。
  // 只有被采纳的群才写进 listen-naming-groups.csv；连带命名还要再打开一个总开关（默认关）。

  const groupState = { options: null, optionsLoaded: false, fingerprints: null, ignored: new Set() };
  const groupPrintCacheFile = () => resolve(options.groupPrintFile ?? join(userDataDir(), "listen-naming-group-prints.json"));

  async function loadOptions() {
    if (groupState.optionsLoaded) return groupState.options;
    groupState.optionsLoaded = true;
    let saved = null;
    try { saved = JSON.parse(await readFile(optionsFile(), "utf8")); } catch { saved = null; }
    groupState.options = {
      twinNaming: isPlainObject(saved) && saved.twinNaming === true,   // 默认关
      acceptedGroups: isPlainObject(saved) && Array.isArray(saved.acceptedGroups) ? saved.acceptedGroups : [],
      ignored: isPlainObject(saved) && Array.isArray(saved.ignored) ? saved.ignored : [],
    };
    groupState.ignored = new Set(groupState.options.ignored.flat());
    return groupState.options;
  }

  async function saveOptions() {
    try {
      const target = optionsFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ...groupState.options }, null, 2), "utf8");
    } catch (error) {
      logWarn("同款群选项写盘失败", String(error?.message ?? error));
    }
  }

  async function loadGroupFingerprints() {
    if (groupState.fingerprints) return groupState.fingerprints;
    let saved = null;
    try { saved = JSON.parse(await readFile(groupPrintCacheFile(), "utf8")); } catch { saved = null; }
    groupState.fingerprints = isPlainObject(saved) && isPlainObject(saved.folders) ? saved.folders : {};
    return groupState.fingerprints;
  }

  async function saveGroupFingerprints() {
    try {
      const target = groupPrintCacheFile();
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify({ version: 1, folders: groupState.fingerprints }), "utf8");
    } catch { /* 缓存写不了不影响使用 */ }
  }

  /** 已采纳的群（从 groups CSV 反推）：folder -> 群号 */
  async function acceptedIndex() {
    const table = await groups.load();
    const index = new Map();
    for (const record of table.values()) {
      const group = String(record["群号"] ?? "").trim();
      const folder = String(record["文件夹"] ?? "").trim();
      if (group && folder) index.set(folder, group);
    }
    return index;
  }

  /** 曲库里所有可试听的文件夹（有 mp4 且在库目录里存在）。 */
  async function candidateFolders() {
    const [rows, folders] = await Promise.all([
      Promise.resolve().then(readSongRows),
      existingFolders(),
    ]);
    const result = new Set();
    for (const row of rows) {
      const videoPath = String(row.video_path ?? "");
      if (!videoPath.toLowerCase().endsWith(".mp4")) continue;
      const folder = folderFromPath(videoPath);
      if (folder && FOLDER_PATTERN.test(folder) && folders.has(folder)) result.add(folder);
    }
    return result;
  }

  /** 把已算过的指纹两两比对，聚成建议群（并标注判定依据）。 */
  async function buildSuggestions() {
    const prints = await loadGroupFingerprints();
    await loadOptions();
    const accepted = await acceptedIndex();
    const ready = Object.keys(prints).filter(folder => Array.isArray(prints[folder]?.fps) && prints[folder].fps.length >= 2);
    const used = new Set();
    const groups = [];
    for (let i = 0; i < ready.length; i += 1) {
      const left = ready[i];
      if (used.has(left)) continue;
      const members = [{ folder: left, scores: null, worst: null }];
      for (let j = i + 1; j < ready.length; j += 1) {
        const right = ready[j];
        if (used.has(right)) continue;
        const verdict = verifyMatch(prints[left].fps, prints[right].fps);
        if (!verdict.ok) continue;
        used.add(right);
        members.push({ folder: right, scores: verdict.scores, worst: verdict.worst });
      }
      if (members.length < 2) continue;
      used.add(left);
      const groupId = accepted.get(left) ?? "";
      groups.push({
        key: [left, ...members.slice(1).map(item => item.folder)].sort().join("|"),
        folders: members.map(item => item.folder),
        members,
        size: members.length,
        // 超大群基本可确定是链式误判（A≈B、B≈C 但 A≠C），单独标出来让人复核
        suspicious: members.length > TWIN_GROUP_MAX,
        accepted: Boolean(groupId) && members.every(item => accepted.get(item.folder) === groupId),
        groupId,
        ignored: members.every(item => groupState.ignored.has(item.folder)),
      });
    }
    groups.sort((a, b) => b.size - a.size || a.folders[0].localeCompare(b.folders[0], "en"));
    return {
      groups,
      thresholds: { segments: 3, minPassed: TWIN_MIN_PASSED, threshold: TWIN_THRESHOLD, floor: TWIN_FLOOR, maxSize: TWIN_GROUP_MAX },
    };
  }

  async function groupsStatus() {
    const [prints, options2, folders] = await Promise.all([
      loadGroupFingerprints(), loadOptions(), candidateFolders(),
    ]);
    const suggestions = await buildSuggestions();
    const computed = Object.keys(prints).filter(folder => Array.isArray(prints[folder]?.fps) && prints[folder].fps.length).length;
    return {
      total: folders.size,
      computed,
      remaining: Math.max(0, folders.size - computed),
      twinNaming: options2.twinNaming === true,
      acceptedCount: suggestions.groups.filter(group => group.accepted).length,
      suggestionCount: suggestions.groups.filter(group => !group.accepted && !group.suspicious).length,
      suspiciousCount: suggestions.groups.filter(group => group.suspicious).length,
      groups: suggestions.groups.filter(group => !group.accepted).slice(0, 40),
      thresholds: suggestions.thresholds,
      groupFile: groupPath,
      twinNamingHint: options2.twinNaming
        ? "连带命名已开启：命名一首时，同群中还没曲名的会一起命名（只补空位）"
        : "连带命名未开启：现在命名只影响当前这一首",
    };
  }

  /**
   * 增量扫描：这一轮最多算 limit 个文件夹的指纹（每个要解码 3 段音频，比较慢），
   * 结果缓存到 listen-naming-group-prints.json，下次接着算。
   */
  async function scanGroups(limit = 8, budgetMs = 25_000) {
    const prints = await loadGroupFingerprints();
    const folders = await candidateFolders();
    const pending = [...folders].filter(folder => !Array.isArray(prints[folder]?.fps));
    const startedAt = Date.now();
    const done = [];
    const failed = [];
    for (const folder of pending) {
      if (done.length >= limit || Date.now() - startedAt > budgetMs) break;
      const video = await firstVideo(folder);
      if (!video) {
        prints[folder] = { fps: [], reason: "no-video" };
        failed.push({ folder, reason: "曲库里找不到视频" });
        continue;
      }
      try {
        const result = await fingerprintFile(video);
        if (Array.isArray(result?.fps) && result.fps.length >= 2) {
          prints[folder] = { fps: result.fps, seconds: result.seconds ?? null, at: Date.now() };
          done.push(folder);
        } else {
          prints[folder] = { fps: [], reason: "short" };
          failed.push({ folder, reason: "取不到足够的音频段" });
        }
      } catch (error) {
        prints[folder] = { fps: [], reason: "error" };
        failed.push({ folder, reason: String(error?.message ?? error).slice(0, 80) });
      }
    }
    await saveGroupFingerprints();
    const suggestions = await buildSuggestions();
    const computed = Object.keys(prints).filter(folder => Array.isArray(prints[folder]?.fps) && prints[folder].fps.length).length;
    return {
      scanned: done.length,
      failed: failed.slice(0, 10),
      computed,
      total: folders.size,
      remaining: Math.max(0, folders.size - computed),
      elapsedMs: Date.now() - startedAt,
      groups: suggestions.groups.filter(group => !group.accepted).slice(0, 40),
      thresholds: suggestions.thresholds,
    };
  }

  /** 采纳一个建议群 → 追加进 groups CSV（表头 文件夹,群号）。 */
  async function acceptGroup(folders) {
    const members = [...new Set((Array.isArray(folders) ? folders : [])
      .map(folder => String(folder ?? "").trim()).filter(folder => FOLDER_PATTERN.test(folder)))];
    if (members.length < 2) throw httpError(400, "一个群至少要两个文件夹", "LISTEN_NAMING_GROUP_TOO_SMALL");
    if (members.length > TWIN_GROUP_MAX)
      throw httpError(400, `这个群有 ${members.length} 首，超过上限 ${TWIN_GROUP_MAX}；请先核对是不是误判`, "LISTEN_NAMING_GROUP_TOO_BIG");
    let existing = "";
    try { existing = await readFile(groupPath, "utf8"); } catch { existing = ""; }
    const rows = existing ? parseCsv(existing) : [["文件夹", "群号"]];
    const header = rows[0]?.length ? rows[0] : ["文件夹", "群号"];
    const kept = rows.slice(1).filter(row => !members.includes(String(row[0] ?? "").trim()));
    const alreadyId = rows.slice(1)
      .filter(row => members.includes(String(row[0] ?? "").trim()))
      .map(row => String(row[1] ?? "").trim())
      .filter(Boolean)[0];
    const groupId = alreadyId || `G${String(Date.now()).slice(-8)}`;
    const body = [header, ...kept, ...members.map(folder => [folder, groupId])];
    await mkdir(dirname(groupPath), { recursive: true });
    await writeFile(groupPath, "\uFEFF" + body.map(row => csvLine(row)).join(""), "utf8");
    const options2 = await loadOptions();
    options2.acceptedGroups = [...new Set([...(options2.acceptedGroups ?? []), groupId])];
    await saveOptions();
    invalidateListCache();
    logInfo("采纳同款群", `${groupId}: ${members.join(", ")}`);
    return { groupId, members, groupFile: groupPath, twinNaming: options2.twinNaming === true };
  }

  /** 忽略一个建议群（不再提示，也不会连带）。 */
  async function ignoreGroup(folders) {
    const members = [...new Set((Array.isArray(folders) ? folders : []).map(String).filter(Boolean))];
    const options2 = await loadOptions();
    options2.ignored = [...new Set([...(options2.ignored ?? []), members])];
    groupState.ignored = new Set(options2.ignored.flat());
    await saveOptions();
    return { ignored: members.length, twinNaming: options2.twinNaming === true };
  }

  /** 连带命名总开关（默认关；关掉就是纯单人命名）。 */
  async function setTwinNaming(value) {
    const options2 = await loadOptions();
    options2.twinNaming = value === true;
    await saveOptions();
    invalidateListCache();
    return { twinNaming: options2.twinNaming };
  }

  /**
   * 输入曲名时的即时检查：   *   · 同名冲突：这个曲名是否已经用在别的编号上（手误造重复）
   *   · 同款群/同编号里的其他写法：便于保持一致
   */
  function nameCheck(name, folder) {
    const wanted = String(name ?? "").trim();
    const wantedKey = wanted.normalize("NFKC").toLocaleLowerCase();
    if (!wantedKey) return { name: wanted, conflicts: [], siblings: [] };
    const db = openReadOnly(databasePath);
    let rows = [];
    try {
      rows = db.prepare(
        "SELECT id, video_path, custom_name FROM user_songs WHERE removed_at IS NULL "
        + "AND custom_name IS NOT NULL AND custom_name <> ''",
      ).all();
    } finally {
      db.close();
    }
    const conflicts = [];
    for (const row of rows) {
      const existing = String(row.custom_name ?? "").trim();
      if (!existing) continue;
      if (existing.normalize("NFKC").toLocaleLowerCase() !== wantedKey) continue;
      const other = folderFromPath(String(row.video_path ?? ""));
      if (other === folder) continue;
      conflicts.push({ folder: other, name: existing });
    }
    // 同编号前缀下已有的曲名（提示"同编号一般都叫这个"）
    const number = folder ? String(songNumber(folder)) : "";
    const siblings = number
      ? [...new Set(rows
        .map(row => ({ folder: folderFromPath(String(row.video_path ?? "")), name: String(row.custom_name ?? "").trim() }))
        .filter(item => item.folder && item.name && String(songNumber(item.folder)) === number && item.folder !== folder)
        .map(item => item.name))].slice(0, 8)
      : [];
    return { name: wanted, conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length, siblings };
  }

  async function libraryHealth() {    const [rows, folders, groupIndex] = await Promise.all([
      Promise.resolve().then(readSongRows),
      existingFolders(),
      groups.load(),
    ]);
    const byName = new Map();
    const byFolder = new Map();
    for (const row of rows) {
      const videoPath = String(row.video_path ?? "");
      if (!videoPath.toLowerCase().endsWith(".mp4")) continue;
      const folder = folderFromPath(videoPath);
      if (!folder || !FOLDER_PATTERN.test(folder)) continue;
      const name = String(row.custom_name ?? "").trim();
      if (name) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(folder);
        if (!byFolder.has(folder)) byFolder.set(folder, name);
      }
    }
    const duplicateNames = [...byName.entries()]
      .filter(([, list]) => new Set(list).size > 1)
      .map(([name, list]) => ({ name, folders: [...new Set(list)].slice(0, 6), count: new Set(list).size }))
      .slice(0, 30);

    const twinConflicts = [];
    for (const [folder, twins] of groupIndex.entries?.() ?? groupIndex.map?.entries?.() ?? []) {
      const members = [folder, ...(twins ?? [])].filter(value => byFolder.has(value));
      const names = [...new Set(members.map(value => byFolder.get(value)))];
      if (names.length > 1) twinConflicts.push({ folders: members.slice(0, 6), names: names.slice(0, 6) });
    }

    const missingVideo = [];
    const durationOdd = [];
    for (const row of rows) {
      const videoPath = String(row.video_path ?? "");
      if (!videoPath.toLowerCase().endsWith(".mp4")) continue;
      const folder = folderFromPath(videoPath);
      if (!folder) continue;
      if (!folders.has(folder)) { missingVideo.push(folder); continue; }
      const seconds = Number(row.duration_us ?? 0) / 1_000_000;
      if (seconds > 0 && (seconds < 20 || seconds > 3600)) durationOdd.push({ folder, seconds: Math.round(seconds) });
    }

    return {
      checkedAt: new Date().toISOString(),
      libraryRoot,
      counts: {
        rows: rows.length,
        folders: folders.size,
        named: byFolder.size,
        duplicateNames: duplicateNames.length,
        twinConflicts: twinConflicts.length,
        missingVideo: missingVideo.length,
        durationOdd: durationOdd.length,
      },
      duplicateNames,
      twinConflicts: twinConflicts.slice(0, 20),
      missingVideo: [...new Set(missingVideo)].slice(0, 30),
      durationOdd: durationOdd.slice(0, 30),
    };
  }

  async function buildList() {
    await loadTags();
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
    // g11「两遍法」用：已命名清单（只给 folder + 曲名 + 编号，不给路径）
    const namedSongs = [];
    const seenNamed = new Set();
    for (const row of rows) {
      const videoPath = String(row.video_path ?? "");
      if (!videoPath.toLowerCase().endsWith(".mp4")) continue;
      const folder = folderFromPath(videoPath);
      if (!folder || !FOLDER_PATTERN.test(folder)) continue;
      const existingName = String(row.custom_name ?? "").trim();
      if (existingName) {
        if (folders.has(folder) && !seenNamed.has(folder)) {
          seenNamed.add(folder);
          namedSongs.push({ folder, number: songNumber(folder), name: existingName });
        }
        continue;
      }
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
        // g12：这首已有的标签（待定/存疑/喜欢），命名页直接显示
        tags: Object.keys(tagState.tags[folder] ?? {}),
      });
    }
    songs.sort((left, right) => left.number - right.number || left.folder.localeCompare(right.folder, "en"));
    namedSongs.sort((left, right) => left.number - right.number || left.folder.localeCompare(right.folder, "en"));

    const progress = await loadProgress();
    return {
      songs,
      // 两遍法：第一遍过后，这些就是"已经拿下的"，第二遍只看 songs 里剩下的
      namedSongs,
      namedTotal: namedSongs.length,
      total: songs.length,
      totalAll: songs.length + namedSongs.length,
      named: session.named,
      namedFolders: [...session.namedFolders],
      progress: snapshotProgress(progress),
      undoable: (await loadUndo()).length,
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
    // g12：智能起点 —— 首段会先用 silencedetect 把起点挪进"有声区"，结果按文件夹缓存
    const offset = await smartStartOf(folder, video);
    const start = SEGMENT_START + offset + segment * SEGMENT_SECONDS;
    // g12：音量归一 —— 各段响度差别大（有的很小声），用 dynaudnorm 拉齐（单遍、开销很低）
    const args = seconds => [
      "-v", "quiet", "-y", "-ss", String(seconds), "-t", String(SEGMENT_SECONDS),
      "-i", video, "-vn", "-ac", "1", "-ar", "32000",
      "-af", "dynaudnorm=f=250:g=15:p=0.9",
      "-b:a", "56k", output,
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
    // g12：连带命名默认关；只有用户在「同款群核对」里显式打开后才连带（且只补空位，绝不覆盖已有曲名）
    const twinOptions = await loadOptions();
    const targets = twinOptions.twinNaming ? [folder, ...twins] : [folder];

    const backupFile = await ensureSessionBackup();
    const written = writeNames(folder, name, targets);

    const writtenFolders = [...new Set(written.map(item => item.folder))];
    const twinWritten = writtenFolders.filter(value => value !== folder);
    session.named += written.length || 1;
    session.namedFolders.add(folder);
    await appendLog({ folder, name, twins: twinWritten, backupFile });

    // g11：记一条撤回缓冲 + 更新进度（"今天命名了多少"）
    await pushUndo({
      at: nowSeconds(),
      folder,
      name,
      backupFile,
      twins: twinWritten,
      rows: written.map(item => ({ id: item.id, folder: item.folder })),
    });
    const progress = await loadProgress();
    progress.today += written.length || 1;
    progress.session += written.length || 1;
    progress.lastFolder = folder;
    progress.lastAt = nowSeconds();
    await saveProgress();

    return {
      folder,
      name,
      written: written.length,
      twins: twinWritten,
      ids: written.map(item => item.id),
      named: session.named,
      backupFile,
      progress: snapshotProgress(progress),
      undoable: (await loadUndo()).length,
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
    // g11：命名撤回（Ctrl+Z）
    if (req.method === "POST" && path === "/listen-naming/undo") return await handleUndo(req, res);
    if (req.method === "GET" && path === "/listen-naming/progress")
      return { progress: snapshotProgress(await loadProgress()), undoable: (await loadUndo()).length };
    // g11：记住"听到哪了"，下次打开命名页可一键继续
    if (req.method === "POST" && path === "/listen-naming/position") {
      const body = await readJson(req);
      const folder = String(body?.folder ?? "").trim();
      if (!FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
      const progress = await loadProgress();
      progress.lastFolder = folder;
      progress.lastAt = nowSeconds();
      await saveProgress();
      return { progress: snapshotProgress(progress) };
    }
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
    // g12：启动耗时报表 + 曲库健康检查（诊断面板用）
    if (req.method === "GET" && path === "/listen-naming/startup-report")
      return await startupReport(Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 3) || 3)));
    if (req.method === "GET" && path === "/listen-naming/health")
      return await libraryHealth();
    // g12：输入曲名时的即时质量检查（同名冲突 / 同编号已有写法）
    if (req.method === "GET" && path === "/listen-naming/name-check") {
      const name = String(url.searchParams.get("name") ?? "");
      const folder = String(url.searchParams.get("folder") ?? "").trim();
      if (folder && !FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
      return nameCheck(name, folder);
    }
    // g12：批量命名表 —— 导出 / 导入
    if (req.method === "GET" && path === "/listen-naming/name-table")
      return await nameTable();
    if (req.method === "POST" && path === "/listen-naming/name-import") {
      const body = await readJson(req);
      if (typeof body?.csv !== "string" || !body.csv.trim())
        throw httpError(400, "缺少 csv 内容", "LISTEN_NAMING_TABLE_EMPTY");
      return await importNameTable(body.csv, body.dryRun === true);
    }
    // g12：同款群核对（建议 → 人工采纳 → 才写索引；连带命名另有总开关）
    if (req.method === "GET" && path === "/listen-naming/groups/status") return await groupsStatus();
    if (req.method === "POST" && path === "/listen-naming/groups/scan") {
      const body = await readJson(req);
      const limit = Math.min(30, Math.max(1, Number(body?.limit ?? 8) || 8));
      const budgetMs = Math.min(120_000, Math.max(5_000, Number(body?.budgetMs ?? 25_000) || 25_000));
      return await scanGroups(limit, budgetMs);
    }
    if (req.method === "POST" && path === "/listen-naming/groups/accept") {
      const body = await readJson(req);
      return await acceptGroup(body?.folders);
    }
    if (req.method === "POST" && path === "/listen-naming/groups/ignore") {
      const body = await readJson(req);
      return await ignoreGroup(body?.folders);
    }
    if (req.method === "POST" && path === "/listen-naming/groups/twin-naming") {
      const body = await readJson(req);
      return await setTwinNaming(body?.value === true);
    }
    // g12：标签（待定 / 存疑 / 喜欢）—— 放服务端，命名页与试听工具页共享
    if (req.method === "GET" && path === "/listen-naming/tags") {
      await loadTags();
      return {
        tags: tagList(String(url.searchParams.get("tag") ?? "")),
        counts: tagCounts(),
        names: { later: "稍后再听", doubt: "存疑", like: "喜欢" },
        all: tagState.tags,
      };
    }
    if (req.method === "POST" && path === "/listen-naming/tags") {
      const body = await readJson(req);
      const folder = String(body?.folder ?? "").trim();
      const tag = String(body?.tag ?? "").trim();
      const value = body?.value === undefined ? true : body.value === true;
      const result = await setTag(folder, tag, value);
      invalidateListCache();
      return { ...result, tags: tagList(""), names: { later: "稍后再听", doubt: "存疑", like: "喜欢" } };
    }
    // g12：智能起点（供排查用：某首被判定从第几秒开始）
    if (req.method === "GET" && path === "/listen-naming/start-offset") {
      const folder = String(url.searchParams.get("folder") ?? "").trim();
      if (!FOLDER_PATTERN.test(folder)) throw httpError(400, "文件夹名无效", "LISTEN_NAMING_FOLDER_INVALID");
      const starts = await loadStarts();
      return { folder, offsetSeconds: Number(starts[folder] ?? 0), segmentStart: SEGMENT_START, segmentSeconds: SEGMENT_SECONDS };
    }
    if (req.method === "GET" && path === "/listen-naming/status")      return {
        named: session.named,
        backupFile: session.backupFile,
        databasePath,
        libraryRoot,
        clipsDir,
        ffmpeg: ffmpegPath(),
        // g11：进度与撤回状态（前端顶部进度条与 Ctrl+Z 用）
        progress: snapshotProgress(await loadProgress()),
        undoable: (await loadUndo()).length,
      };
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
