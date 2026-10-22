// 运行日志：记录本功能的操作与错误，方便排查问题、也方便反馈时附上有用信息
//
// 设计要点：
//   * 内存环形缓冲（最近 500 条）+ 落盘到 <UserData>\listen-naming.log（超 1MB 自动轮转）
//   * 记录错误堆栈（页面 500 这类问题一查就知道原因）
//   * 导出/复制时由前端做脱敏（复用问题反馈模块的 scrub），避免把本机路径带进 GitHub
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = resolve(here, "..", "..");

// ★ E4（2026-10-18 独立审查报告-1）：userData 目录**必须能被调用方设定**。
//   旧写法把 `process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData")` 钉成模块级常量，
//   而 server.js 不设那个环境变量 ⇒ 日志落到**安装树**（实测 `repo\source\UserData\listen-naming.log`
//   已经 633,887 B / 6671 行），「打开日志目录」也指着安装树。同一类 bug 在 1.0.8 / 1.0.9 各修过一次。
//   这里的形状：优先用 setUserDataDir() 设定的路径，其次环境变量，最后才是旧的默认值（只为兼容独立调用）。
let userDataDir = "";
export function setUserDataDir(dir) {
  if (!dir) return;
  userDataDir = resolve(String(dir));
}
function userData() {
  if (userDataDir) return userDataDir;
  return process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData");
}
// 日志文件路径每次现算：模块加载时就固定成常量，正是 E4 那种「设定之后仍写旧位置」的坑。
function logFile() { return join(userData(), "listen-naming.log"); }
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

const buffer = [];

export function logFilePath() { return logFile(); }

export function log(level, message, detail = "") {
  const entry = {
    at: new Date().toISOString(),
    level: String(level || "info"),
    message: String(message ?? "").slice(0, 500),
    detail: String(detail ?? "").slice(0, 2000),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  void enqueuePersist(() => persist(entry));
  return entry;
}

export const logInfo = (message, detail) => log("info", message, detail);
export const logWarn = (message, detail) => log("warn", message, detail);
export const logError = (message, detail) => log("error", message, detail);

// ★ 2026-10-19 修（E4 把日志目录提到启动早期之后的**连带问题**）：
//   `log()` 里的 persist 是 fire-and-forget ⇒ 服务 close 之后它可能还在 mkdir / appendFile。
//   日志目录改成"启动早期就设定"以后，任何一次 logInfo/logError 都会往真实 dataDir 写，
//   而测试用的是临时 dataDir ⇒ 测试的清理 rmdir 会撞上还在飞的写入 ⇒ **ENOTEMPTY**
//   （A/B 实测：把 setUserDataDir 那行注释掉 8/8 通过，加回来就 7/8）。
//   ⇒ 把 persist 串成一条链，并提供 flushLogs() 让"要删目录的人"先等到它落完。
let pendingLogWrites = Promise.resolve();
function enqueuePersist(task) {
  const run = pendingLogWrites.then(task, task);
  // 链条本身吞错：一次写失败不能把后面全钉死（也避免未处理拒绝）
  pendingLogWrites = run.then(() => {}, () => {});
  return run;
}

/** 等到所有在飞的日志写入落盘。服务关闭 / 删除数据目录之前调用。 */
export async function flushLogs() {
  await pendingLogWrites;
}

/**
 * 停止落盘（只留内存 buffer）。服务 close 时**在 flushLogs() 之后**调用。
 *
 * 为什么需要它：close() 返回之后仍可能有新的 log()（关闭过程里的 logError、
 * 其它模块收尾时的 logInfo）⇒ 它们又会 mkdir/appendFile 到那个即将被删除的目录
 * ⇒ flushLogs() 只等得住"已经入队的"，等不住"之后才来的"。
 */
let persistenceStopped = false;
export function stopLogPersistence() {
  persistenceStopped = true;
}

/**
 * 恢复落盘。**每个服务实例启动时必须调一次**。
 * ⚠️ 为什么需要它：persistenceStopped 是模块级的 —— 测试串行地"建服务→关服务→再建服务"时，
 *   第一个 close() 会把开关关掉，第二个服务就再也不写日志了（而且没有任何报错，
 *   只是日志文件凭空消失）。启动侧不恢复的话，这条会变成新的静默坑。
 */
export function resumeLogPersistence() {
  persistenceStopped = false;
}

async function persist(entry) {
  if (persistenceStopped) return;          // close() 之后不再碰磁盘（见 stopLogPersistence）
  try {
    await mkdir(userData(), { recursive: true });
    if (existsSync(logFile())) {
      const info = await stat(logFile());
      if (info.size > MAX_FILE_BYTES) {
        const old = await readFile(logFile(), "utf8").catch(() => "");
        await writeFile(logFile(), old.slice(-Math.floor(MAX_FILE_BYTES / 2)), "utf8");
        await appendFile(logFile(), `\n--- 日志已轮转 ${new Date().toISOString()} ---\n`, "utf8");
      }
    }
    const line = `[${entry.at}] [${entry.level.toUpperCase()}] ${entry.message}${entry.detail ? "\n    " + entry.detail.replace(/\n/gu, "\n    ") : ""}\n`;
    await appendFile(logFile(), line, "utf8");
  } catch {
    // 落盘失败不影响功能（内存里仍有记录）
  }
}

export function recent(limit = 200) {
  const count = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 200));
  return buffer.slice(-count).reverse();
}

export function clear() {
  buffer.length = 0;
  void writeFile(logFile(), "", "utf8").catch(() => {});
  return { cleared: true };
}

export function openFolder() {
  spawn("explorer.exe", [userData()], { detached: true, stdio: "ignore" }).unref();
  return { opened: userData() };
}

/** 路由工厂：与其它模块同风格。 */
export async function createLogRoutes() {
  return async function handle(req, url) {
    const path = String(url?.pathname || "").replace(/^\/toy/u, "");
    if (req.method === "GET" && path === "/listen-naming/logs") {
      return { entries: recent(200), file: logFile() };
    }
    if (req.method === "POST" && path === "/listen-naming/logs/clear") {
      log("info", "用户清空了日志");
      return clear();
    }
    if (req.method === "POST" && path === "/listen-naming/logs/open-folder") {
      return openFolder();
    }
    return null;
  };
}