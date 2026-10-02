import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOliviaService } from "../server.js";

// g14：「时段可视化」以前只看 user_songs.video_path，一首歌永远只列 1 段画面 ——
// 于是 seg=1/2 必然 404「这首歌没有这一段视频」，按画面判定也只按 1 段算，
// 判定值和据此写库的结果都不可信。现在必须按 video_by_tod_view 列出全部变体，
// 且 inspect 与 thumbnail 的段号顺序完全一致。
const VARIANT_KEYS = ["DEFAULT", "DEFAULT_2", "DEFAULT_3"];
const FOLDERS = Object.freeze({
  three: "midi_900_1700000000",   // 一首歌三个变体
  shared: "midi_901_1700000000",  // 同文件夹两首歌共用同一批变体（必须去重）
  single: "midi_902_1700000000",  // 老数据只有 video_path（回退路径不能丢）
  setSlot: "midi_903_1700000000", // g14 手动指定时段（会写库，单独占一个文件夹以免污染上面的只读断言）
});

// 注意：server.js 里 timeOfDayRoutesPromise 是**模块级**缓存，同一个进程里只有第一个
// createOliviaService 实例能真正服务 /listen-naming 路由（第二个实例会命中第一个实例的库，
// 报 unable to open database file）。所以本文件共用一份服务，用三个文件夹覆盖三种数据形态。
const root = await mkdtemp(join(tmpdir(), "olivia-tod-variants-"));
const service = await createOliviaService({
  root,
  dataDir: join(root, "data"),
  officialMediaRoot: join(root, "media"),
  worker: false,
  runMemoryRefresh: false,
  midiDurationProbe: async () => 120_000_000,
});
const address = await service.listen(0);
const base = `http://127.0.0.1:${address.port}`;
// 曲库根直接落在受管目录里：store 存的是相对路径（用 / 分隔），既能命中
// video_path LIKE '%/<folder>/%'，又能靠 midi_library_root 还原成绝对路径。
const libraryRoot = service.midiStore.root;

async function seed(folder, { variantKeys = VARIANT_KEYS, songs = 1 } = {}) {
  const folderDir = join(libraryRoot, folder);
  await mkdir(folderDir, { recursive: true });
  const videos = {};
  for (const key of variantKeys) {
    videos[key] = join(folderDir, `${key}.mp4`);
    await writeFile(videos[key], `not-a-real-video-${folder}-${key}`);
  }
  for (let index = 0; index < songs; index += 1) {
    service.midiStore.upsertUserSong({
      id: `${folder}-${index}`,
      name: `作品 ${folder} #${index}`,
      sourceKind: "official-import",
      videoPath: videos[variantKeys[0]],
      videoByTodView: videos,
      durationUs: 120_000_000,
      contentHash: `${folder}${index}`.padEnd(64, "0").slice(0, 64),
    });
  }
}

await seed(FOLDERS.three);
await seed(FOLDERS.shared, { songs: 2 });
await seed(FOLDERS.single, { variantKeys: ["DEFAULT"] });
await seed(FOLDERS.setSlot);
service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(libraryRoot);

test.after(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

async function inspect(folder) {
  const response = await fetch(`${base}/toy/listen-naming/time-of-day/inspect?folder=${folder}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 0, JSON.stringify(body));
  return body.data;
}

/**
 * 取一段缩略图。夹具里的 mp4 是假文件、沙箱里也写不了缩略图目录，所以
 * 抽帧必然失败 —— 关键只看失败原因：拿到视频是「抽帧失败」，拿不到才是
 * 「这首歌没有这一段视频」。后者正是修复前 seg>=1 的样子。
 */
async function thumbnail(folder, segment) {
  const response = await fetch(`${base}/toy/listen-naming/time-of-day/thumbnail?folder=${folder}&seg=${segment}`);
  if (response.headers.get("content-type")?.startsWith("image/")) return { found: true, code: "" };
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`缩略图接口返回的不是 JSON（seg=${segment}）：${text.slice(0, 200)}`);
  }
  assert.equal(typeof body.code, "string", JSON.stringify(body));
  return { found: body.code !== "TIME_OF_DAY_THUMBNAIL_MISSING", code: body.code };
}

test("时段可视化列出 video_by_tod_view 的全部变体，而不是只有 video_path", async () => {
  const data = await inspect(FOLDERS.three);
  assert.equal(data.folder, FOLDERS.three);
  assert.equal(data.segments.length, VARIANT_KEYS.length);
  // 段号必须连续，顺序与变体键一致；段号就是缩略图 URL 里的 seg
  assert.deepEqual(data.segments.map(item => item.index), [0, 1, 2]);
  assert.deepEqual(data.segments.map(item => item.video), VARIANT_KEYS);
  for (const segment of data.segments) {
    assert.match(segment.thumbnailUrl, new RegExp(`seg=${segment.index}(&|$)`));
  }
});

test("缩略图的第 2、3 段也能取到视频（修复前只会 404「这首歌没有这一段视频」）", async () => {
  for (const segment of [0, 1, 2]) {
    const result = await thumbnail(FOLDERS.three, segment);
    assert.equal(result.found, true, `seg=${segment} 应该能取到视频，实际 code=${result.code}`);
  }
  const missing = await thumbnail(FOLDERS.three, 3);
  assert.equal(missing.found, false);
  assert.equal(missing.code, "TIME_OF_DAY_THUMBNAIL_MISSING");
});

test("同一文件夹里多首歌共用变体时不重复列段", async () => {
  const data = await inspect(FOLDERS.shared);
  assert.equal(data.segments.length, VARIANT_KEYS.length);
  assert.deepEqual(data.segments.map(item => item.video), VARIANT_KEYS);
});

test("老数据只有 video_path 时仍然按一段列出来（回退路径不能丢）", async () => {
  const data = await inspect(FOLDERS.single);
  assert.equal(data.segments.length, 1);
  assert.equal(data.segments[0].video, "DEFAULT");
  assert.equal((await thumbnail(FOLDERS.single, 0)).found, true);
  assert.equal((await thumbnail(FOLDERS.single, 1)).found, false);
});

// g14：手动指定以前在后端写死 `variants[0]`，界面上的三个按钮实际只能改第 1 段 ——
// 下面覆盖「按变体键指定」「兼容旧段号」「非法变体不得写坏库」三件事。
async function setSlot(payload) {
  const response = await fetch(`${base}/toy/listen-naming/time-of-day/set-slot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // /toy/* 的错误也走 HTTP 200，真正的结果在 body.code 里
  assert.equal(response.status, 200);
  return await response.json();
}

function storedMapping(folder) {
  const row = service.db.prepare("SELECT time_of_day_mapping FROM user_songs WHERE id = ?").get(`${folder}-0`);
  return JSON.parse(row?.time_of_day_mapping ?? "{}");
}

test("手动指定写的是这一段的变体键，而不是永远第 1 段", async () => {
  const body = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD20", variant: "DEFAULT_3" });
  assert.equal(body.code, 0, JSON.stringify(body));
  assert.equal(body.data.variant, "DEFAULT_3");
  assert.equal(body.data.mapping.TOD20, "DEFAULT_3");
  assert.equal(storedMapping(FOLDERS.setSlot).TOD20, "DEFAULT_3", "库里必须真的写成第 3 段");
});

test("再指定另一个时段时保留已经写好的时段", async () => {
  const body = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD12", variant: "DEFAULT_2" });
  assert.equal(body.code, 0, JSON.stringify(body));
  const stored = storedMapping(FOLDERS.setSlot);
  assert.equal(stored.TOD12, "DEFAULT_2");
  assert.equal(stored.TOD20, "DEFAULT_3", "改白天不能把已经指定好的夜晚清掉");
});

test("变体键不在这个文件夹里时拒绝写库，一个字节都不改", async () => {
  const before = storedMapping(FOLDERS.setSlot);
  const body = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD1730", variant: "NOT_A_VARIANT" });
  assert.equal(body.code, "TIME_OF_DAY_VARIANT_NOT_FOUND");
  assert.deepEqual(storedMapping(FOLDERS.setSlot), before, "被拒绝的请求不得改动数据库");
});

test("不给变体键时保持老行为（第 1 段），给段号时兼容按段号取", async () => {
  const legacy = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD1730" });
  assert.equal(legacy.code, 0, JSON.stringify(legacy));
  assert.equal(legacy.data.variant, "DEFAULT", "老请求体（只有 folder+slot）仍然落在第 1 段");

  const bySegment = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD1730", seg: 2 });
  assert.equal(bySegment.code, 0, JSON.stringify(bySegment));
  assert.equal(bySegment.data.variant, "DEFAULT_3");

  const outOfRange = await setSlot({ folder: FOLDERS.setSlot, slot: "TOD1730", seg: 9 });
  assert.equal(outOfRange.code, "TIME_OF_DAY_SEGMENT_INVALID");
});
