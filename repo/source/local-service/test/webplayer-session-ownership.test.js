import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-webplayer-local.ps1", import.meta.url), "utf8");
const commandUrl = "http://127.0.0.1:27149/toy/player-command";
const stateUrl = "http://127.0.0.1:27149/toy/player-state";
function replacement(name) {
  const line = patch.match(new RegExp(`^\\$${name} = '([^\\r\\n]*)'\\r?$`, "mu"))?.[1];
  assert.ok(line, `missing ${name} production replacement`);
  return line.replaceAll("' + $playerCommandUrl + '", commandUrl)
    .replaceAll("' + $playerStateUrl + '", stateUrl);
}
const nativeControl = (patch.match(/\$nativeControl = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] ?? "")
  .replaceAll("__OLIVIA_PLAYER_STATE_URL__", stateUrl);
// 时段改写辅助函数（真实定义在 tools/webplayer-pause.js，与补丁注入的函数同作用域）。
// 这里取真实实现，才能验证「恢复默认画面时按当前时段换段」这条链路。
const pauseSource = await readFile(new URL("../../tools/webplayer-pause.js", import.meta.url), "utf8");
const wallpaperHelpers = pauseSource.slice(
  pauseSource.indexOf("const OliviaSoulWallpaperSlots"),
  pauseSource.indexOf("function OliviaSoulSwapPlayback"));
const wallpaper = "https://olivia.local/assets/Wallpaper_Presence/A_R1_1730.mp4";
// 快照里记下的旧时段壁纸（例如中午挂载时记的白天档）。恢复时必须按当前时段改写成 wallpaper。
const dayWallpaper = "https://olivia.local/assets/Wallpaper_Presence/A_R1_1200.mp4";
const localUrl = "http://127.0.0.1:27149/toy/midi/songs/local-song/video.mp4?playSession=local-session";

// Run the actual mounted subscription, command branches and progress handler.
// The fake media loader models only resource selection, not browser decoding.
function fixture() {
  let nativeHandler;
  let poll;
  let serviceCommand = { revision: 0, command: null };
  // 服务端 /toy/player-command 现在会下发当前时段（server.js 的 playbackTimeOfDay 调用）。
  // 恢复默认画面时要按它改写壁纸段，而不是照抄快照里的旧段。
  let timeOfDay = "TOD1730";
  let feCalls = 0;
  let serviceState = {};
  let fetchFailure = false;
  let pendingStateResponse;
  let pendingCommandResponse;
  let intervalDelay;
  let now = 0;
  let commandFetches = 0;
  let consumedBodies = 0;
  const progress = [];
  const nativeEvents = [];
  const swapCalls = [];
  const timeouts = new Map();
  let timerId = 0;
  const video = {
    src: wallpaper, currentSrc: wallpaper, currentTime: 0, duration: 360.566667,
    loop: true, paused: false, style: {},
    pause() { this.paused = true; },
    play() { this.paused = false; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
    load() { this.currentSrc = this.src; this.currentTime = 0; },
  };
  const state = {};
  const context = vm.createContext({
    window: state, console: { log() {}, info() {}, warn() {} }, AbortController,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    queueMicrotask,
    Date: { now: () => now },
    sessionStorage: { getItem: () => null, setItem() {} },
    i: { value: video }, l: { value: [video] }, a: { value: video.duration },
    f: null, y: null,
    ke(fn) { fn(); }, qe(fn) { nativeHandler = fn; return () => {}; }, Je() { return () => {}; }, me() {}, R() {},
    setInterval(fn, delay) { poll = fn; intervalDelay = delay; return 1; }, clearInterval() {},
    setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    async fetch(url, options) {
      if (fetchFailure) throw new Error("service offline");
      if (options?.method === "POST") {
        const body = JSON.parse(options.body);
        progress.push(body);
        return { ok: true, json: async () => ({ code: 0, data: {} }), arrayBuffer: async () => { consumedBodies += 1; return new ArrayBuffer(0); } };
      }
      if (url === commandUrl) {
        commandFetches += 1;
        if (pendingCommandResponse) return pendingCommandResponse;
      }
      if (url === stateUrl && pendingStateResponse) return pendingStateResponse;
      return { ok: true, json: async () => ({ code: 0, data: url === commandUrl ? { ...serviceCommand, timeOfDay } : serviceState }) };
    },
    le(url, options) {
      video.src = video.currentSrc = url;
      video.currentTime = options.offset ?? 0;
      video.loop = options.loop;
      video.play();
    },
    fe() { feCalls += 1; video.pause(); }, ae() {}, ce() { video.play(); }, K(offset) { video.currentTime = offset; },
    // 补丁注入的另外三个函数（真实定义在 tools/webplayer-pause.js）。
    // 测试关心的是「会话所有权」，这里只提供受控实现并记录调用。
    OliviaSoulSwapPlayback(url, options) {
        swapCalls.push([url, JSON.parse(JSON.stringify(options ?? {}))]);
        // 真实实现是双缓冲切换（见 tools/webplayer-pause.js）；这里直接把新媒体挂到播放器上，
        // 让「会话所有权」相关的断言能观察到实际效果。
        if (video && url) { video.src = video.currentSrc = url; video.currentTime = Number(options?.offset) || 0; if (typeof options?.loop === "boolean") video.loop = options.loop; if (typeof options?.mute === "boolean") video.muted = options.mute; }
      },
    async OliviaSoulNativeLyricsCommand(command) { nativeEvents.push({ nativeLyrics: command }); },
    OliviaSoulReportPausedPlayback() {},
    Z(event) { nativeEvents.push(event); }, de() {}, ye() {}, ve(loop) { video.loop = loop; },
  });
  vm.runInContext(`${wallpaperHelpers}
    ${nativeControl}
    function pe(e){if(!e?.cmd)return;switch(e.cmd){${replacement("playTo")}${replacement("stopTo")}${replacement("preloadTo")}
      case "seek":K(e.offset);break;case "resume":ce();break;case "setLoop":ve(e.loop);break;}}
    ${replacement("timeUpdateTo")}
    ${replacement("endedTo")}
    ${replacement("mountedTo")}`, context);
  // interval 回调只负责「触发」；真正的轮询是 async 的 __OliviaSoulPlayerPollNow。
  // 必须 await 它才能等到这一轮请求处理完，否则断言会跑在轮询之前。
  async function runPoll() {
    if (typeof state.__OliviaSoulPlayerPollNow === "function") { await state.__OliviaSoulPlayerPollNow(); return; }
    await runPoll();
  }
  return {
    video, state, progress, nativeEvents, swapCalls,
    native(command) { return nativeHandler(command); },
    direct(command) { context.pe(command); },
    async start() {
      await runPoll();
      serviceCommand = { revision: 1, command: { cmd: "play", url: localUrl, songId: "local-song", sessionId: "local-session" } };
      serviceState = { revision: 1, commandRevision: 1, sessionId: "local-session", songId: "local-song", name: "Example song",
        playbackState: "playing", event: "play", currentTime: 0, duration: 360.566667, mediaUrl: localUrl };
      await runPoll();
      assert.equal(state.__OliviaSoulActiveSessionId, "local-session", "fixture must start real local playback before injecting late commands");
      assert.equal(video.currentSrc, localUrl);
    },
    async command(command, revision = 2) { serviceCommand = { revision, command }; await runPoll(); },
    setState(next) { serviceState = next; },
    setTimeOfDay(next) { timeOfDay = next; },
    feCalls: () => feCalls,
    offline() { fetchFailure = true; },
    holdState() {
      let resolve;
      pendingStateResponse = new Promise(done => { resolve = done; });
      return data => resolve({ ok: true, json: async () => ({ code: 0, data }) });
    },
    holdCommand() {
      let resolve;
      pendingCommandResponse = new Promise(done => { resolve = done; });
      return data => { pendingCommandResponse = null; resolve({ ok: true, json: async () => ({ code: 0, data }) }); };
    },
    poll: () => poll(),
    intervalDelay: () => intervalDelay,
    commandFetches: () => commandFetches,
    consumedBodies: () => consumedBodies,
    async burstTimeUpdates(count) {
      for (let index = 0; index < count; index += 1) await context.z({ target: video });
    },
    async end() { await context.q({ target: video }); },
    async advance(seconds) {
      now += seconds * 1000;
      if (!video.paused) video.currentTime += seconds;
      await context.z({ target: video });
    },
  };
}

test("player polling is three-seconds and does not overlap", async () => {
  const player = fixture();
  assert.equal(player.intervalDelay(), 3000);
  const respond = player.holdCommand();
  const first = player.poll();
  await Promise.resolve();
  const second = player.poll();
  assert.equal(player.commandFetches(), 1);
  respond({ revision: 0, command: null });
  await Promise.all([first, second]);
});

test("progress is throttled, response bodies are consumed, and ended is immediate", async () => {
  const player = fixture();
  await player.start();
  await player.advance(1);
  await player.burstTimeUpdates(8);
  assert.equal(player.progress.filter(event => event.event === "timeupdate").length, 1);
  assert.equal(player.consumedBodies(), 1);
  await player.end();
  assert.equal(player.progress.at(-1).event, "ended");
  assert.equal(player.consumedBodies(), 2);
});

for (const command of [{ cmd: "pause" }, { cmd: "stop" }, { cmd: "play", url: wallpaper, loop: true }]) {
  test(`late native ${command.cmd}${command.url ? " wallpaper" : ""} cannot replace a playing local session`, async () => {
    const player = fixture();
    await player.start();
    await player.advance(2.612582);
    await player.native(command);
    await player.advance(5);
    assert.equal(player.video.currentSrc, localUrl);
    assert.equal(player.video.paused, false);
    assert.equal(player.state.__OliviaSoulActiveSessionId, "local-session");
    assert.equal(player.progress.at(-1).sessionId, "local-session");
    assert.equal(player.progress.at(-1).currentTime, 7.612582);
  });
}

test("current-session service stop returns to the current time-of-day wallpaper, not the stale snapshot", async () => {
  const player = fixture();
  await player.start();
  // 快照里记的是中午挂载时的白天档；停止时服务端报的当前时段已经是傍晚。
  await player.native({ cmd: "play", url: dayWallpaper, offset: 8, loop: true });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session", restoreDefault: true });
  assert.equal(player.video.currentSrc, wallpaper);
  assert.equal(player.video.currentTime, 0, "crossing the time-of-day boundary must reset the offset");
  assert.deepEqual(player.swapCalls.at(-1), [wallpaper, { loop: true, offset: 0 }]);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("service stop without a reported time of day falls back to the official restore", async () => {
  const player = fixture();
  await player.start();
  // 服务端没报时段（或报了未知值）时不得猜一个段，交回官方 stop 路径。
  player.setTimeOfDay(undefined);
  delete player.state.__OliviaSoulCurrentTod;
  await player.native({ cmd: "play", url: dayWallpaper, offset: 8, loop: true });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session", restoreDefault: true });
  assert.equal(player.swapCalls.some(([url]) => url.includes("wallpaper_presence")), false,
    "an unknown time of day must not replay a guessed slot");
  assert.ok(player.feCalls() > 0, "an unknown time of day must hand back to the official stop path");
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("a native official song takes over and a delayed local stop cannot stop it", async () => {
  const player = fixture();
  await player.start();
  await player.native({ cmd: "play", url: "https://media.example.test/official.mp4", loop: false });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session", restoreDefault: false });
  assert.equal(player.video.currentSrc, "https://media.example.test/official.mp4");
  assert.equal(player.video.paused, false);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
  assert.equal(player.state.__OliviaSoulActivePlayerRevision, null);
});

test("a delayed command from a former local session cannot alter the new session revision", async () => {
  const player = fixture();
  await player.start();
  player.direct({ cmd: "play", url: `${localUrl}-new`, songId: "next-song", sessionId: "next-session", __oliviaRevision: 3 });
  await player.command({ cmd: "stop", songId: "local-song", sessionId: "local-session" }, 2);
  assert.equal(player.state.__OliviaSoulActiveSessionId, "next-session");
  assert.equal(player.state.__OliviaSoulActivePlayerRevision, 3);
  assert.equal(player.video.paused, false);
});

test("a current-session service seek is applied and continues reporting its revision", async () => {
  const player = fixture();
  await player.start();
  await player.command({ cmd: "seek", songId: "local-song", sessionId: "local-session", offset: 80 });
  await player.advance(1);
  assert.equal(player.progress.at(-1).currentTime, 81);
  assert.equal(player.progress.at(-1).commandRevision, 2);
});

test("native stop remains available when no local session owns playback", async () => {
  const player = fixture();
  await player.native({ cmd: "play", url: "https://media.example.test/official.mp4" });
  await player.native({ cmd: "stop" });
  assert.ok(player.feCalls() > 0, "the official stop path must still run when no time of day was ever reported");
  assert.equal(player.swapCalls.some(([url]) => url.includes("wallpaper_presence")), false,
    "an unknown time of day must not replay a guessed slot");
});

test("an unreachable service permits native emergency stop", async () => {
  const player = fixture();
  await player.start();
  player.offline();
  await player.native({ cmd: "stop" });
  assert.equal(player.video.currentSrc, wallpaper);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

test("a delayed native status check cannot stop a subsequent local session", async () => {
  const player = fixture();
  await player.start();
  const respond = player.holdState();
  const oldStop = player.native({ cmd: "stop" });
  player.direct({ cmd: "play", url: `${localUrl}-new`, songId: "next-song", sessionId: "next-session", __oliviaRevision: 3 });
  respond({ songId: "local-song", sessionId: "local-session", playbackState: "stopped" });
  await oldStop;
  assert.equal(player.state.__OliviaSoulActiveSessionId, "next-session");
  assert.equal(player.video.currentSrc, `${localUrl}-new`);
  assert.equal(player.video.paused, false);
});

for (const playbackState of ["ended", "stopped"]) {
  test(`native stop is accepted when its current service session is ${playbackState}`, async () => {
    const player = fixture();
    await player.start();
    player.setState({ songId: "local-song", sessionId: "local-session", playbackState });
    await player.native({ cmd: "stop" });
    assert.equal(player.video.currentSrc, wallpaper);
    assert.equal(player.state.__OliviaSoulActiveSessionId, null);
  });
}

test("a native stop cannot borrow the terminal state of another session", async () => {
  const player = fixture();
  await player.start();
  player.setState({ songId: "former-song", sessionId: "former-session", playbackState: "ended" });
  await player.native({ cmd: "stop" });
  assert.equal(player.video.currentSrc, localUrl);
  assert.equal(player.video.paused, false);
});

test("old native seek and loop commands do not change the local session", async () => {
  const player = fixture();
  await player.start();
  await player.advance(10);
  await player.native({ cmd: "seek", offset: 350 });
  await player.native({ cmd: "setLoop", loop: true });
  assert.equal(player.video.currentTime, 10);
  assert.equal(player.video.loop, false);
});

test("an empty native event keeps the original no-op behavior", async () => {
  const player = fixture();
  await player.start();
  await player.native(null);
  assert.equal(player.video.currentSrc, localUrl);
});
