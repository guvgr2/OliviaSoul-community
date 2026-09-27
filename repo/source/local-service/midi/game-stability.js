// 游戏稳定性（g15）：用 Chromium 官方的开关，绕开那处导致游戏闪退的空指针。
//
// 背景（实测）：游戏内嵌 Chromium 在 `libcef.dll + 0x921DA24` 上空指针崩溃（0xC0000005 读 0x0），
// 到 2026-09-27 已复现 6 次，症状完全一致；Chromium 为 page_discarder 的这条路径提供了 feature
// `SkipDiscardDrivenByStaleSignal`（默认关闭）。
//
// 本模块**只改 Steam 启动项里的一个参数**：不改游戏任何文件、随时可关、可完全还原，
// 并且直接复用 steam-launch-options.mjs 里那套"备份 + 清单 + 原子替换"的安全写入。
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { crashReport } from "./crash-report.js";

/** 要写进启动项的参数（Chromium feature 开关）。 */
export const STABILITY_FLAG = "--enable-features=SkipDiscardDrivenByStaleSignal";
const FEATURE_NAME = "SkipDiscardDrivenByStaleSignal";
/** 同一处崩溃累计到这个次数就值得提示用户试着打开开关。 */
const SUGGEST_AFTER = 3;

function httpError(status, message, code = "GAME_STABILITY_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function userDataOf(databasePath) {
  const value = String(databasePath ?? "").trim();
  if (!value) throw httpError(500, "服务没有配置数据库路径", "DATABASE_PATH_MISSING");
  return dirname(dirname(resolve(value)));
}

// ---------------------------------------------------------------- 定位

function looksLikeGameDir(dir) {
  if (!dir || !existsSync(dir)) return false;
  try {
    if (existsSync(join(dir, "Olivia.exe"))) return true;
    return readdirSync(dir).some(name =>
      /^\d+\.\d+\.\d+\.\d+$/u.test(name) && existsSync(join(dir, name, "Olivia.exe")));
  } catch { return false; }
}

/** 从已登记的客户端信息里找出游戏目录（两个来源都试，不猜）。 */
function detectGameRoot(userDataDir) {
  const fromRegistry = () => {
    try {
      const registry = JSON.parse(String(readFileSyncSafe(join(userDataDir, "settings", "client-patches.json")) ?? "null"));
      const found = [];
      const walk = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === "string" && /(clientRoot|gameRoot|gamePath|clientPath)$/iu.test(key)) found.push(child);
          else if (child && typeof child === "object") walk(child);
        }
      };
      walk(registry);
      return found;
    } catch { return []; }
  };
  const fromSettings = () => {
    try {
      const settings = JSON.parse(String(readFileSyncSafe(join(userDataDir, "desktop-settings.json")) ?? "null"));
      return ["gameRoot", "gamePath", "clientPath", "selectedClient", "executable", "clientExe"]
        .map(key => settings?.[key])
        .filter(value => typeof value === "string");
    } catch { return []; }
  };
  for (const candidate of [...fromRegistry(), ...fromSettings()]) {
    if (looksLikeGameDir(candidate)) return resolve(candidate);
    if (looksLikeGameDir(dirname(candidate))) return resolve(dirname(candidate));
  }
  return "";
}

function readFileSyncSafe(path) {
  try { return readFileSync(path); } catch { return null; }
}

/** 从游戏目录向上找到 steamapps，再拿到 appId。 */
function findSteamApps(gameRoot) {
  let current = resolve(gameRoot);
  for (let depth = 0; depth < 5; depth += 1) {
    if (current.toLowerCase().endsWith("steamapps")) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function readAppId(steamApps, gameRoot) {
  if (!steamApps || !existsSync(steamApps)) return "";
  const installDir = gameRoot.slice(steamApps.length).replace(/^[\\/]+/u, "").split(/[\\/]/u).slice(1).join("/");
  try {
    for (const name of readdirSync(steamApps)) {
      if (!/^appmanifest_\d+\.acf$/u.test(name)) continue;
      const text = String(readFileSync(join(steamApps, name), "utf8"));
      const id = /"appid"\s+"(\d+)"/u.exec(text)?.[1] ?? name.match(/\d+/u)?.[0] ?? "";
      const dir = /"installdir"\s+"([^"]*)"/u.exec(text)?.[1] ?? "";
      if (!id) continue;
      if (dir && installDir.toLowerCase().endsWith(dir.toLowerCase())) return id;
    }
  } catch { /* 读不到就当没找到 */ }
  return "";
}

async function readRegistrySteamPath() {
  if (process.platform !== "win32") return "";
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath"], { windowsHide: true });
    } catch { resolvePromise(""); return; }
    let out = "";
    child.stdout?.on("data", chunk => { out += chunk; });
    child.on("error", () => resolvePromise(""));
    child.on("close", () => resolvePromise(out.trim()));
  });
}

/** 依次尝试：注册表里的 SteamPath、以及游戏所在库的上一级。 */
async function findSteamRoot(gameRoot, steamApps) {
  const candidates = [];
  const fromRegistry = await readRegistrySteamPath();
  if (fromRegistry) candidates.push(fromRegistry.replace(/\//gu, "\\"));
  if (steamApps) candidates.push(dirname(steamApps));
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "userdata"))) return candidate;
  }
  return "";
}

/** 找到记录了该 appId 的那个账号的 localconfig.vdf。 */
function findLocalConfig(steamRoot, appId) {
  const userdata = join(steamRoot, "userdata");
  try {
    for (const account of readdirSync(userdata)) {
      const config = join(userdata, account, "config", "localconfig.vdf");
      if (!existsSync(config)) continue;
      const text = String(readFileSync(config, "utf8"));
      if (text.includes(`"${appId}"`)) return { config, account, text };
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 动态加载打包/开发布局里的启动项工具。 */
async function loadSteamEditor(userDataDir) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dirname(userDataDir), "resources", "workspace-template", "tools", "steam-launcher", "steam-launch-options.mjs"),
    resolve(here, "..", "..", "tools", "steam-launcher", "steam-launch-options.mjs"),
    resolve(here, "..", "..", "..", "source", "tools", "steam-launcher", "steam-launch-options.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { module: await import(pathToFileURL(candidate).href), path: candidate };
  }
  throw httpError(500, "找不到 Steam 启动项工具（打包不完整）", "STEAM_TOOL_MISSING");
}

async function locate(databasePath, { steamRoot: steamRootOverride } = {}) {
  const userDataDir = userDataOf(databasePath);
  const gameRoot = detectGameRoot(userDataDir);
  if (!gameRoot) return { ok: false, reason: "GAME_NOT_REGISTERED", userDataDir };
  const steamApps = findSteamApps(gameRoot);
  const appId = readAppId(steamApps, gameRoot);
  if (!appId) return { ok: false, reason: "APPID_NOT_FOUND", userDataDir, gameRoot, steamApps };
  // 正常路径靠注册表找 Steam 根；steamRoot 参数 / OLIVIA_STEAM_ROOT 只给测试用（受限环境读不到注册表）
  const override = steamRootOverride || process.env.OLIVIA_STEAM_ROOT || "";
  const steamRoot = override && existsSync(join(override, "userdata"))
    ? resolve(override)
    : await findSteamRoot(gameRoot, steamApps);
  if (!steamRoot) return { ok: false, reason: "STEAM_NOT_FOUND", userDataDir, gameRoot, steamApps, appId };
  const local = findLocalConfig(steamRoot, appId);
  if (!local) return { ok: false, reason: "ACCOUNT_CONFIG_NOT_FOUND", userDataDir, gameRoot, steamApps, appId, steamRoot };
  return { ok: true, userDataDir, gameRoot, steamApps, appId, steamRoot, configPath: local.config };
}

// ---------------------------------------------------------------- 崩溃统计（用于提示）

async function crashSummary() {
  try {
    const report = await crashReport({ limit: 20 });
    const items = Array.isArray(report?.crashes) ? report.crashes : [];
    const same = items.filter(item => String(item?.exception?.module ?? "").toLowerCase() === "libcef.dll");
    return {
      total: items.length,
      sameModule: same.length,
      lastAt: items[0]?.at ?? "",
      signature: same[0]?.exception ? `${same[0].exception.module} + ${same[0].exception.moduleOffset}` : "",
    };
  } catch {
    return { total: 0, sameModule: 0, lastAt: "", signature: "" };
  }
}

// ---------------------------------------------------------------- 对外接口

export async function gameStabilityStatus({ databasePath, steamRoot } = {}) {
  const found = await locate(databasePath, { steamRoot });
  const crashes = await crashSummary();
  if (!found.ok) {
    return {
      supported: false, reason: found.reason, flag: STABILITY_FLAG, enabled: false,
      crashes, suggest: crashes.sameModule >= SUGGEST_AFTER,
      hint: found.reason === "GAME_NOT_REGISTERED"
        ? "还没登记游戏客户端，先去「客户端挂载与存储」里选中游戏。"
        : "没能定位 Steam 的启动项配置（游戏可能不是从 Steam 安装的）。",
    };
  }
  const { module: editor, path: toolPath } = await loadSteamEditor(found.userDataDir);
  // 工具文件可能是旧版（例如把新服务的代码跑在旧安装目录上）—— 明确告知，别让人以为启动项本身有问题
  if (typeof editor.buildFlagOptions !== "function") {
    return {
      supported: false, reason: "TOOL_OUTDATED", flag: STABILITY_FLAG, feature: FEATURE_NAME, enabled: false,
      appId: found.appId, configPath: found.configPath, toolPath, crashes,
      suggest: false,
      hint: "程序的 Steam 启动项工具版本过旧（安装目录里的文件不完整），请重新安装或更新本程序后再试。",
    };
  }
  const text = String(readFileSync(found.configPath, "utf8"));
  let launchOptions = null;
  try { launchOptions = editor.readLaunchOptions(text, found.appId); } catch { launchOptions = null; }
  const current = String(launchOptions ?? "");
  let editable = true;
  let editableReason = "";
  try { editor.buildFlagOptions(current, STABILITY_FLAG, current.split(/\s+/u).includes(STABILITY_FLAG)); }
  catch (error) { editable = false; editableReason = String(error?.message ?? error); }
  return {
    supported: true, flag: STABILITY_FLAG, feature: FEATURE_NAME,
    appId: found.appId, configPath: found.configPath, toolPath,
    gameRoot: found.gameRoot,
    launchOptions: current,
    enabled: current.split(/\s+/u).includes(STABILITY_FLAG),
    editable,
    editableReason,
    crashes,
    suggest: !current.includes(STABILITY_FLAG) && crashes.sameModule >= SUGGEST_AFTER,
    hint: editable
      ? "改启动项前需要先完全退出 Steam。"
      : "你的启动项不是纯参数形式（含引号或包装命令），程序不自动改，可以按下面给出的内容手动添加。",
  };
}

export async function setGameStability({ databasePath, enabled } = {}) {
  const found = await locate(databasePath);
  if (!found.ok) throw httpError(400, "没找到游戏或 Steam 配置，无法修改启动项", "GAME_NOT_LOCATED");
  const { module: editor, path: toolPath } = await loadSteamEditor(found.userDataDir);
  const on = enabled === true || enabled === "true";
  const text = String(readFileSync(found.configPath, "utf8"));
  const previous = String(editor.readLaunchOptions(text, found.appId) ?? "");
  const configHash = await sha256Of(found.configPath);
  const result = await editor.configureGameFlag({
    mode: "apply",
    configPath: found.configPath,
    appId: found.appId,
    flag: STABILITY_FLAG,
    enabled: on,
    backupDirectory: join(found.userDataDir, "Backups", "steam-launcher"),
    expectedHash: configHash,
  });
  return {
    changed: result.changed === true,
    enabled: on,
    launchOptions: result.next ?? "",
    previous,
    backupPath: result.backupPath ?? "",
    appId: found.appId,
  };
}

async function sha256Of(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// ---------------------------------------------------------------- 路由

export async function createGameStabilityRoutes({ databasePath } = {}) {
  return async function handleGameStabilityRoute(req, url) {
    const path = String(url?.pathname ?? "").replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (!path.startsWith("/listen-naming/game-stability/")) return null;

    if (req.method === "GET" && path === "/listen-naming/game-stability/status")
      return await gameStabilityStatus({ databasePath });

    if (req.method === "POST" && path === "/listen-naming/game-stability/toggle") {
      const body = await readJson(req);
      if (typeof body?.enabled !== "boolean")
        throw httpError(400, "请明确要开启还是关闭", "GAME_STABILITY_BODY_INVALID");
      try {
        return await setGameStability({ databasePath, enabled: body.enabled });
      } catch (error) {
        if (/STEAM_RUNNING/u.test(String(error?.message ?? "")))
          throw httpError(409, "请先完全退出 Steam 再修改启动项", "STEAM_RUNNING");
        throw error;
      }
    }

    return null;
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw httpError(413, "请求体过大", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; }
  catch { throw httpError(400, "请求内容不是合法 JSON", "BODY_INVALID"); }
}
