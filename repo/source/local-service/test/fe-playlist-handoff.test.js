import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const patch = await readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8");
// ⚠️ $xxx = '...' 的赋值**可能跨越很多行**（续播注入就是这么写的：一个 3KB 的字符串）。
// 早先这里用「单行、以引号结尾」的正则提取，补丁脚本改写后它再也匹配不到，
// 于是整个文件在加载期就抛 TypeError —— 「续播 / 播单交接」这块长期没有测试保护，
// 真实后果之一：注入里写死的端口（27149）一直没被发现。
const statementOf = name => {
  const lines = patch.split(/\r?\n/u);
  const startAt = lines.findIndex(line => line.startsWith(`$${name} = '`));
  assert.ok(startAt >= 0, `补丁脚本里找不到 $${name} 的赋值`);
  let text = "";
  for (let index = startAt; index < lines.length; index += 1) {
    text += (text ? "\n" : "") + lines[index];
    // PowerShell 单引号字符串里 '' 是转义，按个数计数仍是偶数 —— 成对即表示字符串已闭合。
    if (((text.match(/'/gu) ?? []).length % 2) === 0) break;
  }
  return text;
};
const replacement = name => {
  const statement = statementOf(name);
  return statement.slice(statement.indexOf("'") + 1, statement.lastIndexOf("'"))
    .replaceAll("' + $playerCommandUrl + '", "http://test/command")
    .replaceAll("' + $playerStateUrl + '", "http://test/state");
};
const store = replacement("playerStateStoreTo");
// 注意：不能假设 finish 与 applyLocalPlayerState 相邻 —— 注入的函数会被后续版本插在中间
  // （g27 就插入了 OliviaSoulApplyResumePoint）。这里以「}, 紧跟另一个注入函数名或 Ge=」作为边界。
  const finish = store.match(/OliviaSoulFinishLocalPlayback=(async B=>[\s\S]*?\}),(?=OliviaSoul|Ge=)/u)[1];
const apply = store.match(/OliviaSoulApplyPlayerState=(B=>[\s\S]*?\}),(?=OliviaSoul|Ge=)/u)[1];

function fixture({ mode = "list", source = "playlist" } = {}) {
  const window = { __OliviaSoulSessionEpoch: 1, __OliviaSoulSongId: "upload", __OliviaSoulSessionId: "session" };
  const d = { value: 244 }, m = { value: true };
  const native = [], advances = [], requests = [], endReasons = [], microtasks = [];
  const context = vm.createContext({
    window, d, m, h: { value: source }, p: { value: mode }, ot: { Single: "single" },
    u: { value: { itemId: "upload" } }, f: { value: null },
    a: () => true,
    // 背景音让位（v57 起）会被 Begin/Finish 调用；这里给个 stub，
    // 否则 vm 里会抛 ReferenceError 把整组用例带崩。
    OliviaSoulDuckAmbience: () => {},
    M() { advances.push({ kind: "repeat", position: d.value }); m.value = true; },
    U() { advances.push({ kind: "next", position: d.value }); m.value = true; },
    G() { d.value = 0; m.value = false; },
    w(reason) { endReasons.push(reason); },
    queueMicrotask(fn) { microtasks.push(fn); },
    We: async ({ data }) => { native.push(data); },
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ code: 0 }) }; },
  });
  vm.runInContext(replacement("directControlTo"), context);
  context.OliviaSoulFinishLocalPlayback = vm.runInContext(`(${finish})`, context);
  context.apply = vm.runInContext(`(${apply})`, context);
  const ended = { songId: "upload", sessionId: "session", playbackState: "ended" };
  return { context, window, d, m, native, advances, requests, endReasons,
    finish: () => context.OliviaSoulFinishLocalPlayback(ended),
    apply: () => context.apply(ended),
    flush() { while (microtasks.length) microtasks.shift()(); },
  };
}

test("local end clears the old 244-second position before advancing to a shorter official song", async () => {
  const player = fixture();
  await player.finish();
  assert.deepEqual(player.advances, [{ kind: "next", position: 0 }]);
  assert.equal(player.requests[0].restoreDefault, false);
  assert.equal(player.m.value, true);
});

test("single repeat also starts at zero, while direct non-playlist playback stops", async () => {
  const single = fixture({ mode: "single" });
  await single.finish();
  assert.deepEqual(single.advances, [{ kind: "repeat", position: 0 }]);
  const direct = fixture({ source: "songlist" });
  await direct.finish();
  assert.deepEqual(direct.advances, []);
  assert.equal(direct.requests[0].restoreDefault, true);
  assert.equal(direct.m.value, false);
});

test("programmatic slider feedback is suppressed even after the local identity is cleared", async () => {
  const player = fixture();
  player.window.__OliviaSoulSongId = null;
  player.window.__OliviaSoulApplyingProgress = true;
  await player.context.Ct({ cmd: "timeupdate", position: 123 });
  assert.deepEqual(player.native, []);
  player.window.__OliviaSoulApplyingProgress = false;
  await player.context.Ct({ cmd: "timeupdate", position: 40 });
  assert.equal(player.native[0].position, 40, "real user seeking remains available");
});

test("duplicate ended snapshots produce one completion and one playlist advance", async () => {
  const player = fixture();
  player.apply();
  player.apply();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(player.endReasons, ["natural_end"]);
  assert.equal(player.requests.length, 1);
  assert.equal(player.advances.length, 1);
});

// 边界不能靠「下一个函数名」定位：注入函数会被后续版本插在中间
// （v57 就把 OliviaSoulDuckAmbience 插在了它和 OliviaSoulSongIdFromItem 之间）。
// 这里锚定它自己的固定结尾 `},250))}`。
const ensurePoll = store.match(/OliviaSoulEnsurePlayerPoll=(\(\)=>\{[\s\S]*?\},250\)\)\})/u)[1];
function pollFixture() {
  let poll, timeout, lastSignal;
  const urls = [];
  const window = { __OliviaSoulSongId: "upload", __OliviaSoulSessionId: "session" };
  const context = vm.createContext({
    window, AbortController,
    setInterval(fn) { poll = fn; return 1; },
    setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {},
    fetch(url, options) {
      urls.push(url);
      // 只记住「带 signal 的那个」请求：轮询回调里还有一条不带 signal 的进度回写请求。
      if (options?.signal) lastSignal = options.signal;
      return new Promise((resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  vm.runInContext(`(${ensurePoll})()`, context);
  return { window, tick: () => poll(), expire: () => timeout(),
    count: () => urls.length, countBy: url => urls.filter(value => value === url).length,
    signal: () => lastSignal };
}

test("player status polling does not accumulate requests while the service stalls", async () => {
  const player = pollFixture();
  player.tick();
  for (let i = 0; i < 100; i++) player.tick();
  // 轮询回调里有**两条独立**的请求路径：
  //   ① 每 2 秒节流的「进度回写」fetch（占位符 __OLIVIA_PLAYER_STATE_URL__，不带 signal）
  //   ② 受 __OliviaSoulProgressPending 守卫的「播放器状态」fetch（带 signal）
  // 两条都必须节流。① 曾经只在 video 正在播放时才更新时间戳，于是没有 video 在播时
  // 每个 250ms 的 tick 都会发一次（101 次 tick → 101 个请求）；已改为进入分支即记时。
  assert.equal(player.countBy("http://test/state"), 1, "受守卫的请求在服务卡住时不得累积");
  assert.equal(player.countBy("__OLIVIA_PLAYER_STATE_URL__"), 1, "进度回写必须按 2 秒节流，不能每个 tick 都发");
});

test("no local playback means no local status polling", () => {
  const player = pollFixture();
  player.window.__OliviaSoulSongId = null;
  player.window.__OliviaSoulSessionId = null;
  player.tick();
  assert.equal(player.count(), 0);
});

test("a stalled request is aborted and a later poll can recover", async () => {
  const player = pollFixture();
  const pending = player.tick();
  assert.ok(player.signal(), "poll must have a cancellable timeout");
  player.expire();
  await pending;
  assert.equal(player.signal().aborted, true);
  const next = player.tick();
  assert.equal(player.countBy("http://test/state"), 2, "卡住的那次被中止后，后续轮询应能重新发起");
  player.expire();
  await next;
});
