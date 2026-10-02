import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// g14：时段页的「按画面判定重写这一首」以前无论识别到几段都能点。识别不到 3 段时，
// 重写会把缺的时段映射清空，播放时三段都回退到同一段视频 —— 必须在界面上拦住。
// 这里用最小假 DOM 把真实前端文件跑起来，只断言护栏行为，不碰真实浏览器。
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
  /** 触发监听器；返回它们产生的 Promise，调用方 await 之后再断言。 */
  async click() {
    const handler = this.listeners.get("click");
    if (!handler) return;
    await handler();
  }
  /** 只支持按标签名查（本文件里用到的是 querySelectorAll("button")）。 */
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
  const asked = [];
  const calls = [];
  const window = { setTimeout: (fn) => setTimeout(fn, 0), confirm: (message) => { asked.push(message); return true; } };
  window.fetch = async (path, options) => {
    calls.push({ path: String(path), body: options && options.body ? JSON.parse(options.body) : null });
    return {
      json: async () => ({
        code: 0,
        data: { folder: FOLDER, segments, current: null, mapping: null, thresholds: { brightnessDay: 110, brightnessNight: 62, warmthDusk: 10 } },
      }),
    };
  };
  const document = { createElement: (tag) => new FakeElement(tag), querySelector: () => null };
  new Function("window", "document", source)(window, document);

  const box = window.OliviaSoulTimeOfDayInspect.render();
  const viewButton = box.find(element => element.tagName === "BUTTON" && element.textContent === "查看依据");
  assert.ok(viewButton, "面板里应该有「查看依据」按钮");
  const input = box.find(element => element.tagName === "INPUT");
  input.value = FOLDER;
  await viewButton.click();
  const rework = box.find(element => element.tagName === "BUTTON" && element.textContent === REWORK_LABEL);
  assert.ok(rework, "报告里应该有重写按钮");
  return { box, rework, asked, calls };
}

test("只识别到 1 段画面时禁用「按画面判定重写这一首」并说明原因", async () => {
  const { box, rework } = await renderPanel([segment(0, "白天")]);
  assert.equal(rework.disabled, true);
  assert.match(rework.title, /只识别到 1 段画面/u);
  assert.match(box.textOf(), /只识别到 1\/3 段画面/u);
});

test("识别到 3 段画面时重写按钮可用且不啰嗦", async () => {
  const { box, rework, asked } = await renderPanel([segment(0, "白天"), segment(1, "傍晚"), segment(2, "夜晚")]);
  assert.equal(rework.disabled, false);
  assert.equal(rework.title, undefined);
  assert.doesNotMatch(box.textOf(), /只识别到/u);
  await rework.click();
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], /只识别到/u);
});

test("识别到 2 段画面时确认框写明只识别到 2/3 段", async () => {
  const { rework, asked } = await renderPanel([segment(0, "白天"), segment(1, "傍晚")]);
  assert.equal(rework.disabled, false);
  await rework.click();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /只识别到 2\/3 段画面/u);
});

// g14：手动指定以前是全局一行三个按钮，后端固定拿第 1 段画面的变体键写库 ——
// 第 2、3 段根本改不动。现在三个按钮必须挂在各自的卡片里，请求要带上这一段的变体键。
test("每段画面卡都能手动指定自己的变体，不再永远写第 1 段", async () => {
  const slots = ["白天", "傍晚", "夜晚"];
  const segments = [segment(0, "白天"), segment(1, "傍晚"), segment(2, "夜晚")];
  const { box, asked, calls } = await renderPanel(segments);

  // 注意用完整类名比对：ln-todCardActions 也含 "ln-todCard" 子串，includes 会多算一倍
  const cards = box.descendants().filter(element => element.className.split(/\s+/u).includes("ln-todCard"));
  assert.equal(cards.length, 3);
  // 全局只有一行按钮时这里会是 3 个（而不是 3×3）：那正是「只能改第 1 段」的老毛病
  assert.equal(
    box.querySelectorAll("button").filter(button => slots.includes(button.textContent)).length,
    slots.length * segments.length,
    "白天/傍晚/夜晚三按钮必须出现在每一张画面卡里",
  );
  for (const [index, card] of cards.entries()) {
    const labels = card.querySelectorAll("button").map(button => button.textContent).filter(text => slots.includes(text));
    assert.deepEqual(labels, slots, `第 ${index + 1} 段卡里应该有白天/傍晚/夜晚三个按钮`);
  }

  const night = cards[1].querySelectorAll("button").find(button => button.textContent === "夜晚");
  assert.ok(night, "第 2 段卡里应该有「夜晚」按钮");
  await night.click();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /第 2 段画面设为「夜晚」/u);

  const posted = calls.filter(call => call.body && call.body.slot);
  assert.equal(posted.length, 1, "一次点击只应该发一个写库请求");
  assert.equal(posted[0].path, "/toy/listen-naming/time-of-day/set-slot");
  assert.deepEqual(posted[0].body, { folder: FOLDER, slot: "TOD20", variant: "DEFAULT_2" });
});

test("拿不到变体键的那一段不给手动指定按钮，只留一句说明", async () => {
  const orphan = { ...segment(0, "白天"), video: "" };
  const { box } = await renderPanel([orphan]);
  assert.equal(box.querySelectorAll("button").filter(button => ["白天", "傍晚", "夜晚"].includes(button.textContent)).length, 0);
  assert.match(box.textOf(), /没有可用的变体键/u);
});
