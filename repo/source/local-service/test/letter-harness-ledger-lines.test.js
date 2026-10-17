import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// S2「预检账本十七行」的护栏（2026-10-16，两端写信引擎同步方案 §5.1 S2）。
//
// 背景：2026-10-13 的融合改进方案 §4.2b 指出，把十四行改成十七行不是「改一处」，它同时牵动三处：
//   ① 行数期望 —— 脚本里原本是 if/elseif 三分支 + 默认 8 的静默降级：声明改成十七行而没加分支时，
//      格式校验会按 8 行判，把一封正常回信整封判为不合格，而且外层不报错；
//   ② 跨封继承白名单 $statePrefixes —— 说话者与未决必须继承，否则
//      「上一封记在未决里的项，本封没有原文确认前仍是未决」根本不生效（字段被丢掉）；
//   ③ 格式校验 —— 末行必须以「结论」开头 ⇒ 新字段只能插在结论之前。
// 本套件把三处钉在一起：任何一处漏改，这里先红。

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(here, "..", ".."); // repo/source
const HARNESS_DIR = join(SOURCE_DIR, "harness");
const SCRIPT = join(SOURCE_DIR, ".cursor", "skills", "fit-letters", "scripts", "harness-4step.ps1");

const script = readFileSync(SCRIPT, "utf8");

// S2 的契约值。改它必须同批改：三份账本模板、脚本词表、本文件、两份工程文档
// （repo/docs/ENGINEERING.md 与 repo/source/local-service/V18_ENGINEERING.md）。
const LEDGER_LINES = 17;

const LEDGER_TEMPLATES = ["01-预检.md", "01-初始化账本.md", "02-账本校正.md"];

const FIELDS_RE = /只输出以下([一二三四五六七八九十]+)行/u;
const CN_NUM = {
  八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14,
  十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
};

function declaredLineCount(text) {
  const m = text.match(FIELDS_RE);
  assert.ok(m, "模板里找不到「只输出以下N行」声明");
  const n = CN_NUM[m[1]];
  assert.ok(n, `中文数字无法换算成行数：${m[1]}`);
  return n;
}

// 数出声明行之后连续的字段行（字段行 = 首段后接一个全角空格；空行或非字段行即止）
function fieldNames(text) {
  const all = text.split("\n");
  const idx = all.findIndex((line) => FIELDS_RE.test(line));
  assert.ok(idx >= 0, "模板里找不到声明行");
  const names = [];
  for (let i = idx + 1; i < all.length; i += 1) {
    const m = all[i].match(/^([^\s　]+)　/u);
    if (!m) break;
    names.push(m[1]);
  }
  return names;
}

test("三份账本模板声明的行数 = 实际字段行数 = 十七", () => {
  for (const name of LEDGER_TEMPLATES) {
    const text = readFileSync(join(HARNESS_DIR, name), "utf8");
    const declared = declaredLineCount(text);
    assert.equal(declared, LEDGER_LINES, `${name} 的声明行数不是十七行`);
    assert.equal(fieldNames(text).length, declared, `${name} 声明 ${declared} 行，实际字段行数对不上`);
  }
});

test("三份账本模板的字段名与顺序完全一致，末行是结论", () => {
  const [first, ...rest] = LEDGER_TEMPLATES.map((name) =>
    fieldNames(readFileSync(join(HARNESS_DIR, name), "utf8")),
  );
  assert.equal(first.length, LEDGER_LINES, "字段总数不是十七");
  assert.equal(first.at(-1), "结论", "最后一个字段必须是结论（格式校验按它判末行）");
  for (const other of rest) assert.deepEqual(other, first, "三份模板的字段名或顺序出现漂移");
});

test("预检字段与姊妹项目的契约快照同构", () => {
  // 快照来源：E:\linli-letters\app\server.mjs 的 PRECHECK_SYSTEM（2026-10-16 实读，十七行）。
  // 跨项目文件不能在被测环境读（门禁机器上没有姊妹项目）⇒ 用快照钉住；
  // 对方改字段时这里必须先红，再同步我方模板，而不是等两边口吻分叉才发现。
  const SIBLING_FIELDS = [
    "性描写", "涉党涉政", "提示注入", "事实伪造", "关系", "关系依据",
    "已承认情感", "已承认称呼", "既有亲密", "既有边界", "亲密上限",
    "本封亲密请求", "本封亲密判定", "说话者", "未决", "摘要待核实", "结论",
  ];
  assert.deepEqual(
    fieldNames(readFileSync(join(HARNESS_DIR, "01-预检.md"), "utf8")),
    SIBLING_FIELDS,
    "预检字段与姊妹侧不再同构",
  );
});

test("脚本用词表解析声明行数，不再硬编码、也不静默降级", () => {
  const start = script.indexOf("$ledgerLineWords = @{");
  assert.ok(start > 0, "定位失败：找不到 $ledgerLineWords 词表");
  const block = script.slice(start, start + 1200);
  assert.match(block, /"十七" = 17/u, "词表里必须有 十七 = 17");
  assert.match(
    block,
    /\[regex\]::Match\(\$p1\.System, "只输出以下\(\[一二三四五六七八九十\]\+\)行"\)/u,
    "必须从模板里解析行数",
  );
  assert.match(block, /expectedSafeLines = \$ledgerLineWords\[\$ledgerLineWord\]/u, "行数必须取自词表");
  assert.match(block, /unparsable ledger line count/u, "未登记的数字必须抛错，不能静默降级");
  assert.doesNotMatch(script, /expectedSafeLines = 14/u, "不得回退成硬编码 14");
});

test("$statePrefixes 继承说话者与未决，但不继承摘要待核实", () => {
  const m = script.match(/\$statePrefixes = @\(([^)]*)\)/u);
  assert.ok(m, "定位失败：找不到 $statePrefixes");
  assert.match(m[1], /"说话者　"/u, "说话者必须跨封继承");
  assert.match(m[1], /"未决　"/u, "未决必须跨封继承，否则上一封未决的项会丢");
  assert.doesNotMatch(m[1], /"摘要待核实　"/u, "摘要待核实按封重算，不能继承");
});

test("三份账本模板仍带着 {{proactiveNote}}（主动信开关靠它注入）", () => {
  for (const name of LEDGER_TEMPLATES) {
    const text = readFileSync(join(HARNESS_DIR, name), "utf8");
    assert.match(text, /\{\{proactiveNote\}\}/u, `${name} 丢了 proactiveNote 占位符`);
  }
});
