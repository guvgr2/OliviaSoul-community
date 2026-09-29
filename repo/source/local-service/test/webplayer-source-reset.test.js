import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the production command branch. The browser media boundary is faked;
// this tests source-reset ordering, not WebView2 decoding or real playback.
const patch = await readFile(new URL("../../tools/patch-webplayer-local.ps1", import.meta.url), "utf8");
const playBranch = patch.match(/^\$playTo = '([^\r\n]*)'\r?$/mu)?.[1];
assert.ok(playBranch, "the patch must expose its play command replacement");

function playerFixture(withVideo = true) {
  const calls = [];
  const swapCalls = [];
  const state = {
    __OliviaSoulActivePlayerRevision: 1,
    __OliviaSoulActiveSongId: "previous-song",
    __OliviaSoulActiveSessionId: "previous-session",
    __OliviaSoulRememberDefaultPlayback(...args) { calls.push(["remember", ...args]); },
  };
  const video = {
    src: "https://media.example.test/official.mp4",
    currentSrc: "https://media.example.test/official.mp4",
    currentTime: 84,
    loop: true,
    pause() { calls.push(["pause", state.__OliviaSoulActiveSessionId]); },
    removeAttribute(name) {
      calls.push(["removeAttribute", name]);
      if (name === "src") this.src = "";
    },
    load() {
      calls.push(["load", this.src, state.__OliviaSoulActiveSessionId]);
      this.currentSrc = this.src;
      this.currentTime = 0;
    },
  };
  const context = vm.createContext({
    window: state,
    i: { value: withVideo ? video : null },
    le(url, options) { calls.push(["play", url, JSON.parse(JSON.stringify(options)), video.src, video.currentSrc]); },
    // 本地会话的切换由该注入函数负责（真实定义在 tools/webplayer-pause.js）；
    // 这里记录调用以验证接线，而不是在 vm 里重演它的异步内部流程。
    OliviaSoulSwapPlayback(url, options) { swapCalls.push([url, JSON.parse(JSON.stringify(options))]); },
  });
  return {
    calls, swapCalls, video, state,
    play(command) {
      context.e = { cmd: "play", ...command };
      vm.runInContext(`switch(e.cmd){${playBranch}}`, context);
    },
  };
}

const localCommand = {
  url: "http://127.0.0.1:27149/toy/midi/songs/upload/video?playSession=new-session",
  songId: "uploaded-song", sessionId: "new-session", __oliviaRevision: 2,
  mute: false, offset: 0,
};

  test("switching official media to a local session hands the source to the swap path", () => {
    const player = playerFixture();
    player.play(localCommand);
    // 先记住原官方播放位置（供「恢复默认画面」使用）
    assert.deepEqual(player.calls, [["remember", "https://media.example.test/official.mp4", 84, true]]);
    // 本地会话必须交给 OliviaSoulSwapPlayback，绝不能走 native le()
    assert.deepEqual(player.swapCalls, [[localCommand.url, { loop: false, mute: false, offset: 0 }]]);
    // 会话所有权被建立
    assert.equal(player.state.__OliviaSoulActivePlayerRevision, 2);
    assert.equal(player.state.__OliviaSoulActiveSongId, "uploaded-song");
    assert.equal(player.state.__OliviaSoulActiveSessionId, "new-session");
  });

  test("a replayed local session also goes through the swap path", () => {
    const player = playerFixture();
    player.video.src = player.video.currentSrc = "http://127.0.0.1:27149/toy/midi/songs/upload/video?playSession=old-session";
    player.play(localCommand);
    assert.deepEqual(player.swapCalls, [[localCommand.url, { loop: false, mute: false, offset: 0 }]]);
    assert.equal(player.state.__OliviaSoulActiveSessionId, "new-session");
  });

test("official and default wallpaper commands keep the native switching path", () => {
  const player = playerFixture();
  player.play({ url: "https://media.example.test/assets/wallpaper_presence/default.mp4", loop: true, offset: 12 });
  assert.deepEqual(player.calls, [
    ["remember", "https://media.example.test/assets/wallpaper_presence/default.mp4", 12, true],
    ["play", "https://media.example.test/assets/wallpaper_presence/default.mp4", { loop: true, offset: 12 },
      "https://media.example.test/official.mp4", "https://media.example.test/official.mp4"],
  ]);
  assert.equal(player.state.__OliviaSoulActiveSessionId, null);
});

  test("a local command without a mounted video is still accepted and claims the session", () => {
    const player = playerFixture(false);
    assert.doesNotThrow(() => player.play(localCommand));
    // 没有挂载视频时不应回落到 native 路径，但仍要建立会话所有权
    assert.deepEqual(player.calls, []);
    assert.equal(player.swapCalls.length, 1);
    assert.equal(player.state.__OliviaSoulActiveSessionId, "new-session");
  });
