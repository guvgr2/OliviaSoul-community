// 「时段识别」后端模块（OliviaSoul 内嵌功能）
//
// 做什么：读曲库里每首歌的 3 个视频画面，判断哪一段是白天 / 傍晚 / 夜晚，
// 生成 time_of_day_mapping（如 {"TOD12":"DEFAULT","TOD1730":"DEFAULT_2","TOD20":"DEFAULT_3"}）。
//
// 判定算法（离线亮度 + 冷暖判据，实测 50 首 / 150 段与已知答案 100% 一致）：
//   1. 每个视频用 ffmpeg 抽 5~7 帧原始 RGB：-vf fps=1/12,scale=160:90 -f rawvideo -pix_fmt rgb24 -
//   2. 每帧算两个量，再对全帧取平均、对多帧取中位数：
//        亮度 Y = 0.114*B + 0.587*G + 0.299*R
//        冷暖 W = (R + G) / 2 - B      （W >= 10 视为偏暖）
//   3. 单段判定（标定值：白天 Y≈119 偏冷、傍晚 Y≈100 偏暖、夜晚 Y≈38）：
//        Y <  62                    → 夜晚 TOD20
//        Y >= 110 且 W <  10        → 白天 TOD12
//        W >= 10  且 Y >= 62        → 傍晚 TOD1730
//        其余（62 <= Y < 110 且 W < 10）→ 白天 TOD12
//   4. 一首歌恰好 3 个视频时改用排序法（更稳）：按亮度从高到低排，
//      最亮 → 白天 TOD12、中间 → 傍晚 TOD1730、最暗 → 夜晚 TOD20。
//
// 设计约定（与同目录 listen-naming.js 一致）：
//   * ESM；路由是 async 工厂返回的 (req, url) => Promise<object|null>，返回 null 表示"不是我的路由"。
//   * 不写死任何本机盘符 / 用户名：曲库根目录读数据库 settings.midi_library_root，数据目录由宿主固定为
//     <安装目录>\UserData，全部可用 configure() 或环境变量覆盖。
//   * 写库完全沿用应用自己的 SQL 与 key 规则（见 midi/listen-naming.js、midi/store.js）：
//       UPDATE user_songs SET custom_name=?, custom_name_key=?, corrected_name=?, corrected_name_key=?,
//                             time_of_day_mapping=?, updated_at=? WHERE id=?
//       UPDATE media_library_meta SET revision = revision + 1 WHERE id = 1
//   * 写库前先备份数据库；只补空值，绝不动用户已经填好的曲名与时段。
//   * 拿不到画面就跳过该视频并如实报告（skipped / errors），不猜、不瞎填。
//
// 本文件是"加法式"新增，不修改、不覆盖任何既有函数。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function routePathOf(url) {
  // 调用方可能传 URL 对象，也可能直接传字符串路径；两种都要能处理，否则会抛
  // "Cannot read properties of undefined (reading 'pathname')"。
  if (typeof url === "string") return url;
  if (url && typeof url.pathname === "string") return url.pathname;
  return "";
}


const here = dirname(fileURLToPath(import.meta.url));

// 安装版布局：<安装目录>\app\midi\time-of-day.js
// 宿主把耐久数据固定在 <安装目录>\UserData（见 native-host 与 test/runtime-bootstrap.test.js），
// 所以从模块自身位置向上两级推导即可，无需写死盘符。
const INSTALL_ROOT = resolve(here, "..", "..");
const DEFAULT_DATA_DIR = join(INSTALL_ROOT, "UserData");
const DEFAULT_DATABASE_PATH = join(DEFAULT_DATA_DIR, "database", "olivia-local.sqlite");

export const TOD_SLOTS = Object.freeze(["TOD12", "TOD1730", "TOD20"]);
export const TOD_LABELS = Object.freeze({ TOD12: "白天", TOD1730: "傍晚", TOD20: "夜晚" });

// 抽取画面的参数（改动前请重跑标定，见文件头注释）
export const TOD_SAMPLE_INTERVAL_SECONDS = 12;   // fps=1/12：每 12 秒一帧
export const TOD_MAX_FRAMES = 7;                 // 一次最多取 7 帧
export const TOD_WINDOW_SECONDS = 300;           // 只看前 300 秒，保证恰好落在 5~7 帧
export const TOD_FRAME_WIDTH = 160;
export const TOD_FRAME_HEIGHT = 90;
export const TOD_BRIGHT_DAY = 110;               // 亮度 >= 此值视为白天
export const TOD_BRIGHT_NIGHT = 62;              // 亮度 <  此值视为夜晚
export const TOD_WARM_DUSK = 10;                 // 冷暖 >= 此值视为偏暖（傍晚）
export const TOD_RANK_TOLERANCE = 6;             // 排序法里亮度差小于此值算"并列"，用冷暖/文件名定序

// ---------------------------------------------------------------- 路径配置

let USER_DATA_DIR = process.env.OLIVIA_USER_DATA || "";
let DATABASE_PATH = process.env.OLIVIA_TOD_DB || process.env.OLIVIA_LISTEN_DB || DEFAULT_DATABASE_PATH;
let BACKUP_DIR = process.env.OLIVIA_TOD_BACKUP || join(DEFAULT_DATA_DIR, "database");
let LIBRARY_ROOT = process.env.OLIVIA_TOD_LIBRARY_ROOT || process.env.OLIVIA_LISTEN_LIBRARY_ROOT || "";
let FFMPEG_PATH = process.env.OLIVIA_FFMPEG || "";

/** 由 server.js 注入本机路径；注入值优先于环境变量，缺项保持原值。 */
export function configure(options = {}) {
  const pick = (value, current) => (typeof value === "string" && value.trim() ? resolve(value.trim()) : current);
  USER_DATA_DIR = pick(options.dataDir, USER_DATA_DIR);
  if (USER_DATA_DIR && !DATABASE_PATH) DATABASE_PATH = join(USER_DATA_DIR, "database", "olivia-local.sqlite");
  DATABASE_PATH = pick(options.databasePath, DATABASE_PATH);
  BACKUP_DIR = pick(options.backupDir, BACKUP_DIR || (DATABASE_PATH ? dirname(DATABASE_PATH) : ""));
  LIBRARY_ROOT = pick(options.libraryRoot, LIBRARY_ROOT);
  FFMPEG_PATH = typeof options.ffmpegPath === "string" && options.ffmpegPath.trim()
    ? options.ffmpegPath.trim()
    : FFMPEG_PATH;
  return { USER_DATA_DIR, DATABASE_PATH, BACKUP_DIR, LIBRARY_ROOT, FFMPEG_PATH };
}

export const TIME_OF_DAY_DEFAULTS = Object.freeze({
  get databasePath() { return DATABASE_PATH; },
  get libraryRoot() { return LIBRARY_ROOT; },
  get backupDir() { return BACKUP_DIR; },
  get ffmpegPath() { return FFMPEG_PATH; },
  dataDir: DEFAULT_DATA_DIR,
  slots: TOD_SLOTS,
  labels: TOD_LABELS,
  sampleIntervalSeconds: TOD_SAMPLE_INTERVAL_SECONDS,
  maxFrames: TOD_MAX_FRAMES,
  windowSeconds: TOD_WINDOW_SECONDS,
  thresholds: Object.freeze({ brightnessDay: TOD_BRIGHT_DAY, brightnessNight: TOD_BRIGHT_NIGHT, warmthDusk: TOD_WARM_DUSK }),
});

function httpError(status, message, code = "TIME_OF_DAY_ERROR") {
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

/**
 * 写库前把数据库整体备份一份（用 SQLite 自己的备份 API，避免直接 copy 一个正在被写入的 WAL 库；
 * 备份 API 不可用时退回 copyFile）。
 */
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

// ---------------------------------------------------------------- ffmpeg 定位

let cachedFfmpeg = "";

/** 在 PATH 里找可执行文件（Windows 上按 PATHEXT 补扩展名）。只用系统能力，不引新依赖。 */
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
 * 定位 ffmpeg：
 *   1. options.ffmpegPath / configure({ffmpegPath})（显式指定）
 *   2. 环境变量 OLIVIA_FFMPEG
 *   3. 应用自带的 <安装目录>\runtime\ffmpeg\bin\ffmpeg.exe（相对模块位置上溯）
 *   4. 系统 PATH 里的 ffmpeg
 *   5. 直接交给 spawn 的 "ffmpeg"
 */
export function resolveFfmpegPath(explicit = "") {
  const asked = String(explicit || FFMPEG_PATH || process.env.OLIVIA_FFMPEG || "").trim();
  if (asked && existsSync(asked)) return asked;
  if (cachedFfmpeg) return cachedFfmpeg;
  const bundled = [
    join(here, "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
    join(here, "..", "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
  ].find(candidate => existsSync(candidate));
  cachedFfmpeg = bundled || searchOnPath("ffmpeg.exe") || searchOnPath("ffmpeg") || "ffmpeg";
  return cachedFfmpeg;
}

// ---------------------------------------------------------------- 画面取帧

/**
 * 用 ffmpeg 取原始 RGB 帧，返回 Buffer（长度 = 帧数 × 宽 × 高 × 3）。
 * 读 stdout；失败/超时返回空 Buffer（调用方按"拿不到画面"处理）。
 */
export function extractRawFrames(mp4Path, options = {}) {
  const ffmpeg = resolveFfmpegPath(options.ffmpegPath ?? "");
  const width = options.width ?? TOD_FRAME_WIDTH;
  const height = options.height ?? TOD_FRAME_HEIGHT;
  const interval = options.intervalSeconds ?? TOD_SAMPLE_INTERVAL_SECONDS;
  const windowSeconds = options.windowSeconds ?? TOD_WINDOW_SECONDS;
  const maxFrames = options.maxFrames ?? TOD_MAX_FRAMES;
  const timeoutMs = options.timeoutMs ?? 120_000;
  // -frames:v 在输出侧限制帧数；-t 限制只看前 windowSeconds 秒（视频更短也没关系）。
  const args = [
    "-v", "error", "-nostdin",
    "-i", mp4Path,
    "-an", "-sn", "-dn",
    "-vf", `fps=1/${interval},scale=${width}:${height}`,
    "-frames:v", String(maxFrames),
    "-t", String(windowSeconds),
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ];
  return new Promise(resolvePromise => {
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolvePromise(Buffer.alloc(0));
      return;
    }
    const chunks = [];
    let size = 0;
    const maxBytes = width * height * 3 * (maxFrames + 2);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } }, timeoutMs);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    child.stdout.on("error", () => { /* 忽略读取错误，按帧数不足处理 */ });
    child.on("error", () => { clearTimeout(timer); resolvePromise(Buffer.alloc(0)); });
    child.on("close", () => { clearTimeout(timer); resolvePromise(Buffer.concat(chunks)); });
  });
}

/** 把 raw RGB 缓冲区切成逐帧的 { brightness, warmth }。 */
export function measureRawFrames(buffer, options = {}) {
  const width = options.width ?? TOD_FRAME_WIDTH;
  const height = options.height ?? TOD_FRAME_HEIGHT;
  const stride = width * height * 3;
  const frames = [];
  if (!buffer || !buffer.length) return frames;
  const count = Math.floor(buffer.length / stride);
  for (let index = 0; index < count; index += 1) {
    const base = index * stride;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let offset = 0; offset < stride; offset += 3) {
      const r = buffer[base + offset];
      const g = buffer[base + offset + 1];
      const b = buffer[base + offset + 2];
      sumR += r; sumG += g; sumB += b;
    }
    const pixels = stride / 3;
    const r = sumR / pixels, g = sumG / pixels, b = sumB / pixels;
    frames.push({
      // 亮度 Y = 0.114*B + 0.587*G + 0.299*R
      brightness: Math.round((0.114 * b + 0.587 * g + 0.299 * r) * 1000) / 1000,
      // 冷暖 W = (R + G) / 2 - B（正 = 偏暖，负 = 偏冷）
      warmth: Math.round((((r + g) / 2) - b) * 1000) / 1000,
      red: Math.round(r * 1000) / 1000,
      green: Math.round(g * 1000) / 1000,
      blue: Math.round(b * 1000) / 1000,
    });
  }
  return frames;
}

/** 中位数（空数组返回 null）。 */
export function median(values) {
  const list = (Array.isArray(values) ? values : []).filter(value => Number.isFinite(value));
  if (!list.length) return null;
  const sorted = [...list].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 单段判定：亮度 + 冷暖 → TOD 键。拿不到数据返回 null（不猜）。 */
export function judgePeriod(brightness, warmth) {
  if (!Number.isFinite(brightness)) return null;
  const warm = Number.isFinite(warmth) ? warmth : 0;
  if (brightness < TOD_BRIGHT_NIGHT) return "TOD20";
  if (brightness >= TOD_BRIGHT_DAY && warm < TOD_WARM_DUSK) return "TOD12";
  if (warm >= TOD_WARM_DUSK && brightness >= TOD_BRIGHT_NIGHT) return "TOD1730";
  return "TOD12";
}

/**
 * 判定单个视频属于哪个时段。
 *
 * @param {string} mp4Path 视频绝对路径
 * @param {object} [options] 见 extractRawFrames；另可传 ffmpegPath
 * @returns {Promise<{period: string|null, brightness: number|null, warmth: number|null,
 *                    frames: Array<{brightness:number, warmth:number}>, frameCount: number,
 *                    reason?: string}>}
 */
export async function classifyVideo(mp4Path, options = {}) {
  const path = String(mp4Path ?? "").trim();
  if (!path) return { period: null, brightness: null, warmth: null, frames: [], frameCount: 0, reason: "视频路径为空" };
  if (!existsSync(path)) return { period: null, brightness: null, warmth: null, frames: [], frameCount: 0, reason: "视频文件不存在" };
  const raw = await extractRawFrames(path, options);
  const frames = measureRawFrames(raw, options);
  if (!frames.length) {
    return { period: null, brightness: null, warmth: null, frames: [], frameCount: 0, reason: "取不到画面（ffmpeg 无输出或视频过短）" };
  }
  // 先对每帧取平均（一帧一个值），再对多帧取中位数
  const brightness = round3(median(frames.map(frame => frame.brightness)));
  const warmth = round3(median(frames.map(frame => frame.warmth)));
  const period = judgePeriod(brightness, warmth);
  return {
    period,
    brightness,
    warmth,
    frames,
    frameCount: frames.length,
    reason: period ? undefined : "亮度数据不足，无法判定",
  };
}

function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/**
 * 判定一首歌的所有视频。
 *
 * 恰好 3 个视频时用排序法：按亮度从高到低 → TOD12 / TOD1730 / TOD20。
 * 亮度差小于 TOD_RANK_TOLERANCE 视为并列，用冷暖（更暖 = 更接近傍晚）+ 视频名定序，保证结果稳定可复现。
 * 其余情况逐段用阈值判定。
 *
 * @param {Array<string|{video?:string, path?:string, variant?:string}>} videos
 * @returns {Promise<Array<{video:string, variant:string, period:string|null,
 *                          brightness:number|null, warmth:number|null,
 *                          frames:Array<object>, frameCount:number, reason?:string}>>}
 */
export async function classifySong(videos, options = {}) {
  const list = (Array.isArray(videos) ? videos : []).map((item, index) => {
    const video = typeof item === "string" ? item : String(item?.video ?? item?.path ?? "").trim();
    const variant = typeof item === "string" ? "" : String(item?.variant ?? "").trim();
    return { video, variant, index };
  }).filter(item => item.video);

  // 逐段取画面（同一首歌的 3 段互相独立，可以并发）
  const measured = await Promise.all(list.map(async item => ({
    ...item,
    result: await classifyVideo(item.video, options).catch(error => ({
      period: null, brightness: null, warmth: null, frames: [], frameCount: 0,
      reason: `取画面出错：${error?.message ?? error}`,
    })),
  })));

  const usable = measured.filter(item => Number.isFinite(item.result.brightness));
  if (measured.length === 3 && usable.length === 3) {
    // 排序法：先按亮度降序，亮度并列时用冷暖降序 + 视频名，保证确定性
    const ranked = [...measured].sort((left, right) => {
      const delta = right.result.brightness - left.result.brightness;
      if (Math.abs(delta) >= TOD_RANK_TOLERANCE) return delta;
      const warmDelta = (right.result.warmth ?? 0) - (left.result.warmth ?? 0);
      if (Math.abs(warmDelta) >= 0.001) return warmDelta;
      return left.video.localeCompare(right.video, "en");
    });
    ranked.forEach((item, rank) => { item.result.period = TOD_SLOTS[rank]; item.result.reason = undefined; });
  } else {
    for (const item of measured) {
      if (Number.isFinite(item.result.brightness)) {
        item.result.period = judgePeriod(item.result.brightness, item.result.warmth);
      }
    }
  }

  return measured.map(item => ({
    video: item.video,
    variant: item.variant,
    period: item.result.period ?? null,
    brightness: Number.isFinite(item.result.brightness) ? item.result.brightness : null,
    warmth: Number.isFinite(item.result.warmth) ? item.result.warmth : null,
    frames: item.result.frames ?? [],
    frameCount: item.result.frameCount ?? 0,
    ...(item.result.reason ? { reason: item.result.reason } : {}),
  }));
}

/** 把 [{variant, period}] 折成应用认得的时间段映射；判不出来的时段留 null。 */
export function mappingFromVideos(videos) {
  const mapping = Object.fromEntries(TOD_SLOTS.map(slot => [slot, null]));
  for (const item of Array.isArray(videos) ? videos : []) {
    if (!TOD_SLOTS.includes(item?.period)) continue;
    // 同一个时段出现多个视频时，只用第一个（顺序由 classifySong 决定）
    if (mapping[item.period] !== null) continue;
    mapping[item.period] = String(item.variant ?? "").trim() || null;
  }
  return mapping;
}

/** 映射里是否至少有一个真实时段（用来判断"用户是否已经设过时段"）。 */
export function mappingHasValue(value) {
  const mapping = typeof value === "string" ? safeJson(value) : value;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return false;
  return TOD_SLOTS.some(slot => {
    const variant = mapping[slot];
    return typeof variant === "string" && variant.trim() !== "";
  });
}

function safeJson(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

// ---------------------------------------------------------------- 曲库/数据库读取

/** 从 video_path 里抽出 midi_<数字>_<时间戳> 文件夹名（与 listen-naming.js 的 folderFromPath 一致）。 */
export function folderFromPath(value) {
  const match = /(midi_\d+_\d+)/u.exec(String(value ?? ""));
  return match ? match[1] : "";
}

/** 去掉应用自己加的 external: 前缀，得到真实文件路径。 */
export function stripExternalPrefix(value) {
  return String(value ?? "").trim().replace(/^external:/iu, "");
}

/** 把视频路径解析为绝对路径（相对路径按曲库根目录拼）。 */
export function toAbsoluteVideoPath(videoPath, libraryRoot = "") {
  const cleaned = stripExternalPrefix(videoPath);
  if (!cleaned) return "";
  if (isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/u.test(cleaned)) return cleaned;
  return libraryRoot ? join(resolve(libraryRoot), cleaned) : cleaned;
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

// ---------------------------------------------------------------- 路由

/**
 * 创建「时段识别」路由处理函数。
 *
 * @param {object} options
 * @param {string} [options.databasePath] 数据库路径（默认安装版的 UserData 库）
 * @param {string} [options.libraryRoot]  曲库根目录（缺省读数据库 settings.midi_library_root）
 * @param {string} [options.backupDir]    备份目录
 * @param {string} [options.ffmpegPath]   指定 ffmpeg
 * @returns {Promise<(req, url) => Promise<object|null>>}
 */
export async function createTimeOfDayRoutes(options = {}) {
  const databasePath = resolve(options.databasePath ?? DATABASE_PATH);
  if (!existsSync(databasePath)) throw new Error(`未找到 OliviaSoul 数据库：${databasePath}`);

  let libraryRootValue = String(options.libraryRoot ?? LIBRARY_ROOT ?? "").trim();
  if (!libraryRootValue) libraryRootValue = readLibraryRootFromDatabase(databasePath);
  const libraryRoot = libraryRootValue ? resolve(libraryRootValue) : "";
  // 曲库目录尚未设置（新装用户就是这种状态）：绝不抛错 —— 抛错会让 /admin 界面整个 500。
  if (!libraryRoot) {
    return async function handleWithoutLibrary(req, res, url) {
    // 兼容两种调用写法：(req, res, url) 与旧的 (req, url)——只传两个参数时 res 其实是 URL。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
      const path = routePathOf(url).replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
      if (path.startsWith("/listen-naming/time-of-day")) {
        return { needsLibrary: true, message: "还没设置曲目存储路径。请到「基础设置」里设置后，再回来使用本功能。" };
      }
      return null;
    };
  }

  const backupDir = resolve(options.backupDir ?? BACKUP_DIR ?? dirname(databasePath));
  const ffmpegPath = options.ffmpegPath ?? "";

  // 一次会话（= 一次服务进程）只备份一次数据库
  const session = { backupFile: "", applied: 0, skipped: 0 };

  function readRows(where) {
    const db = openReadOnly(databasePath);
    try {
      return db.prepare(
        "SELECT id, video_path, custom_name, time_of_day_mapping FROM user_songs "
        + `WHERE removed_at IS NULL${where ? ` AND ${where}` : ""} ORDER BY updated_at DESC, id`,
      ).all();
    } finally {
      db.close();
    }
  }

  /** 把 user_songs 的行按曲库文件夹分组：folder -> { songIds, videos:[{video, variant}] }。 */
  function groupByFolder(rows) {
    const groups = new Map();
    for (const row of rows) {
      const folder = folderFromPath(row.video_path);
      if (!folder) continue;
      if (!groups.has(folder)) groups.set(folder, { folder, songIds: [], rows: [], videos: [] });
      const group = groups.get(folder);
      group.songIds.push(String(row.id));
      group.rows.push(row);
      const video = toAbsoluteVideoPath(row.video_path, libraryRoot);
      if (!video) continue;
      group.videos.push({ video, variant: variantKeyOf(video), row });
    }
    for (const group of groups.values()) group.videos.sort((left, right) => left.variant.localeCompare(right.variant, "en"));
    return groups;
  }

  /** 变体键 = 文件名去掉 .mp4 后缀（应用就是用文件名当 DEFAULT / DEFAULT_2 / DEFAULT_3 的）。 */
  function variantKeyOf(videoPath) {
    const name = String(videoPath).split(/[\\/]/u).pop() ?? "";
    return name.replace(/\.mp4$/iu, "");
  }

  /** 读一个文件夹下所有视频的时段（只读，不写库）。 */
  async function previewFolders(groups) {
    const result = [];
    for (const group of groups) {
      const usable = group.videos.filter(item => existsSync(item.video));
      const missing = group.videos.filter(item => !existsSync(item.video)).map(item => item.variant);
      const classified = await classifySong(
        usable.map(item => ({ video: item.video, variant: item.variant })),
        { ffmpegPath },
      );
      const mapping = mappingFromVideos(classified);
      result.push({
        folder: group.folder,
        songIds: group.songIds,
        songId: group.songIds[0] ?? "",
        videos: classified.map(item => ({
          variant: item.variant,
          period: item.period,
          label: item.period ? TOD_LABELS[item.period] : null,
          brightness: item.brightness,
          warmth: item.warmth,
          frameCount: item.frameCount,
          ...(item.reason ? { reason: item.reason } : {}),
        })),
        mapping,
        missing,
        // 判不出任何时段就不建议写入
        usable: TOD_SLOTS.some(slot => mapping[slot] !== null),
        existing: group.rows.some(row => mappingHasValue(row.time_of_day_mapping)),
      });
    }
    return result;
  }

  /** 只处理"还没设过时段"的行。 */
  function existingTargets() {
    const rows = readRows("(time_of_day_mapping IS NULL OR time_of_day_mapping = '')");
    return groupByFolder(rows);
  }

  function allTargets() {
    return groupByFolder(readRows(""));
  }

  async function handlePreview(req, res, url) {
    void req; void res;
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit") ?? 20)) || 20));
    const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset") ?? 0)) || 0);
    const includeSet = String(url.searchParams.get("include") ?? "unset").trim();
    const source = includeSet === "all" ? allTargets() : existingTargets();
    const groups = [...source.values()];
    // 已经有值的不建议改（除 include=all 时也标出来由前端决定）
    const candidates = groups.filter(group => includeSet === "all" || !group.rows.some(row => mappingHasValue(row.time_of_day_mapping)));
    const page = candidates.slice(offset, offset + limit);
    const songs = await previewFolders(page);
    return {
      songs,
      total: songs.length,
      candidates: candidates.length,
      scanned: groups.length,
      offset,
      limit,
      hasMore: offset + limit < candidates.length,
      nextOffset: offset + limit < candidates.length ? offset + limit : 0,
      libraryRoot,
      databasePath,
      ffmpeg: resolveFfmpegPath(ffmpegPath),
      thresholds: { brightnessDay: TOD_BRIGHT_DAY, brightnessNight: TOD_BRIGHT_NIGHT, warmthDusk: TOD_WARM_DUSK },
      backupFile: session.backupFile,
    };
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw httpError(413, "请求体过大", "TIME_OF_DAY_TOO_LARGE");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError(400, "请求 JSON 无效", "TIME_OF_DAY_JSON_INVALID");
    }
  }

  /** 校验一条 mapping：只认 TOD12/TOD1730/TOD20，值必须是非空字符串或 null。 */
  function normalizeMapping(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw httpError(400, "mapping 必须是对象", "TIME_OF_DAY_MAPPING_INVALID");
    }
    const unknown = Object.keys(value).filter(key => !TOD_SLOTS.includes(key));
    if (unknown.length) throw httpError(400, `mapping 含未知时段：${unknown.join(", ")}`, "TIME_OF_DAY_MAPPING_INVALID");
    const mapping = {};
    for (const slot of TOD_SLOTS) {
      const variant = value[slot];
      if (variant === null || variant === undefined || variant === "") { mapping[slot] = null; continue; }
      if (typeof variant !== "string" || variant.trim().length > 200 || /\p{Cc}/u.test(variant)) {
        throw httpError(400, `${slot} 的变体键无效`, "TIME_OF_DAY_MAPPING_INVALID");
      }
      mapping[slot] = variant.trim();
    }
    if (!mappingHasValue(mapping)) throw httpError(400, "mapping 里没有任何时段，没什么可写", "TIME_OF_DAY_MAPPING_INVALID");
    return mapping;
  }

  /** 写时段：只改指定 id 且"当前时段为空"的行（overwrite 时才替换已有值）。 */
  function writeMappings(plan) {
    const updatedAt = nowSeconds();
    const db = openWritable(databasePath);
    const written = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      const read = db.prepare(
        "SELECT id, custom_name, custom_name_key, corrected_name, corrected_name_key, time_of_day_mapping "
        + "FROM user_songs WHERE id = ?",
      );
      const update = db.prepare(
        "UPDATE user_songs SET custom_name=?, custom_name_key=?, corrected_name=?, "
        + "corrected_name_key=?, time_of_day_mapping=?, updated_at=? WHERE id=?",
      );
      for (const item of plan) {
        for (const songId of item.songIds) {
          const row = read.get(songId);
          if (!row) continue;
          if (mappingHasValue(row.time_of_day_mapping) && !item.overwrite) continue;
          // custom_name / corrected_name 原样写回：本模块永远不改用户的曲名
          update.run(
            row.custom_name ?? null,
            row.custom_name_key ?? null,
            row.corrected_name ?? null,
            row.corrected_name_key ?? null,
            JSON.stringify(item.mapping),
            updatedAt,
            songId,
          );
          written.push({ songId, folder: item.folder });
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

  async function handleApply(req, res, url) {
    void res;
    const body = req.method === "POST" ? await readJson(req) : {};
    const overwrite = body.overwrite === true || url.searchParams.get("overwrite") === "true";
    let items = Array.isArray(body.items) ? body.items : [];
    if (!items.length && String(url.searchParams.get("folder") ?? "").trim()) {
      // 允许用 folder 直接指定一首（预览页"应用这一首"按钮用得上）
      const folder = String(url.searchParams.get("folder")).trim();
      const group = existingTargets().get(folder) ?? allTargets().get(folder);
      if (!group) throw httpError(404, "曲库里没有这个文件夹", "TIME_OF_DAY_FOLDER_NOT_FOUND");
      const generated = (await previewFolders([group]))[0];
      if (!generated?.usable) throw httpError(409, "这首歌的画面判不出时段，没有可写入的值", "TIME_OF_DAY_NO_VERDICT");
      items = [{ songId: generated.songId, mapping: generated.mapping, folder }];
    }
    if (!items.length) throw httpError(400, "请求体里没有 items", "TIME_OF_DAY_ITEMS_REQUIRED");
    if (items.length > 5000) throw httpError(400, "一次最多写 5000 首", "TIME_OF_DAY_TOO_MANY");

    // 按 folder 或 songId 找到目标行；只认"从来没设过时段"的行
    const rows = readRows("");
    const byId = new Map();
    const byFolder = new Map();
    for (const row of rows) {
      const id = String(row.id);
      byId.set(id, row);
      const folder = folderFromPath(row.video_path);
      if (!folder) continue;
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(row);
    }

    const plan = [];
    let skipped = 0;
    const unknown = [];
    for (const item of items) {
      const mapping = normalizeMapping(item?.mapping);
      const folder = String(item?.folder ?? "").trim();
      let targets = [];
      if (folder && byFolder.has(folder)) targets = byFolder.get(folder);
      else if (item?.songId && byId.has(String(item.songId))) {
        const row = byId.get(String(item.songId));
        const rowFolder = folderFromPath(row.video_path);
        targets = rowFolder && byFolder.has(rowFolder) ? byFolder.get(rowFolder) : [row];
      }
      if (!targets.length) { unknown.push(String(item?.songId ?? folder ?? "(未提供标识)")); continue; }
      const songIds = [];
      for (const row of targets) {
        if (mappingHasValue(row.time_of_day_mapping) && !overwrite) { skipped += 1; continue; }
        songIds.push(String(row.id));
      }
      if (!songIds.length) continue;
      plan.push({ folder: folder || folderFromPath(targets[0].video_path), mapping, songIds, overwrite });
    }

    if (!plan.length) {
      return {
        applied: 0, skipped, backup: session.backupFile || null, unknown,
        message: skipped ? "没有可写的行：这些歌都已经设过时段（需要覆盖请带 overwrite:true）" : "没有匹配到任何曲目",
      };
    }

    // 写库前先备份（一次进程一次）
    if (!session.backupFile) {
      session.backupFile = await backupDatabase(databasePath, join(backupDir, `backup-tod-${stamp()}.sqlite`));
    }
    const written = writeMappings(plan);
    session.applied += written.length;
    session.skipped += skipped;
    const byFolders = new Map();
    for (const item of written) byFolders.set(item.folder, (byFolders.get(item.folder) ?? 0) + 1);

    return {
      applied: written.length,
      skipped,
      backup: session.backupFile,
      folders: [...byFolders.entries()].map(([name, count]) => ({ folder: name, rows: count })),
      overwrite,
      unknown,
      totals: { applied: session.applied, skipped: session.skipped },
    };
  }

  /**
   * 路由入口。返回 null = 不是本模块的请求；返回对象 = JSON 结果（server.js 用 ok() 包信封）。
   */
  return async function handleTimeOfDayRoute(req, res, url) {
    // server.js 历史上有两种调用写法：(req, res, url) 与 (req, url)。
    // 只传两个参数时 res 其实是 URL 对象——必须认出来，否则路径变空串，所有接口都会 404「接口不存在」。
    if (res && typeof res.writeHead !== "function") { url = res; res = null; }
    const rawPath = routePathOf(url);
    const path = rawPath.replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (!path.startsWith("/listen-naming/time-of-day/")) return null;
    if (req.method === "GET" && path === "/listen-naming/time-of-day/preview") return await handlePreview(req, res, url);
    if (req.method === "POST" && path === "/listen-naming/time-of-day/apply") return await handleApply(req, res, url);
    if (req.method === "GET" && path === "/listen-naming/time-of-day/status") {
      return {
        databasePath,
        libraryRoot,
        backupDir,
        backupFile: session.backupFile,
        applied: session.applied,
        skipped: session.skipped,
        ffmpeg: resolveFfmpegPath(ffmpegPath),
        thresholds: { brightnessDay: TOD_BRIGHT_DAY, brightnessNight: TOD_BRIGHT_NIGHT, warmthDusk: TOD_WARM_DUSK },
      };
    }
    throw httpError(404, "接口不存在", "TIME_OF_DAY_NOT_FOUND");
  };
}
