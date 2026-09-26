// 游戏日志解读（g13）：把游戏自己写的 Olivia.log（含轮转）解析成事件时间轴。
//
// 为什么需要它：这游戏把所有东西都写进一个每分钟好几十行的日志里（前端控制台的 OTEL 日志占了 35%），
// 人手 grep 十份 20 MB 的文件才能看出"崩溃前发生了什么"。这个模块把那套规则固化成代码：
//   · 行首格式固定为 [时间 +08:00][pid:tid][级别]:(文件:行)[Logger]消息
//   · 约 18% 的行是续行（多行 JSON 的尾巴），必须先归并
//   · 已知无害的（关服后的远程配置 520 之类）折叠成计数，不淹没真正的错误
//   · 本地服务没在跑时前端会刷 network_error（statusCode=0），这是重要信号，单独统计
//   · 崩溃前后若干条自动做成"现场"（显示变化 / 睡眠唤醒 / 播放事件 / 我们服务的调用）
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import readline from "node:readline";
import { join } from "node:path";
import { logInfo } from "./logs.js";

const APPDATA = process.env.APPDATA || "";
const GAME_LOG_DIR = join(APPDATA, "miHoYo", "Olivia-steam", "logs");

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) ([+-]\d{2}:\d{2})\]\[(\d+):(\d+)\]\[(\w+)\]:\(([^:)]+):(\d+)\)(.*)$/u;

/** 关服后属于正常现象，默认折叠 */
const HARMLESS = [
  /run without remote config/iu,
  /onDispatchRequestResult/u,
  /Request failed with status:5\d\d/u,
  /No tracking url; skip event track/u,
  /EventTrack is not initialized/u,
  /LogReport is not initialized/u,
  /no remote base url available/u,
  /Empty api base url/u,
  /Failed to parse json/iu,
];

const RULES = [
  { type: "崩溃", re: /\[CrashMon\]|Application Crashed/iu, hot: true },
  { type: "启动失败", re: /Plugin initialize failed|Failed to initialize the platform/iu, hot: true },
  { type: "Steam 拉起", re: /Steam restarted the application|RestartAppIfNecessary/iu, hot: true },
  { type: "启动阶段", re: /Platform::initialize|Platform::start|printAppInfo|LoginSteam::Implementation::init/iu },
  { type: "壁纸重同步", re: /WallpaperEngine::.*(onDisplayChanged|syncWallpaperWindow|ensureWorkWindow|GetTargetMonitorRect)/iu, hot: true },
  { type: "睡眠唤醒", re: /systemResumed|systemSuspend|powerSuspendResume/iu, hot: true },
  { type: "播放事件", re: /WebPlayerManager::onPlayerComplete|onNotifyPlayerEvent/iu },
  { type: "氛围音频", re: /ambienceControl|ambienceEnded/iu },
  { type: "服务未响应", re: /"category":"network_error"/iu, hot: true },
  { type: "本程序服务", re: /127\.0\.0\.1:27149/u },
  { type: "窗口/界面", re: /onWebInvoke_|ContainerUIController|LiteUIController/iu },
];

function classify(record) {
  const hay = `${record.file} ${record.logger} ${record.msg}`;
  for (const rule of HARMLESS) if (rule.test(hay)) return { type: "已知无害(关服)", hot: false };
  for (const rule of RULES) if (rule.re.test(hay)) return { type: rule.type, hot: !!rule.hot };
  if (record.level === "error" || record.level === "critical") return { type: "错误", hot: true };
  if (record.level === "warning") return { type: "警告", hot: false };
  return { type: "其它", hot: false };
}

async function readTail(file, bytes) {
  const fh = await open(file, "r");
  try {
    const info = await fh.stat();
    const start = Math.max(0, info.size - bytes);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);   // 丢掉半行
    return text;
  } finally { await fh.close(); }
}

/**
 * 解析游戏日志。
 * @param {{ tailBytes?: number, full?: boolean, since?: string, context?: number, maxEvents?: number }} options
 */
export async function gameLogReport(options = {}) {
  const tailBytes = Math.max(64 * 1024, Number(options.tailBytes) || 2 * 1024 * 1024);
  const full = options.full === true;
  const since = String(options.since ?? "");
  const context = Math.max(5, Math.min(200, Number(options.context) || 40));
  const maxEvents = Math.max(100, Math.min(50000, Number(options.maxEvents) || 8000));

  let files = [];
  try {
    const names = (await readdir(GAME_LOG_DIR)).filter(name => /^Olivia(\.\d+)?\.log$/u.test(name));
    const rows = await Promise.all(names.map(async name => {
      const info = await stat(join(GAME_LOG_DIR, name)).catch(() => null);
      return { name, path: join(GAME_LOG_DIR, name), mtime: info?.mtimeMs ?? 0, bytes: info?.size ?? 0 };
    }));
    files = rows.sort((a, b) => a.mtime - b.mtime);
  } catch {
    return { available: false, dir: GAME_LOG_DIR, hint: "没找到游戏日志目录（不是 Steam 版，或者游戏还没运行过）" };
  }

  const events = [];
  const noisy = new Map();
  const netErrors = new Map();
  const levelCount = new Map();
  let lineCount = 0;
  let matched = 0;
  let continuations = 0;
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    const verdict = classify(current);
    current.type = verdict.type;
    current.hot = verdict.hot;
    if (!since || current.ts >= since) events.push(current);
  };

  for (const file of files) {
    const stream = full
      ? createReadStream(file.path)
      : createReadStream(file.path, { start: Math.max(0, file.bytes - tailBytes) });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      lineCount += 1;
      const match = LINE_RE.exec(line);
      if (!match) {
        if (line.trim()) { continuations += 1; if (current) current.detail.push(line); }
        continue;
      }
      matched += 1;
      pushCurrent();
      current = {
        ts: match[1], pid: Number(match[3]), tid: Number(match[4]), level: match[5],
        file: match[6], logger: "", msg: match[8], detail: [],
      };
      const loggerMatch = /^\[([^\]]+)\](.*)$/u.exec(match[8]);
      if (loggerMatch) { current.logger = loggerMatch[1]; current.msg = loggerMatch[2].trim(); }
      levelCount.set(current.level, (levelCount.get(current.level) || 0) + 1);
      // 前端控制台的 OTEL 日志：按 URL 聚合，别一条条列
      if (/OTEL Logger/u.test(match[8])) {
        const jsonMatch = /\{.*\}$/u.exec(match[8]);
        let key = "FE控制台";
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            const url = parsed?.attributes?.["request.url"] ?? "";
            const category = parsed?.category ?? "?";
            key = url ? `${category} ${String(url).replace(/^https?:\/\/127\.0\.0\.1:\d+/u, "")}` : category;
          } catch { key = "FE控制台(JSON 解析失败)"; }
        }
        noisy.set(key, (noisy.get(key) || 0) + 1);
      }
      if (/"category":"network_error"/u.test(match[8])) {
        const url = /"request\.url":"([^"]+)"/u.exec(match[8]);
        const code = /"error\.statusCode":(\d+)/u.exec(match[8]);
        const key = (url ? url[1].replace(/^https?:\/\/127\.0\.0\.1:\d+/u, "") : "?") + " statusCode=" + (code ? code[1] : "?");
        netErrors.set(key, (netErrors.get(key) || 0) + 1);
      }
    }
    reader.close();
    stream.destroy();
  }
  pushCurrent();

  const trimmed = events.length > maxEvents ? events.slice(-maxEvents) : events;

  // 崩溃现场：崩溃前 context 条里的关键事件计数
  const crashes = [];
  trimmed.forEach((event, index) => {
    if (event.type !== "崩溃") return;
    const window = trimmed.slice(Math.max(0, index - context), index);
    const countOf = type => window.filter(item => item.type === type).length;
    crashes.push({
      at: event.ts,
      pid: event.pid,
      tid: event.tid,
      context: {
        display: countOf("壁纸重同步"),
        resume: countOf("睡眠唤醒"),
        player: countOf("播放事件"),
        ambience: countOf("氛围音频"),
        ours: window.filter(item => /27149/u.test(item.msg) || /27149/u.test(item.detail.join(""))).length,
      },
      before: window.slice(-12).map(item => `${item.ts} [${item.type}] ${item.msg.slice(0, 120)}`),
    });
  });

  const typeCount = new Map();
  for (const event of trimmed) typeCount.set(event.type, (typeCount.get(event.type) || 0) + 1);

  const hot = trimmed.filter(event => event.hot).slice(-300).reverse();

  return {
    available: true,
    dir: GAME_LOG_DIR,
    files: files.map(file => ({ name: file.name, bytes: file.bytes })),
    scanned: { lines: lineCount, matched, continuations, fractional: lineCount ? Math.round(continuations / lineCount * 100) : 0 },
    levels: Object.fromEntries([...levelCount.entries()].sort()),
    summary: Object.fromEntries([...typeCount.entries()].sort((a, b) => b[1] - a[1])),
    noisyTop: [...noisy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count })),
    netErrors: [...netErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ key, count })),
    crashes: crashes.slice(-20).reverse(),
    timeline: hot.map(event => ({
      at: event.ts, type: event.type, level: event.level, pid: event.pid,
      text: (event.msg || "").slice(0, 200),
    })),
    note: "只读游戏日志；已知无害项（关服后的远程配置失败等）已折叠成计数",
  };
}

export async function createGameLogRoutes() {
  return async function handle(req, url) {
    const path = String(url?.pathname || "").replace(/^\/toy/u, "");
    if (path !== "/listen-naming/diagnostics/game-log") return null;
    if (req.method !== "GET") return null;
    const params = url?.searchParams;
    const report = await gameLogReport({
      full: params?.get("full") === "1",
      since: String(params?.get("since") ?? ""),
      context: Number(params?.get("context") ?? 40),
    });
    logInfo("读取游戏日志", `可用=${report.available}，崩溃 ${report.crashes?.length ?? 0} 次`);
    return report;
  };
}
