// letter-harness-antifabrication.test.js
// ---------------------------------------------------------------------------
// 「禁补史机械护栏」的护栏（2026-10-16）
//
// 背景：harness/04-尾端检查.md 的「历史证据」一栏要求「草稿引用的旧话、旧称呼、
// 旧约定、旧动作或共同事实，必须能在近期原文或带 ID 与哈希的检索原文中找到」，
// 但那一栏的「过 / 违规」也是**模型自己**写的 —— 模型写「过」就真的过了。
// 2026-10-16 给 harness-4step.ps1 加了一层不看模型结论的机械检查：
//   本轮零原文证据（$historyEvidence.Count -eq 0）+ 草稿命中「指代更早」的措辞
//   ⇒ 判违规，与模型自报的违规同等处理（走 STEP5 重写）。
//
// 这个套件做三件事：
//   1. 源码结构断言：函数存在、判定与调用顺序正确（不能出现「定义了但从不调用」）
//   2. 码点表逐项对照：.ps1 里的 [char]0xXXXX 拼出来的词 == 本文件里的期望词
//      （防止两边漂移 —— 镜像测试最大的风险就是镜子里写的是另一套词）
//   3. 判定逻辑镜像：零证据+命中 ⇒ 拦；有证据 ⇒ 放；不命中 ⇒ 放
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const HARNESS = join(
    here,
    "..",
    "..",
    ".cursor",
    "skills",
    "fit-letters",
    "scripts",
    "harness-4step.ps1"
);

const SOURCE = readFileSync(HARNESS, "utf8");

/** 期望词表：与 harness-4step.ps1 的 $historyClaimWords 必须逐项一致。 */
const EXPECTED_WORDS = [
    "上次",
    "上回",
    "上封",
    "前些天",
    "还记得",
    "你跟我说过",
    "你讲过",
    "你答应过",
    "每次你都",
    "你以前总是"
];

/** 从 .ps1 里解析码点表（每个词是一串 `(-join @([char]0xXXXX, ...))`）。 */
function parseClaimWords(source) {
    const tableMatch = source.match(/\$historyClaimWords\s*=\s*@\(([\s\S]*?)\r?\n\)/u);
    assert.ok(tableMatch, "定位失败：.ps1 里找不到 $historyClaimWords = @( … ) 表");
    const body = tableMatch[1];
    const words = [];
    const re = /\(-join @\(\[char\](0x[0-9A-Fa-f]{4}(?:\s*,\s*\[char\]0x[0-9A-Fa-f]{4})*)\)\)/gu;
    let m;
    while ((m = re.exec(body)) !== null) {
        const codes = m[1].match(/0x[0-9A-Fa-f]{4}/gu).map(c => Number.parseInt(c, 16));
        words.push(String.fromCharCode(...codes));
    }
    return words;
}

/** 判定逻辑镜像（与 .ps1 的 Get-DraftHistoryClaims 一一对应）。 */
function mirrorClaims(draft, evidenceCount, words = EXPECTED_WORDS) {
    if (evidenceCount > 0) return [];
    if (!draft || draft.trim() === "") return [];
    return draft
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0 && words.some(w => line.includes(w)));
}

test("harness-4step.ps1 里存在禁补史护栏的函数定义与两处调用", () => {
    assert.match(SOURCE, /function Get-DraftHistoryClaims\(\[string\]\$Draft, \[int\]\$EvidenceCount\)\s*\{/u);
    const calls = SOURCE.match(/Get-DraftHistoryClaims -Draft/gu) ?? [];
    assert.equal(calls.length, 2, "应当有两处调用：STEP4 判定前 + STEP5 重写后复查");
});

test("判定必须在「零证据」时才拦（有证据一律放行）", () => {
    const fnStart = SOURCE.indexOf("function Get-DraftHistoryClaims");
    assert.ok(fnStart > 0, "定位失败：找不到 Get-DraftHistoryClaims 函数");
    const fnBody = SOURCE.slice(fnStart, SOURCE.indexOf("\n}", fnStart));
    assert.ok(fnBody.length > 0, "定位失败：函数体为空（切片落空 ⇒ 断言会静默失效）");
    assert.match(
        fnBody,
        /if\s*\(\s*\$EvidenceCount\s*-gt\s*0\s*\)\s*\{\s*return\s*@\(\)\s*\}/u,
        "函数开头必须先判「有证据就返回空」，否则会误伤合法引用"
    );
});

test("码点表与本文件期望词逐项一致（防两边漂移）", () => {
    const parsed = parseClaimWords(SOURCE);
    assert.deepEqual(parsed, EXPECTED_WORDS);
});

test("词表只收「指代更早」的措辞，不收本封信里的常用词", () => {
    // 反向：这些词在正常回信里出现不该被拦（避免误伤）
    for (const ok of ["今天", "刚才", "这封信", "你说的这件事"]) {
        assert.ok(!EXPECTED_WORDS.includes(ok), `词表不应包含「${ok}」`);
    }
    assert.ok(EXPECTED_WORDS.length >= 8, "词表太短会漏拦");
});

test("判定逻辑镜像：零证据 + 命中 ⇒ 拦；有证据 ⇒ 放；不命中 ⇒ 放", () => {
    const draft = "上次你说的那件事，我一直记着。\n今天想问问你近况。";
    assert.deepEqual(mirrorClaims(draft, 0), ["上次你说的那件事，我一直记着。"]);

    assert.deepEqual(mirrorClaims(draft, 3), [], "有原文证据时交给 STEP4 逐句核对，不机械拦");

    assert.deepEqual(mirrorClaims("今天想问问你近况。\n天气不错。", 0), []);

    assert.deepEqual(mirrorClaims("", 0), []);
    assert.deepEqual(mirrorClaims("   \n  ", 0), []);
});

test("源码顺序：词表 → 函数 → 调用 1（在 $bad 判定前）→ 调用 2（在 STEP5 复查前）", () => {
    const wordsAt = SOURCE.indexOf("$historyClaimWords = @(");
    const fnAt = SOURCE.indexOf("function Get-DraftHistoryClaims");
    const call1At = SOURCE.indexOf("$draftClaims = @(Get-DraftHistoryClaims");
    const call2At = SOURCE.indexOf("$recheckClaims = @(Get-DraftHistoryClaims");
    const badGateAt = SOURCE.indexOf("if ($bad.Count -eq 0) {");
    const recheckAt = SOURCE.indexOf('if ($recheckBad.Count -gt 0) { throw "STEP5 rewritten reply still violates hard checks" }');

    for (const [name, at] of [
        ["$historyClaimWords", wordsAt],
        ["Get-DraftHistoryClaims", fnAt],
        ["调用 1", call1At],
        ["调用 2", call2At],
        ["$bad 判定", badGateAt],
        ["STEP5 复查 throw", recheckAt]
    ]) {
        assert.ok(at > 0, `定位失败：找不到 ${name}（顺序断言会静默失效）`);
    }

    assert.ok(wordsAt < fnAt, "词表必须定义在函数之前（PowerShell 顺序执行）");
    assert.ok(fnAt < call1At, "函数必须先定义后调用");
    assert.ok(call1At < badGateAt, "调用 1 必须出现在 if ($bad.Count -eq 0) 之前，否则不生效");
    assert.ok(call2At > badGateAt, "调用 2 应在 STEP5 重写分支内");
    assert.ok(call2At < recheckAt, "调用 2 必须在复查 throw 之前");
});

test("调用 1 把命中句并进 $bad（与模型自报违规同等处理）", () => {
    const call1At = SOURCE.indexOf("$draftClaims = @(Get-DraftHistoryClaims");
    assert.ok(call1At > 0, "定位失败：找不到调用 1");
    const seg = SOURCE.slice(call1At, call1At + 600);
    assert.ok(seg.includes("$bad += @("), "命中句必须追加进 $bad，否则 STEP4 的「过」仍会放行");
    assert.match(seg, /\$badWord/u, "追加的行要带上「违规」标记词，STEP5 才认得出");
});
