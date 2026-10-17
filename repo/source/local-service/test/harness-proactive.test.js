// 「她主动写信」harness 链路护栏。
//
// 背景：生成链原本只支持「回信」——输入 = 归档 + 新来信，输出 = 她的回信。
// 主动信要在**没有来信**时生成，走的是同一条 4 步链，靠两处开关切换：
//   harness-4step.ps1 的 -Proactive   +   7 个 harness/*.md 里的 {{proactiveNote}}
// 这条链最容易漏的地方是**某一个阶段没注入提示** —— 那一步会把「由头」当成「他的来信」，
// 产出会被尾端检查或安全闸门拦下，而 JS 侧测试全绿（JS 根本不读 harness）。
//
// 五条断言：
//   1. 7 个 prompt 各自恰好一处 {{proactiveNote}}，且落在行尾（回信模式下展开成空串，不留空行）
//   2. harness-4step.ps1 的每个 prompt map 都带 proactiveNote = $proactiveNote
//   3. -Proactive 开关存在，且透传给了 Build-Memory / Build-FactMemory
//   4. 主动信规则在独立文件 harness/主动来信.md（写法.md 不再持有该节），
//      且 harness-4step.ps1 在 -Proactive 时把它的 ## System 并进 {rules}（抽出的规则必须有人消费）
//   5. harness-proactive.ps1 打开 -Proactive，归档末段用「由头」而不是「我（信件）」
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(HERE, "..");
// harness 与 .cursor 住在 repo/source 下（不是 local-service 下）
const SOURCE_ROOT = resolve(SERVICE_ROOT, "..");
const HARNESS_DIR = join(SOURCE_ROOT, "harness");
const SCRIPTS_DIR = join(SOURCE_ROOT, ".cursor", "skills", "fit-letters", "scripts");
const STEP_PS1 = join(SCRIPTS_DIR, "harness-4step.ps1");
const PROACTIVE_PS1 = join(SCRIPTS_DIR, "harness-proactive.ps1");
const PROMPTS = [
  "01-预检.md",
  "01-初始化账本.md",
  "02-历史检索.md",
  "02-账本校正.md",
  "03-中段生成.md",
  "04-尾端检查.md",
  "05-反馈重写.md",
];
const NOTE_TOKEN = "{{proactiveNote}}";

test("主动写信：7 个 prompt 都注入了 {{proactiveNote}}，且落在行尾", async () => {
  const problems = [];
  for (const name of PROMPTS) {
    const text = await readFile(join(HARNESS_DIR, name), "utf8");
    const count = text.split(NOTE_TOKEN).length - 1;
    if (count !== 1) problems.push(`${name}：{{proactiveNote}} 出现 ${count} 次（应为 1 次）`);
    for (const line of text.split(/\r?\n/u)) {
      if (!line.includes(NOTE_TOKEN)) continue;
      if (!line.trimEnd().endsWith(NOTE_TOKEN)) problems.push(`${name}：{{proactiveNote}} 不在行尾`);
      if (line.trimStart().startsWith(NOTE_TOKEN)) {
        problems.push(`${name}：{{proactiveNote}} 独占一行（回信模式下会留下空行）`);
      }
    }
  }
  assert.deepEqual(problems, [], `这些 prompt 的主动写信提示注入有问题：${problems.join("；")}`);
});

test("主动写信：harness-4step.ps1 的每个 prompt map 都带 proactiveNote", async () => {
  const source = await readFile(STEP_PS1, "utf8");
  assert.match(source, /\[switch\]\$Proactive/u, "harness-4step.ps1 没有 -Proactive 开关");
  assert.match(source, /\$proactiveNote\s*=\s*""/u, "proactiveNote 默认不是空串（回信路径会带上主动信提示）");
  assert.match(
    source,
    /if\s*\(\$Proactive\)\s*\{\s*\r?\n\s*\$proactiveNote\s*=/u,
    "没有在 -Proactive 时才写 proactiveNote 的内容",
  );

  const usedMaps = [
    ...new Set([...source.matchAll(/Expand-Harness\s+\S+\s+(\$[A-Za-z_]\w*)/gu)].map((m) => m[1])),
  ];
  assert.ok(
    usedMaps.length >= 7,
    `只找到 ${usedMaps.length} 个 prompt map（脚本结构变了？同步更新本测试的定位方式）`,
  );
  const missing = usedMaps.filter((name) => {
    const def = new RegExp(`\\${name}\\s*=\\s*@\\{([^}]*)\\}`, "u").exec(source);
    return !def || !def[1].includes("proactiveNote");
  });
  assert.deepEqual(
    missing,
    [],
    `这些 prompt map 没有 proactiveNote 键：${missing.join("、")} —— 它们展开的 {{proactiveNote}} 不会被替换，` +
      "模型会看到字面 token 或把「由头」当成他写来的信",
  );
});

test("主动写信：-Proactive 透传给了两步记忆构建", async () => {
  const source = await readFile(STEP_PS1, "utf8");
  const calls = [...source.matchAll(/Build-(?:Fact)?Memory[^\n]*/gu)].map((m) => m[0]);
  assert.ok(calls.length > 0, "没找到 Build-Memory / Build-FactMemory 调用（函数改名了？）");
  for (const call of calls) {
    assert.ok(
      call.includes("-Proactive"),
      `记忆构建调用没有传 -Proactive：${call.trim()}（主动信的记忆段会退回「他来信了」的写法）`,
    );
  }
});

test("主动写信：规则已抽到独立规范文件 主动来信.md，且 -Proactive 时会有人消费它", async () => {
  const proactive = await readFile(join(HARNESS_DIR, "主动来信.md"), "utf8");
  assert.match(proactive, /^## System$/mu, "主动来信.md 缺 ## System");
  assert.match(proactive, /^## User$/mu, "主动来信.md 缺 ## User");
  assert.match(proactive, /不追问/u, "缺「不追问 / 不施压」约束");
  assert.match(proactive, /由头必须是具体的/u, "缺「由头必须具体」约束（否则会写成空洞问候）");
  assert.match(proactive, /不推进关系/u, "缺「不推进关系」约束");
  assert.match(proactive, /\{\{trigger\}\}/u, "缺 {{trigger}}（由头没进正文）");
  assert.match(proactive, /\{\{anchors\}\}/u, "缺 {{anchors}}（调性锚没接进来）");
  // ⚠️ 段标记必须在文件里各出现**恰好一次**：顶部说明文字里若再写字面的段标记，
  //    Get-HarnessPrompt 的 IndexOf 会把切分点顶到说明文字上 —— 切错的内容照样发出去，不报错。
  assert.equal(
    proactive.split("## System").length - 1,
    1,
    "## System 必须恰好出现 1 次（说明文字里的同名标记会把切分点顶到前面）",
  );
  assert.equal(
    proactive.split("## User").length - 1,
    1,
    "## User 必须恰好出现 1 次（同上）",
  );

  const writes = await readFile(join(HARNESS_DIR, "写法.md"), "utf8");
  assert.doesNotMatch(writes, /^## 主动写信$/mu, "写法.md 还留着「## 主动写信」——规则已抽走，留着就是两份真源");
  assert.doesNotMatch(writes, /由头必须是具体的/u, "写法.md 还留着主动信条款——两份副本会各自漂移");

  // 抽走之后必须有人消费，否则主动信会悄悄退回「没有专属口径」。
  // 三段缺一即空转：① 构造文件名 → ② 取 ## System 段 → ③ 并进 {rules}。
  const step = await readFile(STEP_PS1, "utf8");
  assert.match(
    step,
    /if \(\$Proactive\) \{[\s\S]{0,900}?\$proactiveRulesName\s*=\s*\(-join @\(\[char\]0x4E3B[\s\S]{0,900}?Get-HarnessPrompt \$proactiveRulesName\)\.System[\s\S]{0,900}?\$rules = \$rules \+ "[^"]*" \+ \$proactiveRules/u,
    "harness-4step.ps1 的 -Proactive 分支必须：构造文件名 → 取 ## System → 并进 {rules}（缺一段就是空转）",
  );
  assert.match(step, /\$rules = \$rules \+ "[^"]*" \+ \$proactiveRules/u, "没有把主动信规则并进 {rules}");
});

test("主动写信：harness-proactive.ps1 打开 -Proactive，归档末段用「由头」而不是「我（信件）」", async () => {
  const source = await readFile(PROACTIVE_PS1, "utf8");
  assert.match(source, /Proactive\s*=\s*\$true/u, "harness-proactive.ps1 没有打开 -Proactive");
  assert.match(source, /reasonHeading\s*=[^\n]*0x7531/u, "没有用「由头」拼归档末段标题");
  assert.doesNotMatch(
    source,
    /0x6211/u,
    "归档末段不该用「我」拼接 —— 那会让持久档案里留下「他写过一句由头」的伪事实",
  );
  assert.match(source, /HARNESS PROACTIVE DONE/u, "没有结束标记");
});

// ── S4：调性锚（主动信语料.md）必须真的进 prompt，而不是躺在目录里当摆设 ──────
//
// 为什么单列：`主动信语料.md` 是**跨项目共用素材**（姊妹项目同名文件，用户 2026-10-16
// 授权共用），它最危险的失效方式不是内容错，而是「文件在、没人读」—— 那种情况下
// 主动信照常生成，只是少了「长度／口气／落点」的锚，质量静默劣化、零报错。
test("主动写信：调性锚（主动信语料.md）是纯语料，且 -Proactive 时整份并入 {rules}", async () => {
  const anchors = await readFile(join(HARNESS_DIR, "主动信语料.md"), "utf8");

  // ① 使用声明必须在（删掉它 = 去掉「只学长度、口气、落点，不得套用」这条唯一约束）
  assert.match(anchors, /调性锚/u, "缺「调性锚」声明");
  assert.match(anchors, /不得改写、扩写、拼接或套用/u, "缺「不得套用其中句子」声明");
  // ② 来源与授权留痕：这五封是跨项目共用素材，必须能当场回答「哪来的、谁授权的」
  assert.match(anchors, /来源与授权留痕/u, "缺来源与授权留痕段");
  assert.match(anchors, /0 命中/u, "缺「在上游 v18 快照内 0 命中」这条取证结论");
  assert.match(anchors, /用呗|授权两端共用/u, "缺用户授权记录");

  // ③ 五封锚文齐全
  for (const n of ["一", "二", "三", "四", "五"]) {
    assert.match(anchors, new RegExp(`^## ${n} ·`, "mu"), `缺第 ${n} 封锚文（标题必须是「## ${n} · …」）`);
  }

  // ④ 它是**纯语料**：不许出现段标记 —— 一旦混入，将来有人误用 Get-HarnessPrompt 就会切错内容
  assert.doesNotMatch(
    anchors,
    /^## System$/mu,
    "语料文件不该有 ## System 段标记：它是整份读的正文，混入标记只会让消费方式变歧义",
  );
  assert.doesNotMatch(anchors, /^## User$/mu, "语料文件不该有 ## User 段标记");
  // ⑤ 不许有未渲染的占位符（它直接进 prompt，不是模板）
  assert.doesNotMatch(anchors, /\{\{/u, "语料里出现了 {{ ... }} 占位符 —— 它是要直接进 prompt 的正文");

  // ⑥ 消费链三段缺一即空转：构造路径 → 存在性检查 → 整份读 → 并入 {rules}
  const step = await readFile(STEP_PS1, "utf8");
  assert.match(
    step,
    /\$anchorsName\s*=\s*\(-join @\(\[char\]0x4E3B[\s\S]{0,700}?\$anchorsPath\s*=\s*Join-Path \$HarnessDir \$anchorsName/u,
    "harness-4step.ps1 没有构造 主动信语料.md 的路径（码点拼名 → Join-Path $HarnessDir）",
  );
  assert.match(step, /Test-Path -LiteralPath \$anchorsPath/u, "读之前没有存在性检查（缺文件会静默并入空串）");
  assert.match(step, /\$anchors\s*=\s*\(Read-Utf8 \$anchorsPath\)\.Trim\(\)/u, "没有整份读调性锚");
  assert.match(
    step,
    /if \(\[string\]::IsNullOrWhiteSpace\(\$anchors\)\) \{ throw \("empty proactive anchors: "/u,
    "没有空值检查（读到空文件也照样往下走 = 锚静默消失）",
  );
  assert.match(
    step,
    /\$rules = \$rules \+ "[^"]*调性锚[^"]*" \+ \$anchors/u,
    "没有把调性锚并进 {rules}（构建了路径、读了文件，却没喂给模型 = 空转）",
  );

  // ⑦ 进包清单必须有它：单元测试读的是源码，产物漏文件时测试仍全绿 ⇒ 这条是唯一会红的
  const build = await readFile(join(SERVICE_ROOT, "packaging", "build-release.ps1"), "utf8");
  assert.match(
    build,
    /foreach \(\$name in @\([^)]*"主动信语料\.md"/u,
    "build-release.ps1 的 harness 复制清单缺 主动信语料.md（用户机器上主动信会直接 throw）",
  );
});
