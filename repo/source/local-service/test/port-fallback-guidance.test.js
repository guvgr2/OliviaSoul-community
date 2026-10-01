// 端口退让后的用户引导（1.0.1 遗留缺口）。
//
// 真实故障链：
//   1. 启动时首选端口 27149 被别的程序占用 → controller.js 自动退让到 27150（1.0.1 新增）
//   2. 游戏端补丁里写死的是 http://127.0.0.1:27149
//   3. 于是「程序正常启动」，但游戏连不上本机服务 —— 而界面上没有任何可操作指引
//
// 曾存在的界面缺陷（本套件钉死）：
//   app.js 里 `$("#mountService").hidden = status.mounted && !status.updateAvailable`
//   —— 端口不一致时 mounted=true、updateAvailable=false（补丁版本没变），
//   主按钮被**隐藏**，用户只能看到「端口状态异常」，却无处可点。
//
// 做法：把「端口不一致」提升为可操作状态（按钮可见 + 说清后果 + 指向重打补丁），
// 并让后端把「退让前的原端口」一并回报，界面才能解释端口为什么变了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DesktopController } from "../desktop/controller.js";

const run = promisify(execFile);
const powershell = (args) => run("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args]);

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(join(here, "..", "desktop", "controller.js"), "utf8");
const appSource = readFileSync(join(here, "..", "public", "app.js"), "utf8");

/** 占用一个随机的高位端口，返回 holder（保持占用）与端口号。 */
async function occupyRandomPort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const holder = createServer();
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(0, "127.0.0.1", resolve);
    });
    const port = holder.address().port;
    // 留出退让空间：pickAvailablePort 最多往后找 20 个端口。
    if (port <= 65500) return { holder, port };
    await new Promise(resolve => holder.close(resolve));
  }
  throw new Error("未能取得可用的测试端口");
}

async function readSettingsPort(file) {
  return readFile(file, "utf8").then(text => JSON.parse(text).port, () => null);
}

async function waitForPort(file, expected) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await readSettingsPort(file);
    if (value === expected || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** 造一个不起真实后端的 controller：只替换 createOwnedBackend，其余逻辑保持真实。 */
async function makeController(root, appData, settings) {
  await mkdir(appData, { recursive: true });
  await writeFile(join(appData, "desktop-settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const controller = new DesktopController({
    root,
    dataDir: join(root, "data"),
    appData,
    executable: join(root, "OliviaSoul.exe"),
    onPortChanged() {},
  });
  const started = [];
  controller.createOwnedBackend = async port => { started.push(port); };
  return { controller, started };
}

test("实测：首选端口被占用时自动退让，并记下原端口供界面解释", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-port-guide-"));
  const { holder, port: taken } = await occupyRandomPort();
  t.after(async () => {
    await new Promise(resolve => holder.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const appData = join(root, "app-data");
  const { controller, started } = await makeController(root, appData, { port: taken, clientExe: "" });

  const port = await controller.initialize();

  assert.notEqual(port, taken, `被占用的 ${taken} 不应仍被选用`);
  assert.ok(port > taken, `应往后找端口，实际 ${port}`);
  assert.ok(port <= taken + 19, `不得超出尝试上限，实际 ${port}`);
  assert.equal(controller.portFallbackFrom, taken, "必须记下退让前的原端口");
  assert.deepEqual(started, [port], "后端必须以最终端口启动");

  // 新端口要持久化：否则用户重启一次就回到被占端口，又退让一次，且界面无从解释。
  assert.equal(await waitForPort(join(appData, "desktop-settings.json"), port), port,
    "退让后的端口必须写回设置");
});

test("实测：首选端口空闲时不记录退让来源（不能无中生有）", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-port-guide-"));
  const { holder, port: free } = await occupyRandomPort();
  // 释放它，得到一个确信空闲的端口号。
  await new Promise(resolve => holder.close(resolve));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const appData = join(root, "app-data");
  const { controller, started } = await makeController(root, appData, { port: free, clientExe: "" });

  const port = await controller.initialize();

  assert.equal(port, free, "端口空闲时应原样使用");
  assert.equal(controller.portFallbackFrom, null, "没有退让就不应记录来源端口");
  assert.deepEqual(started, [free]);
});

test("实测：退让来源端口随状态一起回报给界面（未选客户端也能拿到）", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-port-guide-"));
  const { holder, port: taken } = await occupyRandomPort();
  t.after(async () => {
    await new Promise(resolve => holder.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const appData = join(root, "app-data");
  const { controller } = await makeController(root, appData, { port: taken, clientExe: "" });
  await controller.initialize();

  const status = await controller.getClientStatus();

  assert.equal(status.servicePort, controller.currentPort, "必须回报当前真实服务端口");
  assert.equal(status.portFallbackFrom, taken, "必须回报退让前的原端口");
  assert.equal(status.clientSelected, false, "未选客户端时的分支也要带上这两个字段");
});

test("源码：getClientStatus 两个分支都带上退让来源端口与播放器端口", () => {
  // 已选客户端的分支是真实使用中走的那一支，未选分支用于「还没选游戏 exe」的阶段。
  // 用 includes 而不是正则：断言失败时正则会把这 3 万字的源码整个打印出来。
  assert.ok(controllerSource.includes(
    "servicePort: this.currentPort,\n      portFallbackFrom: this.portFallbackFrom,\n      backupReuseSources"),
  "getClientStatus 的已选客户端分支缺少 portFallbackFrom");
  assert.ok(controllerSource.includes("webplayerPort: webplayer.port ?? null,"),
    "已选客户端分支必须回报播放器补丁的端口，否则漏判「只同步了一半」");
  assert.ok(controllerSource.includes(
    "port: null,\n      webplayerPort: null,\n      servicePort: this.currentPort,\n      portFallbackFrom: this.portFallbackFrom,"),
  "getClientStatus 的未选客户端分支缺少 portFallbackFrom / webplayerPort");
});

test("界面：端口不一致时「重打补丁」按钮必须可见（曾因隐藏按钮而无路可走）", () => {
  const hidden = /#mountService"\)\.hidden = ([^;]+);/u.exec(appSource);
  assert.ok(hidden, "未找到主按钮的显示逻辑");
  assert.match(hidden[1], /!portMismatch/u,
    "端口不一致时不能隐藏主按钮：那样用户看得到异常却点不到修复");

  const label = /#mountService"\)\.textContent = ([\s\S]*?);\n/u.exec(appSource);
  assert.ok(label, "未找到主按钮文案");
  assert.match(label[1], /重打补丁（同步端口）/u, "端口不一致时按钮要说清它做什么");
});

test("界面：端口不一致必须说清后果与操作路径", () => {
  assert.match(appSource, /游戏端补丁还指向端口 \$\{stalePort\}/u, "要指出补丁里的旧端口");
  assert.match(appSource, /会连不上本机服务/u, "要说明后果：游戏连不上");
  assert.match(appSource, /请点上方「重打补丁（同步端口）」/u, "要给出下一步操作");
  assert.match(appSource, /完成后再启动游戏/u, "要说明操作顺序（打完补丁再进游戏）");
});

test("界面：端口问题与「补丁待更新」在提示上是两件事", () => {
  const notice = /tabNotices\.set\('desktop', 'health', ([\s\S]*?)\);/u.exec(appSource);
  assert.ok(notice, "未找到页签提示逻辑");
  assert.match(notice[1], /portMismatch/u, "提示必须覆盖端口不一致");
  assert.match(notice[1], /服务端口已变更/u, "端口问题要有自己的提示文案，不能混进「挂载或端口状态异常」");
  const badge = /badge\.textContent = ([\s\S]*?);\n/u.exec(appSource);
  assert.ok(badge, "未找到状态徽章");
  assert.match(badge[1], /端口已变更，需重打补丁/u, "徽章要直接可读");
});

test("界面：端口不一致的判定同时看 feapp 与 webplayer 的端口", () => {
  assert.match(appSource, /function stalePatchPort\(status\) \{/u, "缺少统一的「取对不上的那个端口」函数");
  assert.match(appSource, /\[status\?\.port, status\?\.webplayerPort\]/u,
    "必须同时比对两个补丁文件的端口：只比 feapp 会漏掉播放器");
  assert.match(appSource, /value != null && value !== status\.servicePort/u, "端口未知时不能误报");
  assert.match(appSource, /const portMismatch = status\.mounted === true && stalePort !== null;/u,
    "已挂载且确实存在对不上的端口时才算端口问题");
});

test("界面：端口为什么变了要能解释（用后端回报的原端口）", () => {
  assert.match(appSource, /status\.portFallbackFrom/u, "文案应使用后端回报的退让来源端口");
  assert.match(appSource, /启动时原端口 \$\{status\.portFallbackFrom\} 被别的程序占用/u, "要明确解释原因");
});

// —— 播放器补丁的端口（keepWebplayer 依赖它）——
// 本次审查发现的既有 bug：
//   mountClientResources 里 `const keepWebplayer = ... && currentWebplayer.port === port`，
//   而 get-webplayer-status.ps1 根本不输出 port —— currentWebplayer.port 恒为 undefined，
//   于是 keepWebplayer 恒为 false：每次更新 FE 补丁都会连带重打播放器补丁，
//   「FE-only 升级不打扰当前播放器」的设计意图从未生效。
test("实测：播放器状态脚本会报出补丁里的服务端口", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-webplayer-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 注意：不能用 PowerShell 的 ZipFile::CreateFromDirectory 造这个 fixture ——
  // PS 5.1（.NET Framework）会把条目名写成反斜杠 `assets\main-test.js`，
  // 而状态脚本要求正斜杠 `assets/main-*.js`（真实补丁包就是正斜杠）。
  // 这里显式指定条目名，内容从文件读入，免得把 JS 文本塞进命令行。
  const payloadPath = join(root, "payload.js");
  await writeFile(payloadPath,
    "/*OliviaSoulPatch:webplayer-instant-seamless-v19*/"
    + "const a='http://127.0.0.1:27149/toy/player-command';"
    + "const b='http://127.0.0.1:27149/toy/player-state';"
    + "const c='__OliviaSoulPlayerPoll';", "utf8");
  const zipPath = `${root}.dat`;
  t.after(() => rm(zipPath, { force: true }));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  await powershell(["-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + `$zip = [IO.Compression.ZipFile]::Open(${quote(zipPath)}, 'Create'); `
    + "$entry = $zip.CreateEntry('assets/main-test.js'); $stream = $entry.Open(); "
    + `$bytes = [IO.File]::ReadAllBytes(${quote(payloadPath)}); `
    + "$stream.Write($bytes, 0, $bytes.Length); $stream.Dispose(); $zip.Dispose()"]);

  const { stdout } = await powershell(["-File", join(here, "..", "..", "tools", "get-webplayer-status.ps1"),
    "-WebplayerPath", zipPath]);
  const status = JSON.parse(stdout);

  assert.equal(status.mounted, true, "补丁状态应被认出来，否则本用例没测到端口提取");
  assert.equal(status.port, 27149, "必须报出补丁里写死的服务端口");
});

test("源码：播放器端口的提取不得参与挂载判定", () => {
  const source = readFileSync(join(here, "..", "..", "tools", "get-webplayer-status.ps1"), "utf8");
  const managedAt = source.indexOf("$managed =");
  const mountedAt = source.indexOf("$mounted =");
  assert.ok(managedAt >= 0 && mountedAt > managedAt, "未找到 managed 判定");
  assert.ok(!source.slice(managedAt, mountedAt).includes("$port"),
    "managed 判定不得引用 $port：把已打补丁的文件误判成干净原版，之后再也恢复不回去");
  assert.match(source, /revision = \$revision; port = \$port/u, "必须把 port 一起输出给调用方");
});

test("界面：重打补丁用的端口取自输入框（不存在「陈旧值」这种情形）", () => {
  assert.match(appSource, /const port = \$\("#servicePort"\)\.value;/u, "端口应取自输入框");
  assert.ok(!appSource.includes("dataset.programValue"),
    "不要为「输入框停在旧端口」加防护：getSettings 返回的是内存中的当前端口，该情形不存在");
});

test("界面：启用/重打完成的校验要包含端口一致", () => {
  const verified = /const verified = ([\s\S]*?);\n/u.exec(appSource);
  assert.ok(verified, "未找到完成校验");
  assert.match(verified[1], /stalePatchPort\(status\) === null/u,
    "补丁端口没同步干净时不能报「服务已启用」，否则用户会带着连不上的补丁去启动游戏");
});
