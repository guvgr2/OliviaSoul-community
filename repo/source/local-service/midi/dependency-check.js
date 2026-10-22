// 依赖自检：告诉用户"跑起来需要的东西"在不在，缺了怎么办
//
// 检查项都是**只读探测**，不会修改任何东西：
//   ffmpeg / ffprobe  —— 随程序打包在 <安装目录>\runtime\ffmpeg\bin
//   WebView2 运行时   —— 系统必要依赖（安装包会自动装）
//   Node 运行时       —— 随程序打包
//   数据库            —— 能不能读写
//   曲库目录          —— 应用设置里配的路径在不在
//   社区名单缓存      —— 有没有拉到过
import { existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
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
const INSTALL_ROOT = resolve(here, "..", "..");

// ★ E4（2026-10-18 独立审查报告-1）：数据路径**必须由调用方传进来**，不能靠模块级常量。
//   旧写法是 `process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData")`，而 server.js 从不设
//   那个环境变量 ⇒ 界面「依赖检查」报的数据库是「程序目录下的 UserData\database\olivia-local.sqlite」
//   （实测 ENOENT，指向工作区源码目录），面板上「程序目录 / 数据目录」也整个指错。同一类 bug 在
//   1.0.8 / 1.0.9 各修过一次（listen-naming、time-of-day），这里是漏修的第三、四处。
//   现在的形状：调用方（server.js）把真实的 dataDir 传进 createDependencyCheckRoutes；
//   不传时退回环境变量与旧默认值 —— 只为了让独立调用仍能工作，不是正常路径。
function resolvePaths({ dataDir, databasePath } = {}) {
  const userData = dataDir
    ? resolve(dataDir)
    : (process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData"));
  return {
    userData,
    databasePath: databasePath
      ? resolve(databasePath)
      : (process.env.OLIVIA_LISTEN_DB || join(userData, "database", "olivia-local.sqlite")),
    catalogCache: join(userData, "community-catalog.json"),
  };
}

// 默认路径不预先生成：`resolvePaths()` 在每次调用时现算，避免把「模块加载那一刻」的环境变量
// 钉死成常量 —— 那正是 E4 的成因（server.js 后来才拿到 dataDir，模块却已经记死了旧值）。

function runVersion(exe) {
  return new Promise(resolvePromise => {
    let child;
    try {
      child = spawn(exe, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolvePromise("");
      return;
    }
    let text = "";
    child.stdout.on("data", chunk => { text += chunk.toString("utf8"); });
    child.on("error", () => resolvePromise(""));
    child.on("close", () => resolvePromise(text.split("\n")[0] || ""));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(text.split("\n")[0] || ""); }, 5000);
  });
}

async function checkFfmpeg(kind) {
  const name = `${kind}.exe`;
  const candidates = [
    process.env.OLIVIA_FFMPEG && kind === "ffmpeg" ? process.env.OLIVIA_FFMPEG : "",
    join(here, "..", "runtime", "ffmpeg", "bin", name),
    join(here, "..", "..", "runtime", "ffmpeg", "bin", name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = await runVersion(candidate);
    return {
      name,
      ok: Boolean(version),
      detail: version || "文件在，但执行失败",
      fix: version ? "" : "文件可能损坏，重新安装本程序即可恢复",
      path: candidate,
    };
  }
  return {
    name,
    ok: false,
    detail: "没找到（既不在程序目录，也不在系统 PATH）",
    fix: "重新安装本程序；或把 ffmpeg.exe 放到程序目录的 runtime\\ffmpeg\\bin 下",
    path: "",
  };
}

async function checkWebView2() {
  const roots = [
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "EdgeWebView", "Application"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "EdgeWebView", "Application"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    return { name: "WebView2 运行时", ok: true, detail: "已安装", fix: "", path: root };
  }
  return {
    name: "WebView2 运行时",
    ok: false,
    detail: "未检测到",
    fix: "这是本程序的【必要依赖】。重新运行安装包会自动安装；或到微软官网搜索 WebView2 Runtime 手动安装",
    path: "",
  };
}

async function checkDatabase(paths) {
  try {
    await access(paths.databasePath, FS.R_OK | FS.W_OK);
    const db = new DatabaseSync(paths.databasePath, { readOnly: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM user_songs WHERE removed_at IS NULL").get();
    db.close();
    return { name: "数据库", ok: true, detail: `可读写，共 ${count?.n ?? "?"} 首作品`, fix: "", path: paths.databasePath };
  } catch (error) {
    return { name: "数据库", ok: false, detail: String(error.message).slice(0, 120), fix: "确认本程序有权限访问自己的数据目录；必要时重装", path: paths.databasePath };
  }
}

async function checkLibrary(paths) {
  try {
    const db = new DatabaseSync(paths.databasePath, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'midi_library_root'").get();
    db.close();
    const root = String(row?.value ?? "").trim();
    if (!root) return { name: "曲库目录", ok: false, detail: "应用里还没设置", fix: "到「客户端与歌词 → 客户端挂载与存储」的「数据与曲目保存位置」里设置曲目存储路径", path: "" };
    const info = await stat(root);
    return { name: "曲库目录", ok: info.isDirectory(), detail: root, fix: "", path: root };
  } catch (error) {
    return { name: "曲库目录", ok: false, detail: String(error.message).slice(0, 120), fix: "确认曲库所在磁盘已连接、路径未改名", path: "" };
  }
}

async function checkCatalog(paths) {
  if (!existsSync(paths.catalogCache)) {
    return { name: "社区名单缓存", ok: true, detail: "还没拉取过（首次点「刷新名单」即可）", fix: "", path: "" };
  }
  try {
    const document = JSON.parse(await readFile(paths.catalogCache, "utf8"));
    const count = Object.keys(document.entries ?? {}).length;
    return { name: "社区名单缓存", ok: true, detail: `${count} 条`, fix: "", path: paths.catalogCache };
  } catch (error) {
    return { name: "社区名单缓存", ok: false, detail: String(error.message).slice(0, 120), fix: "点「刷新名单」重新拉取", path: paths.catalogCache };
  }
}

/**
 * 依赖自检报告。
 * @param {{ dataDir?: string, databasePath?: string }} [options]
 *        正常路径由 createDependencyCheckRoutes 从 server.js 传进来（真实 dataDir）；
 *        不传时退回 resolvePaths() 的默认值 —— 只有独立调用才会走到。
 */
export async function dependencyReport({ dataDir, databasePath } = {}) {
  const paths = resolvePaths({ dataDir, databasePath });
  const items = [
    await checkFfmpeg("ffmpeg"),
    await checkFfmpeg("ffprobe"),
    await checkWebView2(),
    { name: "Node 运行时", ok: true, detail: `内置 ${process.version}`, fix: "", path: process.execPath },
    await checkDatabase(paths),
    await checkLibrary(paths),
    await checkCatalog(paths),
  ];
  return {
    items,
    required: items.filter(item => !item.ok).map(item => item.name),
    ok: items.every(item => item.ok),
    installRoot: INSTALL_ROOT,
    userData: paths.userData,
  };
}

/** 启动随程序附带的 WebView2 引导程序（用户在前端确认后才会调用）。 */
export async function installWebView2() {
  const bootstrapper = join(INSTALL_ROOT, "redist", "MicrosoftEdgeWebview2Setup.exe");
  if (!existsSync(bootstrapper)) {
    throw new Error("程序目录里没有找到 redist\\MicrosoftEdgeWebview2Setup.exe，请重新安装本程序");
  }
  const child = spawn(bootstrapper, ["/silent", "/install"], { detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, path: bootstrapper };
}

/**
 * 路由工厂：与其它模块同风格；返回 null 表示"不是我的路由"。
 * @param {{ dataDir?: string, databasePath?: string }} [options]
 *        必须由 server.js 传入真实 dataDir：不传的话，界面「依赖检查」会报安装树里的假路径（E4）。
 */
export async function createDependencyCheckRoutes(options = {}) {
  return async function handle(req, url) {
    const path = routePathOf(url).replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (req.method === "GET" && path === "/listen-naming/dependencies") return dependencyReport(options);
    if (req.method === "POST" && path === "/listen-naming/dependencies/install-webview2") return installWebView2();
    return null;
  };
}
