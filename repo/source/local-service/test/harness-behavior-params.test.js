import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// S5「行为参数」的护栏（2026-10-16，两端写信引擎同步方案 §5.1 / §3.8）。
//
// 为什么需要这个套件：`harness/行为参数.json` 是两端硬校验数值的**单一真相源**，
// 但它自己不会被任何东西守护 —— 规范文本改了（写法.md 的 200 字改成 150 字）、
// 或谁把禁词表删掉两项，都不会有任何报错。本套件把三件事钉住：
//   ① 硬校验必须「不严于」规范目标值（否则照规范写出来的信会被程序拒掉）；
//   ② 参数文件里的目标值必须与真源规范文本里的中文数字一致（防两边漂移）；
//   ③ 清单（harness-manifest.json）必须覆盖 harness 目录里的每一个文件，
//      且逐项哈希/字节/行数与磁盘一致（清单过期即红）。

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(here, "..", ".."); // repo/source
const HARNESS_DIR = join(SOURCE_DIR, "harness");
const PARAMS_PATH = join(HARNESS_DIR, "行为参数.json");
const MANIFEST_PATH = join(HARNESS_DIR, "harness-manifest.json");
const SCRIPT_PATH = join(SOURCE_DIR, ".cursor", "skills", "fit-letters", "scripts", "harness-4step.ps1");
const GEN_PATH = join(SOURCE_DIR, "tools", "gen-harness-manifest.mjs");
const BUILD_PS1 = join(SOURCE_DIR, "local-service", "packaging", "build-release.ps1");

const params = JSON.parse(readFileSync(PARAMS_PATH, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const script = readFileSync(SCRIPT_PATH, "utf8");
const columns = readFileSync(join(HARNESS_DIR, "00-栏目.md"), "utf8");
const craft = readFileSync(join(HARNESS_DIR, "写法.md"), "utf8");

// 从文本里**提取**数字再比对（而不是拿参数去构造正则）——
// 用参数构造正则时，「两边一起错」会一起通过，等于没测。
function numberIn(text, re, label) {
  const m = text.match(re);
  assert.ok(m, `定位失败：${label}（规范文本被改写了，请同步更新本断言）`);
  return Number(m[1]);
}

test("行为参数.json：结构齐备，硬校验都是正整数且 min < max", () => {
  assert.equal(params.paramsVersion, 1);
  for (const [who, cfg] of [
    ["reply", params.reply],
    ["proactive", params.proactive],
  ]) {
    for (const k of ["maxChars", "minChars", "maxParagraphs", "maxAsciiRun"]) {
      assert.ok(Number.isInteger(cfg[k]) && cfg[k] > 0, `${who}.${k} 必须是正整数，实际 ${cfg[k]}`);
    }
    assert.ok(cfg.minChars < cfg.maxChars, `${who}: minChars(${cfg.minChars}) 必须小于 maxChars(${cfg.maxChars})`);
  }
  assert.ok(
    params.reply.forbidNamePrefixRegex.startsWith("^") &&
      !params.reply.forbidNamePrefixRegex.startsWith("/") &&
      !params.reply.forbidNamePrefixRegex.endsWith("/"),
    "角色名前缀必须是锚定行首的正则 pattern 本体（不以 / 开头、不以 / 结尾）",
  );
  assert.ok(params.targets?.reply && params.targets?.proactive, "targets 必须同时有 reply 与 proactive");
  assert.ok(params.antifabrication?.historyClaimWordsWhenZeroEvidence, "缺 antifabrication 词表");
});

test("禁词表：无重复、无空项、无首尾空白（否则 includes 检查形同虚设）", () => {
  const lists = [
    ["reply.forbiddenWords", params.reply.forbiddenWords],
    ["proactive.extraForbiddenWords", params.proactive.extraForbiddenWords],
    ["antifabrication.historyClaimWordsWhenZeroEvidence", params.antifabrication.historyClaimWordsWhenZeroEvidence],
  ];
  for (const [name, list] of lists) {
    assert.ok(Array.isArray(list) && list.length > 0, `${name} 必须是非空数组`);
    assert.equal(new Set(list).size, list.length, `${name} 有重复项：${list.join("、")}`);
    for (const w of list) {
      assert.equal(typeof w, "string", `${name} 含非字符串项：${JSON.stringify(w)}`);
      assert.equal(w.trim(), w, `${name} 含首尾空白项：${JSON.stringify(w)}（带空白永远匹配不上正文）`);
      assert.ok(w.length > 0, `${name} 含空串项（空串会让 includes 恒真）`);
    }
  }
});

test("硬校验不严于规范目标值（否则照规范写出来的信会被程序拒掉）", () => {
  const cases = [
    ["reply.maxChars", params.reply.maxChars, params.targets.reply.complexMaxChars],
    ["reply.maxParagraphs", params.reply.maxParagraphs, params.targets.reply.maxParagraphs],
    ["proactive.maxChars", params.proactive.maxChars, params.targets.proactive.maxChars],
    ["proactive.maxParagraphs", params.proactive.maxParagraphs, params.targets.proactive.paragraphs[1]],
  ];
  for (const [label, hard, target] of cases) {
    assert.ok(
      Number.isInteger(target),
      `定位失败：${label} 对应的规范目标值不是整数（targets 结构被改了吗）`,
    );
    assert.ok(hard >= target, `${label}: 硬校验 ${hard} 严于规范目标 ${target} —— 规范允许的信会被拒`);
  }
});

test("targets.reply 与 00-栏目.md / 写法.md 里的中文数字一致（规范改了、参数没改即红）", () => {
  const t = params.targets.reply;

  // 00-栏目.md:9  「通常3~4段、不超过200字；…三件以上或认真大问题4~5段、可到220字；复杂可到6段。」
  const colsTypical = columns.match(/通常\s*(\d+)\s*~\s*(\d+)\s*段/u);
  assert.ok(colsTypical, "定位失败：00-栏目.md 里找不到「通常N~M段」");
  assert.deepEqual([Number(colsTypical[1]), Number(colsTypical[2])], t.typicalParagraphs, "typicalParagraphs 与 00-栏目.md 不一致");
  assert.equal(numberIn(columns, /通常\s*\d+\s*~\s*\d+\s*段、不超过\s*(\d+)\s*字/u, "00-栏目.md 的「不超过N字」"), t.typicalMaxChars);
  assert.equal(numberIn(columns, /可到\s*(\d+)\s*字/u, "00-栏目.md 的「可到N字」"), t.complexMaxChars);
  assert.equal(numberIn(columns, /复杂可到\s*(\d+)\s*段/u, "00-栏目.md 的「复杂可到N段」"), t.maxParagraphs);

  // 写法.md:78-80「通常 3~4 段…不超过 200 字」「1~2 段即可」「4~5 段、到 220 字；复杂时到 6 段」
  const craftTypical = craft.match(/通常\s*(\d+)\s*~\s*(\d+)\s*段[\s\S]{0,40}?不超过\s*(\d+)\s*字/u);
  assert.ok(craftTypical, "定位失败：写法.md 里找不到「通常 N~M 段…不超过 K 字」");
  assert.deepEqual([Number(craftTypical[1]), Number(craftTypical[2])], t.typicalParagraphs, "typicalParagraphs 与 写法.md 不一致");
  assert.equal(Number(craftTypical[3]), t.typicalMaxChars, "typicalMaxChars 与 写法.md 的「不超过 N 字」不一致");
  assert.deepEqual(
    (craft.match(/(\d+)\s*~\s*(\d+)\s*段即可/u) ?? []).slice(1, 3).map(Number),
    t.singleTopicParagraphs,
    "singleTopicParagraphs 与 写法.md 的「N~M 段即可」不一致",
  );
  const craftComplex = craft.match(/(\d+)\s*~\s*(\d+)\s*段、到\s*(\d+)\s*字；复杂时到\s*(\d+)\s*段/u);
  assert.ok(craftComplex, "定位失败：写法.md 里找不到「N~M 段、到 K 字；复杂时到 J 段」");
  assert.deepEqual([Number(craftComplex[1]), Number(craftComplex[2])], t.complexParagraphs, "complexParagraphs 与 写法.md 不一致");
  assert.equal(Number(craftComplex[3]), t.complexMaxChars, "complexMaxChars 与 写法.md 不一致");
  assert.equal(Number(craftComplex[4]), t.maxParagraphs, "maxParagraphs 与 写法.md 不一致");
});

test("targets.proactive 与主动信规范文本一致（文件到齐前这条会红，属预期）", () => {
  // S3/S4 会把主动信规范抽成 harness/主动来信.md；在那之前，主动信的目标值只有姊妹侧
  // 的那一份（E:/linli-letters/app/harness/主动来信.md，不在本仓库内），无法在真源侧断言。
  // 这里先断言「参数自洽」，并在主动来信.md 到齐后由下一条断言接管。
  const t = params.targets.proactive;
  assert.ok(Array.isArray(t.paragraphs) && t.paragraphs.length === 2, "proactive.paragraphs 必须是 [下限, 上限]");
  assert.ok(t.paragraphs[0] < t.paragraphs[1], "proactive.paragraphs 下限必须小于上限");
  assert.ok(Number.isInteger(t.maxChars) && t.maxChars > 0, "proactive.maxChars 必须是正整数");
  const localProactive = join(HARNESS_DIR, "主动来信.md");
  let text = null;
  try {
    text = readFileSync(localProactive, "utf8");
  } catch {
    text = null;
  }
  if (text === null) {
    assert.ok(
      typeof t.source === "string" && t.source.length > 0,
      "主动来信.md 还没到真源（S3 未做）时，targets.proactive.source 必须写明数值出处，不许留空",
    );
    return;
  }
  // S3 之后：主动来信.md 到齐，改为从真源文本提取
  const got = text.match(/(\d+)\s*~\s*(\d+)\s*段[\s\S]{0,20}?不超过\s*(\d+)\s*字/u);
  assert.ok(got, "定位失败：主动来信.md 里找不到「N~M 段…不超过 K 字」");
  assert.deepEqual([Number(got[1]), Number(got[2])], t.paragraphs, "proactive.paragraphs 与 主动来信.md 不一致");
  assert.equal(Number(got[3]), t.maxChars, "proactive.maxChars 与 主动来信.md 不一致");
});

test("禁词表覆盖规范文本点名的泄漏面（00-栏目.md 的「泄漏」栏逐个落成禁词）", () => {
  // 这一条是双向的：规范点名了、禁词表却没有 ⇒ 红；规范不再点名 ⇒ 也红（提示同步）。
  // 它守的是「禁词表被悄悄删项」——只断言“非空/无重复”挡不住删掉一项。
  const leak = columns.match(/泄漏\s+(.+)/u);
  assert.ok(leak, "定位失败：00-栏目.md 里找不到「泄漏」栏");
  for (const w of ["预检", "账本", "栏目"]) {
    assert.ok(leak[1].includes(w), `00-栏目.md 的泄漏栏里没提到「${w}」——规范文本被改了吗`);
    assert.ok(
      params.reply.forbiddenWords.includes(w),
      `禁词表缺「${w}」：规范点名的泄漏面必须逐个落成禁词，删项不会让别的断言变红`,
    );
  }
});

test("防补史词表与 harness-4step.ps1 的 $historyClaimWords 逐项一致（码点解码后比）", () => {
  const block = script.match(/\$historyClaimWords = @\(([\s\S]*?)\n\)/u);
  assert.ok(block, "定位失败：脚本里找不到 $historyClaimWords 数组");
  const fromScript = [...block[1].matchAll(/\(-join @\(([^)]*)\)\)/gu)].map((m) =>
    m[1]
      .split(",")
      .map((s) => String.fromCodePoint(parseInt(s.trim().replace(/\[char\]0x/iu, ""), 16)))
      .join(""),
  );
  assert.ok(fromScript.length > 0, "定位失败：一个码点组都没解析出来（脚本换了写法？）");
  assert.deepEqual(
    params.antifabrication.historyClaimWordsWhenZeroEvidence,
    fromScript,
    "行为参数.json 的防补史词表与真源脚本的 $historyClaimWords 必须逐项一致：改一处就要同批改另一处",
  );
});

function digest(abs) {
  const buf = readFileSync(abs);
  const text = buf.toString("utf8");
  return {
    bytes: buf.length,
    lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

test("harness-manifest.json 覆盖 harness 目录下每个文件，且逐项与磁盘一致", () => {
  const files = manifest.files;
  assert.ok(files && typeof files === "object", "清单缺 files 段");

  // 反向检查：目录里有、清单里没有 ⇒ 红（比「清单里有、目录里没有」重要得多）
  const onDisk = readdirSync(HARNESS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== "harness-manifest.json")
    .map((e) => e.name);
  const unlisted = onDisk.filter((n) => !(n in files));
  assert.deepEqual(
    unlisted,
    [],
    `清单缺文件：${unlisted.join("、")} —— 跑 node repo/source/tools/gen-harness-manifest.mjs 重出清单`,
  );

  for (const [name, meta] of Object.entries(files)) {
    assert.match(meta.sha256, /^[0-9a-f]{64}$/u, `${name} 的 sha256 必须是小写十六进制（PowerShell 侧要先 .ToLower()）`);
    const abs = join(HARNESS_DIR, meta.relPath ?? name);
    const got = digest(abs);
    assert.deepEqual(
      { bytes: got.bytes, lines: got.lines, sha256: got.sha256 },
      { bytes: meta.bytes, lines: meta.lines, sha256: meta.sha256 },
      `${name} 已改动但清单未同批重出（路径 ${meta.relPath ?? name}）`,
    );
  }
});

test("清单的 behavior 指向行为参数.json，且 pending / consumers 不被打空", () => {
  assert.equal(
    manifest.behavior?.source,
    "行为参数.json",
    "清单的 behavior 必须指向 行为参数.json（null = 还没有单一真相源，S5 已经做完了，不该退回 null）",
  );
  assert.ok(
    manifest.pending && Object.keys(manifest.pending).length > 0,
    "清单的 pending 被清空了 —— 若真的全部完成，请连同这条断言一起改，不要静默删",
  );
  assert.ok(Array.isArray(params.consumers) && params.consumers.length >= 2, "consumers 必须逐个列出两端的消费方");
  for (const c of params.consumers) {
    assert.ok(c.who && c.where && c.state, `consumers 每项必须有 who / where / state：${JSON.stringify(c)}`);
  }
  assert.ok(
    Array.isArray(params.pending) && params.pending.length > 0,
    "行为参数.json 的 pending 不许为空：OliviaSoul 侧生产链路的机械兜底尚未接",
  );
});

test("清单生成器：排除自身、支持 relPath、用小写 hex（源码钉死）", () => {
  const gen = readFileSync(GEN_PATH, "utf8");
  assert.match(gen, /e\.name !== SELF/u, "生成器必须排除清单自己，否则每次生成哈希都变（自引用死循环）");
  // 下面三条刻意写成「完整语句」而不是单个词：只匹配 `relPath` / `--check` 这种裸词时，
  // 代码里任何一处注释或别的用法都能让它保持绿 —— 那时它守不住任何东西（2026-10-16 变异测试发现）。
  assert.match(
    gen,
    /relPath: "\.\.\/林离人设\.md"/u,
    "生成器必须给林离人设.md 带 relPath（它物理上在 harness 的上一级，否则 join 会 ENOENT）",
  );
  assert.match(gen, /\.digest\("hex"\)/u, "生成器必须用小写十六进制（digest('hex')）");
  assert.match(
    gen,
    /process\.argv\.includes\("--check"\)/u,
    "生成器必须保留 --check 模式（测试与门禁靠它做只读比对）",
  );
  // ⑥ 码点解码的切片下标（2026-10-16 补，[审查-4] 同批次）
  //    注入脚本里中文名基本写成 `-join @([char]0x5386, …)`，`[char]0x5386` 长 **12** 字符
  //    （`[char]` 6 + `0x` 2 + 4 位十六进制）⇒ 十六进制从下标 8 起。
  //    这里曾经写成 `t.slice(9)`，把首位数字吃掉 ⇒ 解出 `Ά, ϲ, ࣀ` 这类乱码 ⇒ 现扫**静默变空**、
  //    `requiredBy.source` 少一大截，而当时没有任何断言会红（变异 G5 漏网就是这条）。
  //    断言写法：必须用**捕获组**取十六进制，不许再按固定下标切片。
  assert.match(
    gen,
    /\\\[char\\\]0x\(\[0-9A-Fa-f\]\{4\}\)/u,
    "码点解码必须用捕获组取十六进制（`[char]0x5386` 的十六进制在下标 8，按固定下标切片会吃掉首位数字 ⇒ 现扫静默变空）",
  );
  assert.match(
    gen,
    /Number\.parseInt\(hex, 16\)/u,
    "码点解码必须直接 parseInt(hex, 16)（用捕获组拿到的十六进制）",
  );
  // ⑦ `--check` 必须**同时**比对 requiredBy.source（2026-10-16 补）
  //    只比 files 的话，「扫描器少扫一项」是发现不了的：清单依旧“一致”，
  //    而那份文件在姊妹侧永远不被硬校验（= 不报错的漂移）。反向验证：摘掉清单里任一 requiredBy 项 ⇒ exit 1。
  assert.match(
    gen,
    /const expectReq = ordered\.filter\(\(k\) => RUNTIME_READ\.includes\(k\)\);/u,
    "--check 必须现算 expectReq（= ordered ∩ RUNTIME_READ）才能比对 requiredBy.source",
  );
  assert.match(
    gen,
    /requiredBy\.source 缺少（本侧运行时确实会读）/u,
    "--check 必须能在 requiredBy.source 少项时报出「缺少」",
  );
  assert.match(
    gen,
    /requiredBy\.source 多余（本侧运行时并不读）/u,
    "--check 必须能在 requiredBy.source 多项时报出「多余」",
  );
  // ⑦d 叙述字段的现算块（2026-10-17 [审查-5] 🟠-7 补）
  //     病根：`pathSemantics` / `syncedWith` / `requiredBy.note` 里的两端快照是**写死**的，
  //     姊妹侧同步之后它们集体变成假话，而 `--check` 只比 files 与 requiredBy.source ⇒ 一路绿灯
  //     （读包的人会据此得出错误结论）。修法 = 这些字段正文里不许出现具体数字，只留
  //     `<!--AUTO:id-->…<!--/AUTO:id-->` 占位，由生成器每轮现算回填。
  assert.match(
    gen,
    /<!--AUTO:\(\[\^>\]\+\)-->/u,
    "生成器必须回填 `<!--AUTO:id-->…<!--/AUTO:id-->` 形式的现算块（叙述字段不许再写死数字）",
  );
  //     结束标记在源码里是 `<!--\/AUTO:`（正则字面量里 `/` 要转义）—— 用 includes 比正则转义更不容易写错。
  assert.ok(
    gen.includes("<!--\\/AUTO:"),
    "生成器必须认 `<!--/AUTO:id-->` 结束标记（它是配对回填的另一半）",
  );
  assert.match(
    gen,
    /function autoBlockStructuralProblems\(text\)/u,
    "生成器必须有现算块的结构检查（孤立标记 / id 无实现 / 一块都没有）",
  );
  //     反验 B（2026-10-17 实测）暴露的缺口：第一版只查「配对块内容对不对」+「至少填了 1 块」，
  //     于是把开始标记写坏（`<!--AUTOx:…-->`）时，那个块**不再被正则匹配**、别的块还在填
  //     ⇒ 它从此永远停在旧内容上，而工具一路绿灯 —— 与 🟠-7 同一种病。
  //     判据：**结束标记总数必须等于配对块数**，多出来的即孤立标记。
  assert.match(
    gen,
    /孤立\*\*的现算块结束标记/u,
    "生成器必须能报出「孤立的结束标记」（开始标记被写坏时，那块会永远停在旧值上而不报错）",
  );
  assert.match(
    gen,
    /problems\.push\(\.\.\.autoBlockProblems\(readFileSync\(MANIFEST, "utf8"\)\)\);/u,
    "--check 必须把现算块比对并进 problems（只比 files/requiredBy 时，叙述字段过期永远不红）",
  );
  assert.match(
    gen,
    /const structural = autoBlockStructuralProblems\(text\);/u,
    "写盘分支必须先做结构检查（否则「回填时修好坏内容」会把孤立标记一起掩盖过去）",
  );
  //     变异 G7（2026-10-17）暴露的缺口：上面几条都是「有没有这套机制」的文本断言，
  //     把回填那行改成 `return whole;`（= 读了不写回）时它们**全都还是绿的** ——
  //     清单当前内容正好是上一轮回填过的正确值，于是「不回填」在单轮里看不出来。
  //     ⇒ 断言必须精确到**那条拼装语句**：它才是「把现算结果写回去」的承重行。
  assert.match(
    gen,
    /return `<!--AUTO:\$\{id\}-->\$\{fn\(\)\}<!--\/AUTO:\$\{id\}-->`;/u,
    "写盘分支必须真的把现算结果拼回去（改成 `return whole;` 会让叙述字段永远停在旧值上，而工具一路绿灯）",
  );
  // ⑧ `pathOverrides`（B6，2026-10-17 落地）：relPath 语义收敛为「真源侧相对路径」，
  //    跨级文件在姊妹侧会解析到不存在的路径 ⇒ 那份文件**永远不被硬校验**。
  //    `--check` 必须把它一起比对，且判据必须写成「每个消费方都查」而不是「查第一个」——
  //    否则以后加第二个消费方时又静默退回同一个洞（G9/G10 两条变异就是这么漏网的）。
  assert.match(
    gen,
    /problems\.push\(\.\.\.pathOverrideProblems\(prev\.pathOverrides\)\);/u,
    "--check 必须把 pathOverrides 一起比对（不比对时，新增跨级文件忘加覆盖 ⇒ 姊妹侧解析到空、静默不被校验）",
  );
  assert.match(
    gen,
    /for \(const root of consumers\) \{/u,
    "pathOverrides 校验必须遍历**每一个**消费方根目录（只查第一个 ⇒ 加第二个消费方时 B6 换个位置复活）",
  );
  assert.match(
    gen,
    /files\[k\]\.relPath\.includes\("\.\.\/"\)/u,
    "pathOverrides 校验必须按「relPath 含 ../」筛出跨级文件（这是 B6 的判据）",
  );
  assert.match(
    gen,
    /必须是相对消费方 harness 目录的路径且不得含 \.\./u,
    "pathOverrides 校验必须拒绝含 .. 的覆盖值（否则等于把洞换个位置）",
  );
});

test("打包清单含 行为参数.json、且刻意不含 harness-manifest.json（build-release.ps1 手写枚举）", () => {
  // AGENTS.md §二.3 第 7 条 / §七.1.5：「清单 vs 实际」是小问题重灾区 —— build-release.ps1 的
  // 复制清单是**手写枚举**，漏一个文件不会报任何错（单元测试读源码、产物检查只查前端）。
  // 真实事故（2026-10-15）：proactive-letters.js 没进顶层清单，用户装完打开程序只看到
  // 「本地服务启动失败 / Node 服务已退出，退出码：1」。
  const build = readFileSync(BUILD_PS1, "utf8");
  const marker = "resources\\workspace-template\\harness\\$name";
  const at = build.indexOf(marker);
  assert.ok(at > 0, `定位失败：build-release.ps1 里找不到 harness 复制目标 ${marker}（结构变了？请同步本断言）`);
  const line = build
    .slice(0, at)
    .split(/\r?\n/u)
    .reverse()
    .find((l) => l.includes("foreach ($name in @("));
  assert.ok(line, "定位失败：harness 复制目标前面没有 foreach 清单行");
  const names = [...line.matchAll(/"([^"]+)"/gu)].map((x) => x[1]);
  assert.ok(
    names.includes("行为参数.json"),
    "打包清单缺 行为参数.json：生产链路的字数/段数机械兜底接入后，用户机器上读不到它",
  );
  assert.ok(
    !names.includes("harness-manifest.json"),
    "打包清单不许含 harness-manifest.json：它是开发/审计用清单（含本机绝对路径 sourceRepo），进产物只会让产物随清单重出而变",
  );
  // 反向检查：harness 目录里每个「该进包」的文件都必须在清单里（新加的文件忘了登记即红）。
  // ⚠️ 不能只查 .json（2026-10-16 评审指出）：S2/S3/S4 会往这个目录加 .md（十七行预检、
  // 主动来信.md、主动信语料.md），而单元测试读的是**源码**、1.0-final-check 的产物检查只查前端 ——
  // 手写枚举漏掉一个 .md 的后果就是「用户机器上少一个文件」，没有任何一层会红。
  const onDisk = readdirSync(HARNESS_DIR).filter((n) => n !== "harness-manifest.json");
  assert.ok(onDisk.length >= 12, `harness 目录下只有 ${onDisk.length} 个要进包的文件？登记面异常，定位可能已失效`);
  for (const n of onDisk) {
    assert.ok(names.includes(n), `harness/ 下的 ${n} 没进打包清单（build-release.ps1 手写枚举漏了它）`);
  }
});

// ── S9「近况层」的数值与判据契约（2026-10-16） ────────────────────────────────
//
// 为什么先测「还没启用」的段：近况层的内容阻塞于用户拍板（方案 §3.9 自己标了
// 「不要自行裁定」：§0 说人设层冻结、§2.2 又说新人设已完整）。作者裁定前能做的、
// 也是必须先做的，是把**数值与判据**固化下来 —— 否则「档位阈值」会变成第三处手抄副本。
// 这段断言的全部意义是：**不许悄悄启用**（启用前必须先清 pending 与补齐词表）。
test("近况层契约（nearTerm）：未启用必须带 pending；启用后档位连续、判据可执行、禁入目标写死", () => {
  const nt = params.nearTerm;
  assert.ok(nt, "缺 nearTerm 段：S9 的数值与判据必须固化进本文件，两端才读得到同一份");

  // ① 「不许悄悄启用」：enabled=true 之前必须先把 pending 答完、把词表补齐
  if (nt.enabled === true) {
    assert.ok(!nt.pending, "nearTerm.enabled 已置 true，但 pending 还有内容：启用前必须先回答 P1 并清空 pending");
    assert.ok(
      Array.isArray(nt.mechanicalEvidence?.newTimeWords) && nt.mechanicalEvidence.newTimeWords.length > 0,
      "启用后必须有 newTimeWords 词表（方案 §3.9 要求，未给词表时只能是 null）",
    );
  } else {
    assert.equal(nt.enabled, false, "nearTerm.enabled 只允许是 true / false");
    assert.ok(typeof nt.pending === "string" && nt.pending.length > 0, "nearTerm 未启用时必须写明卡在哪（pending）");
  }

  // ② 档位必须连续覆盖 [0, +∞)：中间留缺口 = 某些信件数没有档位
  const tiers = [...nt.tiers].sort((a, b) => a.lettersFrom - b.lettersFrom);
  assert.ok(tiers.length >= 2, "至少要有一个「不注入」档与一个「注入」档");
  assert.equal(tiers[0].lettersFrom, 0, "第 0 档必须从 0 封开始");
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    assert.equal(
      prev.lettersTo + 1,
      cur.lettersFrom,
      `档位之间有缺口或重叠：第 ${prev.tier} 档到 ${prev.lettersTo}，下一档却从 ${cur.lettersFrom} 开始`,
    );
  }
  assert.equal(tiers.at(-1).lettersTo, null, "最后一档必须是开区间（方案 §3.9 是「> 60 封」）");

  // ③ 第 0 档不注入，其余注入
  for (const t of tiers) {
    assert.equal(t.inject, t.tier === 0 ? false : true, `第 ${t.tier} 档的 inject 与方案口径不符`);
  }

  // ④ override 必须指向一个真实存在的档
  assert.ok(
    tiers.some((t) => t.tier === nt.tierOverride.tier),
    `tierOverride 指向不存在的档 ${nt.tierOverride.tier}`,
  );
  assert.match(nt.tierOverride.when, /关系/u, "tierOverride 必须说明它读的是账本「关系」字段");
  // [审查-4] 代码-6：tierOverride 原先只有「配置形状」断言（指向存在的档、when 含「关系」），
  // 没有任何东西能证明它**到底实没实现** —— 一条永不生效的规则躺在配置里，读起来像功能齐了。
  // 契约：`implemented` 必须显式写布尔；标 false 时要写清为什么、并给出源码里的 TODO 标记，
  // 且该标记必须真能在 server.js 里找到（两边说法不许各写各的）。
  assert.equal(
    typeof nt.tierOverride.implemented,
    "boolean",
    "tierOverride 必须显式标 implemented: true/false，不许留空让人猜",
  );
  if (nt.tierOverride.implemented === false) {
    assert.ok(
      (nt.tierOverride.whyNotImplemented ?? "").length >= 40,
      "tierOverride 标了 implemented:false，就必须在 whyNotImplemented 里写清为什么现在做不到（≥40 字）",
    );
    assert.match(
      nt.tierOverride.todoMarker ?? "",
      /^TODO\([a-z-]+\)$/u,
      "tierOverride 标 false 时必须给出形如 TODO(标记名) 的标记名",
    );
    assert.ok(
      readFileSync(join(SOURCE_DIR, "local-service", "server.js"), "utf8").includes(nt.tierOverride.todoMarker),
      `行为参数.json 说 tierOverride 未实现并指向 ${nt.tierOverride.todoMarker}，但 server.js 里找不到该标记 —— 两边说法不一致`,
    );
  } else {
    // 标 true 的一方要自己拿证据：源码里必须真的在读账本「关系」档位。
    // 现在没有任何地方读它 ⇒ 谁把 implemented 翻成 true，这条就红，逼他先把实现写出来。
    const impl = readFileSync(join(SOURCE_DIR, "local-service", "server.js"), "utf8");
    assert.match(
      impl,
      /relationStanding|账本关系|relationTier/u,
      "tierOverride 标了 implemented:true，但 server.js 里找不到任何读账本「关系」档位的实现 —— 要么真做出来，要么把 implemented 改回 false",
    );
  }

  // ⑤ 机械判据必须是能编译的正则
  assert.doesNotThrow(
    () => new RegExp(nt.mechanicalEvidence.newActionPattern, "u"),
    "mechanicalEvidence.newActionPattern 不是合法正则",
  );
  assert.match(nt.mechanicalEvidence.newActionPattern, /\(去\|买\|/u, "新动作词表被改写了？请同步方案 §3.9");

  // ⑥ 禁入目标写死：摘要在前（这是「不许被事实化」的唯一防线）
  const joined = nt.forbiddenTargets.join(" ");
  assert.match(joined, /摘要/u, "forbiddenTargets 必须点名「摘要」—— 近况层进了摘要就会被后续检索当事实反复引用");
  assert.match(joined, /账本/u, "forbiddenTargets 必须点名跨封账本");
  assert.match(joined, /navigation/u, "forbiddenTargets 必须点名 {{navigation}}");

  // ⑦ 载体与变量名两端必须一致
  assert.equal(nt.variable, "drift");
  assert.match(nt.carrier, /近况\.md$/u, "carrier 必须指向 harness/近况.md");
  assert.match(nt.injectAt, /03-中段生成\.md/u, "注入点是 STEP3");

  // ⑦b 模板里的每一个 {{变量}} 都必须登记在清单的 variablesById 里（2026-10-16 补）
  //     为什么单列一条：variablesById 是**手维护**的（gen-harness-manifest.mjs 只生成 files/generatedAt），
  //     而渲染侧的守卫在 Expand-Harness（未登记变量 ⇒ throw、渲染后再查残留 ⇒ throw）。
  //     两者是不同层：渲染守卫保「生成不出事」，这张表保「跨端对照与审计不失真」——
  //     模板加了变量而忘了改这张表，谁都不会报错（不报错的漂移最贵）。
  {
    const declared = manifest.variablesById ?? {};
    const extractVars = (name) => {
      const body = readFileSync(join(HARNESS_DIR, name), "utf8");
      return [...new Set([...body.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu)].map((m) => m[1]))];
    };
    const missing = [];
    const scanned = [];
    for (const name of readdirSync(HARNESS_DIR).filter((n) => n.endsWith(".md"))) {
      const raw = readFileSync(join(HARNESS_DIR, name), "utf8");
      // 只扫**真模板**：模板的判据是含 `## System` / `## User` 段（与
      // letter-harness-strict-render.test.js 的渲染判据同源）。
      // 反例（本断言第一版就踩了）：`近况.md` 是**内容文件**，但它的散文里有一处
      // 「第 0 档不注入（\`{{drift}}\` 为空串）」—— 那是**说明**不是占位符，
      // 按「见 {{ 就当变量」会把说明文字误判成未登记变量。
      if (!/^##\s+(System|User)\s*$/mu.test(raw)) continue;
      scanned.push(name);
      const known = new Set(declared[name] ?? []);
      for (const v of extractVars(name)) {
        if (!known.has(v)) missing.push(`${name}:{{${v}}}`);
      }
    }
    assert.ok(
      scanned.length >= 6,
      `只扫到 ${scanned.length} 个模板（${scanned.join("、")}）—— 判据写歪了，断言会空转`,
    );
    assert.deepEqual(
      missing,
      [],
      `harness 模板里有变量没登记进清单 variablesById：${missing.join("、")} —— 补登记或重出清单`,
    );
  }

  // ⑦c `requiredBy.source` 必须覆盖「本侧真的会读的 harness 文件」（2026-10-16 补）
  //     为什么必须钉住：这张表是**跨端对照的输入** —— 姊妹侧照它决定「缺了要补」还是
  //     「本来就不该有」（它自己的 tests/harness-manifest.test.js ① 就是这么用的）。
  //     它现在由 gen-harness-manifest.mjs 的 RUNTIME_READ 常量生成，但**没有任何东西**
  //     会在「真读了却没登记」时报错 —— 典型的 AGENTS.md §七.4「不报错的漂移」。
  //
  //     判据（只能用「本侧真读集合」这一侧，姊妹侧的读取点不在本仓库内，硬编码它的
  //     文件名会变成第二份真源）：从注入脚本里把 `harness/<文件名>` 全部扫出来
  //     （含用 `[char]0xXXXX` 码点拼中文名的那种写法 ⇒ 先反解再扫），
  //     要求**每一个**都出现在 requiredBy.source 里。
  //     扫描面包含 `[char]` 拼接是为了不重蹈 [审查-4] §四 那个坑（按文件名字符串
  //     直接搜会全部漏掉）；下一条 `assert.ok` 就是它的防空转闸。
  {
    const src = manifest.requiredBy?.source ?? [];
    const fileKeys = Object.keys(manifest.files ?? {});
    const declared = new Set(src);

    // 清单里登记的项必须真实存在于 files（防止清单写了不存在的文件）
    const ghosts = src.filter((k) => !fileKeys.includes(k));
    assert.deepEqual(ghosts, [], `requiredBy.source 里有清单 files 中不存在的项：${ghosts.join("、")}`);

    const SCRIPTS_DIR = join(SOURCE_DIR, ".cursor", "skills", "fit-letters", "scripts");
    const readHarnessNames = (text) => {
      // 先把 `-join @([char]0x6797, [char]0x79BB, …)` 这类码点拼接还原成字符，再统一扫 `harness/<名>`。
      // 为什么要还原：脚本里的中文文件名是**按码点拼的**（避免 .ps1 编码问题），
      // 按文件名字符串直接搜会**全部漏掉** —— [审查-4] §四 已踩过同一个坑。
      const decoded = text.replace(/\[char\]0x[0-9A-Fa-f]{4}/gu, (t) =>
        String.fromCodePoint(Number.parseInt(t.slice(9), 16)),
      );
      return [...new Set([...decoded.matchAll(/harness[\\/]([^\\/"'\s)]+\.(?:md|json|ps1|txt))/gu)].map((m) => m[1]))];
    };
    const sourceNames = new Set();
    for (const f of ["harness-live.ps1", "harness-proactive.ps1", "harness-4step.ps1", "ds-call.ps1"]) {
      const p = join(SCRIPTS_DIR, f);
      if (existsSync(p)) for (const n of readHarnessNames(readFileSync(p, "utf8"))) sourceNames.add(n);
    }
    // server.js 侧读 `harness/行为参数.json` 与 `harness/VERSION`（resolveDriftTier / 两个 generator）
    const serverJs = join(SOURCE_DIR, "local-service", "server.js");
    if (existsSync(serverJs)) for (const n of readHarnessNames(readFileSync(serverJs, "utf8"))) sourceNames.add(n);

    const knownNames = [...sourceNames].filter((n) => fileKeys.includes(n));
    const notDeclared = knownNames.filter((n) => !declared.has(n));

    assert.ok(
      knownNames.length >= 5,
      `只从注入脚本与 server.js 里扫到 ${knownNames.length} 个 harness 文件名（${knownNames.join("、")}）—— 扫描判据写歪了，这断言会空转`,
    );
    assert.deepEqual(
      notDeclared,
      [],
      `这些文件本侧真的会读，却没登记进 requiredBy.source：${notDeclared.join("、")} —— 改 gen-harness-manifest.mjs 的 RUNTIME_READ 后重出清单`,
    );
  }

  // ⑧ 未启用时载体文件允许不存在；一旦启用就必须既存在、又进了清单
  if (nt.enabled === true) {
    assert.ok(readdirSync(HARNESS_DIR).includes("近况.md"), "nearTerm 已启用，但 harness/近况.md 不存在");
    assert.ok(manifest.files["近况.md"], "nearTerm 已启用，但清单里没有 近况.md（重出 gen-harness-manifest.mjs）");
  }

  // ⑨ P1（2026-10-16 用户拍板）三问的口径必须落成字段 —— 缺一个就是「拍板没落地」
  if (nt.enabled === true) {
    assert.ok(
      typeof nt.whyEnabled === "string" && nt.whyEnabled.length > 0,
      "启用后必须写明 whyEnabled（谁、什么时候、按什么口径拍的板）",
    );
    assert.equal(nt.thresholdMode, "letters", "P1 口径：分档按信件数");
    assert.equal(nt.allowRollback, false, "P1 口径：档位不回退");
    const tg = nt.userToggle;
    assert.ok(tg, "P1 口径：必须给用户「保持她现在的样子」开关（userToggle）");
    assert.equal(typeof tg.key, "string");
    assert.ok(tg.key.length > 0, "userToggle.key 不能为空");
    assert.equal(tg.default, false, "userToggle.default 必须是 false（默认近况层生效）");
    assert.match(tg.label, /保持她现在的样子/u, "开关标签两端必须逐字一致");
    assert.ok(typeof tg.meaning === "string" && tg.meaning.length > 0, "userToggle 必须写清打开/关掉各是什么行为");
  }

  // ⑨b 引擎接线：两个入口脚本必须能接住调用方算好的档位、并转发给 harness-4step.ps1。
  //     只改 harness-4step.ps1 而不改入口 = 调用方传了也没人接，档位永远停在 -1（静默不生效）。
  const ENTRY_DIR = join(SOURCE_DIR, ".cursor", "skills", "fit-letters", "scripts");
  for (const entry of ["harness-live.ps1", "harness-proactive.ps1"]) {
    const src = readFileSync(join(ENTRY_DIR, entry), "utf8");
    assert.match(src, /\[int\]\$DriftTier\s*=\s*-1/u, `${entry} 没有接 -DriftTier 参数（默认必须是 -1）`);
    assert.match(src, /DriftTier\s*=\s*\$DriftTier/u, `${entry} 接了参数却没转发给 harness-4step.ps1（空转）`);
  }

  // ⑨c 调用方必须真的算好档位并传下去 —— server.js 是唯一的生产调用方。
  //     只把脚本参数接上还不够：调用方不传，档位永远是 -1，近况层一个字都不注入（整条链静默空转）。
  //
  // ⚠️ 2026-10-16 大改（[审查-4] 代码-5）：这一节原来是**一大段源码文本断言**，审查实测证明它守不住
  //    行为 —— 例如「把开关那行后面改成 `if (false)`」文本仍在、断言照样绿。现在策略改成两层：
  //      ① **接线断言**（少量、只守「有没有真的连上」，如调用点与 push 语句）；
  //      ② **行为断言**（⑪ 节）：档位算法已抽成纯函数 `nearTermTierDecision()`，
  //         对真实返回值下断言 —— 档 0、不回退、NaN、开关、非法配置全都能实测。
  const serverSrc = readFileSync(join(SOURCE_DIR, "local-service", "server.js"), "utf8");
  assert.match(serverSrc, /const resolveDriftTier = person => \{/u, "server.js 缺 resolveDriftTier（档位算法）");
  assert.match(
    serverSrc,
    /if \(Number\.isInteger\(driftTier\) && driftTier >= 0\) harnessArgs\.push\("-DriftTier", String\(driftTier\)\);/u,
    "回信链路没把档位传给 harness-live.ps1（条件与 push 必须同时在场 —— 只留下 push 的文本是假接线）",
  );
  assert.match(
    serverSrc,
    /if \(Number\.isInteger\(driftTier\) && driftTier >= 0\) proactiveArgs\.push\("-DriftTier", String\(driftTier\)\);/u,
    "主动信链路没把档位传给 harness-proactive.ps1（条件与 push 必须同时在场）",
  );
  assert.match(serverSrc, /driftTier: resolveDriftTier\(row\.person\)/u, "回信 worker 没有算档位");
  assert.match(serverSrc, /driftTier: resolveDriftTier\(localUser\.person\)/u, "主动信链路没有算档位");
  // 调用方必须把「按信件数」「开关」「历史最高档」三样都喂给纯函数 —— 少一样算法就退化成固定值
  // [审查-4] 代码-1（🟠）：分档**只算用户自己写、且已经回过**的信 —— 声明与实现必须一致。
  // 原先实现是裸 `WHERE person = ?`：主动信（她每周最多 1 封）也计入 ⇒ 用户一封不回也会自己爬档；
  // 且生成回信时那封信已在表里 ⇒ 比「已回信数」提前 1 封。
  assert.match(
    serverSrc,
    /SELECT COUNT\(\*\) AS n FROM letters WHERE person = \? AND source <> 'proactive' AND status = \?/u,
    "分档 SQL 没有排除主动信与在途信（[审查-4] 代码-1 回归：她主动写的信会推高往来档位）",
  );
  assert.match(
    serverSrc,
    /DRIFT_LETTER_COUNT_SQL\)\.get\(person, STATUS\.REPLIED\)/u,
    "分档没有按「已回信」状态过滤（在途信会把档位提前 1 封）",
  );
  // 姊妹侧 [#2-12] B 段带来的教训：SQLite 是三值逻辑 —— 若 `source` 列**可为 NULL**，
  // `source <> 'proactive'` 对 NULL 行返回 NULL（不入选）⇒ 用户来信会被整片漏掉、档位恒 0。
  // 我侧之所以没这个坑，全靠列定义是 `NOT NULL DEFAULT 'live'`；但**列定义本身没有任何断言守**
  // （谁把 ALTER 改成可空、或谁加了不带默认值的迁移，上面那条 SQL 就静默漏行）。
  assert.match(
    serverSrc,
    /ALTER TABLE letters ADD COLUMN source TEXT NOT NULL DEFAULT 'live'/u,
    "source 列必须是 NOT NULL DEFAULT 'live' —— 一旦可为 NULL，分档 SQL 的 `source <> 'proactive'` 会因三值逻辑漏掉全部用户来信（档位恒 0）",
  );
  // 配置声明必须与新口径一致 —— 声明写「主动信单独计数」而实现已经不那样做，就是又漂了
  assert.match(
    nt.tierDataSource,
    /source <> 'proactive'/u,
    "tierDataSource 声明没写「排除主动信」，与实现口径不一致",
  );
  assert.match(
    nt.tierDataSource,
    /already|已回过|REPLIED/u,
    "tierDataSource 声明没写「只算已回信」，与实现口径不一致",
  );  assert.match(serverSrc, /nearTermTierDecision\(\{/u, "server.js 没有调用纯函数 nearTermTierDecision");
  assert.match(serverSrc, /remembered: getSetting\("drift_tier_max"\)/u, "调用方没把历史最高档喂进去（不回退会失效）");
  assert.match(
    serverSrc,
    /keepCurrentShape:\s*\n?\s*nt\?\.userToggle\?\.key && String\(getSetting\(nt\.userToggle\.key\) \?\? ""\) === "1"/u,
    "调用方没把「保持她现在的样子」开关读出来喂进去（开关会变成死开关）",
  );
  assert.match(
    serverSrc,
    /if \(decision\.write !== null\) setSetting\("drift_tier_max", decision\.write\);/u,
    "调用方没把纯函数算出的 write 落盘 —— 不回退（allowRollback:false）会静默失效",
  );
  // 配置读不到时必须留下可观测痕迹（原 catch 是静默降级，而脚本侧与姊妹侧都是 throw）
  assert.match(
    serverSrc,
    /\[near-term\] 档位配置读不到/u,
    "catch 里没有 console.warn —— 配置坏了会静默降级成「不注入」，排查时看不见",
  );
  // 阈值必须现读配置，绝不硬编码（否则两端各写一份、迟早漂移）
  assert.match(serverSrc, /join\(root, "harness", "行为参数\.json"\)/u, "阈值没有现读 行为参数.json（会两端漂移）");
  // [审查-4] 之后的 WorkBuddy [#2-12] D.2：requiredBy.note 曾长期写着「本清单两边都**不进** app/harness/」，
  // 而实情是两侧都在（姊妹侧 app/harness/harness-manifest.json 就在那儿，它的 harness-manifest.test.js:22 要读）。
  // 这类「自述与事实相反」的字段不会让任何测试变红，只能靠钉住过期措辞来防它回来。
  const manifestText = readFileSync(join(SOURCE_DIR, "harness", "harness-manifest.json"), "utf8");
  assert.doesNotMatch(
    manifestText,
    /两边都\*\*不进\*\*\s*app\/harness\//u,
    "requiredBy.note 里的过期说法回来了（『本清单两边都不进 app/harness/』）—— 姊妹侧 app/harness/ 里就有它",
  );
  assert.match(
    manifest.requiredBy.note,
    /两侧都存在/u,
    "requiredBy.note 必须写明本清单在两侧都存在（姊妹侧 app/harness/ 也在用它）",
  );
  // 00-栏目.md 的口径（[#2-12] D.1）：它在 `files` 里（**进哈希校验**），只是不走 Expand-Harness 渲染。
  // 以前我在交流文档里写成「不进 files」，是错的 —— 这里把真实语义钉住。
  assert.ok(
    Object.hasOwn(manifest.files, "00-栏目.md"),
    "00-栏目.md 必须在 files 里（进哈希校验）；它只是不参与 Expand-Harness 渲染，不是不登记",
  );

  // ⑩ 内容层：近况.md 必须自己过机械判据 —— 这条断言就是「只写怎么写、不写发生了什么」的看守
  if (nt.enabled === true) {
    const drift = readFileSync(join(HARNESS_DIR, "近况.md"), "utf8");
    for (const n of [1, 2, 3]) {
      assert.equal(
        (drift.match(new RegExp(`^## 第 ${n} 档`, "gmu")) ?? []).length,
        1,
        `近况.md 里「## 第 ${n} 档」必须恰好出现 1 次（引擎按它切段）`,
      );
    }
    assert.match(drift, /累积/u, "近况.md 必须写明第 2 档起是累积注入（引擎的拼接规则靠它）");
    assert.match(drift, /不回退/u, "近况.md 必须写明档位不回退");

    const bullets = drift.split(/\r?\n/u).filter((l) => /^\s*-\s/u.test(l));
    assert.equal(bullets.length, 9, `近况.md 三档共 9 条（现 ${bullets.length} 条）—— 改条数请同步本断言与草案文档`);
    const actionRe = new RegExp(nt.mechanicalEvidence.newActionPattern, "u");
    const hits = [];
    for (const b of bullets) {
      for (const w of nt.mechanicalEvidence.newTimeWords) {
        if (b.includes(w)) hits.push(`时间点词「${w}」：${b.trim()}`);
      }
      if (actionRe.test(b)) hits.push(`新动作句式：${b.trim()}`);
    }
    assert.deepEqual(hits, [], `近况.md 写成了「发生了什么」而不是「怎么写」：\n${hits.join("\n")}`);
  }
});

// ⑪ 行为断言：档位算法（`nearTermTierDecision`）必须对**真实返回值**守住五件事。
//     为什么单列一节（[审查-4] 代码-5）：⑨c 那一段再怎么写也是**源码文本**断言 ——
//     文本在、行为错的情况守不住（审查实测「把开关那行后面改成 `if (false)` 仍然绿」）。
//     所以把算法抽成纯函数（`local-service/proactive-letters.js`），这里直接喂参数、断言返回值。
test("⑪ 近况层档位判定：纯函数对真实返回值守住 档位/不回退/NaN/开关/停用 五条", async () => {
  const { nearTermTierDecision } = await import("../proactive-letters.js");
  assert.equal(typeof nearTermTierDecision, "function", "proactive-letters.js 必须导出纯函数 nearTermTierDecision");

  // 与真源同一份档位表（现读，不手写 —— 手写就是第二份真源）
  const realTiers = params.nearTerm.tiers;

  // ① 档 0（0–3 封，inject:false）⇒ -1：整段不注入
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 0, remembered: undefined }).tier,
    -1,
    "0 封信必须不注入（第 0 档 inject:false）",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 3, remembered: undefined }).tier,
    -1,
    "3 封信仍落在第 0 档 ⇒ 不注入",
  );

  // ② 落档：第 1 档 4–20 ⇒ 1；第 2 档 21–60 ⇒ 2
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 4, remembered: undefined }).tier,
    1,
    "4 封信应进第 1 档",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 20, remembered: undefined }).tier,
    1,
    "20 封信仍是第 1 档（上界含）",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 21, remembered: undefined }).tier,
    2,
    "21 封信应进第 2 档",
  );
  // 无上界档（lettersTo: null）也要能命中 —— 否则「最高档永远进不去」这种静默失败没人抓
  const lastTier = realTiers.reduce((a, t) => (Number(t.tier) > Number(a.tier) ? t : a));
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 9999, remembered: undefined }).tier,
    Number(lastTier.tier),
    `信件数极大时应进最高档（第 ${lastTier.tier} 档），说明 lettersTo:null 的开放上界生效`,
  );

  // ③ **不回退**（allowRollback:false）：信件被删回 0 封，历史最高档仍要兜住。
  //    这是 2026-10-16 两个项目**同时踩到**的坑：把「不回退」写在「档 0 ⇒ -1」之后 ⇒ 空转。
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 0, remembered: "2" }).tier,
    2,
    "历史最高档为 2、当前 0 封信时仍须返回 2 —— 否则 allowRollback:false 是空话（档 0 提前 return 会吃掉它）",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 0, remembered: 3 }).tier,
    3,
    "历史最高档为 3 时同样兜住",
  );
  // 不回退**只升不降**：当前档更高时取当前档
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 9999, remembered: "1" }).tier,
    Number(lastTier.tier),
    "当前档高于记忆档时应取当前档（记忆不是上限）",
  );
  // 落盘语义：档位变了才写；没变就不写（避免每次回信都写一次 settings）
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 4, remembered: undefined }).write,
    "1",
    "首次进第 1 档必须写 drift_tier_max",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 5, remembered: "1" }).write,
    null,
    "档位没变时不应写盘",
  );
  assert.equal(
    nearTermTierDecision({ nearTerm: params.nearTerm, letterCount: 0, remembered: "2" }).write,
    null,
    "记忆档兜住且未变化时不应写盘",
  );

  // ④ 非整数 tier（配置写坏成字符串/写错）⇒ 该档**跳过**、绝不把 NaN 传出去。
  //    原缺陷：`Number(t.tier)` 得 NaN 时 `tier <= 0` 为 false ⇒ `setSetting("drift_tier_max", NaN)`
  //    把字符串 "NaN" 落进设置永久化。
  //
  //    ⚠️ 2026-10-16 反向验证踩到的坑：**只断言最终 tier/write 会漏掉「本层跳过」这一实现** ——
  //    实测把 `if (!Number.isInteger(cand)) continue;` 整行删掉后仍然绿，因为下游
  //    `!Number.isInteger(effective)` 的兜底也会把 NaN 拦住（**冗余层**，不是缺口）。
  //    所以要有一条能区分「本层拦下」与「下层兜住」的用例：**同一批档位里既有坏档又有好档**，
  //    坏档必须被跳过、好档必须照常命中 —— 只有「本层 continue」才能同时满足这两点。
  const mixed = {
    ...params.nearTerm,
    tiers: [
      { tier: "第一档", lettersFrom: 0, lettersTo: 20, inject: true }, // 坏档：范围更宽，若不跳过会抢先命中
      { tier: 2, lettersFrom: 4, lettersTo: 20, inject: true }, // 好档：必须仍能命中
    ],
  };
  assert.equal(
    nearTermTierDecision({ nearTerm: mixed, letterCount: 10, remembered: undefined }).tier,
    2,
    "坏档（tier 非整数）必须被**本层跳过**，让好档正常命中 —— 若只靠下游兜底，这里会退化成 -1",
  );
  // 只有坏档、没有任何好档时才落到 -1（且不得写盘）
  const onlyBroken = { ...params.nearTerm, tiers: [{ tier: "第一档", lettersFrom: 0, lettersTo: 20, inject: true }] };
  const broken = onlyBroken;
  const brokenOut = nearTermTierDecision({ nearTerm: broken, letterCount: 10, remembered: undefined });
  assert.equal(brokenOut.tier, -1, "tier 非整数时该档必须被跳过（不能把 NaN 当档位传出去）");
  assert.equal(brokenOut.write, null, "tier 非整数时绝不能把 NaN 落盘");
  assert.ok(!String(brokenOut.write ?? "").includes("NaN"), '任何情况下都不允许出现 write = "NaN"');

  // ⑤ 用户开关（「保持她现在的样子」）⇒ -1，且**不写记忆**
  //    —— 开关是「保持现在的样子」，若顺手把档位记忆写掉，关掉开关后就跳档了。
  const kept = nearTermTierDecision({
    nearTerm: params.nearTerm,
    letterCount: 9999,
    remembered: "1",
    keepCurrentShape: true,
  });
  assert.equal(kept.tier, -1, "打开开关时必须不注入");
  assert.equal(kept.write, null, "打开开关时必须不写档位记忆（否则关掉开关会跳档）");

  // ⑥ 停用 / 配置残缺 ⇒ -1，不抛（调用方外面还有一层 try/catch，这里保证纯函数自身安全）
  for (const bad of [
    undefined,
    {},
    { ...params.nearTerm, enabled: false },
    { ...params.nearTerm, tiers: null },
    { ...params.nearTerm, tiers: "不是数组" },
  ]) {
    const r = nearTermTierDecision({ nearTerm: bad, letterCount: 99, remembered: "2" });
    assert.equal(r.tier, -1, `停用/残缺配置必须返回 -1（输入：${JSON.stringify(bad)?.slice(0, 60)}）`);
    assert.equal(r.write, null, "停用/残缺配置不得写盘");
  }
});

// ── P2（2026-10-16 拍板）：主动信最低长度从单值改成双条件 ──
// 为什么单列一项：`minChars` 是硬校验，两端各有一份 inspection 实现（我方 harness 兜底、
// 姊妹侧 app/core.mjs 的 baseInspect）。只读 `minChars` 会把**合法**的短主动信拒掉
// （「今天路过那家店，忽然很想你。」= 12 个汉字），这正是 conflicts.C1 当初记录的问题。
// 双条件 = 单段须 ≥ minChars；段落数 ≥ 2 时只须 ≥ minCharsWhenMultiParagraph（即非空）。
test("主动信最低长度是双条件（P2）：单段 ≥ minChars、多段 ≥ minCharsWhenMultiParagraph，且 C1 已消解", () => {
  const p = params.proactive;
  assert.equal(typeof p.minChars, "number", "proactive.minChars 必须是数字");
  assert.equal(
    typeof p.minCharsWhenMultiParagraph,
    "number",
    "缺 proactive.minCharsWhenMultiParagraph：P2 拍板的双条件必须写进本文件，否则两端只读 minChars 又会把短主动信拒掉",
  );
  assert.ok(
    p.minCharsWhenMultiParagraph < p.minChars,
    `多段下限(${p.minCharsWhenMultiParagraph}) 必须小于单段下限(${p.minChars})，否则双条件等于没放宽`,
  );
  assert.ok(p.minCharsWhenMultiParagraph >= 1, "多段下限至少为 1 —— 空信仍然要拒");
  assert.match(
    String(p.minCharsRule ?? ""),
    /双条件/u,
    "必须留下 proactive.minCharsRule 说明（含「双条件」），否则后来人只看到两个数、不知道该怎么用",
  );
  assert.match(
    String(p.minCharsRule ?? ""),
    /minCharsWhenMultiParagraph/u,
    "minCharsRule 必须点名 minCharsWhenMultiParagraph，否则说明与字段脱节",
  );

  // 拍板值钉死：改这里之前先回看 conflicts.C1 的 whyItMatters
  assert.equal(p.minChars, 12, "P2 拍板的单段下限是 12 个汉字");
  // 反例必须是「合法但会被旧单值 20 拒掉」的那类：单段、12 个汉字（落在 [12, 20)）
  const sample = "今天路过那家店，忽然很想你。";
  const cjk = (sample.match(/[一-龥]/gu) ?? []).length;
  assert.ok(
    cjk >= p.minChars && cjk < 20,
    `双条件示例句应落在 [${p.minChars}, 20) 区间（现 ${cjk} 字），才能证明这条放宽解决的是真问题`,
  );

  // C1 必须已被标成 resolved —— 否则读文件的人以为还卡着用户
  const c1 = params.conflicts.find((c) => c.id === "C1");
  assert.ok(c1, "conflicts 里必须保留 C1 的记录（它是这次放宽的依据）");
  assert.equal(c1.severity, "resolved", "C1 已由 P2 解决，severity 必须是 resolved");
  assert.match(String(c1.status), /已解决|P2/u, "C1.status 必须写明已按 P2 解决");
});
