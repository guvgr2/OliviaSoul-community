// 1.2.0 真机反馈（文件选择器顶部那条黑）的护栏。
// 见 analysis/给deepseek-1.2.0-真机反馈修复单-2026-10-11.md §一：
//   · 触发前必须把文档切成浅色（否则 Chromium 会把选择器里「面包屑路径」那一行画成黑底）；
//   · change / cancel / window focus **三路都**必须还原 —— 少一路就会出现
//     「用户按了取消，整个界面从此变白」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFile, lightForFilePicker } from "../public/file-picker-guard.js";
import { readSourceText } from "./lib/read-source.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== handler));
    },
    fire(type, event = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    count(type) { return (listeners.get(type) ?? []).length; },
  };
}

function setup() {
  const root = { style: { colorScheme: "" } };
  const win = makeEventTarget();
  globalThis.document = { documentElement: root };
  globalThis.window = win;
  const input = makeEventTarget();
  input.clicked = 0;
  input.click = () => { input.clicked += 1; };
  return { root, win, input };
}

test("pickFile：必须在 click() 之前就把文档切成浅色", () => {
  const { root, input } = setup();
  let schemeAtClick = null;
  input.click = () => { schemeAtClick = root.style.colorScheme; };
  pickFile(input);
  assert.equal(schemeAtClick, "light", "对话框是在 click() 那一刻读 color-scheme 的，顺序不能反");
});

test("pickFile：选中文件（change）后还原", async () => {
  const { root, input } = setup();
  pickFile(input);
  assert.equal(root.style.colorScheme, "light");
  input.fire("change");
  await tick();                                   // change 的处理函数要先读完 files
  assert.equal(root.style.colorScheme, "", "change 之后必须还原，不能停在 light");
});

test("pickFile：用户按取消 / Esc（cancel）后也必须还原 —— 最容易漏的那一半", async () => {
  const { root, input } = setup();
  pickFile(input);
  input.fire("cancel");
  await tick();
  assert.equal(root.style.colorScheme, "", "cancel 不还原 ⇒ 滚动条 / 下拉框 / 日期控件永久变白");
});

test("pickFile：对话框关掉后主窗口回焦（window focus）也要还原", async () => {
  const { root, win, input } = setup();
  pickFile(input);
  win.fire("focus");
  await tick();
  assert.equal(root.style.colorScheme, "");
});

test("pickFile：还原只做一次，且三路监听全部摘掉（不留空转监听）", async () => {
  const { root, win, input } = setup();
  pickFile(input);
  assert.equal(input.count("change"), 1);
  assert.equal(input.count("cancel"), 1);
  assert.equal(win.count("focus"), 1);
  input.fire("cancel");
  await tick();
  assert.equal(root.style.colorScheme, "");
  assert.equal(input.count("change"), 0);
  assert.equal(input.count("cancel"), 0);
  assert.equal(win.count("focus"), 0);
  // 已经还原过之后再收到 focus，不得再动样式
  root.style.colorScheme = "dark";
  win.fire("focus");
  assert.equal(root.style.colorScheme, "dark");
});

test("pickFile：还原成触发前的原值，而不是写死某个字符串", async () => {
  const { root, input } = setup();
  root.style.colorScheme = "only light";          // 触发前本来就有内联值
  pickFile(input);
  assert.equal(root.style.colorScheme, "light");
  input.fire("change");
  await tick();
  assert.equal(root.style.colorScheme, "only light");
});

test("lightForFilePicker：只切浅色、不替用户点（label / 直点 input 的场合不能弹两次）", () => {
  const { root, input } = setup();
  lightForFilePicker(input);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(input.clicked, 0, "用户自己已经在点了，再调一次 click() 会弹两个对话框");
});

test("pickFile / lightForFilePicker：没有 input 时安静返回（不抛错、不动样式）", () => {
  const { root } = setup();
  root.style.colorScheme = "dark";
  assert.doesNotThrow(() => pickFile(null));
  assert.doesNotThrow(() => lightForFilePicker(undefined));
  assert.equal(root.style.colorScheme, "dark");
});

// 全局挂载必须带 typeof 守卫：几处假 DOM 夹具（node:vm）会把 app.js 的 import 行整行剥掉
// 再跑本文件（test/update-channel.test.js:489 的 .replace(/^import .*\r?\n/gmu, "") 是代表），
// 那种环境下 `window.pickFile = pickFile;` 会抛 ReferenceError，表现为
// 「update-channel 5 项 + rollback-patch-ui 11 项 + patch-loss-notice 5 项」一起红 —— 2026-10-12 真实踩过。
test("app.js 的全局挂载带 typeof 守卫（假 DOM 夹具会剥掉 import 行）", async () => {
  const source = await readSourceText(new URL("../public/app.js", import.meta.url));
  assert.match(source, /if \(typeof pickFile === "function"\) window\.pickFile = pickFile;/u);
  assert.match(
    source,
    /if \(typeof lightForFilePicker === "function"\) window\.lightForFilePicker = lightForFilePicker;/u,
  );
  assert.doesNotMatch(
    source,
    /^window\.(?:pickFile|lightForFilePicker) =/mu,
    "不要直接赋值 —— 剥掉 import 的 vm 夹具会在这里抛 ReferenceError，打红三个既有套件",
  );
});
