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
const USER_DATA = process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData");
const DATABASE_PATH = process.env.OLIVIA_LISTEN_DB || join(USER_DATA, "database", "olivia-local.sqlite");
const CATALOG_CACHE = join(USER_DATA, "community-catalog.json");

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

async function checkDatabase() {
  try {
    await access(DATABASE_PATH, FS.R_OK | FS.W_OK);
    const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM user_songs WHERE removed_at IS NULL").get();
    db.close();
    return { name: "数据库", ok: true, detail: `可读写，共 ${count?.n ?? "?"} 首作品`, fix: "", path: DATABASE_PATH };
  } catch (error) {
    return { name: "数据库", ok: false, detail: String(error.message).slice(0, 120), fix: "确认本程序有权限访问自己的数据目录；必要时重装", path: DATABASE_PATH };
  }
}

async function checkLibrary() {
  try {
    const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'midi_library_root'").get();
    db.close();
    const root = String(row?.value ?? "").trim();
    if (!root) return { name: "曲库目录", ok: false, detail: "应用里还没设置", fix: "在 OliviaSoul 的「基础设置」里设置曲目存储路径", path: "" };
    const info = await stat(root);
    return { name: "曲库目录", ok: info.isDirectory(), detail: root, fix: "", path: root };
  } catch (error) {
    return { name: "曲库目录", ok: false, detail: String(error.message).slice(0, 120), fix: "确认曲库所在磁盘已连接、路径未改名", path: "" };
  }
}

async function checkCatalog() {
  if (!existsSync(CATALOG_CACHE)) {
    return { name: "社区名单缓存", ok: true, detail: "还没拉取过（首次点「刷新名单」即可）", fix: "", path: "" };
  }
  try {
    const document = JSON.parse(await readFile(CATALOG_CACHE, "utf8"));
    const count = Object.keys(document.entries ?? {}).length;
    return { name: "社区名单缓存", ok: true, detail: `${count} 条`, fix: "", path: CATALOG_CACHE };
  } catch (error) {
    return { name: "社区名单缓存", ok: false, detail: String(error.message).slice(0, 120), fix: "点「刷新名单」重新拉取", path: CATALOG_CACHE };
  }
}

export async function dependencyReport() {
  const items = [
    await checkFfmpeg("ffmpeg"),
    await checkFfmpeg("ffprobe"),
    await checkWebView2(),
    { name: "Node 运行时", ok: true, detail: `内置 ${process.version}`, fix: "", path: process.execPath },
    await checkDatabase(),
    await checkLibrary(),
    await checkCatalog(),
  ];
  return {
    items,
    required: items.filter(item => !item.ok).map(item => item.name),
    ok: items.every(item => item.ok),
    installRoot: INSTALL_ROOT,
    userData: USER_DATA,
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

/** 路由工厂：与其它模块同风格；返回 null 表示"不是我的路由"。 */
export async function createDependencyCheckRoutes() {
  return async function handle(req, url) {
    const path = routePathOf(url).replace(/^\/toy/u, "").replace(/^\/admin\/api/u, "");
    if (req.method === "GET" && path === "/listen-naming/dependencies") return dependencyReport();
    if (req.method === "POST" && path === "/listen-naming/dependencies/install-webview2") return installWebView2();
    return null;
  };
}
