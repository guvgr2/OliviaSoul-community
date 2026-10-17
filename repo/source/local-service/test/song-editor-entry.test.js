import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const [app, patch, editor] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/patch-feapp-local.ps1", import.meta.url), "utf8"),
  readFile(new URL("../public/song-editor.js", import.meta.url), "utf8"),
]);

test("admin row opens the same stable work ID and applies save to cached records", () => {
  const entry = app.match(/function openMidiSongEditor\(songId\) \{[\s\S]*?\n\}/u)?.[0] || "";
  const rows = [{ id: "work-1", name: "Old" }, { id: "other", name: "Old" }]; let opened, rendered;
  const window = { document: {} };
  const context = vm.createContext({ window, midiStatusSnapshot: { songs: rows }, renderMidiStatus(data) { rendered = data; } });
  vm.runInContext(editor, context); window.OliviaSoulSongEditor.open = options => { opened = options; };
  vm.runInContext(entry, context);
  assert.equal(typeof context.openMidiSongEditor, "function");
  context.openMidiSongEditor("work-1");
  assert.equal(opened.songId, "work-1"); assert.equal(opened.baseUrl, "/admin/api");
  opened.onSaved({ id: "work-1", name: "New" });
  assert.equal(rows[0].name, "New"); assert.equal(rows[1].name, "Old"); assert.equal(rendered.songs, rows);
});

test("game editor rejects official rows and uses decoded local stable IDs without play commands", () => {
  const entry = patchVariable(patch, 'songEditorBridge');
  assert.ok(entry.length > 100, `$songEditorBridge 应抓到完整串值，实际 ${entry.length} 字符`);
  const opened = [], window = {};
  // ⚠️ `$songEditorBridge` 的第一行是 IIFE：往 document.head 里插 4 个 <script> 拉游戏端页面脚本。
  // 假 window 只有 `{ document: {} }`，而 vm context 的全局里**根本没有 `document`** 这个绑定
  // （`window.document` 不等于全局 `document`）⇒ 直接 runInContext 会
  // ReferenceError: document is not defined。修法：把 document stub 同时挂到
  // **context 顶层**与 window 上，只够让 IIFE 跑完，不影响后面 OliviaSoulEditSong 的断言。
  const documentStub = {
    visibilityState: 'visible',
    createElement: () => ({ set charset(v) {}, set src(v) {} }),
    head: { appendChild() {} },
    addEventListener() {},
    querySelectorAll: () => [],
  };
  const context = vm.createContext({ window, document: documentStub });
  window.document = documentStub;
  vm.runInContext(editor, context);
  window.OliviaSoulSongEditor.open = options => opened.push(options);
  vm.runInContext(entry.replaceAll("__OLIVIA_SONG_EDITOR_BASE__", "http://fixture.test/toy"), context);
  assert.equal(typeof context.OliviaSoulEditSong, "function");
  context.OliviaSoulEditSong({ id: "official", videoUrl: "https://media.test/official.mp4" });
  context.OliviaSoulEditSong({ id: "playlist-entry", videoUrl: "http://fixture.test/toy/midi/songs/work%2F42/video" });
  assert.equal(opened.length, 1); assert.equal(opened[0].songId, "work/42"); assert.equal(opened[0].baseUrl, "http://fixture.test/toy");
});

test("game current and playlist titles update by ID without touching playing state", () => {
  const sync = patchVariable(patch, 'songTitleSync');
  assert.ok(sync.length > 500, `$songTitleSync 应抓到完整串值，实际 ${sync.length} 字符`);
  const current = { id: "work", videoUrl: "/toy/midi/songs/work/video", name: "Old" };
  const playlist = [{ itemId: "entry", videoUrl: "/toy/midi/songs/work/video", name: "Old" }, { itemId: "other", name: "Old" }];
  // ⚠️ 同上：vm context 顶层没有 `document` 绑定（`$songTitleSync` 末尾读 `document.visibilityState`
  // 与 `document.addEventListener`），必须把 stub 挂到 context 顶层，而不是只挂 window。
  const documentStub = { visibilityState: 'visible', addEventListener() {} };
  const window = { document: documentStub, addEventListener() {}, __OliviaSoulSessionId: "session", __OliviaSoulSessionEpoch: 8 };
  const context = vm.createContext({ window, document: documentStub, x: { value: playlist }, u: { value: null }, f: { value: current }, setInterval() {}, fetch() { throw new Error("no playback or fetch during rename"); } });
  vm.runInContext(editor, context); vm.runInContext(sync.replaceAll("__OLIVIA_SONG_EDITOR_BASE__", "http://fixture.test/toy"), context);
  assert.equal(typeof context.OliviaSoulApplySongMetadata, "function"); context.OliviaSoulApplySongMetadata({ id: "work", name: "New" });
  assert.equal(current.name, "New"); assert.equal(playlist[0].name, "New"); assert.equal(playlist[1].name, "Old");
  assert.equal(window.__OliviaSoulSessionId, "session"); assert.equal(window.__OliviaSoulSessionEpoch, 8);
});

test("game upload and playlist caches receive editor saves in place", () => {
  const sync = patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1] || "";
  const song = { id: "work", name: "Old" }, item = { itemId: "entry", videoUrl: "/toy/midi/songs/work/video", name: "Old" };
  const window = { document: {} }; let metadata;
  const context = vm.createContext({ window, he: { value: [song] }, K: { value: [item] }, h: { applySongMetadata(value) { metadata = value; } } });
  vm.runInContext(editor, context); vm.runInContext(sync, context);
  assert.equal(typeof context.OliviaSoulUploadMetadata, "function");
  context.OliviaSoulUploadMetadata({ detail: { id: "work", name: "New" } });
  assert.equal(song.name, "New"); assert.equal(item.name, "New"); assert.equal(metadata.id, "work");
});

// ⚠️ 真源里同一名字有两种字面量形态，抽取函数必须都认识（2026-10-17 S3 实测）：
//  ① 单引号串 `$name = '...'`，且值**可能跨行**（`$playerStateStoreTo` 在 `patch-feapp-local.ps1:408-409`，
//     408 行末尾是 `setInterval(async()=>{` 的未闭合花括号，409 行才以 `'` 收尾）。
//     测试原来用 `^\$name = '([^\r\n]*)'\r?$` 单行正则 ⇒ 永远匹配不上 ⇒ 空串 ⇒ 下游断言红。
//     这是「测试 fixture 跟不上真源」的活例：真源在 2026-10-12 把进度轮询展开成多行，测试没跟着改。
//  ② here-string `$name = @'` … `'@`（`$songEditorBridge` `:52-62`、`$songTitleSync` `:115-173`），
//     行尾可能是 CRLF 且内容里合法出现 `'` —— 所以必须以「单独一行且 TrimEnd 后等于 `'@`」收尾。
// 找不到 ⇒ 返回空串；调用方一律 `assert.ok(v.length > N)` 防空转（宁可真红，不要静默空跑）。
function patchVariable(text, name) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '');
    const here = line.startsWith(`$${name} = @'`);
    if (!here && !line.startsWith(`$${name} = '`)) continue;
    if (here) {
      let j = i + 1;
      while (j < lines.length && lines[j].replace(/\r$/, '') !== "'@") j++;
      if (j >= lines.length) return '';
      return lines.slice(i + 1, j).join('\n');
    }
    let buf = lines[i];
    let j = i;
    while ((buf.match(/'/g) || []).length % 2 !== 0 && j + 1 < lines.length) { j++; buf += '\n' + lines[j]; }
    return buf.replace(new RegExp(`^\\$${name} = '`), '').replace(/'\r?$/, '');
  }
  return '';
}

test("current session duration updates both songlist and playlist display without changing identity", () => {
  const store = patchVariable(patch, 'playerStateStoreTo');
  assert.ok(store.length > 1000, `$playerStateStoreTo 应抓到完整串值，实际 ${store.length} 字符`);
  const apply = store.match(/OliviaSoulApplyPlayerState=(B=>[\s\S]*?\}),(?=OliviaSoul|Ge=)/u)?.[1];
  assert.ok(apply);
  const current = { id: "work", duration: 1, videoDuration: 1 }, songlist = { id: "work", duration: 1, videoDuration: 1 };
  const window = { document: {}, __OliviaSoulSongId: "work", __OliviaSoulSessionId: "session" };
  const context = vm.createContext({ window, u: { value: current }, f: { value: songlist }, d: { value: 5 }, m: { value: true } });
  vm.runInContext(editor, context);
  context.apply = vm.runInContext(`(${apply})`, context);
  context.apply({ songId: "work", sessionId: "old", playbackState: "playing", duration: 99, currentTime: 5 });
  assert.equal(current.duration, 1);
  context.apply({ songId: "work", sessionId: "session", playbackState: "playing", duration: 367.5, currentTime: 5 });
  assert.equal(current.duration, 367.5); assert.equal(current.videoDuration, 367.5); assert.equal(songlist.duration, 367.5);
  assert.equal(current.id, "work"); assert.equal(window.__OliviaSoulSessionId, "session");
});

test("current playlist duration cannot overwrite a stale songlist object from another work", () => {
  const store = patchVariable(patch, 'playerStateStoreTo');
  assert.ok(store.length > 1000, `$playerStateStoreTo 应抓到完整串值，实际 ${store.length} 字符`);
  const apply = store.match(/OliviaSoulApplyPlayerState=(B=>[\s\S]*?\}),(?=OliviaSoul|Ge=)/u)?.[1];
  assert.ok(apply);
  const current = { itemId: "playlist-entry", videoUrl: "/toy/midi/songs/work-A/video", duration: 1, videoDuration: 1 };
  const staleSonglist = { id: "work-B", videoUrl: "/toy/midi/songs/work-B/video", duration: 90, videoDuration: 90 };
  const window = { document: {}, __OliviaSoulSongId: "work-A", __OliviaSoulSessionId: "session-A" };
  const context = vm.createContext({ window, u: { value: current }, f: { value: staleSonglist }, d: { value: 5 }, m: { value: true } });
  vm.runInContext(editor, context);
  const handler = vm.runInContext(`(${apply})`, context);
  handler({ songId: "work-A", sessionId: "session-A", playbackState: "playing", duration: 367.5, currentTime: 5 });
  assert.equal(current.duration, 367.5); assert.equal(current.videoDuration, 367.5);
  assert.equal(staleSonglist.duration, 90); assert.equal(staleSonglist.videoDuration, 90);
  assert.equal(current.itemId, "playlist-entry"); assert.equal(window.__OliviaSoulSessionId, "session-A");
});
