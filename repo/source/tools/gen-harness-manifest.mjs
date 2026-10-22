#!/usr/bin/env node
// 重出 harness 基线清单（同步方案 §6.3：真源任一文件改动，必须同批重出本文件）。
//
// 用法：
//   node repo/source/tools/gen-harness-manifest.mjs            # 重算并写盘
//   node repo/source/tools/gen-harness-manifest.mjs --check     # 只比对不写盘，不一致 exit 1（给测试用）
//
// 设计要点（都是踩过的坑）：
//   ① 清单自己不进 files —— 否则每生成一次哈希就变一次，自引用死循环。具名排除。
//   ② 林离人设.md 物理上在 harness 的上一级，必须带 relPath "../林离人设.md"，
//      否则消费方 join(harnessDir, name) 会 ENOENT（同步方案 §6.1 的示例漏了这点）。
//   ③ files 的键顺序：沿用现有清单的顺序，新文件按名排后追加 —— 避免每次生成都整份重排。
//      （只有“顺序”是沿用的，“内容”全部现算。）
//   ④ sha256 一律小写（Node digest('hex') 原样）。PowerShell 侧复算必须先 .Hash.ToLower()。
//   ⑤ 行数语义：换行符个数 + 末尾无换行时把最后一行计入。
//   ⑥ 本脚本负责 files / generatedAt / requiredBy.source，以及**叙述字段里的两端口径**
//      （pathSemantics 的姊妹侧现状、syncedWith 各条、requiredBy.note 的六步链现状）。
//      stepMap / variablesById / behavior / pending 等人工维护字段原样保留（它们描述的是“约定”，
//      不是“磁盘现状”）。
//
//       ⚠️ 为什么叙述字段现在也必须现算（2026-10-17 [审查-5] 🟠-7）：
//       这些字段以前写着「姊妹侧同名文件仍是换代前的 5584 B —— 两侧内容目前不同」
//       「sister 没有 00-栏目.md / 01-* / 04-尾端检查.md 等六步链模板」「行为参数.json 两侧相同（9312 B）」
//       —— 全是**写死的历史快照**，姊妹侧同步之后它们集体变成假话，而**没有任何东西会红**
//       （`--check` 只比 files 与 requiredBy.source）。读包的人会据此得出错误结论。
//       ⇒ 修法：这些字段的正文里**不许出现具体数字**，只留 `{{stat:<文件名>}}` 占位，
//       由本脚本按「本侧现算 vs 姊妹侧现算」生成。姊妹侧路径找不到时它会写「无法现算」，
//       而**不会**留下一个看起来像事实的旧数字。
//   ⑦ `pathOverrides`（B6，2026-10-17 落地）：relPath 的语义收敛为「真源侧相对 harness 目录」，
//      跨级文件（如 `../林离人设.md`）在**姊妹侧**会解析到不存在的路径 ⇒ 那份文件永远不被硬校验。
//      消费方按自己的根目录在 pathOverrides 里查覆盖值。硬约定（由 --check 把守）：
//      **凡 relPath 含 `../` 的文件，必须在每个覆盖条目里出现** —— 否则再新增一个跨级文件时，
//      姊妹侧又会静默退回「解析到空、不被校验」，而没有任何东西会红。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // repo/source/tools
const SOURCE = dirname(HERE); // repo/source
const HARNESS = join(SOURCE, "harness");
const MANIFEST = join(HARNESS, "harness-manifest.json");
const SELF = basename(MANIFEST);
const PERSONA = { key: "林离人设.md", abs: join(SOURCE, "林离人设.md"), relPath: "../林离人设.md" };

const CHECK = process.argv.includes("--check");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

// 行数语义见文件头 ⑤
function linesOf(text) {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function describe(abs) {
  const buf = readFileSync(abs);
  return {
    bytes: buf.length,
    lines: linesOf(buf.toString("utf8")),
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

// 「本侧运行时真的读到的文件」——**现扫**，不是手写清单。
//
// ⚠️ 为什么必须现扫（2026-10-16 [审查-4] 的教训）：这张表原来是一份手写的 16 项常量，
// 而它**没有任何东西**会在「注入脚本里又读了一个新文件、这里忘了加」时报错 ——
// 于是 `requiredBy.source` 会静默地少一项，而姊妹侧正是照这张表决定「缺了要补」
// 还是「本来就不该有」（见它 tests/harness-manifest.test.js ①）⇒ 后果是那份文件
// 在它那边**永远不被硬校验**。这正是 AGENTS.md §七.4 的「不报错的漂移」。
//
// 扫描写法（脚本里的真实形态，2026-10-16 实测）：
//   · 中文名大量用 `-join @([char]0x4E3B, [char]0x52A8, …)` 码点拼接（避免 .ps1 编码问题）
//   · 拼接形态是 `"01-" + (-join @([char]…)) + ".md"`，或 `$HarnessDir $nameVar`
//   · 也有直接字面量 `harness\近况.md`（注释与 Join-Path 兜底里）
// ⇒ 策略：**先把码点还原成字符**，再把「同一表达式里相邻的字符串字面量/加号」拼成一个候选名
//    （`"01-" + "预检" + ".md"` → `01-预检.md`），最后按「像不像 harness 目录下的文件」筛选。
const SCAN_FILES = [
  join(SOURCE, ".cursor", "skills", "fit-letters", "scripts", "harness-live.ps1"),
  join(SOURCE, ".cursor", "skills", "fit-letters", "scripts", "harness-proactive.ps1"),
  join(SOURCE, ".cursor", "skills", "fit-letters", "scripts", "harness-4step.ps1"),
  join(SOURCE, ".cursor", "skills", "fit-letters", "scripts", "ds-call.ps1"),
  join(SOURCE, "local-service", "server.js"),
];

// 显式补充：运行时确实会读、但读取点不在上面几个脚本的**字面**里（每条都要写清为什么）：
//   · 近况.md —— 由 `行为参数.json` 的 `nearTerm.carrier` 指路、`Get-DriftText` 读（档 0 时读都不读）。
//     它是内容载体、姊妹侧必须存在同名文件 ⇒ 登记进 requiredBy（这条表达的是
//     「姊妹侧该不该有这个文件」，不是「每条路径都读」）。
//   · VERSION —— `server.js:834` / `:872` 读它并硬断言等于 `v18`，但文件名是 `join(root, "harness", "VERSION")`
//     的**第二段参数**，上面按 `harness[\/]<名>` 的字面量规则扫不到（`"VERSION"` 与 `"harness"` 被逗号隔开）。
//     它是真正的运行时前置件（读不到/值不对 ⇒ 两条生成链直接 throw），姊妹侧也有这个文件（4 B）。
const RUNTIME_READ_EXTRA = [
  "近况.md",
  "VERSION",
];

/** 把 `-join @([char]0x6797, …)` / `[char]0x6797` 还原成字符。
 *  ⚠️ `[char]0x5386` 长 12 字符：`[char]` 6 + `0x` 2 + 4 位十六进制 ⇒ 十六进制从**下标 8** 开始。
 *  （这里曾写成 slice(9)，把首位数字吃掉，得到 `Ά, ϲ, ࣀ` 这类乱码、扫描结果静默变空。） */
function decodeCharCodes(text) {
  return text.replace(/\[char\]0x([0-9A-Fa-f]{4})/gu, (_t, hex) =>
    String.fromCodePoint(Number.parseInt(hex, 16))
  );
}

/**
 * 从源码文本里抽出「像 harness 文件的候选名」。
 * 覆盖两种真实写法（2026-10-16 实测脚本里的形态）：
 *   ① 字面量：`harness\近况.md` / `harness/行为参数.json`
 *   ② 拼接式：`"01-" + (-join @("预检")) + ".md"`（码点已在 decodeCharCodes 里还原成中文引号字面量）
 *
 * 实现思路（直白版）：先把 `+` 两侧的「字符串字面量 / -join @(…) 字面量列表」拉平成一条候选串，
 * 再看它整体**像不像一个文件名**（以 .md/.json 结尾、不含路径分隔符与空白）。
 * 不做「猜变量值」—— 变量里存的名字（如 `$precheckPrompt`）由它**被赋值时**的那条拼接链覆盖。
 */
function scanHarnessNames(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return new Set();
  }
  const decoded = decodeCharCodes(text);
  const found = new Set();

  // ① 字面量 `harness[\/]<名>` 与 `$HarnessDir` 后面跟的引号字面量
  for (const m of decoded.matchAll(/harness[\\/]([^\\/"'\s]+\.(?:md|json))/gu)) found.add(m[1]);
  for (const m of decoded.matchAll(/HarnessDir\s*\(?\s*"([^"'\s]+\.(?:md|json))"/gu)) found.add(m[1]);
  for (const m of decoded.matchAll(/HarnessDir\s*,\s*"([^"'\s]+\.(?:md|json))"/gu)) found.add(m[1]);
  for (const m of decoded.matchAll(/Join-Path\s+\$HarnessDir\s+"([^"'\s]+)"/gu)) found.add(m[1]);

  // ② 拼接式：脚本里的真实形态是
  //      `Get-HarnessPrompt ("03-" + (-join @([char]0x4E2D, …)) + ".md")`
  //      `Join-Path $HarnessDir ((-join @([char]0x5F00, …)) + ".md")`
  //    ⚠️ 解码之后，`-join @([char]0x5386, …)` 会变成 `-join @(历, 史, 检, 索)` —— 参数是**裸字符**
  //    （不是引号字符串），所以折叠时必须按「逗号分隔的任意 token」收集，不能只认 `"…"`。
  //    三次替换之后整行只剩一个普通字符串字面量，再按「像不像文件名」筛。
  for (const line of decoded.split(/\r?\n/u)) {
    if (!line.includes("+")) continue;
    const folded = line.replace(
      /\(?\s*-join\s+@\(([^)]*)\)\s*\)?/gu,
      (_a, inner) =>
        `"${inner
          .split(",")
          .map((x) => x.trim().replace(/^"(.*)"$/u, "$1"))
          .join("")}"`,
    );
    for (const m of folded.matchAll(/"([^"]*)"(?:\s*\+\s*"([^"]*)")+/gu)) {
      const parts = [...m[0].matchAll(/"([^"]*)"/gu)].map((x) => x[1]);
      const name = parts.join("");
      if (/\.(?:md|json)$/u.test(name) && !/[\\/\s]/u.test(name)) found.add(name);
    }
  }
  return found;
}
const RUNTIME_READ = [
  ...[...new Set(SCAN_FILES.flatMap((p) => [...scanHarnessNames(p)]))].sort(),
  ...RUNTIME_READ_EXTRA,
];
if (RUNTIME_READ.length < 5) {
  throw new Error(
    "现扫「本侧运行时读到的 harness 文件」只得到 " +
      RUNTIME_READ.length +
      " 项 —— 扫描判据写歪了，requiredBy.source 会被写空。检查 SCAN_FILES 是否还存在。"
  );
}

const prev = JSON.parse(readFileSync(MANIFEST, "utf8"));

// ---------- pathOverrides 的形状校验（B6，2026-10-17）----------
// 判据只有两条，都是「不满足就一定有消费方解析到空」：
//   ① 凡 relPath 含 `../` 的逻辑文件，必须出现在**每一个**覆盖条目里；
//   ② 覆盖值本身不得含 `..`（否则等于把洞换个位置）。
// 消费方根目录清单来自 prev.pathOverrides 的键（去掉 `_说明`）—— 这样新增消费方时
// 只要在清单里加一个条目，校验自动覆盖它。
function pathOverrideProblems(saved) {
  const out = [];
  if (saved === undefined) {
    // 旧版清单还没有这个字段：不算红（写盘分支会补上），但要把话说清楚。
    return [];
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return ["pathOverrides 必须是「消费方根目录 → { 逻辑名: 相对路径 }」的对象"];
  }
  const consumers = Object.keys(saved).filter((k) => k !== "_说明");
  if (consumers.length === 0) {
    return ["pathOverrides 里一个消费方都没有（至少要有 linli-letters）—— 空对象等于没做 B6"];
  }
  const crossLevel = ordered.filter(
    (k) => typeof files[k]?.relPath === "string" && files[k].relPath.includes("../")
  );
  for (const root of consumers) {
    const entry = saved[root];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push(`pathOverrides[${root}] 必须是「逻辑名 → 相对路径」的对象`);
      continue;
    }
    for (const logical of crossLevel) {
      const v = entry[logical];
      if (v === undefined) {
        out.push(
          `pathOverrides[${root}] 缺少跨级文件 ${logical} 的覆盖 —— 该文件 relPath 含 ../，` +
            "消费方照原值解析会得到不存在的路径 ⇒ 它永远不被硬校验（B6 的静默洞）",
        );
        continue;
      }
      if (typeof v !== "string" || v.includes("..")) {
        out.push(`pathOverrides[${root}][${logical}] 必须是相对消费方 harness 目录的路径且不得含 ..：实际 ${JSON.stringify(v)}`);
      }
    }
  }
  return out;
}

// ---------- 两端现状（叙述字段用；[审查-5] 🟠-7）----------
// 姊妹侧仓库路径：环境事实，不是清单内容 ⇒ 用常量 + 环境变量覆盖，**不写进清单**。
// （清单里已有的 `sourceRepo` 是本侧路径，性质相同。）
const SISTER_REPO = process.env.OLIVIA_SISTER_REPO || "E:/linli-letters";
const SISTER_HARNESS = join(SISTER_REPO, "app", "harness");
let SISTER_OK = false;
try {
  SISTER_OK = existsSync(SISTER_HARNESS) && statSync(SISTER_HARNESS).isDirectory();
} catch {
  SISTER_OK = false;
}
const sha8 = (hex) => hex.slice(0, 8);

// 同一逻辑文件在两端的现状。姊妹侧不可达时**如实写不可达**，绝不猜、绝不留下看起来像事实的旧数字。
function twoSided(logical) {
  const mine = computed.get(logical);
  if (!mine) return `（本侧 files 里没有 ${logical}，无法比对）`;
  const head = `本侧 ${mine.bytes} B / ${sha8(mine.sha256)}…`;
  if (!SISTER_OK) {
    return `${head}；**姊妹侧仓库不可达**（${SISTER_HARNESS} 不存在）—— 本项**未现算**，不要据此判断两侧是否同步`;
  }
  const sp = join(SISTER_HARNESS, logical);
  if (!existsSync(sp)) return `${head}；姊妹侧 app/harness/${logical} **不存在**`;
  const s = describe(sp);
  const same = s.sha256 === mine.sha256;
  return `${head}；姊妹侧 ${s.bytes} B / ${sha8(s.sha256)}…；**逐字节${same ? "相同" : "不同"}**`;
}

// 姊妹侧 harness 目录里到底有哪些六步链模板（原文写死「它没有 00-栏目 / 01-* / 04-尾端检查」是错的）。
const SIX_CHAIN = [
  "00-栏目.md",
  "01-初始化账本.md",
  "01-预检.md",
  "02-历史检索.md",
  "02-账本校正.md",
  "03-中段生成.md",
  "04-尾端检查.md",
  "05-反馈重写.md",
];
function sisterHarnessStat() {
  if (!SISTER_OK) {
    return `**姊妹侧仓库不可达**（${SISTER_HARNESS} 不存在）—— 本项**未现算**`;
  }
  const names = readdirSync(SISTER_HARNESS, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const there = SIX_CHAIN.filter((n) => names.includes(n));
  const gone = SIX_CHAIN.filter((n) => !names.includes(n));
  const parts = [`共 ${names.length} 件`];
  parts.push(
    gone.length === 0
      ? `六步链八件（${SIX_CHAIN.join(" / ")}）**全在盘上**`
      : `六步链八件里**缺**：${gone.join(" / ")}`,
  );
  parts.push(`有 ${there.length}/8 件`);
  return parts.join("；");
}


// 目录下的普通文件（排除清单自己）
const dirNames = readdirSync(HARNESS, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name !== SELF)
  .map((e) => e.name);

const computed = new Map();
for (const name of dirNames) computed.set(name, describe(join(HARNESS, name)));
{
  const meta = describe(PERSONA.abs);
  computed.set(PERSONA.key, { relPath: PERSONA.relPath, ...meta });
}

const prevKeys = Object.keys(prev.files ?? {});
const ordered = [
  ...prevKeys.filter((k) => computed.has(k)),
  ...[...computed.keys()].filter((k) => !prevKeys.includes(k)).sort(),
];

const files = {};
for (const k of ordered) files[k] = computed.get(k);

const dropped = prevKeys.filter((k) => !computed.has(k));
const added = ordered.filter((k) => !prevKeys.includes(k));
const changed = ordered.filter(
  (k) => prevKeys.includes(k) && JSON.stringify(prev.files[k]) !== JSON.stringify(files[k])
);

// ---------- 叙述字段里的现算块（[审查-5] 🟠-7）----------
// 形态：`<!--AUTO:<id>-->（旧内容）<!--/AUTO:<id>-->`，每次重出把中间那段换成现算结果。
// 为什么用成对标记而不是直接改文本：这些字段是**一句话里的插入语**，靠正则抠「数字段」会
// 在措辞调整时静默失配（AGENTS.md §七.4）。标记则让「谁负责这段」在文本里看得见，
// 且标记丢失时会直接报错而不是悄悄留旧值。
//
// ⚠️ 定义必须放在 `--check` 分支**之前**：`const` 有 TDZ，放到写盘段里会让 `--check` 直接
// ReferenceError（2026-10-17 实测踩过）。
const AUTO_FILL = {
  "sister-harness": () => sisterHarnessStat(),
};
for (const k of ordered) {
  AUTO_FILL[`sided-${k}`] = () => twoSided(k);
  AUTO_FILL[`synced-${k}`] = () => twoSided(k);
}

// 扫一遍现算块，返回问题清单（空数组 = 没问题）。`--check` 与写盘分支都要调它。
//
// ⚠️ 为什么必须查「孤立标记」（2026-10-17 反验 B 抓出的真缺口）：
// 第一版只查「配对的块里内容对不对」+「至少填了 1 块」。
// 于是把 `<!--AUTO:sister-harness-->` 写坏成 `<!--AUTOx:…-->` 时，
// **配对的块变成 0 个、正则不再匹配它**，而 `autoFilled >= 1` 仍成立（别的块还在填）
// ⇒ 那一块从此永远停在旧内容上，而工具一路绿灯 —— 正是 🟠-7 的同一种病。
// 判据：**结束标记的总数必须等于配对块数**；多出来的就是孤立标记（开始标记被写坏了）。
function autoBlockStructuralProblems(text) {
  const out = [];
  const ids = new Set();
  let paired = 0;
  for (const m of text.matchAll(/<!--AUTO:([^>]+)-->([\s\S]*?)<!--\/AUTO:\1-->/gu)) {
    const id = m[1];
    ids.add(id);
    paired++;
    if (!AUTO_FILL[id]) {
      out.push(`现算块 id 没有对应实现：${id}（它永远停在写死的内容上）`);
    }
  }
  const allOpens = [...text.matchAll(/<!--AUTO:([^>]+)-->/gu)].map((m) => m[1]);
  const allCloses = [...text.matchAll(/<!--\/AUTO:([^>]+)-->/gu)].map((m) => m[1]);
  const orphanCloses = allCloses.filter((id) => !ids.has(id));
  const orphanOpens = allOpens.filter((id) => !ids.has(id));
  if (orphanCloses.length) {
    out.push(
      `有 ${orphanCloses.length} 个**孤立**的现算块结束标记（开始标记被写坏或删了）：` +
        orphanCloses.join("、") +
        " —— 那一块会永远停在旧内容上，而工具不会红",
    );
  }
  if (orphanOpens.length) {
    out.push(
      `有 ${orphanOpens.length} 个**孤立**的现算块开始标记（结束标记被写坏或删了）：` +
        orphanOpens.join("、"),
    );
  }
  if (paired === 0) {
    out.push("一个现算块都没找到（期望 ≥ 9）—— 标记被删/写坏会让叙述字段静默留旧值");
  }
  return out;
}

// 结构 + 内容（`--check` 用这个；写盘分支只用结构那半 —— 回填本来就是为了修过期内容）
function autoBlockProblems(text) {
  const out = [...autoBlockStructuralProblems(text)];
  for (const m of text.matchAll(/<!--AUTO:([^>]+)-->([\s\S]*?)<!--\/AUTO:\1-->/gu)) {
    const fn = AUTO_FILL[m[1]];
    if (!fn) continue; // 结构检查已报
    const want = fn();
    if (m[2] !== want) out.push(`现算块已过期：${m[1]}\n    清单= ${m[2]}\n    现算= ${want}`);
  }
  return out;
}

if (CHECK) {
  const problems = [];
  if (added.length) problems.push("清单缺少文件：" + added.join(", "));
  if (dropped.length) problems.push("清单有多余文件：" + dropped.join(", "));
  for (const k of changed) {
    problems.push(
      `文件已改动但清单未重出：${k}\n    清单= ${JSON.stringify(prev.files[k])}\n    磁盘= ${JSON.stringify(files[k])}`
    );
  }
  // ⚠️ `requiredBy.source` 必须一起比对（2026-10-16 补）。
  // 为什么：它是**现扫**出来的（见上方 SCAN_FILES / RUNTIME_READ），而姊妹侧照它决定「缺了要补」
  // 还是「本来就不该有」。若扫描判据写歪、少扫一项，只比 `files` 是**发现不了**的 ——
  // 清单仍然“一致”，而那份文件在姊妹侧永远不被硬校验。这正是「不报错的漂移」。
  // 反向验证：从清单里摘掉 `写法.md` ⇒ 本分支必须报红（已实测）。
  const expectReq = ordered.filter((k) => RUNTIME_READ.includes(k));
  const prevReq = Array.isArray(prev.requiredBy?.source) ? prev.requiredBy.source : [];
  const reqAdded = expectReq.filter((k) => !prevReq.includes(k));
  const reqDropped = prevReq.filter((k) => !expectReq.includes(k));
  if (reqAdded.length)
    problems.push("requiredBy.source 缺少（本侧运行时确实会读）：" + reqAdded.join(", "));
  if (reqDropped.length)
    problems.push("requiredBy.source 多余（本侧运行时并不读）：" + reqDropped.join(", "));
  // ⚠️ `pathOverrides`（B6）必须一起比对。
  // 为什么：它是「消费方按自己根目录解析 relPath」的覆盖表。手写时最常见的两个漂移是
  //   ① 新增一个跨级文件（relPath 含 ../）却忘了加覆盖 ⇒ 姊妹侧解析到空、静默不被校验；
  //   ② 覆盖值写成含 `..` 的路径 ⇒ 又绕回同一个洞。
  // 只比 files 与 requiredBy 时这两个都不会红 —— 正是「不报错的漂移」。
  // 反向验证：① 从覆盖条目里删掉林离人设.md ⇒ 报「缺少跨级覆盖」；② 把覆盖值改成 "../林离人设.md" ⇒ 报「覆盖值不得含 ..」（已实测）。
  problems.push(...pathOverrideProblems(prev.pathOverrides));
  // ⚠️ 叙述字段里的现算块也必须一起比对（2026-10-17 [审查-5] 🟠-7）。
  // 为什么：那些块的职责就是「随着磁盘现状自动更新」，而它们的**过期不会影响 files 与 requiredBy**
  // —— 只比那两样时，清单会一直显示「逐项一致」，而 pathSemantics / syncedWith / requiredBy.note
  // 里写着的仍是上一轮的两端快照（= 假话）。这正是「不报错的漂移」。
  // 反向验证：① 手改任一块里的字节数 ⇒ 报「现算块已过期」；② 写坏开始标记 ⇒ 报「孤立标记」（已实测）。
  problems.push(...autoBlockProblems(readFileSync(MANIFEST, "utf8")));
  if (problems.length) {
    console.error("[harness-manifest] 不一致（" + problems.length + " 项）：");
    for (const p of problems) console.error("  - " + p);
    console.error("\n跑 `node repo/source/tools/gen-harness-manifest.mjs` 重出清单。");
    process.exit(1);
  }
  console.log("[harness-manifest] OK：" + ordered.length + " 个文件与清单逐项一致");
  process.exit(0);
}

// 写盘走**文本级最小改动**：只替换 generatedAt 的值与 files 块的正文。
// 为什么不用 JSON.stringify 整份重写：那样会把文件里的人工排版（每行一个文件、单行数组）
// 全部改写成“每个字段单独一行”，每次重出都产生几百行无意义 diff，真正变化的行反而看不见。
function replaceBraceBlock(text, key, newBlock) {
  const marker = `"${key}": {`;
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`harness-manifest.json 里找不到 ${marker}`);
  let i = at + marker.length - 1; // 指向 '{'
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`harness-manifest.json 的 ${key} 块括号不平衡`);
  return text.slice(0, at) + `"${key}": ` + newBlock + text.slice(i + 1);
}

// 单个文件条目排成一行，且保留第 0 步的人工排版（键值间带空格）——
// 这样才能做到「重出时只动真正变化的行」。
const fmtFile = (m) => {
  const parts = [];
  if (m.relPath !== undefined) parts.push(`"relPath": ${JSON.stringify(m.relPath)}`);
  parts.push(`"bytes": ${m.bytes}`, `"lines": ${m.lines}`, `"sha256": ${JSON.stringify(m.sha256)}`);
  return `{ ${parts.join(", ")} }`;
};
const block = "{\n" + ordered.map((k) => `    ${JSON.stringify(k)}: ${fmtFile(files[k])}`).join(",\n") + "\n  }";

let text = readFileSync(MANIFEST, "utf8");
text = text.replace(/("generatedAt"\s*:\s*")[^"]*(")/u, `$1${stamp()}$2`);
text = replaceBraceBlock(text, "files", block);

// `requiredBy.source` 同步重出：内容 = 本次 `ordered` 里出现过的 RUNTIME_READ 项（按 ordered 顺序）。
// 为什么必须在这里同步、不能靠人记：`requiredBy` 是「消费方据此分流『缺了要补』与『本来就不该有』」
// 的字段，漏更新时它**不会报错**，只会静默给出过期答案 —— 正是 AGENTS.md §七.4 说的空转写法。
const prevSource = Array.isArray(prev.requiredBy?.source) ? prev.requiredBy.source : [];
const newSource = ordered.filter((k) => RUNTIME_READ.includes(k));
const missingFromRuntime = ordered.filter((k) => !RUNTIME_READ.includes(k));
{
  // `requiredBy.source` 是 requiredBy 块里的**第一个**数组，紧随其后的是 `"sister": [`。
  // 只替换 source 这一段（不能整块重写 requiredBy —— 那会把 `note` 的人工排版与文字一起改掉）。
  const header = '"requiredBy": {';
  const head = text.indexOf(header);
  if (head < 0) throw new Error(`harness-manifest.json 里找不到 ${header}`);
  const srcAt = text.indexOf('"source"', head);
  if (srcAt < 0) throw new Error('harness-manifest.json 的 requiredBy 块里找不到 "source"');
  const open = text.indexOf("[", srcAt);
  let i = open;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "]") break; // source 数组里没有嵌套数组/对象，第一个 ']' 就是它的结尾
  }
  if (i >= text.length) throw new Error('harness-manifest.json 的 requiredBy.source 数组括号不平衡');
  const parts = newSource.map((k) => JSON.stringify(k)).join(", ");
  text = text.slice(0, open + 1) + parts + text.slice(i);
}
if (JSON.stringify(prevSource) !== JSON.stringify(newSource)) {
  const addedReq = newSource.filter((k) => !prevSource.includes(k));
  const removedReq = prevSource.filter((k) => !newSource.includes(k));
  if (addedReq.length) console.log("  requiredBy.source 新增：" + addedReq.join(", "));
  if (removedReq.length) console.log("  requiredBy.source 移除：" + removedReq.join(", "));
}
if (missingFromRuntime.length) {
  console.log(
    "  ⚠️ 以下文件在 harness/ 里但**没有**登记为「本侧运行必备件」，请确认它是不是内容/审计件：\n    " +
      missingFromRuntime.join(", "),
  );
}

// ---------- 回填叙述字段里的现算块 ----------
// 回填**之前**先查结构问题（孤立标记 / id 无实现 / 一块都没有）——
// 这些都会让某块永远停在旧值上。注意「内容过期」在这里不算问题（回填就是要修它），
// 所以只查结构，不查 stale。
{
  const structural = autoBlockStructuralProblems(text);
  if (structural.length) {
    console.error("[harness-manifest] 现算块结构有问题（" + structural.length + " 项）：");
    for (const p of structural) console.error("  - " + p);
    throw new Error("现算块结构不对，未写盘（改好标记或 AUTO_FILL 后重跑）。");
  }
}
let autoFilled = 0;
text = text.replace(
  /<!--AUTO:([^>]+)-->[\s\S]*?<!--\/AUTO:\1-->/gu,
  (whole, id) => {
    const fn = AUTO_FILL[id];
    if (!fn) return whole; // 结构检查已经拦过，这里不会发生
    autoFilled++;
    return `<!--AUTO:${id}-->${fn()}<!--/AUTO:${id}-->`;
  },
);
if (autoFilled === 0) {
  throw new Error(
    "清单里一个现算块都没找到（期望 ≥ 9）—— 标记被删/写坏会让叙述字段静默留旧值。",
  );
}
if (!text.endsWith("\n")) text += "\n";
writeFileSync(MANIFEST, text, "utf8");
console.log(`  叙述字段现算块：回填 ${autoFilled} 块`);

console.log("[harness-manifest] 已重出：" + ordered.length + " 个文件");
if (added.length) console.log("  新增：" + added.join(", "));
if (dropped.length) console.log("  移除：" + dropped.join(", "));
for (const k of changed) {
  console.log(`  更新：${k}\n    旧= ${JSON.stringify(prev.files[k])}\n    新= ${JSON.stringify(files[k])}`);
}
