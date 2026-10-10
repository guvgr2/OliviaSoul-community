import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopController } from "../desktop/controller.js";

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
async function fixture(t, { driveType = 4, processes = [{ Name: "unrelated.exe", ExecutablePath: "C:\\Other\\unrelated.exe" }], available = true, probeOutput, processError = false, denyDirect = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-network-fixture-"));
  const script = join(root, "write-fixture.ps1"), marker = join(root, "arguments.json");
  await writeFile(script, `param([string]$GameRoot,[string]$Version,[string]$OriginalFile,[switch]$RefreshOriginal)
[ordered]@{gameRoot=$GameRoot;version=$Version;original=$OriginalFile;refresh=[bool]$RefreshOriginal} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${literal(marker)} -Encoding UTF8`);
  const controller = new DesktopController({ root, dataDir: root, appData: root, executable: join(root, "unused.exe") });
  controller.clientExePath = "N:\\Games\\Example\\Launcher.exe";
  const original = childProcess.spawn;
  const observed = { elevated: 0, direct: 0 };
  let onDirect;
  const directStarted = new Promise(resolve => { onDirect = resolve; });
  childProcess.spawn = (command, args, options) => {
    const outer = Buffer.from(args.at(-1), "base64").toString("utf16le");
    const inner = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(outer)?.[1];
    if (outer.includes("Win32_LogicalDisk") && probeOutput !== undefined) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      if (probeOutput !== "timeout") setImmediate(() => { child.stdout.emit("data", Buffer.from(probeOutput)); child.emit("close", 0); });
      return child;
    }
    if (inner) observed.elevated++;
    else if (outer.includes(script)) {
      observed.direct++; onDirect();
      // denyDirect：模拟「当前用户对该目录没有写权限」。runProcess 把 stderr 文本
      // 当作 error.message，needsElevation 据此判定「只有权限不足才值得提权」。
      if (denyDirect) {
        const denied = new EventEmitter();
        denied.stdout = new EventEmitter(); denied.stderr = new EventEmitter(); denied.kill = () => true;
        setImmediate(() => { denied.stderr.emit("data", Buffer.from("拒绝访问")); denied.emit("close", 1); });
        return denied;
      }
    }
    const prefix = `function Test-Path { param($LiteralPath,$PathType) return $${available} }; function Get-CimInstance { param($ClassName,$Filter,$ErrorAction,$OperationTimeoutSec) if ($ClassName -eq 'Win32_LogicalDisk') { [pscustomobject]@{DriveType=${driveType}} } elseif ($ClassName -eq 'Win32_Process') { ${processError ? "throw 'visibility unavailable'" : `ConvertFrom-Json ${literal(JSON.stringify(processes))}`} } else { throw 'Unexpected probe' } }; `;
    const code = prefix + (inner ? Buffer.from(inner, "base64").toString("utf16le") : outer);
    return original(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], options);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  return { controller, script, marker, observed, root, directStarted };
}

test("mapped network clientWrite executes fixture directly with exact selected arguments", async t => {
  const ctx = await fixture(t);
  await ctx.controller.clientWrite(ctx.script, ["-GameRoot", "N:\\Games\\Example", "-Version", "test", "-OriginalFile", "literal.dat"]);
  assert.equal(ctx.observed.elevated, 0);
  assert.equal(ctx.observed.direct, 1);
  assert.deepEqual(JSON.parse((await readFile(ctx.marker, "utf8")).replace(/^\uFEFF/u, "")), {
    gameRoot: "N:\\Games\\Example", version: "test", original: "literal.dat", refresh: false,
  });
});

// 固定盘（DriveType 3）在 1.2.0 起与网络盘一样「先按当前用户身份直跑」——
// 玩家的游戏目录通常本来就有写权限，没必要每次弹 UAC（见 desktop/controller.js
// runElevatedScripts 里的说明）。只有直跑报「权限不足」才提权重试，另有专门用例覆盖。
for (const [name, gameRoot, options, elevated] of [
  ["UNC", "\\\\server\\share\\游戏's folder", {}, 0],
  ["fixed disk", "D:\\Games\\Example", { driveType: 3 }, 0],
  ["known launcher outside selected directory", "N:\\Games\\Example", { processes: [{ Name: "Launcher.exe", ExecutablePath: "N:\\Games\\Example-other\\Launcher.exe" }] }, 0],
]) test(`${name} preserves literal arguments and switch binding`, async t => {
  const ctx = await fixture(t, options);
  await ctx.controller.clientWrite(ctx.script, ["-GameRoot", gameRoot, "-Version", "版本 ' test", "-OriginalFile", "原版 ' file.dat", "-RefreshOriginal", true]);
  assert.equal(ctx.observed.elevated, elevated);
  assert.equal(ctx.observed.direct, elevated ? 0 : 1);
  assert.deepEqual(JSON.parse((await readFile(ctx.marker, "utf8")).replace(/^\uFEFF/u, "")), {
    gameRoot, version: "版本 ' test", original: "原版 ' file.dat", refresh: true,
  });
});

// 反向用例：直跑被拒绝（真实场景 = 游戏目录不可写）时必须提权重试一次，
// 且只重试一次、参数与直跑完全一致 —— 这是 1.2.0「先不提权」改动唯一保留的提权入口。
test("fixed disk elevates once when the direct attempt is denied", async t => {
  const ctx = await fixture(t, { driveType: 3, denyDirect: true });
  await ctx.controller.clientWrite(ctx.script, ["-GameRoot", "D:\\Games\\Example", "-Version", "版本 ' test", "-OriginalFile", "原版 ' file.dat", "-RefreshOriginal", true]);
  assert.equal(ctx.observed.elevated, 1);
  assert.equal(ctx.observed.direct, 1);
  assert.deepEqual(JSON.parse((await readFile(ctx.marker, "utf8")).replace(/^\uFEFF/u, "")), {
    gameRoot: "D:\\Games\\Example", version: "版本 ' test", original: "原版 ' file.dat", refresh: true,
  });
});

for (const [name, options, pattern] of [
  ["unavailable path", { available: false }, /目录不可用/u],
  ["unknown drive", { driveType: 0 }, /磁盘类型/u],
  ["malformed probe", { probeOutput: "maybe" }, /执行环境/u],
  ["missing probe", { probeOutput: "" }, /执行环境/u],
  ["open game", { processes: [{ Name: "worker.exe", ExecutablePath: "n:\\games\\example\\version\\worker.exe" }] }, /关闭游戏/u],
  ["hidden Olivia executable", { processes: [{ Name: "Olivia.exe", ExecutablePath: null }] }, /关闭游戏/u],
  ["hidden selected launcher", { processes: [{ Name: "Launcher.exe", ExecutablePath: null }] }, /关闭游戏/u],
  ["unavailable process enumeration", { processError: true }, /关闭游戏/u],
  ["empty process enumeration", { processes: [] }, /关闭游戏/u],
]) test(`${name} fails closed before fixture invocation`, async t => {
  const ctx = await fixture(t, options);
  await assert.rejects(ctx.controller.clientWrite(ctx.script, ["-GameRoot", "N:\\Games\\Example"]), error => error.stage === "write-fixture" && pattern.test(error.message));
  await assert.rejects(readFile(ctx.marker), { code: "ENOENT" });
  assert.equal(ctx.observed.elevated, 0);
});

test("probe timeout fails before starting a write", async t => {
  const ctx = await fixture(t, { probeOutput: "timeout" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = assert.rejects(ctx.controller.clientWrite(ctx.script, ["-GameRoot", "N:\\Games\\Example"]), { code: "CLIENT_SERVICE_STATUS_TIMEOUT", stage: "write-fixture" });
  t.mock.timers.tick(15000);
  await pending;
  assert.deepEqual(ctx.observed, { elevated: 0, direct: 0 });
});

for (const message of ["Permission denied", "fixture script error"]) test(`${message} is surfaced once without elevation retry`, async t => {
  const ctx = await fixture(t);
  await writeFile(ctx.script, `param([string]$GameRoot)\nAdd-Content -LiteralPath ${literal(ctx.marker)} -Value 'attempt'\nthrow ${literal(message)}`);
  await assert.rejects(ctx.controller.clientWrite(ctx.script, ["-GameRoot", "N:\\Games\\Example"]), error => error.stage === "write-fixture" && error.message.includes(message));
  assert.equal((await readFile(ctx.marker, "utf8")).trim(), "attempt");
  assert.deepEqual(ctx.observed, { elevated: 0, direct: 1 });
});

test("network write retains operation exclusion through helper completion and paired verification", async t => {
  const ctx = await fixture(t);
  ctx.controller.selectedClientLayout = async () => ({
    gameRoot: "N:\\Games\\Example", version: "fixture",
    feappPath: "N:\\Games\\Example\\fixture\\resources\\feapp.dat",
    webplayerPath: "N:\\Games\\Example\\fixture\\resources\\webplayer.dat",
  });
  ctx.controller.restoreClientResources = async () => {
    await ctx.controller.clientWrite(ctx.script, ["-GameRoot", "N:\\Games\\Example"]);
    return { clientSelected: true, clientFound: true, webplayerFound: true, feappMounted: false, webplayerMounted: false };
  };
  const pending = ctx.controller.restoreClient();
  await ctx.directStarted;
  await assert.rejects(ctx.controller.restoreClient(), { code: "CLIENT_SERVICE_BUSY" });
  await assert.rejects(ctx.controller.mountClient(27149), { code: "CLIENT_SERVICE_BUSY" });
  const status = await pending;
  assert.equal(status.feappMounted, false);
  assert.equal(status.webplayerMounted, false);
  assert.equal(ctx.controller.clientOperation, null);
  assert.deepEqual(ctx.observed, { elevated: 0, direct: 1 });
});
