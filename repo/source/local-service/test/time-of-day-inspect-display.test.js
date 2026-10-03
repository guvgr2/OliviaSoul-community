/**
 * 时段复核面板「显示层」的防回归测试（1.0.8 修的两个界面缺陷）。
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

async function renderPanel(segments) {
  const window = { setTimeout: (fn) => setTimeout(fn, 0), confirm: () => true };
  window.fetch = async () => ({
    json: async () => ({
      code: 0,
      data: {
        folder: FOLDER, segments, current: null, mapping: null,
        thresholds: { brightnessDay: 110, brightnessNight: 62, warmthDusk: 10 },
      },
    }),
  });
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
  return { box };
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
