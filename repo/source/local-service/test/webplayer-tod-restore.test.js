// 桌面壁纸时段不再更新的回归保护。
//
// 补丁里的 __OliviaSoulRestoreDefaultPlayback 以前无条件回放 sessionStorage 里的快照
// （`{url,offset,loop}`），快照是「挂载那一刻的壁纸」，于是停止播放后画面永远停在
// 启动时的时段：19 点还播白天、播过个人上传作品后「时间像静止了一样」。
// 修复后按服务端下发的 timeOfDay 把快照 URL 改写到当前时段，段号判断不了就交回官方 stop。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const here = new URL(".", import.meta.url);
const readTool = name => readFile(new URL(`../../tools/${name}`, here), "utf8");

async function loadHelperProbe() {
  const source = await readTool("webplayer-pause.js");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: "webplayer-pause.js" });
  return (url, timeOfDay) => vm.runInContext(
    `OliviaSoulCurrentTodUrl(${JSON.stringify(url)}, ${JSON.stringify(timeOfDay)})`, context);
}

// 从 $mountedTo 里把赋值表达式 `window.__OliviaSoulRestoreDefaultPlayback=()=>{…}` 整段抠出来。
// 单行 4.8K 的 PowerShell here-string 里没有别的手段定位函数结尾，只能数花括号。
function extractRestoreDefinition(patch) {
  const start = patch.indexOf("window.__OliviaSoulRestoreDefaultPlayback=");
  assert.ok(start >= 0, "补丁里找不到 __OliviaSoulRestoreDefaultPlayback");
  const open = patch.indexOf("{", patch.indexOf("()=>", start));
  assert.ok(open > start, "找不到恢复函数的函数体");
  let depth = 0;
  for (let index = open; index < patch.length; index += 1) {
    const char = patch[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return patch.slice(start, index + 1);
    }
  }
  throw new Error("恢复函数的花括号不配对");
}

// 只取「时段改写」这一小段（常量 + 辅助函数）。整份 webplayer-pause.js 里还声明了真的
// OliviaSoulSwapPlayback，它会盖掉测试桩，所以不能整份求值。
function extractHelperSource(pauseSource) {
  const start = pauseSource.indexOf("const OliviaSoulWallpaperSlots");
  const end = pauseSource.indexOf("function OliviaSoulSwapPlayback");
  assert.ok(start >= 0 && end > start, "找不到壁纸时段改写辅助函数");
  return pauseSource.slice(start, end);
}

function runRestore(definition, helperSource, { snapshot, timeOfDay }) {
  const calls = { swap: [], fe: 0, paused: 0 };
  const window = {};
  if (snapshot) window.__OliviaSoulDefaultPlayback = { url: snapshot, offset: 42, loop: true };
  if (timeOfDay) window.__OliviaSoulCurrentTod = timeOfDay;
  const context = vm.createContext({
    window,
    i: { value: { pause: () => { calls.paused += 1; } } },
    fe: () => { calls.fe += 1; },
    OliviaSoulSwapPlayback: (url, options) => { calls.swap.push({ url, options }); },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(helperSource, context, { filename: "webplayer-wallpaper-tod.js" });
  vm.runInContext(`(${definition})()`, context, { filename: "restore-default-playback.js" });
  return calls;
}

const WALL = "https://olivia.local/assets/Wallpaper_Presence/A_R1_";

test("时段改写：把快照里的旧时段换成当前时段", async () => {
  const call = await loadHelperProbe();
  assert.equal(call(`${WALL}1200.mp4`, "TOD1730"), `${WALL}1730.mp4`,
    "傍晚恢复默认画面必须换到 _1730 段，否则就是「到点不换画面」");
  assert.equal(call(`${WALL}1200.mp4`, "TOD20"), `${WALL}2000.mp4`);
  assert.equal(call(`${WALL}2000.mp4`, "TOD12"), `${WALL}1200.mp4`);
  assert.equal(call(`${WALL}1730.mp4`, "TOD1730"), `${WALL}1730.mp4`, "本来就是当前时段时应原样返回");
});

test("时段改写：判断不了就返回空串，交回官方 stop", async () => {
  const call = await loadHelperProbe();
  assert.equal(call(`${WALL}1200.mp4`, undefined), "");
  assert.equal(call(`${WALL}1200.mp4`, "TOD9999"), "");
  assert.equal(call("", "TOD1730"), "");
  assert.equal(call("https://olivia.local/toy/midi/songs/abc/video.mp4?variant=DEFAULT_3", "TOD20"), "",
    "演奏视频不是壁纸资产，不能改写");
  assert.equal(call(`${WALL.replace("A_R1_", "A_Transition_")}1200_1730.mp4`, "TOD1730"), "",
    "过场片段语义是「上一时段→下一时段」，改写会指到不存在的文件");
});

test("时段改写：查询串保持原样", async () => {
  const call = await loadHelperProbe();
  assert.equal(call(`${WALL}1200.mp4?v=7`, "TOD20"), `${WALL}2000.mp4?v=7`);
});

test("补丁：恢复默认画面按服务端时段改写，且不再从旧 offset 续播", async () => {
  const patch = await readTool("patch-webplayer-local.ps1");
  assert.match(patch, /OliviaSoulPatch:webplayer-instant-seamless-v20/u);
  assert.match(patch, /if\(m&&m\.timeOfDay\)window\.__OliviaSoulCurrentTod=String\(m\.timeOfDay\)/u,
    "轮询响应里的 timeOfDay 必须缓存下来，否则恢复时无从判断当前时段");
  assert.match(patch,
    /const m=e&&e\.url\?OliviaSoulCurrentTodUrl\(e\.url,window\.__OliviaSoulCurrentTod\):"";m\?OliviaSoulSwapPlayback\(m,\{loop:!!e\.loop,offset:0\}\):fe\(\)/u,
    "恢复壁纸必须先改写时段，改不了就走官方 stop");
  assert.doesNotMatch(patch, /offset:Number\(e\.offset\)\|\|0/u,
    "恢复壁纸不得再沿用快照的旧播放位置（跨时段续播正是「时间静止」的观感来源）");
});

test("恢复默认画面：有当前时段就换段重播，拿不准才走官方 stop", async () => {
  const [patch, pauseSource] = await Promise.all([
    readTool("patch-webplayer-local.ps1"),
    readTool("webplayer-pause.js"),
  ]);
  const definition = extractRestoreDefinition(patch);
  const helperSource = extractHelperSource(pauseSource);

  const evening = runRestore(definition, helperSource, {
    snapshot: `${WALL}1200.mp4`, timeOfDay: "TOD1730",
  });
  assert.equal(evening.paused, 1, "先暂停当前视频");
  assert.equal(evening.fe, 0, "能改写时段时不得走官方 stop（官方 stop 之后没有东西重新上屏）");
  assert.deepEqual(JSON.parse(JSON.stringify(evening.swap)), [{
    url: `${WALL}1730.mp4`, options: { loop: true, offset: 0 },
  }]);

  const unknown = runRestore(definition, helperSource, { snapshot: `${WALL}1200.mp4` });
  assert.equal(unknown.swap.length, 0, "不知道当前时段时不得回放快照");
  assert.equal(unknown.fe, 1, "不知道当前时段时交回官方 stop");

  const song = runRestore(definition, helperSource, {
    snapshot: "https://olivia.local/toy/midi/songs/abc/video.mp4", timeOfDay: "TOD20",
  });
  assert.equal(song.swap.length, 0);
  assert.equal(song.fe, 1);
});

test("服务端：GET /toy/player-command 下发 timeOfDay", async () => {
  const server = await readFile(new URL("../server.js", here), "utf8");
  assert.match(server,
    /path === "\/toy\/player-command"[\s\S]{0,600}timeOfDay: playbackTimeOfDay\(options\.playbackNow\?\.\(\) \?\? new Date\(\)\)/u,
    "时段必须由服务端按 playback-clock.js 计算后下发，前端不另写一套边界");
});
