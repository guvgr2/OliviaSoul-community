// B1 / B3 / B7（2026-10-09 复审 ── 《交付 deepseek：1.2.0 问题修复总单》§B）：
// 写信 harness（PowerShell）是「写回信」这条主功能的实际执行者，它的三个坑以前没有任何护栏：
//   B1 不传 max_tokens：智谱 / 火山方舟的「最大回答」官方默认只有 4k，而推理 token 与正文共享这份预算
//      ⇒ 回信稍长就 finish_reason=length ⇒ Get-ModelFinalText 抛 "model did not produce complete text"，
//      整封回信直接失败（不是「回信短一点」）。同根因的第三处，且落在主功能上。
//   B3 -NoThink 是死参数：唯一入口 harness-4step.ps1 的开关，而 harness-live.ps1 从不传它 ⇒ 思考永远开着，
//      推理 token 按输出单价计费。现在改由 model.env 的 MODEL_THINKING 决定（默认 on，保持原行为）。
//   B7 _probe 只写不删：Save-Step 的 18 个调用点 + memory-lib 的 mem_* 把明文信件内容永久留在程序目录里。
// 这份套件按「源码断言 + BOM 断言」钉住这三条（真跑一轮要真实 Key，不适合当门禁用例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const scriptsDir = new URL('../../.cursor/skills/fit-letters/scripts/', import.meta.url);
const readText = name => readFileSync(new URL(name, scriptsDir), 'utf8').replace(/\r\n/gu, '\n');

test('B1：写信 payload 必须带 max_tokens，默认 32768 且可用 model.env 覆盖', () => {
  const source = readText('model-call.ps1');
  assert.match(source, /\$MaxTokensField = \$script:ModelMaxTokens/u,
    'payload 里必须有输出预算（字段名走 $MaxTokensField），否则预算又交给厂商默认值（4k）');
  assert.match(source, /\[string\]\$MaxTokensField = "max_tokens"/u,
    '默认字段名是 max_tokens');
  assert.match(source, /\$maxTokensRaw = Get-ModelValue -Primary \$config -PrimaryName \(\$prefix \+ "_MAX_TOKENS"\)[\s\S]{0,200}?-Default "32768"/u,
    '预算要从 model.env 读（与 base/model/auth/key 同一处读法）并带保守默认值 32768');
  assert.match(source, /\[int\]::TryParse\(\$maxTokensRaw, \[ref\]\$maxTokensValue\)/u,
    '填错的值要当场拒绝，别把 0 或负数发出去');
  assert.match(source, /\$script:ModelMaxTokens = \$maxTokensValue/u,
    '读出来的预算要存进脚本状态，payload 才有得用');
  // 与 model-transport.js 对齐的参数名协商：中转站/新版接口不认 max_tokens 时要能换名重试一次。
  assert.match(source, /function Test-MaxTokensUnsupported/u, '要有「这个参数名不认」的判定');
  assert.match(source, /Test-MaxTokensUnsupported -Detail \$detail/u);
  assert.match(source, /-MaxTokensField "max_completion_tokens"/u, '400 且确认是参数名问题时换名重试');
  assert.match(source, /max_completion_tokens[\s\S]{0,200}?unsupported_parameter/u, '识别厂商的显式参数名报错');
});

test('B3：MODEL_THINKING=on|off 真的接到思考开关（-NoThink 不再是唯一入口）', () => {
  const source = readText('model-call.ps1');
  assert.match(source, /-PrimaryName "MODEL_THINKING"[\s\S]{0,160}?-Default "on"/u,
    '默认必须是 on —— 关思考可能降低回信质量，不能替用户改默认行为');
  assert.match(source, /if \(\$thinkingRaw -notin @\("on", "off"\)\) \{ throw/u,
    '只认 on / off，写错要报错而不是默默当作开');
  assert.match(source, /\$script:ModelThinking = \(\$thinkingRaw -eq "on"\)/u,
    '思考开关必须由 model.env 决定');
  assert.doesNotMatch(source, /\$script:ModelThinking = \$true/u,
    '不许再硬编码 true：那样 harness-live.ps1 不传 -NoThink 时思考就永远关不掉（B3 的根因）');
});

test('B7：每一步中间产物写盘后要回收 _probe 里的旧信件文件（每人只留最近 3 封）', () => {
  const harness = readText('harness-4step.ps1');
  assert.match(harness, /\. \(Join-Path \$PSScriptRoot "probe-prune\.ps1"\)/u,
    'harness 要加载回收器');
  assert.match(harness, /Remove-OldProbeFiles -ProbeDir \$probe -Person \$Person -Keep 3/u,
    'Save-Step 每次写完都要回收 —— 不然一封回信就落 8～11 个明文文件、永不回收');

  const prune = readText('probe-prune.ps1');
  assert.match(prune, /function Remove-OldProbeFiles \{/u);
  assert.match(prune, /\[int\]\$Keep = 3/u, '默认保留最近 3 封：够排查，又不会无限膨胀');
  assert.match(prune, /\$prefixes = @\("h4_", "mem_"\)/u,
    'harness 的中间产物 h4_* 与 memory-lib 的 mem_* 都要管');
  assert.match(prune, /\$numbers = @\(\$map\.Keys \| Sort-Object -Descending\)[\s\S]{0,120}?Select-Object -Skip \$Keep/u,
    '按封号降序、跳过前 Keep 个封号 —— 删的必须是最旧的，别把还要读的（上一封的 1safe）删掉');
  assert.match(prune, /Remove-Item -LiteralPath \$path -Force/u);
});

test('护栏本身：三个 .ps1 必须保留 UTF-8 BOM（受管 edit 会吞掉，PowerShell 随后报假语法错）', () => {
  for (const name of ['model-call.ps1', 'harness-4step.ps1', 'probe-prune.ps1']) {
    const bytes = readFileSync(new URL(name, scriptsDir));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 丢了 UTF-8 BOM`);
  }
});

// B2：家族判定必须只有一份真相源。这里把「12 项预设 → 家族」在 JS 与 PowerShell 两边各跑一遍比对，
// 任何一边自己加/改正则都会当场变红（以前 PS 侧只认 deepseek/glm，Kimi 三条全缺）。
const FAMILY_CASES = [
  ['deepseek-flash', 'deepseek'],
  ['deepseek-v4-pro', 'deepseek'],
  ['glm-5.3-flash', 'glm'],
  ['glm-5.3-flashx', 'glm'],
  ['glm-5.3', 'glm'],
  ['kimi-k3', 'kimi-k3'],
  ['kimi-k2.6', 'kimi-k2.6'],
  ['kimi-k2.7-code', 'kimi-k2.7'],
  ['M2-her', null],
  ['doubao-seed-character-260628', null],
  ['doubao-seed-character-251128', null],
  ['doubao-seed-2-0-mini-260428', null],
];

test('B2：JS 与 PowerShell 对 12 项预设的家族判定必须完全一致（单一真相源）', async () => {
  const {reasoningFamilyOf} = await import('../model-config.js');
  const jsNames = FAMILY_CASES.map(([model]) => reasoningFamilyOf(model)?.name ?? null);
  assert.deepEqual(jsNames, FAMILY_CASES.map(([, family]) => family),
    'JS 侧的家族判定与预期不符（改了 model-families.json 就要同步这份期望值）');

  // PowerShell 侧：加载 harness 的模型脚本，用它自己的表判一遍。
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const helper = new URL('model-call.ps1', scriptsDir).pathname.replace(/^\/(?=[A-Za-z]:)/u, '');
  const models = FAMILY_CASES.map(([model]) => model);
  const script = [
    "$ErrorActionPreference='Stop'",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8`,
    `. '${helper}'`,
    'Import-ModelFamilyTable',
    `$models = @(${models.map(model => `'${model}'`).join(',')})`,
    '$result = foreach ($m in $models) { $f = Get-ModelFamily -Model $m; if ($f) { $f.name } else { "-" } }',
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const {stdout} = await promisify(execFile)('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {timeout: 30000, windowsHide: true});
  const psRaw = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
  // PowerShell 的管道会把 $null 丢掉，所以用 "-" 当哨兵再换回 null。
  const psNames = (Array.isArray(psRaw) ? psRaw : [psRaw]).map(name => (name === '-' ? null : name));
  assert.deepEqual(psNames, jsNames,
    'PowerShell 侧与 JS 侧的家族判定分叉了 —— 两边都必须读 model-families.json');
});

