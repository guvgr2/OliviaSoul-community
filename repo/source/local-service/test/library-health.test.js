import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// C1 曲库体检：既有的 /listen-naming/health 只报 5 类，而且每类**硬截断**（30/20 条）——
// 前端拿到 30 条没法说清「是正好 30 条还是被砍了」，占位名（个人上传 · midi_xxx）与
// 「磁盘上有文件夹、曲库表里没有这首」两个最该修的维度根本没报。这里补的就是第一部分：
// 占位名统计（只统计不猜曲名）、缺失 MIDI（missingVideo 的反向）、同款群拆成
// 「名字一样＝可合并」与「名字不一样＝要人工核对」，以及每类的 total + ?full=1 的全量口径。
// 旧键（duplicateNames / twinConflicts / missingVideo / durationOdd / counts.*）一个都不能少，
// 因为「高级设置 → 曲库诊断」那个旧面板还吃着同一份返回。
const FOLDERS = Object.freeze({
  placeholder: "midi_800_1700000001",  // 占位名、没写过真名 → 该报
  named: "midi_801_1700000001",        // 占位名 + 命名页写过曲名 → 不该报
  corrected: "midi_802_1700000001",    // 占位名 + 纠正名 → 不该报
  midiOnly: "midi_803_1700000001",     // 磁盘上有文件夹，曲库表里没有 → 缺失 MIDI
  videoOnly: "midi_804_1700000001",    // 曲库表里有、文件夹没了 → 既有 missingVideo
  shortClip: "midi_805_1700000001",    // 时长 5 秒 → 时长异常
  bulk: "midi_810_1700000001",         // 35 首占位名 → 专门用来验「不静默截断」
  sameA: "midi_820_1700000001",        // 同款群 g1：两首名字一样 → 可合并
  sameB: "midi_821_1700000001",
  diffA: "midi_822_1700000001",        // 同款群 g2：两首名字不一样 → 要人工核对
  diffB: "midi_823_1700000001",
});

const root = await mkdtemp(join(tmpdir(), "olivia-library-health-"));
// 同款群索引默认落在 <安装目录>\UserData 下（跑测试会写进仓库），所以先用环境变量把它
// 指到临时目录，再**动态** import server.js —— listen-naming.js 是在模块加载时读这个变量的。
const groupCsv = join(root, "listen-naming-groups.csv");
process.env.OLIVIA_LISTEN_GROUP_CSV = groupCsv;
const { createOliviaService } = await import("../server.js");

// 同一个进程里只有第一个 createOliviaService 实例能真正服务 /listen-naming 路由
// （server.js 里 listenNamingRoutesPromise 是模块级缓存，见 time-of-day-variants.test.js）。
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
const libraryRoot = service.midiStore.root;
// 曲库根一会儿要被 /listen-naming 路由现读，所以必须写进 settings 再发第一个请求。
service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(libraryRoot);

let hashSeed = 0;
async function seedSong(folder, { name, customName = null, permanentName = null, durationUs = 120_000_000, dropFolder = false, suffix = "" } = {}) {
  const dir = join(libraryRoot, folder);
  const videoPath = join(dir, "DEFAULT.mp4");
  await mkdir(dir, { recursive: true });
  await writeFile(videoPath, `not-a-real-video-${folder}`);
  const id = `${folder}-song${suffix}`;
  hashSeed += 1;
  service.midiStore.upsertUserSong({
    id,
    name,
    sourceKind: "official-import",
    videoPath,
    durationUs,
    contentHash: hashSeed.toString(16).padStart(64, "0"),
  });
  if (customName) service.midiStore.updateUserSongMetadata(id, { name: customName });
  if (permanentName) service.midiStore.updateUserSongMetadata(id, { permanentName });
  // missingVideo 的场景：先让库里记上，再把文件夹删掉（不然有些写入路径会先校验文件在不在）。
  if (dropFolder) await rm(dir, { recursive: true, force: true });
  return id;
}

const placeholderName = folder => `个人上传 · ${folder}`;
await seedSong(FOLDERS.placeholder, { name: placeholderName(FOLDERS.placeholder) });
await seedSong(FOLDERS.named, { name: placeholderName(FOLDERS.named), customName: "小雨" });
await seedSong(FOLDERS.corrected, { name: placeholderName(FOLDERS.corrected), permanentName: "春夜" });
await mkdir(join(libraryRoot, FOLDERS.midiOnly), { recursive: true });
await seedSong(FOLDERS.videoOnly, { name: "只有记录没有文件夹", dropFolder: true });
await seedSong(FOLDERS.shortClip, { name: "五秒钟的一段", durationUs: 5_000_000 });
await seedSong(FOLDERS.sameA, { name: "同一首的两种录法", customName: "同一首" });
await seedSong(FOLDERS.sameB, { name: "同一首的两种录法", customName: "同一首" });
await seedSong(FOLDERS.diffA, { name: "同一首的两种录法", customName: "甲" });
await seedSong(FOLDERS.diffB, { name: "同一首的两种录法", customName: "乙" });
// 同款群索引：表头 文件夹,群号（与「采纳同款群」写出来的文件同一个形状）。
await writeFile(groupCsv, "\uFEFF" + [
  ["文件夹", "群号"],
  [FOLDERS.sameA, "G00000001"], [FOLDERS.sameB, "G00000001"],
  [FOLDERS.diffA, "G00000002"], [FOLDERS.diffB, "G00000002"],
].map(row => `${row.join(",")}\n`).join(""), "utf8");

test.after(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

async function health(query = "") {
  const response = await fetch(`${base}/toy/listen-naming/health${query}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 0, JSON.stringify(body));
  return body.data;
}

test("曲库体检：占位名只统计不猜曲名，缺失 MIDI 是 missingVideo 的反向", async () => {
  const data = await health();
  assert.equal(data.counts.placeholderNames, 1, "写过曲名/纠正名的都不该算占位名");
  assert.equal(data.placeholderNames.length, 1);
  assert.equal(data.placeholderNames[0].folder, FOLDERS.placeholder);
  assert.equal(data.placeholderNames[0].name, placeholderName(FOLDERS.placeholder));
  assert.equal(data.counts.missingMidi, 1, "磁盘上有文件夹但曲库表里没有这首，要报出来");
  assert.deepEqual(data.missingMidi, [FOLDERS.midiOnly]);
  assert.equal(data.counts.missingVideo, 1, "曲库表里有、文件夹没了，仍是既有的 missingVideo");
  assert.deepEqual(data.missingVideo, [FOLDERS.videoOnly]);
  assert.equal(data.counts.durationOdd, 1);
  assert.deepEqual(data.durationOdd, [{ folder: FOLDERS.shortClip, seconds: 5 }]);
  assert.ok(Number.isFinite(Date.parse(data.checkedAt)), data.checkedAt);
  assert.equal(data.libraryRoot, libraryRoot);
});

test("同款群分成两种：名字一样＝可合并不算错，名字不一样＝要人工核对", async () => {
  const data = await health();
  assert.equal(data.counts.duplicateGroups, 1);
  assert.equal(data.duplicateGroups.length, 1, "同一个群不能按成员数报 N 次");
  assert.equal(data.duplicateGroups[0].name, "同一首");
  assert.equal(data.duplicateGroups[0].count, 2);
  assert.deepEqual([...data.duplicateGroups[0].folders].sort(), [FOLDERS.sameA, FOLDERS.sameB].sort());
  assert.equal(data.counts.twinConflicts, 1);
  assert.equal(data.twinConflicts.length, 1);
  assert.deepEqual([...data.twinConflicts[0].names].sort(), ["乙", "甲"]);
  assert.equal(data.counts.duplicateNames, 1, "「同一首」在两首上是重名，旧的 duplicateNames 照旧");
});

test("不静默截断：默认每类只回前 30 条，但 totals 是真实条数，?full=1 才回全部", async () => {
  const before = (await health()).totals.placeholderNames;
  for (let index = 0; index < 35; index += 1)
    await seedSong(FOLDERS.bulk, { name: placeholderName(`${FOLDERS.bulk}_${index}`), suffix: `-${index}` });

  const page = await health();
  assert.equal(page.full, false);
  assert.equal(page.totals.placeholderNames, before + 35);
  assert.equal(page.placeholderNames.length, 30, "默认仍只回 30 条（旧诊断面板口径不变）");
  assert.equal(page.counts.placeholderNames, before + 35, "counts 一直是全部数量，不是本页条数");

  const all = await health("?full=1");
  assert.equal(all.full, true);
  assert.equal(all.placeholderNames.length, before + 35);
  assert.equal(all.totals.placeholderNames, before + 35);
});

test("旧键一个都不能少：高级设置里的曲库诊断面板还吃着同一份返回", async () => {
  const data = await health();
  for (const key of ["duplicateNames", "twinConflicts", "missingVideo", "duplicateGroups", "missingMidi", "placeholderNames", "durationOdd"])
    assert.ok(Array.isArray(data[key]), `${key} 应该是数组`);
  for (const key of ["rows", "folders", "named", "duplicateNames", "twinConflicts", "missingVideo", "durationOdd", "duplicateGroups", "missingMidi", "placeholderNames"])
    assert.equal(typeof data.counts[key], "number", `counts.${key} 应该是数字`);
  assert.equal(typeof data.counts.rows, "number");
  assert.equal(typeof data.counts.folders, "number");
  for (const entry of data.duplicateNames) {
    assert.equal(typeof entry.name, "string");
    assert.ok(Array.isArray(entry.folders));
    assert.equal(typeof entry.count, "number");
  }
  for (const entry of data.twinConflicts) {
    assert.ok(Array.isArray(entry.folders) && Array.isArray(entry.names));
  }
  // 程序端 /admin/api 与游戏端 /toy 是同一份数据（两个前缀都挂同一批路由）
  const mirrored = await fetch(`${base}/admin/api/listen-naming/health`);
  assert.equal(mirrored.status, 200);
  const mirroredBody = await mirrored.json();
  assert.equal(mirroredBody.code, 0);
  assert.deepEqual(mirroredBody.data.counts, data.counts);
});
