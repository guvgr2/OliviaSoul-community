// g27：本地播放续播点（暂停后继续，从上次位置接着播）
//
// 背景：游戏 UI 的「暂停」实际发送 stop（游戏原生 JS 里没有 pause/resume），
// 会话被销毁、进度丢失，于是「继续」只能从头。服务端现在在 stop 时记住位置，
// 同一首歌在 30 分钟窗口内再次 play 时下发 resumeAt。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOliviaService } from "../server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "olivia-resume-"));
  const service = await createOliviaService({
    root, dataDir: join(root, "data"), appData: join(root, "app-data"),
    runtimeDir: join(root, "runtime"), officialMediaRoot: join(root, "media"),
    worker: false, runMemoryRefresh: false,
    playbackNow: () => new Date(2026, 8, 4, 21, 0),
    midiDurationProbe: async () => 218_000_000,
    fetch: async () => { throw new Error("External requests are forbidden in resume tests"); },
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
  // 模拟前端 timeupdate 上报
  const report = async (snapshot, currentTime) => json("/toy/player-state", {
    songId: snapshot.songId, sessionId: snapshot.sessionId, mediaUrl: snapshot.mediaUrl,
    commandRevision: snapshot.commandRevision, event: "timeupdate",
    currentTime, duration: 218,
  });
  const stop = async () => {
    const snapshot = await state();
    return json("/toy/player-command", { cmd: "stop", songId: snapshot.songId, sessionId: snapshot.sessionId });
  };
  // 真实前端会持续上报 timeupdate（每秒多次），而服务端会拒绝 commandRevision 过期的上报。
  // 测试若只上报一次，就会偶发落在「服务端刚 bump 过 revision」的窗口里被拒 →
  // 断言偶发失败（门禁里真实出现过）。这里按真实行为上报：重试到服务端接受为止。
  const reportUntilApplied = async (seconds, attempts = 8) => {
    for (let i = 0; i < attempts; i += 1) {
      const snapshot = await state();
      await report(snapshot, seconds);
      const now = await state();
      if (Number(now.currentTime) === Number(seconds)) return now;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`进度上报始终未被服务端接受（目标 ${seconds} 秒）`);
  };
  // 「播到 N 秒后暂停」这一趟完整动作
  const playThenStopAt = async (song, seconds) => {
    await play(song);
    await reportUntilApplied(seconds);
    await stop();
    return state();
  };
  return { service, json, state, play, stop, makeSong, report, playThenStopAt, reportUntilApplied };
}

test("暂停后同一首歌再次播放：带上 resumeAt（从上次位置继续）", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("resume-a", "Resume A");

  const first = await ctx.play(song);
  assert.equal(first.code, 0);
  let snapshot = await ctx.state();
  assert.equal(snapshot.resumeAt, 0, "首次播放不应带续播点");
  assert.equal(snapshot.currentTime, 0);

  snapshot = await ctx.reportUntilApplied(42);
  assert.equal(snapshot.currentTime, 42, "进度上报应更新 currentTime");

  const stopped = await ctx.stop();
  assert.equal(stopped.code, 0);
  snapshot = await ctx.state();
  assert.equal(snapshot.playbackState, "stopped");

  const again = await ctx.play(song);
  assert.equal(again.code, 0);
  snapshot = await ctx.state();
  assert.equal(snapshot.resumeAt, 42, "同一首歌再次播放应下发上次位置");
  assert.equal(snapshot.playbackState, "playing");
});

test("续播点用过即清除：连续第三次播放同一首不再续播", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("resume-b", "Resume B");
  await ctx.playThenStopAt(song, 30);

  await ctx.play(song);
  assert.equal((await ctx.state()).resumeAt, 30, "第二次播放带续播点");

  await ctx.play(song); // 第三次（服务端已把记忆点用掉）
  assert.equal((await ctx.state()).resumeAt, 0, "续播点用过即清除，不做无限续播");
});

test("换一首歌播放不带续播点", async t => {
  const ctx = await fixture(t);
  const first = await ctx.makeSong("resume-c", "Resume C");
  const second = await ctx.makeSong("resume-d", "Resume D");
  await ctx.playThenStopAt(first, 55);

  await ctx.play(second);
  assert.equal((await ctx.state()).resumeAt, 0, "换歌必须从头播");

  // 而且记忆点已被清除，回到第一首也不该续播
  await ctx.play(first);
  assert.equal((await ctx.state()).resumeAt, 0, "中途换歌后旧记忆点不应复活");
});

test("几乎没播就停止（≤1 秒）不记续播点，避免片头就续播", async t => {
  const ctx = await fixture(t);
  const song = await ctx.makeSong("resume-e", "Resume E");
  await ctx.playThenStopAt(song, 0.4);

  await ctx.play(song);
  assert.equal((await ctx.state()).resumeAt, 0, "刚开头就停止不应产生续播点");
});
