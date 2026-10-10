// 提权命令模板的护栏（2026-10-11）。
//
// 背景：原来的写法把 Start-Process 直接放在顶层、结尾裸写 exit $process.ExitCode，
// 用户取消 UAC 时 Start-Process 抛的是非终止错误 → 脚本继续 → $process 为 $null →
// exit $null.ExitCode 等于 exit 0 → 上层以为补丁写入成功，最后抛出一句
// 「更新后自检未通过」，真实原因（授权被取消、一个字节都没写）被完全掩盖。
//
// 这组用例同时钉住两件事：
// ① 生成的命令必须「先失败先报错」，绝不静默成功；
// ② controller.js / main.js 里不得再出现裸的旧模板（防回归）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ELEVATION_CANCELLED_HINT,
  ELEVATION_NO_EXIT_CODE_MESSAGE,
  ELEVATION_NO_PROCESS_MESSAGE,
  describeElevationFailure,
  elevatedProcessCommand,
} from "../desktop/elevation-command.js";

const desktopDirectory = resolve(new URL("../desktop", import.meta.url).pathname.replace(/^\//u, ""));
const sourceOf = name => readFile(join(desktopDirectory, name), "utf8");

function powershellExecutable() {
  const root = process.env.SystemRoot;
  const classic = root ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
  if (classic && existsSync(classic)) return classic;
  return "powershell.exe";
}

// 受限沙箱里 node→子进程的 spawn 会被拦（EPERM），此时跳过真实执行类用例，
// 与 installer-chinese / packaging-artifact 的豁免口径一致。
function powershellRunnable() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
  return probe.status === 0;
}

test("生成的命令先设 Stop，并把 Start-Process 包进 try/catch", () => {
  const command = elevatedProcessCommand({ encodedCommand: "QUJD", errorFile: "C:\\t\\e.txt" });
  assert.match(command, /\$ErrorActionPreference = 'Stop';/u, "必须以 Stop 开头，否则 Start-Process 失败只是非终止错误");
  assert.match(command, /try \{ \$process = Start-Process/u, "Start-Process 必须在 try 里");
  assert.match(command, /catch \{/u, "必须有 catch");
  assert.ok(command.includes("C:\\t\\e.txt"), "错误文件路径要写进命令");
});

test("生成命令里所有 exit 路径都在守卫之后，不存在裸的 exit $process.ExitCode", () => {
  const command = elevatedProcessCommand({ encodedCommand: "QUJD", errorFile: "C:\\t\\e.txt" });
  const catchIndex = command.indexOf("catch {");
  const nullGuardIndex = command.indexOf("if (-not $process)");
  const codeGuardIndex = command.indexOf("if ($null -eq $process.ExitCode)");
  const finalExitIndex = command.indexOf("exit $process.ExitCode");
  assert.ok(catchIndex > 0 && nullGuardIndex > catchIndex, "拿不到进程句柄必须先于最终 exit");
  assert.ok(codeGuardIndex > nullGuardIndex, "退出码缺失也必须先于最终 exit");
  assert.ok(finalExitIndex > codeGuardIndex, "最终 exit 必须排在所有守卫之后");
  assert.equal(command.indexOf("exit 1") > 0, true, "失败路径必须 exit 1");
});

test("错误文件路径里的单引号被转义，不会破坏命令", () => {
  const command = elevatedProcessCommand({ encodedCommand: "QUJD", errorFile: "C:\\it's\\e.txt" });
  assert.ok(command.includes("'C:\\it''s\\e.txt'"), `单引号应被翻倍转义：${command}`);
});

test("verb 传空串时不生成 -Verb RunAs（测试用的不提权失败路径）", () => {
  const command = elevatedProcessCommand({ encodedCommand: "QUJD", errorFile: "C:\\t\\e.txt", verb: "" });
  assert.equal(command.includes("-Verb"), false, "verb 为空时不应出现 -Verb");
  assert.equal(elevatedProcessCommand({ encodedCommand: "QUJD", errorFile: "C:\\t\\e.txt" }).includes("-Verb 'RunAs'"), true, "默认必须仍走 RunAs");
});

test("describeElevationFailure：取消类错误换成明确中文，其余原样保留", () => {
  const cancelled = describeElevationFailure("The operation was canceled by the user.");
  assert.ok(cancelled.includes(ELEVATION_CANCELLED_HINT), `应给出取消提示：${cancelled}`);
  assert.ok(cancelled.includes("canceled"), "原始报错要被保留，便于排查");
  assert.equal(describeElevationFailure("磁盘空间不足"), "磁盘空间不足");
  assert.equal(describeElevationFailure(""), ELEVATION_CANCELLED_HINT);
});

test("真实失败路径：启动一个不存在的程序必须 exit 1 并写下错误文件", async t => {
  if (!powershellRunnable()) {
    t.skip("受限环境跑不了 powershell 子进程（沙箱 spawn 被拦）");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "olivia-elevation-"));
  try {
    const errorFile = join(directory, "error.txt");
    const command = elevatedProcessCommand({
      encodedCommand: "QUJD",
      errorFile,
      fileName: join(directory, "definitely-missing-program.exe"),
      verb: "",
    });
    const result = spawnSync(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
    assert.equal(result.status, 1, `失败必须 exit 1，实际 ${result.status}；stderr=${result.stderr}`);
    const written = (await readFile(errorFile, "utf8")).trim();
    assert.ok(written.length > 0, "必须写下错误原因，不能静默");
    assert.ok(written.includes(ELEVATION_CANCELLED_HINT), `错误文件应含提示语：${written}`);
    assert.match(command, /exit 1/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller.js 与 main.js 不得再出现裸的 Start-Process 旧模板", async () => {
  for (const name of ["controller.js", "main.js"]) {
    const source = await sourceOf(name);
    assert.equal(source.includes("$process = Start-Process"), false, `${name} 里又出现了顶层 Start-Process 旧写法`);
    assert.ok(source.includes("elevatedProcessCommand"), `${name} 应改用 elevatedProcessCommand`);
  }
});

test("controller.js 的 runElevatedScripts 先不提权执行，只有失败才提权", async () => {
  const source = await sourceOf("controller.js");
  const start = source.indexOf("async runElevatedScripts(");
  assert.ok(start > 0, "找不到 runElevatedScripts");
  const body = source.slice(start, source.indexOf("\n  async elevationError(", start));
  const direct = body.indexOf("powershellCommand(command)");
  const elevated = body.indexOf("elevatedProcessCommand");
  assert.ok(direct > 0, "必须先尝试按当前用户身份执行");
  assert.ok(elevated > direct, "提权只能作为失败后的兜底，且排在直接执行之后");
  assert.match(body, /needsElevation/u, "只有权限不足时才提权");
});

test("兜底文案都在（避免误改成空字符串）", () => {
  assert.ok(ELEVATION_NO_PROCESS_MESSAGE.length > 0);
  assert.ok(ELEVATION_NO_EXIT_CODE_MESSAGE.length > 0);
  assert.ok(ELEVATION_CANCELLED_HINT.includes("没有被改动"));
});
