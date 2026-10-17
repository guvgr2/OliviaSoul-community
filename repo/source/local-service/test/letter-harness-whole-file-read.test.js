// S6（两端同步 · 真源侧）：规则与人设一律「整份读」，不再靠标题嗅探。
//
// 背景：旧实现是
//   $rules   = Take-FromHeading (Strip-Yaml (Read-Utf8 $RulesFile)) $writeHeading      # "# 写法"
//   $persona = Take-FromHeading (Read-Utf8 $personaPath)           $personaHeading     # "## 基础"
// Take-FromHeading 的定义（ds-call.ps1:28-33 与 deepseek-reply.ps1:47）只有两种收场：
//   ① 标题找不到 ⇒ 返回整份（fail-open，行为随文件内容漂移）
//   ② 标题找得到 ⇒ 返回「从标题到末尾」（标题之前的内容被静默丢掉）
// 对「林离人设.md」而言 ② 是真的在丢东西：该文件首行是 `# 林离 / Olivia Lin 人设`，
// `## 基础` 在第 3 行 ⇒ 旧实现把首行标题丢了，且这件事没有任何日志或断言。
// 对「写法.md」而言首行就是 `# 写法` ⇒ 旧实现「恰好等于整份」，纯属巧合。
//
// 为什么这里不直接跑 PowerShell 真脚本：
//   ① 本仓测试在受限沙箱下 node 的子进程 spawn 被拦（EPERM），一跑就红，与断言无关；
//   ② harness-4step.ps1 跑起来要模型凭据与真实归档。
// 所以用两层论证代替：源码钉死（读脚本字符串）+ 数据契约（读真源文件，证明旧实现的两种收场都会出错）。
// 断言有效性由 .test-twins/mut-config-whole-file-read.json 的变异证明 —— 每个变异都必须让本套件变红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SCRIPTS = new URL("../../.cursor/skills/fit-letters/scripts/", import.meta.url);
const HARNESS = new URL("../../harness/", import.meta.url);
const PERSONA = new URL("../../林离人设.md", import.meta.url);

const read = (url) => readFile(url, "utf8");

test("harness-4step.ps1：规则与人设都是整份读（Strip-Yaml(Read-Utf8 ...)）", async () => {
  const script = await read(new URL("harness-4step.ps1", SCRIPTS));
  assert.match(script, /\$rules = Strip-Yaml \(Read-Utf8 \$RulesFile\)/u);
  assert.match(script, /\$persona = Strip-Yaml \(Read-Utf8 \$personaPath\)/u);
});

test("harness-4step.ps1：不再有 Take-FromHeading 调用，也没有残留的标题常量", async () => {
  const script = await read(new URL("harness-4step.ps1", SCRIPTS));
  assert.doesNotMatch(script, /Take-FromHeading\s+\(/u, "不得再调用 Take-FromHeading");
  assert.doesNotMatch(script, /=\s*Take-FromHeading/u, "不得把 Take-FromHeading 的返回值赋给变量");
  assert.doesNotMatch(script, /\$writeHeading/u, "标题常量应随切片逻辑一起删除（否则是死代码）");
  assert.doesNotMatch(script, /\$personaHeading/u, "标题常量应随切片逻辑一起删除（否则是死代码）");
});

test("deepseek-reply.ps1：同样改为整份读（它是自足脚本，自带工具函数）", async () => {
  const script = await read(new URL("deepseek-reply.ps1", SCRIPTS));
  assert.match(script, /\$rules = Strip-Yaml \(Read-Utf8 \$rulesPath\)/u);
  assert.match(script, /\$persona = Strip-Yaml \(Read-Utf8 \(Join-Path \$Root "林离人设\.md"\)\)/u);
  assert.doesNotMatch(script, /Take-FromHeading\s+\(/u, "不得再有 Take-FromHeading 调用");
  assert.doesNotMatch(script, /\$writeHeading|\$personaHeading/u, "标题常量应随切片逻辑一起删除");
});

test("数据契约：林离人设.md 的切片标题之前有内容（旧实现会丢掉它）", async () => {
  const persona = await read(PERSONA);
  const lines = persona.split("\n");
  assert.match(lines[0], /^# 林离 \/ Olivia Lin 人设/u, "人设首行是文件标题");
  const headingIndex = lines.findIndex((line) => line.startsWith("## 基础"));
  assert.ok(headingIndex > 0, `## 基础 必须不在首行（实为第 ${headingIndex + 1} 行），否则本契约失去意义`);
  assert.ok(
    lines.slice(0, headingIndex).some((line) => line.trim().length > 0),
    "切片标题之前必须确实有内容 —— 这正是旧实现静默丢掉的那部分",
  );
});

test("数据契约：写法.md 首行恰是切片标题（旧实现「恰好整份」只是巧合）", async () => {
  const rules = await read(new URL("写法.md", HARNESS));
  const lines = rules.split("\n");
  assert.equal(lines[0].trim(), "# 写法");
});

test("共享库仍保留 Take-FromHeading / Strip-Yaml 函数定义（S6 只改调用点，不删公共工具）", async () => {
  const dsCall = await read(new URL("ds-call.ps1", SCRIPTS));
  assert.match(dsCall, /function Take-FromHeading\(\[string\]\$text, \[string\]\$heading\)/u);
  assert.match(dsCall, /function Strip-Yaml\(\[string\]\$text\)/u);
  const reply = await read(new URL("deepseek-reply.ps1", SCRIPTS));
  assert.match(reply, /function Strip-Yaml\(\[string\]\$text\)/u, "自足脚本必须自带 Strip-Yaml");
});

test("harness-4step.ps1 仍经 memory-lib.ps1 -> ds-call.ps1 拿到 Strip-Yaml（dot-source 链不能断）", async () => {
  const script = await read(new URL("harness-4step.ps1", SCRIPTS));
  const memoryLib = await read(new URL("memory-lib.ps1", SCRIPTS));
  const dsCall = await read(new URL("ds-call.ps1", SCRIPTS));
  assert.match(script, /\. \(Join-Path \$PSScriptRoot "memory-lib\.ps1"\)/u);
  assert.match(memoryLib, /\. \(Join-Path \$PSScriptRoot "ds-call\.ps1"\)/u);
  assert.match(dsCall, /function Strip-Yaml/u);
});

test("Strip-Yaml 的职责只剩「去 front matter」：两个真源文件都没有 front matter（于是它是幂等的）", async () => {
  const persona = await read(PERSONA);
  const rules = await read(new URL("写法.md", HARNESS));
  // 与 ds-call.ps1:18-26 的判定同款：只有以 --- 开头才剥。
  assert.ok(!persona.startsWith("---"), "人设不应有 YAML front matter");
  assert.ok(!rules.startsWith("---"), "写法不应有 YAML front matter");
  // 因此 Strip-Yaml 的净效果 = 去掉首尾空白。整份读就是「文件全文（trim）」。
  assert.equal(persona.trim(), persona.replace(/^\s+|\s+$/gu, ""));
});
