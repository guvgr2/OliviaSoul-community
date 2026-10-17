// P5 落地护栏（2026-10-16 两端写信引擎同步）：升级版《人设与表达规范》§四 的**结构**进写法.md。
//
// 口径（用户 2026-10-16「按你建议的来」选的 B）：
//   - 采纳 §四 的 4.1 六段结构 / 4.3 时间与天气 / 4.4 场景矩阵 / 4.6 红线；
//   - **不采纳** §三 与 §四 4.2 的字数规格 —— 字数的单一来源是 harness/行为参数.json
//     （reply.maxChars 240 / proactive.maxChars 200）。照 §三 的「常规 250–450 字」写出来的信
//     会被硬校验当场拒掉，两套数值并存必然漂移。
//
// 所以这里既钉「该有的结构在」，也钉「不该有的字数规格没被写进来」（反向断言）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WRITING = new URL("../../harness/写法.md", import.meta.url);

async function writingText() {
  return readFile(WRITING, "utf8");
}

test("写法.md 有「六段结构」，六段齐全且两条硬要求在场", async () => {
  const text = await writingText();
  assert.match(text, /### 六段结构/u, "P5 落地的「六段结构」一节不见了");
  for (const seg of ["起首", "回应来信", "你的切片", "一点看法", "半开的门", "收束"]) {
    assert.ok(text.includes(seg), `六段结构缺「${seg}」`);
  }
  assert.match(text, /不写「亲爱的」/u, "「起首不写亲爱的」这条约束被删了");
  assert.match(text, /必须复述或化用他信里至少一个具体细节/u, "第 2 段「回应来信」的硬要求被删了");
  assert.match(text, /可以缺省，不要乱序/u, "「可缺省、不可乱序」的口径被删了");
});

test("写法.md 有 12 类来信场景矩阵", async () => {
  const text = await writingText();
  assert.match(text, /### 场景/u, "「场景」一节不见了");
  const rows = text
    .split(/\r?\n/u)
    .filter((line) => /^\|.+\|.+\|.+\|.+\|$/u.test(line.trim()) && !line.includes("---"));
  assert.ok(rows.length >= 12, `场景矩阵应有 ≥12 类来信，实测 ${rows.length} 行`);
  for (const key of ["日常分享", "告别 / 停服", "边界 / 越界请求", "心理学问题", "音乐问题", "感谢"]) {
    assert.ok(text.includes(key), `场景矩阵缺「${key}」这一类`);
  }
  assert.match(text, /最重要的一种/u, "「告别 / 停服」没有被标成最重要场景");
});

test("写法.md 有「红线」一节，禁补史条款与机械护栏同源", async () => {
  const text = await writingText();
  assert.match(text, /### 红线/u, "「红线」一节不见了");
  for (const w of [
    "上次",
    "上回",
    "上封",
    "前些天",
    "还记得",
    "你跟我说过",
    "你讲过",
    "你答应过",
    "每次你都",
    "你以前总是",
  ]) {
    assert.ok(text.includes(w), `红线缺禁补史措辞「${w}」`);
  }
  assert.match(text, /机械护栏/u, "红线里的禁补史条款没有和机械护栏挂钩（模型会以为只是建议）");
});

test("写法.md 的天气规则带「要有画面」要求（4.3）", async () => {
  const text = await writingText();
  assert.match(text, /天气按来信的情绪配/u, "4.3 的「天气按来信情绪配」规则不见了");
  assert.match(text, /不是报天气/u, "天气句的「要有画面、不是报天气」被删了");
});

test("写法.md 保留原有骨架（P5 是加法不是替换）", async () => {
  const text = await writingText();
  for (const s of [
    "## 愿景",
    "## 方法",
    "### 事实",
    "### 文风",
    "### 关注点",
    "### 温度",
    "### 行文",
    "### 手法",
    "## 寄出前",
  ]) {
    assert.ok(text.includes(s), `原有小节「${s}」被删掉了`);
  }
  assert.ok(text.includes("厌恶 <- 一般人 <- 令你感兴趣的笔友"), "关系档位序列被改动了");
  for (const w of ["呀、啦、嘛、呢、吧"]) {
    assert.ok(text.includes(w), `手法里的口语活性条目被删了（${w}）`);
  }
});

test("写法.md 不含 §三 的字数规格（P5 选 B：字数单一来源是 行为参数.json）", async () => {
  const text = await writingText();
  assert.doesNotMatch(text, /250\s*[-–—~]\s*450/u, "§三 的「常规 250–450 字」被写进来了（硬校验 240 会拒掉合规信）");
  assert.doesNotMatch(text, /500\s*[-–—~]\s*700/u, "§四 4.2 的长信「500–700 字」被写进来了");
  assert.doesNotMatch(text, /不超过\s*160\s*字/u, "主动信的 160 字上限被写进写法.md —— 它属于 行为参数.json 的 proactive.maxChars");
});
