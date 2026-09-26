// 一键诊断包（g13）：把排障需要的材料打成一个 zip，**全部脱敏**，且绝不包含个人数据本体。
//
// 设计要点：
//   * 打包进去的：程序/依赖/挂载状态、启动报表、运行日志尾部、命名日志尾部、数据库完整性结论、
//     游戏崩溃摘要、环境信息（node/ffmpeg 版本）、以及"哪些东西没被打包"的说明。
//   * 绝不打包：数据库本体、信件、记忆、歌词、切片音频、任何个人文件。这条会写进包内 README。
//   * 脱敏：安装目录 / UserData / 用户目录 / 曲库根目录一律替换成占位符，日志里也不留绝对路径。
//   * zip 自己写（node:zlib deflateRaw + CRC32），不引第三方依赖。
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { logInfo, logWarn } from "./logs.js";
import { dependencyReport } from "./dependency-check.js";
import { startupReport } from "./startup-report.js";
import { crashReport } from "./crash-report.js";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = resolve(here, "..", "..");
const USER_DATA = process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData");
const OUT_DIR = join(USER_DATA, "diagnostics");
const APPDATA = process.env.APPDATA || "";
const GAME_ROOT = join(APPDATA, "miHoYo", "Olivia-steam");
const CRASH_DIR = join(GAME_ROOT, "crash");
const GAME_LOG_DIR = join(GAME_ROOT, "logs");
const MAX_LOG_BYTES = 512 * 1024;   // 每份日志最多带 512 KB 尾巴

// ---------------------------------------------------------------- 脱敏

/** 需要被替换掉的绝对路径（越长的排前面，避免短路径先把长路径切碎）。 */
async function sensitivePaths() {
  const list = [USER_DATA, INSTALL_ROOT, process.env.USERPROFILE || "", APPDATA, GAME_ROOT].filter(Boolean);
  // 曲库根目录：settings 里形如 X:\... 的值
  try {
    const db = new DatabaseSync(join(USER_DATA, "database", "olivia-local.sqlite"), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT value FROM settings").all()) {
        const value = String(row.value ?? "");
        if (/^[A-Za-z]:[\\/]/u.test(value)) list.push(value);
      }
    } finally { db.close(); }
  } catch { /* 读不到就算了，下面还有兜底正则 */ }
  return [...new Set(list)].sort((a, b) => b.length - a.length);
}

function scrubWith(paths, text) {
  let out = String(text ?? "");
  for (const p of paths) {
    if (p.length < 4) continue;
    out = out.split(p).join("<本机路径>");
    out = out.split(p.replace(/\\/gu, "\\\\")).join("<本机路径>");
  }
  // 兜底 1：任何盘符绝对路径里带用户名的，统一抹掉用户名
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, "<用户目录>");
  // 兜底 2（g13）：历史日志里可能残留别的绝对路径（例如迁移前的目录），
  // 上面那些"已知根目录"替换不到；这里把任意 X:\a\b\c 收敛成 <本机路径>\<末段>，
  // 既不留本机路径，也保住"出问题的是哪个文件"这点信息。
  // 顺序要紧：先处理 file:/// 这种正斜杠 URL（Node 的报错栈里就是这种），再处理盘符路径。
  out = out.replace(/file:\/\/\/[A-Za-z]:\/[^\s)"'，。；]*/gu, (match) => {
    const segments = String(match).split("/").filter(Boolean);
    return "file:///<本机路径>/" + (segments.length ? segments[segments.length - 1] : "");
  });
  out = out.replace(/[A-Za-z]:\/(?:[^/\s"':*?<>|]+\/?)+/gu, (match) => {
    const segments = String(match).split("/").filter(Boolean);
    return "<本机路径>/" + (segments.length ? segments[segments.length - 1] : "");
  });
  out = out.replace(/[A-Za-z]:\\(?:[^\\\s"':*?<>|]+\\?)+/gu, (match) => {
    const segments = String(match).split(/[\\/]+/u).filter(Boolean);
    const tail = segments.length ? segments[segments.length - 1] : "";
    return "<本机路径>\\" + tail;
  });
  return out;
}

// ---------------------------------------------------------------- 采集

async function tailOf(file, bytes = MAX_LOG_BYTES) {
  try {
    const text = await readFile(file, "utf8");
    const cut = text.length > bytes ? text.slice(-bytes) : text;
    return cut.startsWith("\n") ? cut : "（只保留尾部）\n" + cut;
  } catch { return null; }
}

function dbSummary(dbPath) {
  const out = { path: "<UserData>/database/olivia-local.sqlite", integrity: [], tables: {}, error: null };
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      out.integrity = db.prepare("PRAGMA integrity_check").all().map(row => String(Object.values(row)[0]));
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map(row => String(row.name));
      out.tableCount = names.length;
      // 只带行数，不带内容
      for (const name of names.slice(0, 40)) {
        try { out.tables[name] = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/gu, "\"\"")}"`).get().c; }
        catch { out.tables[name] = null; }
      }
    } finally { db.close(); }
  } catch (error) { out.error = error.message; }
  return out;
}

async function mountSummary() {
  try {
    const data = JSON.parse(await readFile(join(USER_DATA, "settings", "client-patches.json"), "utf8"));
    return (data.clients ?? []).map(client => ({
      clientRoot: "<客户端目录>",   // 绝对路径不进包
      version: client.version,
      id: String(client.id ?? "").slice(0, 12),
      state: client.state,
      files: (client.files ?? []).map(file => ({
        kind: file.kind,
        state: file.state,
        originalSha256: String(file.originalSha256 ?? "").slice(0, 16),
        patchedSha256: String(file.patchedSha256 ?? "").slice(0, 16),
      })),
    }));
  } catch { return []; }
}

async function crashSummary() {
  const items = [];
  try {
    for (const name of await readdir(CRASH_DIR)) {
      if (!name.startsWith("crash-")) continue;
      const m = /crash-Olivia\.exe-(\d+)-(\d+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/u.exec(name);
      const info = await stat(join(CRASH_DIR, name)).catch(() => null);
      items.push({
        at: m ? `${m[3]}-${m[4]}-${m[5]} ${m[6]}:${m[7]}:${m[8]}` : name,
        pid: m ? Number(m[1]) : null,
        tid: m ? Number(m[2]) : null,
        hasTxt: existsSync(join(CRASH_DIR, name, "crash.txt")),
        hasDump: existsSync(join(CRASH_DIR, name, "crash.dmp")),
        mtime: info?.mtime?.toISOString?.() ?? null,
      });
    }
  } catch { /* 没有 crash 目录就是没崩过 */ }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return items;
}

async function gameLogSummary() {
  try {
    const files = (await readdir(GAME_LOG_DIR)).filter(n => /^Olivia(\.\d+)?\.log$/u.test(n));
    const rows = await Promise.all(files.map(async name => {
      const info = await stat(join(GAME_LOG_DIR, name)).catch(() => null);
      return { name, bytes: info?.size ?? null, mtime: info?.mtime?.toISOString?.() ?? null };
    }));
    return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch { return []; }
}

// ---------------------------------------------------------------- zip（自己写，不引依赖）

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);            // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------- 打包清单

const EXCLUDED = [
  "数据库本体（olivia-local.sqlite）",
  "信件与记忆内容",
  "歌词文件",
  "试听切片与缩略图缓存",
  "任何音视频文件",
  "用户名、账号、设备信息",
];

async function collect() {
  const paths = await sensitivePaths();
  const scrub = text => scrubWith(paths, text);
  const dbPath = join(USER_DATA, "database", "olivia-local.sqlite");

  const [dependencies, startup, mount, crashes, gameLogs] = await Promise.all([
    dependencyReport().catch(error => ({ error: error.message })),
    startupReport({ userDataDir: USER_DATA, limit: 3 }).catch(error => ({ error: error.message })),
    mountSummary(),
    crashSummary(),
    gameLogSummary(),
  ]);

  // 崩溃记录带上解读结果（异常码 / 落在哪个模块 / 归因），比只列时间有用得多
  let crashAnalysis = null;
  try {
    const report = await crashReport({ withDump: true, limit: 20 });
    crashAnalysis = {
      dir: "<AppData>/miHoYo/Olivia-steam/crash",
      total: report.total,
      patchedModules: report.patchedModules,
      crashes: report.crashes.map(item => ({
        at: item.at,
        appVersion: item.appVersion,
        signature: item.signature,
        exception: item.exception,
        system: item.system,
        frames: item.frames,
        topFramesAllInOneModule: item.topFramesAllInOneModule,
        framesPreview: item.framesPreview,
        hasDump: item.hasDump,
        dumpBytes: item.dumpBytes,
      })),
    };
  } catch (error) { crashAnalysis = { error: error.message }; }

  const runtimeLog = await tailOf(join(USER_DATA, "runtime.log"));
  const runtimePrev = await tailOf(join(USER_DATA, "runtime.previous.log"));
  const namingLog = await tailOf(join(USER_DATA, "listen-naming.log"));

  const env = {
    程序版本: process.env.OLIVIA_SOUL_VERSION || "(见 package.json)",
    node版本: process.version,
    平台: `${process.platform} ${process.arch}`,
    生成时间: new Date().toISOString(),
    ffmpeg: dependencies?.items?.find?.(item => /ffmpeg/iu.test(String(item.name)))?.detail ?? null,
    ffprobe: dependencies?.items?.find?.(item => /ffprobe/iu.test(String(item.name)))?.detail ?? null,
    webview2: dependencies?.items?.find?.(item => /WebView2/iu.test(String(item.name)))?.detail ?? null,
  };

  const readme = [
    "OliviaSoul 诊断包",
    "",
    "这个包是给你自己看、或者发给作者排障用的。里面已经做过脱敏（本机路径被替换成 <本机路径> / <用户目录>）。",
    "",
    "包含：",
    "  · env.json            版本、node、ffmpeg 等环境信息",
    "  · dependencies.json   依赖自检七项结果",
    "  · startup.json        最近几次启动的分段耗时",
    "  · mount.json          客户端补丁挂载状态（只含类型与哈希前 16 位，不含任何路径）",
    "  · database.json       数据库完整性检查结论 + 各表行数（不含任何内容）",
    "  · game-crashes.json   游戏本体的崩溃记录清单（时间 / 是否有 dump）",
    "  · game-logs.json      游戏日志文件清单（大小 / 时间）",
    "  · runtime.log.txt     本程序宿主日志尾部",
    "  · runtime.previous.log.txt",
    "  · listen-naming.log.txt 命名模块日志尾部",
    "",
    "不含（刻意不打包）：",
    ...EXCLUDED.map(item => "  · " + item),
    "",
    "如果你要发到公开 issue 里，建议先自己扫一眼这几个 txt，确认没有不想公开的内容。",
  ].join("\n");

  const entries = [
    { name: "README.txt", data: readme },
    { name: "env.json", data: JSON.stringify(env, null, 2) },
    { name: "dependencies.json", data: scrub(JSON.stringify(dependencies, null, 2)) },
    { name: "startup.json", data: scrub(JSON.stringify(startup, null, 2)) },
    { name: "mount.json", data: JSON.stringify(mount, null, 2) },
    { name: "database.json", data: JSON.stringify(dbSummary(dbPath), null, 2) },
    { name: "game-crashes.json", data: JSON.stringify(crashAnalysis ?? crashes, null, 2) },
    { name: "game-logs.json", data: JSON.stringify(gameLogs, null, 2) },
  ];
  if (runtimeLog) entries.push({ name: "runtime.log.txt", data: scrub(runtimeLog) });
  if (runtimePrev) entries.push({ name: "runtime.previous.log.txt", data: scrub(runtimePrev) });
  if (namingLog) entries.push({ name: "listen-naming.log.txt", data: scrub(namingLog) });

  return { entries, paths };
}

// ---------------------------------------------------------------- 路由

export async function createDiagnosticRoutes() {
  return async function handle(req, url) {
    const path = String(url?.pathname || "").replace(/^\/toy/u, "");

    // 先看会打包什么（不落盘）
    if (path === "/listen-naming/diagnostics/package/preview") {
      if (req.method !== "GET") return null;
      const { entries } = await collect();
      return {
        entries: entries.map(entry => ({
          name: entry.name,
          bytes: Buffer.isBuffer(entry.data) ? entry.data.length : Buffer.byteLength(String(entry.data), "utf8"),
        })),
        excluded: EXCLUDED,
        outDir: OUT_DIR,
      };
    }

    // 真正打包
    if (path === "/listen-naming/diagnostics/package") {
      if (req.method !== "POST") return null;
      const { entries } = await collect();
      const zip = makeZip(entries);
      await mkdir(OUT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
      const file = join(OUT_DIR, `olivia-diagnostics-${stamp}.zip`);
      await writeFile(file, zip);
      logInfo("已导出诊断包", `${file}（${zip.length} 字节）`);
      return {
        file,
        bytes: zip.length,
        entries: entries.map(entry => entry.name),
        excluded: EXCLUDED,
      };
    }

    // 打开诊断包所在目录
    if (path === "/listen-naming/diagnostics/package/reveal") {
      if (req.method !== "POST") return null;
      await mkdir(OUT_DIR, { recursive: true });
      try { spawn("explorer.exe", [OUT_DIR], { detached: true, stdio: "ignore" }).unref(); }
      catch (error) { logWarn("打开诊断包目录失败", error.message); }
      return { opened: OUT_DIR };
    }

    return null;
  };
}
