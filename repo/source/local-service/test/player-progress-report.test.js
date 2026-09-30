// g31：续播点必须能通过「前端上报进度」建立。
//
// 起因（真实缺陷）：服务端的 currentTime 只在 seek 时更新，而游戏 UI 的「暂停」发 stop
// 会把 currentTime 归零 → 记录条件 currentTime > 1 永不成立 → 暂停后无法续播。
// 旧测试 player-resume.test.js 直接用 seek 构造场景，所以完全测不到这个断点。
//
// 本测试专门锁定：**只有经过 progress 上报，暂停后才会有续播点**。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOliviaService } from "../server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "olivia-progress-"));
  const service = await createOliviaService({
    root, dataDir: join(root, "data"), appData: join(root, "app-data"),
    runtimeDir: join(root, "runtime"), officialMediaRoot: join(root, "media"),
    worker: false, runMemoryRefresh: false,
    playbackNow: () => new Date(2026, 8, 4, 21, 0),
    midiDurationProbe: async () => 218_000_000,
    fetch: async () => { throw new Error("External requests are forbidden in progress tests"); },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

  const address = await service.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const json = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  };
  const state = async () => (await json("/toy/player-state")).data;
  const makeSong = async (id, name) => {
    const file = join(service.midiStore.root, "outputs", `${id}.mp4`);
    await mkdir(join(service.midiStore.root, "outputs"), { recursive: true });
    await writeFile(file, `VIDEO ${id}`);
    return service.midiStore.upsertUserSong({
      id, name, sourceKind: "official-import",
      videoPath: file, videoByTodView: { DEFAULT: file }, durationUs: 218_000_000,
    });
  };
  const play = song => json("/toy/player-command", {
    cmd: "play", songId: song.id, name: song.name,
    url: `${base}/toy/midi/songs/${encodeURIComponent(song.id)}/video.mp4`,
  });
  const progress = (song, sessionId, currentTime) => json("/toy/player-command", {
    cmd: "progress", songId: song.id, sessionId, currentTime,
  });
  const stop = (song, sessionId) => json("/toy/player-command", {
    cmd: "stop", songId: song.id, sessionId,
  });
  return { json, state, makeSong, play, progress, stop };
}

test("上报进度后暂停，同一首歌再次播放应从该位置继续", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("song-a", "A 曲");
  await ctx.play(song);
  const sessionId = (await ctx.state()).sessionId;

  // 播放到 42 秒：只有经过 progress 上报，服务端才知道这个位置
  await ctx.progress(song, sessionId, 42);
  assert.equal((await ctx.state()).currentTime, 42, "progress 应更新服务端位置");

  // 游戏 UI 的暂停 = stop
  await ctx.stop(song, sessionId);
  assert.equal((await ctx.state()).playbackState, "stopped");

  // 再次播放同一首歌 → 应带续播点
  await ctx.play(song);
  assert.equal((await ctx.state()).resumeAt, 42, "暂停后重播应下发上次位置");
});

test("progress 不改变播放状态，也不推进 revision", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("song-b", "B 曲");
  await ctx.play(song);
  const before = await ctx.state();
  await ctx.progress(song, before.sessionId, 30);
  const after = await ctx.state();
  assert.equal(after.playbackState, before.playbackState, "progress 不应改变播放状态");
  assert.equal(after.revision, before.revision, "progress 不应推进 revision（避免每几秒触发一轮同步）");
  assert.equal(after.currentTime, 30, "但位置要更新");
});

test("没有 progress 上报时，暂停不会产生续播点（锁定真实缺陷）", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("song-c", "C 曲");
  await ctx.play(song);
  const sessionId = (await ctx.state()).sessionId;
  // 故意不上报进度，直接暂停 —— 这正是修复前的行为
  await ctx.stop(song, sessionId);
  await ctx.play(song);
  assert.equal((await ctx.state()).resumeAt, 0, "没有进度上报就不该有续播点");
});

test("别的会话上报的进度会被忽略", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("song-d", "D 曲");
  await ctx.play(song);
  await ctx.progress(song, "not-the-current-session", 99);
  assert.equal((await ctx.state()).currentTime, 0, "会话不匹配的 progress 必须被忽略");
});

test("负数或非法进度会被忽略", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("song-e", "E 曲");
  await ctx.play(song);
  const sessionId = (await ctx.state()).sessionId;
  await ctx.progress(song, sessionId, -5);
  assert.equal((await ctx.state()).currentTime, 0, "负数进度必须被忽略");
});
