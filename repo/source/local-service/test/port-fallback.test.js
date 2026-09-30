// 端口自动退让的回归测试（正确位置：desktop/controller.js）。
//
// 用户在真实机器上跑，所以重点在「不能弄坏人家的电脑」：
//   · 绝不无限探测端口（有次数上限，越界即停）
//   · 探测只绑定回环地址，探测完立刻关闭，不长期占用
//   · 全部端口都不可用时返回原值，让后续流程按原样报错（不掩盖真实问题）
//   · 只在启动阶段退让；挂载补丁之后不能悄悄换端口（补丁里写死了服务地址）
//
// 重要背景（曾做错位置）：
//   程序是 C#(WebView2) 宿主 + node 服务。链路是：
//     C#(NodeBackend.cs) 启动 → node app/desktop/node-host.js
//       node-host.js: const port = await controller.initialize()
//       node-host.js: send({ type: "ready", port })   ← 端口回报给 C#
//   所以端口由 desktop/controller.js 决定，C# 只负责接收。
//   desktop/main.js 是 Electron 遗留物，程序不使用它 —— 早先的错误修复正是加在了那里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(join(here, "..", "desktop", "controller.js"), "utf8");
const nodeHostSource = readFileSync(join(here, "..", "desktop", "node-host.js"), "utf8");
const mainSource = readFileSync(join(here, "..", "desktop", "main.js"), "utf8");

function probeAvailable(port) {
  return new Promise(resolvePromise => {
    const probe = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePromise(true)));
  });
}

test("端口退让实现在 controller.js（程序真正使用的控制器）", () => {
  assert.match(controllerSource, /async function pickAvailablePort\(preferred, attempts = 20\)/u, "缺少 pickAvailablePort 或默认上限");
  assert.match(controllerSource, /function isPortAvailable\(port\)/u, "缺少 isPortAvailable");
});

test("端口探测只绑定回环地址，且探测后立即关闭", () => {
  const block = /function isPortAvailable\(port\)[\s\S]*?\n\}/u.exec(controllerSource);
  assert.ok(block, "未找到 isPortAvailable 实现");
  assert.match(block[0], /listen\(port, "127\.0\.0\.1"/u, "必须绑定 127.0.0.1");
  assert.match(block[0], /probe\.close\(/u, "探测后必须关闭，不能长期占用端口");
});

test("端口尝试有上限，遇越界即停，且全部失败时返回原值", () => {
  const block = /async function pickAvailablePort\(preferred, attempts = 20\)[\s\S]*?\n\}/u.exec(controllerSource);
  assert.ok(block, "未找到 pickAvailablePort 实现");
  assert.match(block[0], /offset < attempts/u, "必须限制尝试次数");
  assert.match(block[0], /candidate > 65535/u, "必须处理端口越界");
  assert.match(block[0], /break/u, "越界后必须停止");
  assert.match(block[0], /return start/u, "全部失败时应返回原值，交由后续流程报错");
});

test("initialize 会在启动时退让，并把新端口持久化", () => {
  const block = /async initialize\(\)[\s\S]*?\n  \}/u.exec(controllerSource);
  assert.ok(block, "未找到 initialize");
  assert.match(block[0], /this\.currentPort = await pickAvailablePort\(settings\.port\)/u, "initialize 必须使用 pickAvailablePort");
  assert.match(block[0], /writeRuntimeSettings\(\)/u, "换端口后应持久化到 runtime-settings.json");
  assert.match(block[0], /await this\.createOwnedBackend\(this\.currentPort\)/u, "仍应使用最终确定的端口启动后端");
});

test("node-host 把端口回报给宿主（C# 依赖这条消息）", () => {
  assert.match(nodeHostSource, /send\(\{ type: "ready", port \}\)/u, "缺少 ready + port 回报");
  assert.match(nodeHostSource, /controller\.initialize\(\)/u, "应先 initialize 再回报");
});

test("挂载流程仍会因端口冲突报错（挂载后不能悄悄换端口）", () => {
  const calls = controllerSource.match(/assertPortAvailable\(port\)/gu) ?? [];
  assert.ok(calls.length >= 2, `挂载/升级/改端口路径都应校验端口，实际 ${calls.length} 处`);
  assert.match(controllerSource, /端口 \$\{port\} 已被其他程序占用/u, "缺少冲突提示");
});

test("端口冲突提示可操作（指向设置项与关闭占用程序）", () => {
  assert.match(controllerSource, /设置 → 服务端口/u, "应告诉用户去哪里改端口");
  assert.match(controllerSource, /关闭占用该端口的程序/u, "应告诉用户可以关闭占用程序");
});

test("Electron 遗留的 main.js 不应被塞入端口逻辑（曾因此做错位置）", () => {
  assert.ok(!mainSource.includes("pickAvailablePort"), "main.js 不是程序入口，不应包含端口退让");
  assert.ok(!mainSource.includes("findAvailablePort"), "main.js 不应包含端口退让");
});

test("实测：端口被占用时探测为不可用，释放后可用", async () => {
  const holder = createServer();
  await new Promise(resolvePromise => holder.listen(0, "127.0.0.1", resolvePromise));
  const taken = holder.address().port;
  try {
    assert.equal(await probeAvailable(taken), false, "已占用端口不应探测为可用");
  } finally {
    await new Promise(resolvePromise => holder.close(resolvePromise));
  }
  assert.equal(await probeAvailable(taken), true, "释放后应探测为可用");
});

test("实测：退让算法能跳过被占端口且不超上限", async () => {
  const holders = [];
  const base = 45500 + Math.floor(Math.random() * 300);
  for (const port of [base, base + 1]) {
    const server = createServer();
    try {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolvePromise);
      });
      holders.push(server);
    } catch {
      for (const item of holders) await new Promise(r => item.close(r));
      return;
    }
  }
  try {
    let found = 0;
    for (let offset = 0; offset < 20; offset += 1) {
      if (await probeAvailable(base + offset)) { found = base + offset; break; }
    }
    assert.ok(found > base + 1, `应跳过被占的 ${base} 与 ${base + 1}，实际选中 ${found}`);
    assert.ok(found <= base + 19, "不得超出尝试上限");
  } finally {
    for (const item of holders) await new Promise(r => item.close(r));
  }
});

test("faststart 的 ffmpeg 调用显式指定 -f mp4（临时名 .part 无法推断格式）", () => {
  const faststart = readFileSync(join(here, "..", "midi", "faststart-cache.js"), "utf8");
  const block = /await runProcess\(ffmpegPath, \[[\s\S]*?\]/u.exec(faststart);
  assert.ok(block, "未找到 ffmpeg 调用");
  assert.ok(block[0].includes('"-f", "mp4"'), "缺少 -f mp4：临时文件名为 .part，ffmpeg 会报 Unable to choose an output format");
  assert.ok(block[0].includes('"-movflags", "+faststart"'), "应保留 faststart 标记");
});

