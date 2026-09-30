// g29：试听播放器的「首次进入不自动播放」防回归测试
//
// 背景：进入「曲名与时段」页面时，loadClip() 原本会立刻 autoplay，浏览多首时会被突然发声打扰。
// 行为改为：首次进入只载入不播放；用户主动操作（播放器上的播放键、空格、重播/换段/跳过/上一首）
// 之后才继续自动播放。本测试锁住这个约定，防止以后被无意改回去。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/listen-naming.js", import.meta.url), "utf8");

test("试听首次进入不自动播放：存在主动开始开关", () => {
  assert.match(source, /let userStartedPlayback = false;/u, "缺少 userStartedPlayback 开关");
  assert.match(source, /function markUserStartedPlayback\(\) \{ userStartedPlayback = true; \}/u, "缺少登记函数");
});

test("loadClip 只在用户主动开始后才自动播放", () => {
  assert.match(source, /if \(userStartedPlayback\) void autoplay\(elements\);/u,
    "loadClip 末尾的自动播放必须受开关保护");
  const unconditional = (source.match(/(?<!if \(userStartedPlayback\) )void autoplay\(elements\);/gu) ?? []).length;
  assert.equal(unconditional, 0, "存在不受开关保护的 autoplay(elements) 调用");
});

test("loadeddata 补播同样受开关保护", () => {
  assert.match(source, /addEventListener\("loadeddata", \(\) => \{ if \(userStartedPlayback\) void autoplay\(ui\); \}\)/u,
    "loadeddata 补播必须受开关保护");
});

test("用户主动操作的入口都登记了主动标记", () => {
  for (const entry of ["ui.replay", "ui.nextSegment", "ui.skip", "ui.previous"]) {
    const pattern = new RegExp(`${entry.replace(/\./gu, "\\.")}[\\s\\S]{0,120}?markUserStartedPlayback`, "u");
    assert.match(source, pattern, `${entry} 未登记主动标记`);
  }
  assert.match(source, /event\.key === " " && !inNameInput\) \{[\s\S]{0,120}?markUserStartedPlayback/u,
    "空格键未登记主动标记");
  assert.match(source, /addEventListener\("pointerdown", markUserStartedPlayback\)/u,
    "播放器自带的播放键未登记主动标记");
});

test("首次进入的提示不说「正在播放」", () => {
  assert.match(source, /已载入「\$\{song\.folder\}」第 \$\{state\.segment \+ 1\} 段/u,
    "首次进入应有「已载入…」这类不暗示正在播放的提示");
  assert.match(source, /setStatus\(userStartedPlayback/u, "提示文案应区分是否已主动开始");
});
