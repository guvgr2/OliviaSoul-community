// 包内「作者绝对路径」护栏（2026-10-19 第四轮审查 · 包内作者路径核查 §6-3）。
//
// 为什么要有这条：`E:\olivia-soul-community-kit\...` / `E:\linli-letters\...` 这类**作者本机目录**
// 曾随 1.2.3 包发出（harness/行为参数.json 两处 + 发布说明.md 一处），而**没有任何东西会红**
// —— 只能等下一轮审查偶然发现。护栏加在 package-safety.ps1 里，这里钉住它的两件事：
//   ① 命中 / 误报边界（尤其是别被 JS 正则字面量 `\s*` 打满假红，那种护栏最后一定被人关掉）；
//   ② **真的接进了内容扫描**（直接调 Assert-PackageTextContent 看抛不抛）——
//      只验函数本身的话，「写完忘了调用」照样全绿。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./support/author-path-probe.ps1", import.meta.url));

function runProbe() {
  // `-ExecutionPolicy Bypass -File` 是本仓既有写法（api.test.js 调 harness-live.ps1 就是这样）。
  // 不加 Bypass 的话，子进程的机器策略是 Restricted，`-File` 直接被拒（实测 UnauthorizedAccess）。
  // ⚠️ 不要换回 `-EncodedCommand` + windowsHide：那三件套会被卡巴判 PDM:Trojan.Win32.Generic 并删文件。
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, `探针没跑起来：${result.stdout ?? ""}${result.stderr ?? ""}`);
  const lines = String(result.stdout ?? "").split(/\r?\n/u).map(l => l.trim()).filter(Boolean);
  const samples = new Map();
  const wired = {};
  for (const line of lines) {
    const parts = line.split(";");
    if (parts[0].startsWith("S")) samples.set(Number(parts[0].slice(1)), { count: Number(parts[1]), hit: parts[2] ?? "" });
    else if (parts[0].startsWith("WIRED")) wired[parts[0]] = parts[1];
  }
  return { samples, wired };
}

const probeResult = runProbe();

test("作者本机路径必须被拦下（阴性对照：判据不能是恒绿的）", () => {
  const { samples } = probeResult;
  assert.equal(samples.get(0).count, 1, "E:/olivia-soul-community-kit 必须命中");
  assert.match(samples.get(0).hit, /^E:\\olivia-soul-community-kit/u);
  assert.equal(samples.get(1).count, 1, "E:\\linli-letters 必须命中");
  assert.equal(samples.get(9).count, 1, "中文目录（E:\\我的文件夹）也要命中：首段非 ASCII 那条分支不能漏");
});

test("系统目录 / 文档占位盘符 / URL / JS 正则字面量都不能误报", () => {
  const { samples } = probeResult;
  for (const index of [2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(samples.get(index).count, 0, `第 ${index} 号样本不该命中，实际=${samples.get(index).hit}`);
  }
});

test("护栏真的接进了内容扫描（不是写完没调用）", () => {
  const { wired } = probeResult;
  assert.equal(wired["WIRED-LEAK"], "AUTHOR_PATH", "带作者路径的文本走 Assert-PackageTextContent 必须抛 AUTHOR_PATH");
  assert.equal(wired["WIRED-CLEAN"], "NO-THROW", "干净文本不该抛 —— 否则说明护栏在乱咬");
});
