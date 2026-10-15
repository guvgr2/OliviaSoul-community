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
//   4. 写法.md 有「## 主动写信」一节（主动信不是回信，需要自己的文风与边界约束）
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

test("主动写信：写法.md 有「## 主动写信」一节（主动信需要自己的文风与边界约束）", async () => {
  const text = await readFile(join(HARNESS_DIR, "写法.md"), "utf8");
  assert.match(text, /^## 主动写信$/mu, "写法.md 缺「## 主动写信」一节");
  assert.match(text, /不追问/u, "缺「不追问 / 不施压」约束");
  assert.match(text, /由头必须是具体的/u, "缺「由头必须具体」约束（否则会写成空洞问候）");
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
