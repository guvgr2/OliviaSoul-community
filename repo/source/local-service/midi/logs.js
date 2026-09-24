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
const USER_DATA = process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData");
const LOG_FILE = join(USER_DATA, "listen-naming.log");
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

const buffer = [];

export function logFilePath() { return LOG_FILE; }

export function log(level, message, detail = "") {
  const entry = {
    at: new Date().toISOString(),
    level: String(level || "info"),
    message: String(message ?? "").slice(0, 500),
    detail: String(detail ?? "").slice(0, 2000),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  void persist(entry);
  return entry;
}

export const logInfo = (message, detail) => log("info", message, detail);
export const logWarn = (message, detail) => log("warn", message, detail);
export const logError = (message, detail) => log("error", message, detail);

async function persist(entry) {
  try {
    await mkdir(USER_DATA, { recursive: true });
    if (existsSync(LOG_FILE)) {
      const info = await stat(LOG_FILE);
      if (info.size > MAX_FILE_BYTES) {
        const old = await readFile(LOG_FILE, "utf8").catch(() => "");
        await writeFile(LOG_FILE, old.slice(-Math.floor(MAX_FILE_BYTES / 2)), "utf8");
        await appendFile(LOG_FILE, `\n--- 日志已轮转 ${new Date().toISOString()} ---\n`, "utf8");
      }
    }
    const line = `[${entry.at}] [${entry.level.toUpperCase()}] ${entry.message}${entry.detail ? "\n    " + entry.detail.replace(/\n/gu, "\n    ") : ""}\n`;
    await appendFile(LOG_FILE, line, "utf8");
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
  void writeFile(LOG_FILE, "", "utf8").catch(() => {});
  return { cleared: true };
}

export function openFolder() {
  spawn("explorer.exe", [USER_DATA], { detached: true, stdio: "ignore" }).unref();
  return { opened: USER_DATA };
}

/** 路由工厂：与其它模块同风格。 */
export async function createLogRoutes() {
  return async function handle(req, url) {
    const path = String(url?.pathname || "").replace(/^\/toy/u, "");
    if (req.method === "GET" && path === "/listen-naming/logs") {
      return { entries: recent(200), file: LOG_FILE };
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