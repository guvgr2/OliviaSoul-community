/**
 * 时段复核面板「显示层」的防回归测试（1.0.8 修的两个界面缺陷 + 1.0.9 的反馈修复）。
 *
 * 为什么不直接加进 time-of-day-inspect-ui.test.js：
 *   那个文件是既有的门禁套件，改动它会波及别人的测试流程。这里单独成文件，
 *   既不碰既有断言，也能把这次的修复钉住。
 *
 * 本文件的假 DOM 辅助代码是从 time-of-day-inspect-ui.test.js 复制来的（刻意复制，不共享）：
 *   抽成公共 helper 需要改既有测试文件的 import —— 那正是要避免的改动。
 *   等哪天既有测试允许重构了，再把 FakeElement / renderPanel 抽到 helper 里，两边一起改。
 *   **在此之前，如果 time-of-day-inspect-ui.test.js 的辅助代码变了，这里要跟着看一眼。**
 *
 * 跑法：node --test --test-force-exit test/time-of-day-inspect-display.test.js
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/time-of-day-inspect.js", import.meta.url), "utf8");
const FOLDER = "midi_900_1700000000";
const REWORK_LABEL = "按画面判定重写这一首";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.listeners = new Map();
  }
  append(...nodes) { for (const child of nodes) if (child) { child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  async click() {
    const handler = this.listeners.get("click");
    if (!handler) return;
    await handler();
  }
  querySelectorAll(selector) {
    const tag = String(selector).toUpperCase();
    return this.descendants().filter(element => element.tagName === tag);
  }
  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
  find(predicate) { return this.descendants().find(predicate) ?? null; }
  textOf() { return [this.textContent, ...this.children.map(child => child.textOf())].filter(Boolean).join(" "); }
}

function segment(index, verdictLabel) {
  return {
    index, video: `DEFAULT${index ? `_${index + 1}` : ""}`, brightness: 120 - index * 30, warmth: index * 10,
    period: ["TOD12", "TOD1730", "TOD20"][index], verdictLabel, frameCount: 7, reason: "",
    thumbnailUrl: `/admin/api/listen-naming/time-of-day/thumbnail?folder=${FOLDER}&seg=${index}`,
  };
}

/** 报告里的画面卡（注意用完整类名比对：ln-todCardActions 也含 ln-todCard 子串）。 */
function cardsOf(box) {
  return box.descendants().filter(element => String(element.className).split(/\s+/u).includes("ln-todCard"));
}

/**
 * options.current  —— 数据库现值映射（{ TOD12: "DEFAULT", … }），null 表示库里是空
 * options.confirm  —— 替换 confirm；缺省会记录每次提问并一律答应（prompts 里能读到）
 * options.respond  —— 自定义响应（{ path, init, calls, base } → { code, data }），缺省一律返回 base
 */
async function renderPanel(segments, options = {}) {
  const prompts = [];
  const calls = [];
  const base = {
    folder: FOLDER, segments, current: options.current ?? null, mapping: null,
    thresholds: { brightnessDay: 110, brightnessNight: 62, warmthDusk: 10 },
  };
  const window = {
    setTimeout: (fn) => setTimeout(fn, 0),
    confirm: options.confirm ?? ((message) => { prompts.push(message); return true; }),
  };
  window.fetch = async (path, init) => {
    calls.push({ path: String(path), init, body: init && init.body ? JSON.parse(init.body) : null });
    const payload = options.respond
      ? options.respond({ path: String(path), init, calls: calls.length, base })
      : { code: 0, data: base };
    return { json: async () => payload };
  };
  const document = { createElement: (tag) => new FakeElement(tag), querySelector: () => null };
  new Function("window", "document", source)(window, document);

  const box = window.OliviaSoulTimeOfDayInspect.render();
  const viewButton = box.find(element => element.tagName === "BUTTON" && element.textContent === "查看依据");
  assert.ok(viewButton, "面板里应该有「查看依据」按钮");
  const input = box.find(element => element.tagName === "INPUT");
  input.value = FOLDER;
  await viewButton.click();
  assert.ok(
    box.find(element => element.tagName === "BUTTON" && element.textContent === REWORK_LABEL),
    "报告里应该有重写按钮（数据没渲染出来的话这条会先挂）",
  );
  return { box, prompts, calls };
}

// 后端给的是原始浮点（亮度如 227.285），判定阈值却是整数（110 / 62 / 10）。
// 以前直接拼进文案，界面上出现「亮度 227.285 · 色温 -20.5」—— 同一行两种精度，
// 小数位对判断毫无帮助。展示层必须收一下。
test("亮度与色温按整数显示，不把原始浮点直接上屏", async () => {
  const precise = [
    { ...segment(0, "白天"), brightness: 227.285, warmth: -20.5 },
    { ...segment(1, "傍晚"), brightness: 177.629, warmth: 103.5 },
    { ...segment(2, "夜晚"), brightness: 22.307, warmth: -19.5 },
  ];
  const { box } = await renderPanel(precise);
  const text = box.textOf();
  assert.doesNotMatch(text, /227\.285|177\.629|22\.307/u, "不应该出现原始浮点");
  assert.match(text, /亮度 227 · 色温 -20/u);
  assert.match(text, /亮度 178 · 色温 104/u);
  // Math.round(-19.5) === -19（JS 的 .5 向正无穷取整），别想当然写 -20
  assert.match(text, /亮度 22 · 色温 -19/u);
});

test("拿不到亮度与色温时显示问号，不猜数字", async () => {
  // 这一条盯的是「先判空再转数字」：Number(null) 是 0、Number("") 也是 0，
  // 直接 Math.round(Number(v)) 会把「没有值」显示成 0，比原来的 ?? "?" 更糟。
  const blanks = [{ ...segment(0, "白天"), brightness: null, warmth: null }];
  const { box } = await renderPanel(blanks);
  assert.match(box.textOf(), /亮度 \? · 色温 \?/u);

  const empties = [{ ...segment(0, "白天"), brightness: "", warmth: "" }];
  const { box: emptyBox } = await renderPanel(empties);
  assert.match(emptyBox.textOf(), /亮度 \? · 色温 \?/u);
});

// 时段卡片有两处：曲名与时段页（listen-naming.js）与试听工具页的复核面板
// （time-of-day-inspect.js）。排布规则以前只写在 [data-page="listen-naming"] .ln-clueOut
// 作用域下，复核面板挂在试听工具页、父级也不是 .ln-clueOut，于是完全匹配不到：
// 卡片退化成竖排、没有内边距。这里盯住「至少要有一条不带页面限定的规则」。
test("卡片排布样式不能被单一页面作用域卡住", async () => {
  const css = await readFile(new URL("../public/listen-naming.css", import.meta.url), "utf8");
  const lines = css.split(/\r?\n/u);
  const scoped = (needle) => lines.filter(line => line.includes(needle));
  for (const [needle, label] of [[".ln-todRow", "卡片行"], [".ln-todCard", "卡片"]]) {
    const matches = scoped(needle);
    assert.ok(matches.length > 0, `${label}应该有排布规则`);
    assert.ok(
      matches.some(line => !line.includes("[data-page=")),
      `${label}的排布规则不能只写在某个页面的作用域下（复核面板挂在试听工具页）`,
    );
  }
  assert.ok(
    scoped(".ln-todRow").some(line => !line.includes("[data-page=") && /display:\s*flex/u.test(line)),
    "卡片行应该是 flex 排布（原来只在曲名与时段页生效，试听工具页退化成竖排）",
  );
});

// 显示取整有两处：试听工具页的复核面板（上面测过）与「曲名与时段」页的就地时段依据
// （listen-naming.js，点「看时段依据」展开的那一栏）。两处取的是同一个接口的原始浮点，
// 只修一处的话另一页照样显示 227.285 —— 这里把第二处一起钉住。
// 为什么是源码级断言：listen-naming.js 是 1100 行的整页 IIFE，要 state / elements /
// 一大票 DOM 才跑得起来，为一个 4 行函数搭假环境不划算；仓库对这类前端文件已有源码级
// 断言的先例（test/no-autoplay.test.js、test/runtime-bootstrap.test.js）。
test("「曲名与时段」页的就地依据也走同一个取整函数", async () => {
  const listenNaming = await readFile(new URL("../public/listen-naming.js", import.meta.url), "utf8");
  assert.match(
    listenNaming,
    /function formatMetric\(value\) \{\s*if \(value == null \|\| value === ""\) return "\?";/u,
    "listen-naming.js 里应该有同一份 formatMetric（第一句就必须判空）",
  );
  assert.match(
    listenNaming,
    /亮度 \$\{formatMetric\(segment\.brightness\)\} · 色温 \$\{formatMetric\(segment\.warmth\)\}/u,
    "就地依据的亮度/色温应该走 formatMetric",
  );
  assert.doesNotMatch(
    listenNaming,
    /亮度 \$\{segment\.brightness/u,
    "就地依据不能直接拼原始浮点（会显示 227.285）",
  );
});

// 1.0.9：手动指定写库成功以前只回一句「已写入 N 行」，界面上看不出「这一段现在算哪个时段」——
// 照着截图核对修复效果时就是这么卡住的。每张画面卡必须直接写出它在数据库里的当前归属，
// 没被任何时段占着就老实写「未指定」，不能猜。
test("每张画面卡写明它当前被哪个时段占着，没被占就写未指定", async () => {
  const segments = [segment(0, "白天"), segment(1, "傍晚"), segment(2, "夜晚")];
  const all = await renderPanel(segments, {
    current: { TOD12: "DEFAULT", TOD1730: "DEFAULT_2", TOD20: "DEFAULT_3" },
  });
  const texts = cardsOf(all.box).map(card => card.textOf());
  assert.match(texts[0], /当前：白天/u);
  assert.match(texts[1], /当前：傍晚/u);
  assert.match(texts[2], /当前：夜晚/u);

  // 只把「夜晚」指到第 1 段：第 1 段归夜晚，另外两段谁都不占 → 未指定
  const partial = await renderPanel(segments, { current: { TOD20: "DEFAULT" } });
  const partialTexts = cardsOf(partial.box).map(card => card.textOf());
  assert.match(partialTexts[0], /当前：夜晚/u);
  assert.match(partialTexts[1], /当前：未指定/u);
  assert.match(partialTexts[2], /当前：未指定/u);
});

// 1.0.9：手动指定是有代价的 —— 同一段只能占一个时段。以前确认框只说「设为夜晚」，
// 用户不知道原来占着它的「白天」会被清空、目标时段原本指着的那段会被替换。
test("确认框提前讲清哪个时段会被清空、哪个时段会被替换", async () => {
  const segments = [segment(0, "白天"), segment(1, "傍晚"), segment(2, "夜晚")];
  const { box, prompts } = await renderPanel(segments, {
    current: { TOD12: "DEFAULT", TOD1730: "DEFAULT_2", TOD20: "DEFAULT_3" },
  });
  const night = cardsOf(box)[0].querySelectorAll("button").find(button => button.textContent === "夜晚");
  assert.ok(night, "第 1 段卡里应该有「夜晚」按钮");
  await night.click();

  assert.equal(prompts.length, 1, "点一下只应该问一次");
  assert.match(prompts[0], /第 1 段画面设为「夜晚」/u);
  assert.match(prompts[0], /当前「白天」指向这一段，会被清空/u, "第 1 段现在占着「白天」，改到夜晚就得把白天清掉");
  assert.match(prompts[0], /「夜晚」原本指向第 3 段，将被替换/u, "「夜晚」原本指着第 3 段，界面要说清");
});

// 1.0.9：写库成功的回执必须写清「改成了什么、原来那个时段怎么了」，而且**重渲染之后仍然看得见**。
// 老代码的顺序是「先往结果行写回执 → 再整体重渲染」——重渲染会把整块报告连同结果行一起换掉，
// 回执当场消失，用户点完什么都看不到。这条用「回执节点仍在当前报告里」把它钉死。
test("写入回执写清改动，并且在重渲染之后仍然看得见", async () => {
  const segments = [segment(0, "白天"), segment(1, "傍晚"), segment(2, "夜晚")];
  const before = { TOD12: "DEFAULT", TOD1730: "DEFAULT_2", TOD20: "DEFAULT_3" };
  const posted = {
    folder: FOLDER,
    slot: "TOD20",
    slotLabel: "夜晚",
    variant: "DEFAULT",
    previous: before,
    mapping: { TOD12: null, TOD1730: "DEFAULT_2", TOD20: "DEFAULT" },
    written: 1,
    backupFile: "backup-2026.sqlite",
  };
  const { box } = await renderPanel(segments, {
    current: before,
    respond: ({ init, calls, base }) => {
      if (init && init.method === "POST") return { code: 0, data: posted };
      // 第一次 GET 是「查看依据」，写入之后的第二次 GET 要带回新的现值
      return { code: 0, data: { ...base, current: calls > 1 ? posted.mapping : before } };
    },
  });
  const night = cardsOf(box)[0].querySelectorAll("button").find(button => button.textContent === "夜晚");
  await night.click();

  const result = box.find(element => String(element.className).split(/\s+/u).includes("ln-todResult"));
  assert.ok(result, "重渲染之后报告里应该还有结果行");
  assert.match(result.textContent, /✓ 已写入 1 行/u);
  assert.match(result.textContent, /夜晚 → 第 1 段（DEFAULT）/u, "回执要说清这次是把哪一段指给了哪个时段");
  assert.match(result.textContent, /原「白天」已清空/u, "被清空的时段必须在回执里点出来");
  assert.match(result.textContent, /备份 backup-2026\.sqlite/u);
  // 重渲染后每张卡的「当前」也要跟着变
  assert.match(cardsOf(box)[0].textOf(), /当前：夜晚/u);
  assert.match(cardsOf(box)[2].textOf(), /当前：未指定/u);
});
