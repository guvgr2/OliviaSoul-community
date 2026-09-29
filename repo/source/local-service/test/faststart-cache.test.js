// faststart 缓存的行为测试：核心是「没有缓存时不阻塞播放」和「任何失败都不影响播放」
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFaststartCache } from "../midi/faststart-cache.js";

const HASH = "a".repeat(64);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "faststart-"));
  const root = join(dir, "data");
  mkdirSync(root, { recursive: true });
  const video = join(dir, "song.mp4");
  writeFileSync(video, Buffer.alloc(2048, 1));
  const calls = [];
  const cache = createFaststartCache({
    root,
    ffmpegPath: "ffmpeg",
    runProcess: async (command, args) => {
      calls.push({ command, args });
      writeFileSync(args.at(-1), Buffer.alloc(1024, 2));
      return { command, args, exitCode: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  });
  return { dir, root, video, calls, cache };
}

test("没有缓存时先返回 null（不阻塞这次播放），随后后台生成，下次直接用缓存", async () => {
  const f = fixture();
  try {
    assert.equal(f.cache.prefer(f.video, HASH, "DEFAULT"), null, "第一次不该阻塞播放");
    await wait(60);
    assert.equal(f.calls.length, 1, "应触发一次后台生成");
    assert.ok(f.calls[0].args.includes("+faststart"), "应带 -movflags +faststart");
    assert.ok(f.calls[0].args.includes("copy"), "应无损重封装");
    const target = join(f.root, ".faststart-cache", HASH, "DEFAULT.mp4");
    assert.ok(existsSync(target), "生成后缓存应就位");
    assert.equal(f.cache.prefer(f.video, HASH, "DEFAULT"), target, "第二次应直接命中缓存");
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("缓存只落在应用数据目录，不写进媒体所在目录", async () => {
  const f = fixture();
  try {
    f.cache.prefer(f.video, HASH, "DEFAULT");
    await wait(60);
    assert.ok(existsSync(join(f.root, ".faststart-cache")), "缓存应在应用数据根下");
    assert.equal(existsSync(join(f.dir, ".faststart-cache")), false, "媒体目录不应被写入");
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("没有 ffmpeg 时优雅降级：始终返回 null，也不起进程", async () => {
  const f = fixture({ ffmpegPath: "" });
  try {
    assert.equal(f.cache.prefer(f.video, HASH, "DEFAULT"), null);
    await wait(40);
    assert.equal(f.calls.length, 0);
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("非 MP4 与无效内容哈希都直接跳过，不无谓起 ffmpeg", async () => {
  const f = fixture();
  try {
    const other = join(f.dir, "audio.mp3");
    writeFileSync(other, "x");
    assert.equal(f.cache.prefer(other, HASH, "DEFAULT"), null);
    assert.equal(f.cache.prefer(f.video, "not-a-hash", "DEFAULT"), null);
    await wait(40);
    assert.equal(f.calls.length, 0);
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("生成失败绝不影响播放：不抛错，仍返回 null", async () => {
  const f = fixture({ runProcess: async () => { throw new Error("ffmpeg 崩了"); } });
  try {
    assert.equal(f.cache.prefer(f.video, HASH, "DEFAULT"), null);
    await wait(60);
    assert.equal(f.cache.prefer(f.video, HASH, "DEFAULT"), null, "失败后仍应安全降级");
    assert.equal(existsSync(join(f.root, ".faststart-cache", HASH, "DEFAULT.mp4")), false, "不该留下半成品");
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("同一目标不重复排队", async () => {
  const f = fixture();
  try {
    f.cache.prefer(f.video, HASH, "DEFAULT");
    f.cache.prefer(f.video, HASH, "DEFAULT");
    f.cache.prefer(f.video, HASH, "DEFAULT");
    await wait(80);
    assert.equal(f.calls.length, 1, "同一目标只能生成一次");
  } finally { f.cache.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
