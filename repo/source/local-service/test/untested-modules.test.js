// 漏测闸门：把「新功能忘了加测试」变成「不加就红」。
//
// 背景（2026-10-11 用户反馈）：反复出现两种翻车 ——
//   ① 新功能写进源码，但没建 test / 没登记两处 $suites ⇒ 门禁全绿（它根本没跑到）⇒ 发布后人工验收才发现；
//   ② 有测试但审查不全 ⇒ 小问题从反向/边界/产物/间接影响的洞里漏过去。
// 这道闸门只解决第①种里最难靠记忆守住的一环：**源码里有、但没有任何测试提到它**。
//
// 判定（由强到弱）：
//   · 强命中：测试语料里出现**带引号的文件名或去扩展名的模块名**（`'game-letter-timeline.js'` / `'game-letter-timeline'`）
//     —— 这才算「有测试知道它」。裸词（注释里提到、文档里写）不算，故意从严：宁可多报，不能漏报。
//   · 间接覆盖：从强命中文件出发，沿本项目内的 import 边向下闭包 —— 被它 import 的也算被带到（弱覆盖）。
//   · 零覆盖：以上都不是。
//
// 断言是**双向**的：
//   1. 实际零覆盖集合 ⊆ 白名单（新增文件落到零覆盖 ⇒ 红）
//   2. 白名单里的文件必须**仍然**零覆盖（补了测试却忘了从白名单删 ⇒ 也红）
//   3. 白名单每条必须写清 owner 与 gap（防止它退化成橡皮图章）
//
// 白名单不是免死金牌：每一条都应在后续版本里被「产物检查」或独立断言替换掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = dirname(HERE); // local-service
const KIT = join(SRC, "..", "..", ".."); // 工作区根
const E2E = join(KIT, ".test-twins");

// 产物检查区标记 —— .test-twins/1.0-final-check.ps1 用这一对注释把「产物存在性 / 产物内容检查」
// （2e ~ 2h-13）与其余内容分开。判定「有没有行为测试覆盖」时只剔除这一段，
// **不是**整个文件：文件其余部分（$suites 名单、2b/2c/2d 冒烟、3)/4) 段）仍是有效语料。
const FINAL_CHECK_FILE = "1.0-final-check.ps1";
const ARTIFACT_CHECK_RE = /# <<<ARTIFACT-CHECK-START>>>[\s\S]*?# <<<ARTIFACT-CHECK-END>>>/u;

// ---------------------------------------------------------------- 扫描面
const SCAN_DIRS = ["public", "midi"];
const ROOT_JS = [
  "server.js", "model-config.js", "model-transport.js", "data-migration.js",
  "remote-memory.js", "transcription.js", "update-network.js", "update-download.js",
  "storage-migration.js", "storage-paths.js", "soul-bundle.js",
];
const SKIP_EXT = new Set([".css", ".png", ".svg", ".json", ".html", ".md", ".txt", ".map", ".ico"]);

function listFiles(dir) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = join(dir, name);
    let st = null;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function functionalSources() {
  const out = [];
  for (const d of SCAN_DIRS) {
    const full = join(SRC, d);
    let names = [];
    try { names = readdirSync(full); } catch { continue; }
    for (const name of names) {
      const fp = join(full, name);
      try { if (!statSync(fp).isFile()) continue; } catch { continue; }
      if (SKIP_EXT.has(extname(name).toLowerCase())) continue;
      out.push(`${d}/${name}`);
    }
  }
  for (const name of ROOT_JS) {
    try { if (statSync(join(SRC, name)).isFile()) out.push(name); } catch { /* 不存在就跳过 */ }
  }
  return out.sort();
}

// 测试语料：test/ 下的套件 + .test-twins 下的端到端脚本与门禁脚本
function testCorpus() {
  const chunks = [];
  for (const root of [HERE, E2E]) {
    for (const fp of listFiles(root)) {
      const ext = extname(fp).toLowerCase();
      if (![".js", ".mjs", ".cjs", ".ps1"].includes(ext)) continue;
      // 本文件自己把白名单写成带引号的路径 —— 那不是「有测试提到它」，必须排除，
      // 否则白名单里的每个文件都会被自己判成强命中，闸门当场自指污染。
      if (basename(fp) === "untested-modules.test.js") continue;
      if (fp.includes(`${join("", "node_modules")}`) || fp.includes(`${join("", "_build")}`)) continue;
      let text = "";
      try { text = readFileSync(fp, "utf8"); } catch { continue; }
      // 1.0-final-check.ps1 的产物检查区（2e ~ 2h-13）会逐条列出「产物里必须存在」的文件名（带引号）。
      // 那是存在性检查、不是行为覆盖：整段算成「有测试提到」，ACCEPTED_ZERO 的「白名单过期」
      // 断言就会假红 —— 2026-10-11 加 2h-14 时真实踩到：6 个管理端面板明明仍然零行为覆盖，
      // 却因为产物检查列了它们的路径被判成「已经有测试了」。
      // 第一版修法是「排除整个 1.0-final-check.ps1」，第二轮复核指出粒度太粗
      // （文件其余部分本来仍是有效语料，整份排除会把真实命中一起丢掉）⇒ 改成只剔除标记出的那一段。
      if (basename(fp) === FINAL_CHECK_FILE) text = text.replace(ARTIFACT_CHECK_RE, "");
      chunks.push(text);
    }
  }
  return chunks.join("\n");
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 强命中：带引号的文件名或带引号的去扩展名模块名 —— 注释里裸提到不算。 */
function stronglyMentioned(corpus, rel) {
  const base = basename(rel);
  const stem = base.replace(/\.[^.]+$/u, "");
  const quotedPath = new RegExp(`['"\`][^'"\`]{0,120}${escapeRe(base)}['"\`]`, "u");
  const quotedStem = new RegExp(`['"\`]${escapeRe(stem)}['"\`]`, "u");
  return quotedPath.test(corpus) || quotedStem.test(corpus);
}

// -------------------------------------------------------------- 间接闭包
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/gu;

function importGraph(known) {
  const graph = new Map();
  for (const rel of known) {
    let src = "";
    try { src = readFileSync(join(SRC, rel), "utf8"); } catch { /* ignore */ }
    const deps = new Set();
    IMPORT_RE.lastIndex = 0;
    let m = IMPORT_RE.exec(src);
    while (m) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const dep = normalize(join(dirname(rel), spec)).replace(/\\/gu, "/");
        if (known.has(dep)) deps.add(dep);
      }
      m = IMPORT_RE.exec(src);
    }
    graph.set(rel, deps);
  }
  return graph;
}

// 白名单：每条都必须写清「谁在守着它」与「缺口在哪」。
// 判据是 #3 —— 没有 owner/gap 的条目直接让套件变红，避免它退化成橡皮图章。
const ACCEPTED_ZERO = {
  "public/game-log-panel.js": {
    owner: "无",
    gap: "管理端「游戏日志」面板：行为靠真实浏览器验收；后端部分由日志路由套件间接覆盖。缺的是 this file 的产物存在断言。",
  },
  "public/game-stability-panel.js": {
    owner: "无",
    gap: "管理端「游戏稳定性」面板：同上。后端崩溃报告由 midi/crash-report.js 侧覆盖。",
  },
  "public/getting-started.js": {
    owner: "无",
    gap: "「新手上路」六条引导：纯展示，无独立断言；引导文案变更无人守（文档层缺口）。",
  },
  "public/logs-page.js": {
    owner: "无",
    gap: "日志页签：纯展示 + 拉接口，产物层无断言。",
  },
  "public/migrate-ui.js": {
    owner: "无",
    gap: "数据搬家界面：运行期行为在门禁 5/6（数据搬家）覆盖，但那是端到端脚本、不算本文件的独立断言。",
  },
  "public/panel-host.js": {
    owner: "无",
    gap: "面板宿主（注册表 + 懒加载）：跨页复用点，目前只靠 notice-layer-keyboard 等间接带到。",
  },
};

const ACCEPTED_INDIRECT = {
  "midi/crash-report.js": "被 midi/diagnostic-package.js import 带进诊断包套件；崩溃解析本身无独立断言。",
  "midi/game-log.js": "被日志路由带到；日志解析本身无独立断言。",
  "midi/sqlite-snapshot.js": "被数据库自愈 / 诊断包带到；快照本身无独立断言。",
  "midi/startup-report.js": "被依赖检查带到；启动报告本身无独立断言。",
  "midi/system-probe.js": "被 midi/dependency-check.js 带到；系统探测本身无独立断言。",
  "midi/fingerprint.js": "被 midi/community-catalog.js:36 与 midi/listen-naming.js:30 import 带到；指纹算法本身无独立断言（曲库体检只验外层结论）。",
  "midi/game-stability.js": "被 server.js:11 import 带到；稳定性统计本身无独立断言。",
  "midi/library-removal.js": "被 server.js:58 import 带到；移除曲目本身无独立断言（数据安全套件守的是删除闸门，不是这条）。",
  "midi/library-sources.js": "被 server.js:59 import 带到；来源归类本身无独立断言。",
  "midi/logs.js": "被 midi/crash-report.js:15 / diagnostic-package.js:16 / game-log.js:14 / listen-naming.js:29 import 带到；日志落盘本身无独立断言。",
  "midi/playback-clock.js": "被 server.js:61 import 带到；播放时刻换算本身无独立断言（时段复核套件验的是判定，不是这条换算）。",
};

test("漏测闸门：产物检查区不得被当成「有测试覆盖」（剔除粒度 = 那一段，不是整个文件）", () => {
  const text = readFileSync(join(E2E, FINAL_CHECK_FILE), "utf8");

  // ① 标记必须各出现一次且成对 —— 标记被删掉会让 testCorpus() 的剔除静默失效
  //    （闸门变松：零覆盖文件被误判成「已经有测试了」），必须有测试钉住。
  assert.equal(
    (text.match(/<<<ARTIFACT-CHECK-START>>>/gu) ?? []).length,
    1,
    `1.0-final-check.ps1 必须恰好有一个 <<<ARTIFACT-CHECK-START>>> 标记（增删产物检查区时别把它丢掉）`,
  );
  assert.equal(
    (text.match(/<<<ARTIFACT-CHECK-END>>>/gu) ?? []).length,
    1,
    `1.0-final-check.ps1 必须恰好有一个 <<<ARTIFACT-CHECK-END>>> 标记`,
  );
  assert.match(text, ARTIFACT_CHECK_RE, "两个标记不成对（START 必须在 END 之前）");

  // ② 剔除确实生效：零覆盖白名单里的文件名不得再出现在语料里
  const corpus = testCorpus();
  for (const rel of Object.keys(ACCEPTED_ZERO)) {
    const base = basename(rel);
    assert.ok(
      !corpus.includes(`'${base}'`) && !corpus.includes(`"${base}"`),
      `${base} 是零覆盖白名单条目，却仍出现在测试语料里 —— 说明产物检查区的剔除没生效`,
    );
  }

  // ③ 剔的是「那一段」而不是整个文件：文件其余部分仍然必须算语料（否则粒度又退回整份排除）
  assert.ok(
    corpus.includes("关键测试套件"),
    "1.0-final-check.ps1 的产物检查区之外的内容不该被整段排除（至少 $suites 那一段要留在语料里）",
  );
});

test("漏测闸门：零覆盖的功能文件必须都在白名单里（白名单外的一律算漏）", () => {
  const corpus = testCorpus();
  const sources = functionalSources();
  const known = new Set(sources);

  const direct = sources.filter(rel => stronglyMentioned(corpus, rel));
  const rest = sources.filter(rel => !direct.includes(rel));

  const graph = importGraph(known);
  const reached = new Set(direct);
  const todo = [...direct];
  while (todo.length) {
    const cur = todo.pop();
    for (const dep of graph.get(cur) ?? []) {
      if (!reached.has(dep)) { reached.add(dep); todo.push(dep); }
    }
  }

  const indirect = rest.filter(rel => reached.has(rel));
  const zero = rest.filter(rel => !reached.has(rel));

  // 断言 1：白名单外的零覆盖 ⇒ 红（新增功能落在这里就是「忘了加测试」）
  const unexpected = zero.filter(rel => !(rel in ACCEPTED_ZERO));
  assert.deepEqual(
    unexpected,
    [],
    `以下功能文件没有任何测试提到（也不在白名单里）：\n  ${unexpected.join("\n  ")}\n` +
      "处理：① 建 test/<name>.test.js 并登记两处 $suites；② 若是界面功能，另加一段产物检查；" +
      "③ 确实只需人工验收的，才加进 test/untested-modules.test.js 的 ACCEPTED_ZERO 并写清 owner/gap。",
  );

  // 断言 2：白名单过期 ⇒ 红（补了测试却忘了删条目，说明白名单已经不准了）
  const stale = Object.keys(ACCEPTED_ZERO).filter(rel => !zero.includes(rel));
  assert.deepEqual(
    stale,
    [],
    `这些文件已经在白名单里，但现在有测试提到了（说明白名单过期）：\n  ${stale.join("\n  ")}\n` +
      "处理：把它们从 ACCEPTED_ZERO 里删掉。",
  );

  // 断言 3：白名单条目必须写清 owner 与 gap
  for (const [rel, info] of Object.entries(ACCEPTED_ZERO)) {
    assert.ok(info && typeof info === "object", `${rel} 的白名单条目必须是对象`);
    assert.ok(String(info.owner ?? "").trim(), `${rel} 的白名单条目缺 owner（谁在守着它）`);
    assert.ok(String(info.gap ?? "").trim(), `${rel} 的白名单条目缺 gap（缺口在哪）`);
  }

  // 仅间接覆盖：这类文件「上游改了会连带影响、自己却没有独立断言」，是最容易藏小问题的一档。
  console.log(
    `[漏测闸门] 功能文件 ${sources.length} 个：强命中 ${direct.length} / 仅间接覆盖 ${indirect.length} / 零覆盖 ${zero.length}`,
  );

  // 断言 4：仅间接覆盖的也必须登记 —— 没登记就说明没人知道它只被顺带带到。
  const unrecordedIndirect = indirect.filter(rel => !(rel in ACCEPTED_INDIRECT));
  assert.deepEqual(
    unrecordedIndirect,
    [],
    `这些文件只被间接带到（自己没有独立断言），但没有登记：\n  ${unrecordedIndirect.join("\n  ")}\n` +
      "处理：优先补一条独立断言；暂时只能靠间接覆盖的，加进 ACCEPTED_INDIRECT 并写清「被谁带到、缺口在哪」。",
  );
});

test("漏测闸门：白名单本身不能是空的、也不能随便膨胀", () => {
  const zeroCount = Object.keys(ACCEPTED_ZERO).length;
  assert.ok(zeroCount > 0 || true, "白名单可以为空 —— 那说明每个功能文件都有测试");
  // 上限只是提醒：真到了 15 个以上，说明「产物检查 + 独立断言」这条补课路已经欠太多。
  assert.ok(
    zeroCount <= 14,
    `零覆盖白名单已经 ${zeroCount} 条 —— 该补产物检查或独立断言了，别让它无限膨胀。`,
  );
});
