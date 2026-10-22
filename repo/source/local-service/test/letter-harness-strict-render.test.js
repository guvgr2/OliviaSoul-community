import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupFileSync } from "./lib/cleanup.mjs";

// S1「渲染严格化」的护栏（2026-10-16，两端写信引擎同步方案 §7 验收 2）。
//
// 被测对象：repo/source/.cursor/skills/fit-letters/scripts/harness-4step.ps1 的 Expand-Harness。
// 旧实现只做 .Replace：模板里写错一个变量名、或某一步忘了传值，占位符会**原样** `{{xxx}}`
// 送进模型 prompt（模型读到的是一段垃圾指令），而外层毫无异常、日志也干净。
// 本套件把这种「静默污染」钉成「当场抛错」，并守住新代码最大的风险面：
// 只要有一处模板变量不在对应 map 里，写信会在运行时 throw（比静默污染更严重）。

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(here, "..", ".."); // repo/source
const HARNESS_DIR = join(SOURCE_DIR, "harness");
const SCRIPT = join(SOURCE_DIR, ".cursor", "skills", "fit-letters", "scripts", "harness-4step.ps1");
const MANIFEST = join(HARNESS_DIR, "harness-manifest.json");

const source = readFileSync(SCRIPT, "utf8");

// ── 「定位成功」断言：切片失败时必须变红，不能让后面的断言静默失效（AGENTS.md §七.4）──
const START_MARK = "$harnessOptionalVars";
const END_MARK = "function Get-HarnessPrompt";
const startAt = source.indexOf(START_MARK);
const endAt = source.indexOf(END_MARK);
assert.ok(
  startAt > 0 && endAt > startAt,
  "定位失败：找不到渲染严格化区段（$harnessOptionalVars … function Get-HarnessPrompt）",
);
const renderBlock = source.slice(startAt, endAt);
assert.ok(renderBlock.includes("function Expand-Harness"), "定位失败：区段里没有 Expand-Harness");

// ── 检查表：每个注入模板 → 它会被哪些 map 渲染 ──
// 这是手写镜像，但下面两条断言会把它钉在真实源码上（map 变量名必须真实存在，
// 目录里的模板必须都被登记），所以重构时它会先红，而不是静默过期。
const STEP_MAPS = [
  { file: "01-预检.md", maps: ["map1"] },
  { file: "01-初始化账本.md", maps: ["map1"] },
  { file: "02-历史检索.md", maps: ["historyMap", "finishRepairMap", "repairMap"] },
  { file: "02-账本校正.md", maps: ["reconcileMap"] },
  { file: "03-中段生成.md", maps: ["map3"] },
  { file: "04-尾端检查.md", maps: ["map4", "recheckMap"] },
  { file: "05-反馈重写.md", maps: ["map5"] },
];
// harness 目录里存在、但**不**经 Expand-Harness 渲染的文件（它们都会进 prompt，只是各有别的注入方式）：
// 00-栏目.md / 开信.md 由脚本直接读进 {fields} / 开信段；写法.md 经显式整份读进 {rules}；
// 主动来信.md 只在 -Proactive 时由 Get-HarnessPrompt 取 ## System 并进 {rules}（见 harness-proactive 套件）；
// 主动信语料.md 同样只在 -Proactive 时整份读进 {rules} 的「调性锚」段（见 harness-proactive 套件的调性锚用例）。
const NON_INJECTED = new Set(["00-栏目.md", "开信.md", "写法.md", "主动来信.md", "主动信语料.md", "近况.md"]);

const ALL_VARS = [
  "budget", "check", "ctx", "draft", "drift", "evidence", "facts", "fields", "historyResults",
  "navigation", "persona", "previousState", "proactiveNote", "relationshipMemory", "rules", "safe",
];

// ── 用系统 PowerShell 真跑这段函数 ──
function findShell() {
  for (const exe of ["pwsh", "powershell"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8", windowsHide: true });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}

const SHELL = findShell();
assert.ok(SHELL, "环境里没有 pwsh 也没有 powershell：无法验证 Expand-Harness 的行为（这不算通过）");

function runPowerShell(body) {
  const tmp = join(tmpdir(), `olivia-harness-strict-${process.pid}-${Date.now()}.ps1`);
  // 带 BOM 落盘再用 -File 执行：避开 PowerShell 读 stdin 时按 ANSI 解码中文文件名的问题
  writeFileSync(tmp, `\uFEFF${body}`, "utf8");
  try {
    const r = spawnSync(SHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), error: r.error };
  } finally {
    cleanupFileSync(tmp);
  }
}

// 探测脚本刻意只输出 ASCII：PS 5.1 往管道写中文会按 ANSI 编码，回来就乱了。
// 需要从错误消息里取的信息（哪一类错误、涉及哪个变量）都在 PS 侧解析成短标记。
const psLines = [
  "$ErrorActionPreference = 'Stop'",
  renderBlock,
  "function Get-Kind([string]$m) {",
  "  if ($m -match 'unregistered variable') { return 'UNREG' }",
  "  if ($m -match 'required variable is empty') { return 'EMPTY' }",
  "  if ($m -match 'unreplaced placeholder') { return 'LEFTOVER' }",
  "  return 'OTHER'",
  "}",
  "function Get-Name([string]$m) {",
  "  if ($m -match '\\{\\{([A-Za-z][A-Za-z0-9]*)\\}\\}') { return $Matches[1] }",
  "  return 'NONE'",
  "}",
  "function Probe([scriptblock]$body) {",
  "  try {",
  "    $v = & $body",
  "    if ($null -eq $v) { return 'OK-EMPTY' }",
  "    return [string]$v",
  "  } catch {",
  "    $m = [string]$_.Exception.Message",
  "    return ('THROW-' + (Get-Kind $m) + ':' + (Get-Name $m))",
  "  }",
  "}",
  "$r = [ordered]@{}",
  "$r['unregistered'] = Probe { Expand-Harness 'hi {{nope}}' @{ ctx = 'x' } }",
  "$r['requiredEmpty'] = Probe { Expand-Harness 'hi {{ctx}}' @{ ctx = '' } }",
  "$r['optionalEmpty'] = Probe { Expand-Harness 'a[{{proactiveNote}}]b' @{ proactiveNote = '' } }",
  "$r['spaced'] = Probe { Expand-Harness 'a[{{ ctx }}]b' @{ ctx = 'X' } }",
  "$r['weirdSpacing'] = Probe { Expand-Harness 'a{{  ctx  }}b' @{ ctx = 'X' } }",
  "$r['multilineSpacing'] = Probe { Expand-Harness \"a{{\nctx\n}}b\" @{ ctx = 'X' } }",
  "$r['dollarValue'] = Probe { Expand-Harness 'a{{ctx}}b' @{ ctx = '$1' } }",
  "$all = @{ budget='B'; check='C'; ctx='CTX'; draft='D'; drift='DR'; evidence='E'; facts='F'; fields='FI'; historyResults='HR'; navigation='N'; persona='P'; previousState='PS'; proactiveNote='PN'; relationshipMemory='RM'; rules='R'; safe='S' }",
  "$tpl = @{}",
  "$names = @('01-预检.md','01-初始化账本.md','02-历史检索.md','02-账本校正.md','03-中段生成.md','04-尾端检查.md','05-反馈重写.md')",
  "for ($i = 0; $i -lt $names.Count; $i++) {",
  `  $text = [IO.File]::ReadAllText((Join-Path '${HARNESS_DIR}' $names[$i]), (New-Object System.Text.UTF8Encoding($false)))`,
  "  try {",
  "    $o = Expand-Harness $text $all",
  "    if ($o -match '\\{\\{') { $tpl['t' + $i] = 'LEFTOVER' } else { $tpl['t' + $i] = 'OK' }",
  "  } catch {",
  "    $m = [string]$_.Exception.Message",
  "    $tpl['t' + $i] = ('THROW-' + (Get-Kind $m) + ':' + (Get-Name $m))",
  "  }",
  "}",
  "$r['templates'] = $tpl",
  "$r | ConvertTo-Json -Depth 5 -Compress",
];

const probe = runPowerShell(psLines.join("\n"));
assert.equal(probe.error, undefined, `启动 ${SHELL} 失败：${probe.error}`);
assert.equal(probe.status, 0, `探测脚本自身失败（exit ${probe.status}）：${probe.stderr}`);
const R = JSON.parse(probe.stdout);

test("Expand-Harness：模板里的未登记变量当场抛错（不再把 {{xxx}} 送进 prompt）", () => {
  assert.equal(R.unregistered, "THROW-UNREG:nope");
});

test("Expand-Harness：必填变量为空当场抛错（旧实现渲染成空串继续跑）", () => {
  assert.equal(R.requiredEmpty, "THROW-EMPTY:ctx");
});

test("Expand-Harness：可选变量为空按空串渲染，不抛错", () => {
  assert.equal(R.optionalEmpty, "a[]b");
});

test("Expand-Harness：容忍 {{ ctx }} 这种带空格的写法（旧实现静默漏替换）", () => {
  assert.equal(R.spaced, "a[X]b");
});

// S4（2026-10-17 发版前必修清单）：`{{  ctx  }}`（两个以上空格）以前**走不到**这里 ——
// 替换阶段只补紧凑与「恰好一个空格」两种形态，残留检查用 \s* 宽松正则 ⇒ 抛 THROW-LEFTOVER，
// 即「模板写得不常见就炸掉整封信生成」。现改为按同一套 \s* 正则统一替换 ⇒ 与 spaced 同等处理。
// 这条断言是**行为翻转**：把正则替换改回两行字面 .Replace，它立刻变红。
test("Expand-Harness：任意多个空格的写法同样被替换（不再抛 LEFTOVER 炸掉生成）", () => {
  assert.equal(R.weirdSpacing, "aXb");
});

// S4 之后这一条不再适用（`{{  ctx  }}` 已被正确替换），改为钉**真**漏替换的形态：
// 变量名不在 map 里（未登记）与「替换值本身含 {{」都不该被静默放过。
// 这里改用**跨行**怪写法：`{{\nctx\n}}` —— $harnessVarPattern 的 \s* 同样能匹配它，
// 所以它现在也该被正常替换；若将来有人把 \s* 收窄成不含换行，这条会先炸。
test("Expand-Harness：跨行写法的占位符同样被替换（正则与字面替换必须同口径）", () => {
  assert.equal(R.multilineSpacing, "aXb");
});

test("Expand-Harness：替换值里的 $ 不被当成正则组引用", () => {
  assert.equal(R.dollarValue, "a$1b");
});

test("七个注入模板都能用完整变量表渲染且不残留占位符", () => {
  // 键用索引而不是中文文件名：PowerShell 5.1 往管道写中文会按 ANSI 编码，回来就是乱码
  STEP_MAPS.forEach(({ file }, i) => {
    const got = R.templates[`t${i}`];
    assert.equal(got, "OK", `模板 ${file}（索引 ${i}）渲染异常：${got}`);
  });
});

function mapKeys(name) {
  const re = new RegExp(`\\$${name}\\s*=\\s*@\\{([\\s\\S]*?)\\}`, "u");
  const m = source.match(re);
  assert.ok(m, `定位失败：脚本里找不到 $${name} = @{...}（检查表过期或脚本被重构了）`);
  return new Set([...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/gu)].map((x) => x[1]));
}

test("每个注入模板的变量都是该步骤 map 的键（新代码最大的风险面）", () => {
  for (const { file, maps } of STEP_MAPS) {
    const text = readFileSync(join(HARNESS_DIR, file), "utf8");
    const vars = [...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu)].map((m) => m[1]);
    for (const mapName of maps) {
      const keys = mapKeys(mapName);
      const missing = vars.filter((v) => !keys.has(v));
      assert.deepEqual(
        missing,
        [],
        `模板 ${file} 用了 $${mapName} 里没有的变量：${missing.join("、")} —— 运行时 Expand-Harness 会直接 throw，写信会失败`,
      );
    }
  }
});

test("harness 目录里的模板都登记进本检查表（新增模板漏登记即红）", () => {
  const listed = new Set(STEP_MAPS.map((s) => s.file));
  const unlisted = readdirSync(HARNESS_DIR)
    .filter((n) => n.endsWith(".md"))
    .filter((n) => !listed.has(n) && !NON_INJECTED.has(n));
  assert.deepEqual(unlisted, [], `harness 目录下有未登记的模板：${unlisted.join("、")}`);
});

test("带段标记的模板里 ## System / ## User 各恰好一次（出现两次会切到说明文字上，不报错）", () => {
  // Get-HarnessPrompt / renderStep 都用 IndexOf 找第一个标记来切分；
  // 顶部说明里若引用了字面的段标记，切出来的就是说明文字 —— 而且悄无声息地发出去。
  const problems = [];
  for (const name of readdirSync(HARNESS_DIR).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(HARNESS_DIR, name), "utf8");
    if (!text.includes("## System")) continue;
    const sys = text.split("## System").length - 1;
    const user = text.split("## User").length - 1;
    if (sys !== 1) problems.push(`${name}：## System 出现 ${sys} 次`);
    if (user !== 1) problems.push(`${name}：## User 出现 ${user} 次`);
  }
  assert.deepEqual(
    problems,
    [],
    `段标记必须唯一（切分用 IndexOf，出现两次会切到说明文字上）：${problems.join("；")}`,
  );
});

test("可选变量表与 harness-manifest.json 的 optionalVariables 集合一致", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const declared = manifest.optionalVariables;
  assert.ok(Array.isArray(declared) && declared.length > 0, "harness-manifest.json 缺 optionalVariables");
  const inScript = [
    ...renderBlock.match(/\$harnessOptionalVars\s*=\s*@\(([\s\S]*?)\)/u)[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...inScript].sort(),
    [...declared].sort(),
    "脚本里的 $harnessOptionalVars 与 harness-manifest.json 的 optionalVariables 必须逐项一致：改一处就要同批改另一处",
  );
  assert.deepEqual(
    [...ALL_VARS].sort(),
    [...new Set(STEP_MAPS.flatMap((s) => {
      const text = readFileSync(join(HARNESS_DIR, s.file), "utf8");
      return [...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu)].map((m) => m[1]);
    }))].sort(),
    "本套件顶部写的 ALL_VARS 与真源模板实际用到的变量集合不一致（改模板就要同批改 ALL_VARS）",
  );
});

test("源码钉死：不得回退成 map.Keys 全量替换，三处 throw 文案必须在", () => {
  assert.doesNotMatch(source, /\$map\.Keys/u, "不得回退成遍历 map.Keys —— 模板里的未登记变量会静默漏替换");
  assert.match(source, /harness template uses an unregistered variable/u);
  assert.match(source, /harness required variable is empty/u);
  assert.match(source, /harness prompt still has an unreplaced placeholder/u);
});

// ── S4 第二处 fail-open：预检行数契约解析不到时不许静默退回默认 8（2026-10-17 必修清单）──
// 旧代码：`if ($ledgerContractMatch.Success) { ... }` —— 模板措辞一改（例如「只输出下列若干行」）
// expectedSafeLines 永远是 8，而实际要求 17 行，Test-SafeLedgerFormat 会把每封合规的信判违规。
// 变异验证 mut-config-s4-expand-regex.json 的 S4B 会把它改回 fail-open，这条断言必须变红。
test("源码钉死：预检行数契约解析不到时必须抛错，不许静默退回默认 8", () => {
  assert.match(
    source,
    /if \(-not \$ledgerContractMatch\.Success\) \{\s*\r?\n\s*throw \("precheck prompt does not declare its ledger line count/u,
    "预检行数契约解析不到时必须当场 throw（fail-open 会把 17 行的契约静默按 8 行校验）",
  );
  // 默认值 8 只允许出现一次（$expectedSafeLines = 8 的初值），不允许再出现第二个回退路径
  const defaults = [...source.matchAll(/\$expectedSafeLines\s*=\s*8/g)].length;
  assert.equal(defaults, 1, `$expectedSafeLines = 8 应恰好一处（初值），实际 ${defaults} 处 —— 又出现了一条回退路径`);
});
