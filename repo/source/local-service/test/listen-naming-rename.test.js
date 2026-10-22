// 「命名纠错」：已命名的歌可以随时改名（2026-10-20 新增）
//
// 起因（用户原话）：「命名了以后就不能修改命名了」。
// 命名页的写库（writeNames）只挑 custom_name 为空的行 —— 这是「同款群连带命名只补空位」
// 这条不变量的一部分，不能动；于是写错的名字过去只能去改数据库。
//
// 本套件守四件事：
//   1. 清单能列出全部已命名的作品（搜索 / 排序 / 分页都对）；
//   2. 改名真的写进库，且只改本文件夹、不动时段（time_of_day_mapping）；
//   3. 反向：没命名的作品不能"改名"、空名 / 超长 / 控制字符 / 非法文件夹一律拒绝且不落库；
//   4. 撤回：Ctrl+Z（/undo）把名字改回旧名，而不是清空；改名不算"今天新命名一首"。
//
// 注意：server.js 的 listen-naming 路由是模块级 Promise 缓存，同一进程里只有第一个
// createOliviaService 实例能服务这些路由 —— 所以本文件共用一份服务，用不同文件夹分场景。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOliviaService } from "../server.js";
import { cleanupDir } from "./lib/cleanup.mjs";
import { readSourceTextSync } from "./lib/read-source.mjs";
import { listenOnFetchablePort } from "./support/fetch-ports.js";

const here = dirname(fileURLToPath(import.meta.url));
const backendSource = readSourceTextSync(join(here, "..", "midi", "listen-naming.js"));
const frontendSource = readSourceTextSync(join(here, "..", "public", "listen-naming.js"));
const cssSource = readSourceTextSync(join(here, "..", "public", "listen-naming.css"));

const root = await mkdtemp(join(tmpdir(), "olivia-listen-rename-"));
const service = await createOliviaService({
  root,
  dataDir: join(root, "data"),
  officialMediaRoot: join(root, "media"),
  worker: false,
  runMemoryRefresh: false,
  midiDurationProbe: async () => 120_000_000,
});
const address = await listenOnFetchablePort(service);
const base = `http://127.0.0.1:${address.port}`;
const libraryRoot = service.midiStore.root;
// 命名页要求"曲目存储路径"已设置，否则 /name 会回 needsLibrary 指引卡片（而不是写库）。
// 必须在第一次请求之前设置：server.js 用 setting 的值决定何时创建 listen-naming 路由。
service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(libraryRoot);

test.after(async () => {
  await service.close();
  await cleanupDir(root);
});

/** 造一首作品（folder 下的 DEFAULT.mp4 + 一行 user_songs）。 */
async function seed(folder, { id = `${folder}-0`, hash = folder } = {}) {
  const folderDir = join(libraryRoot, folder);
  await mkdir(folderDir, { recursive: true });
  const video = join(folderDir, "DEFAULT.mp4");
  await writeFile(video, `not-a-real-video-${folder}`);
  service.midiStore.upsertUserSong({
    id,
    name: `作品 ${folder}`,
    sourceKind: "official-import",
    videoPath: video,
    durationUs: 120_000_000,
    contentHash: hash.padEnd(64, "0").slice(0, 64),
  });
  return video;
}

async function api(path, options) {
  const response = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return { status: response.status, body: await response.json() };
}

const post = (path, payload) => api(path, { method: "POST", body: JSON.stringify(payload ?? {}) });

function dbRow(id) {
  return service.db.prepare("SELECT id, custom_name, custom_name_key, corrected_name, time_of_day_mapping FROM user_songs WHERE id = ?").get(id);
}

// ---------------------------------------------------------------- 静态护栏

test("源码接线：两条新路由都在，前端有「修改命名」按钮且调的是 rename 接口", () => {
  // 这两条断言看着琐碎，但它们是"功能还在不在"的唯一静态护栏：
  // 路由被删 / 前端改回直接调 /name（那是"只补空位"的写库，改不动已有曲名）都会立刻红。
  assert.match(backendSource, /path === "\/listen-naming\/named"/u, "缺少已命名清单路由 /listen-naming/named");
  assert.match(backendSource, /path === "\/listen-naming\/rename"/u, "缺少改名路由 /listen-naming/rename");
  assert.match(frontendSource, /修改命名/u, "前端没有「修改命名」按钮");
  assert.match(frontendSource, /\/toy\/listen-naming\/rename/u, "前端保存改名时必须打 rename 接口");
  // 改名输入框必须让位给全局快捷键：否则打字时的空格会被当成「重播」、Ctrl+Z 会撤掉上一条命名。
  assert.match(frontendSource, /target\.closest\("\.ln-fix"\)/u, "缺少「改名输入框里不抢全局快捷键」的守卫");
  // 跨页复用/单页作用域的老坑（AGENTS.md §五）：样式必须限定在 listen-naming 页，
  // 但类名本身要能在该页命中 —— 这里钉住"确实写了这套样式"。
  assert.match(cssSource, /\.ln-fixRow/u, "缺少「命名纠错」清单行样式");
});

// ---------------------------------------------------------------- 正向

test("写库 → 清单能查到 → 改名写进库 → 清单显示新名", async () => {
  const folder = "midi_920_1700000000";
  await seed(folder);

  const named = await post("/toy/listen-naming/name", { folder, name: "旧名字" });
  assert.equal(named.status, 200);
  assert.equal(named.body.code, 0, named.body.message);
  assert.equal(dbRow(`${folder}-0`).custom_name, "旧名字");

  const list = await api("/toy/listen-naming/named?pageSize=500");
  assert.equal(list.status, 200);
  assert.equal(list.body.code, 0, list.body.message);
  const found = list.body.data.songs.find(song => song.folder === folder);
  assert.ok(found, `已命名清单里应该出现 ${folder}：${JSON.stringify(list.body.data.songs.map(s => s.folder))}`);
  assert.equal(found.name, "旧名字");
  assert.equal(found.number, 920, "编号要透出来（前端按编号排序/搜索用）");

  const renamed = await post("/toy/listen-naming/rename", { folder, name: "新名字" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.code, 0, renamed.body.message);
  assert.equal(renamed.body.data.name, "新名字");
  assert.deepEqual(renamed.body.data.before, ["旧名字"], "回执要带改之前的名字，前端拿它提示「A → B」");
  assert.equal(renamed.body.data.written, 1);

  const row = dbRow(`${folder}-0`);
  assert.equal(row.custom_name, "新名字", "改名必须真的写进库");
  assert.equal(row.custom_name_key, "新名字", "custom_name_key 必须跟着改（搜索与同名判定靠它）");
  assert.equal(row.corrected_name, "新名字", "corrected_name 与 custom_name 保持一致（写库也是这么写的）");

  const after = await api("/toy/listen-naming/named?query=" + encodeURIComponent("新名字"));
  assert.equal(after.body.data.total, 1);
  assert.equal(after.body.data.songs[0].folder, folder);
});

test("改名只动本文件夹：同前缀的别的作品不受影响", async () => {
  const target = "midi_921_1700000000";
  const neighbour = "midi_9210_1700000000";   // 前缀相似，靠 LIKE 的转义区分
  await seed(target);
  await seed(neighbour);
  await post("/toy/listen-naming/name", { folder: target, name: "甲" });
  await post("/toy/listen-naming/name", { folder: neighbour, name: "乙" });

  const renamed = await post("/toy/listen-naming/rename", { folder: target, name: "甲改" });
  assert.equal(renamed.status, 200);
  assert.equal(dbRow(`${target}-0`).custom_name, "甲改");
  assert.equal(dbRow(`${neighbour}-0`).custom_name, "乙", "隔壁那首绝不能被连带改掉");
});

test("改名不碰时段：time_of_day_mapping 原样保留（撤回也不碰）", async () => {
  const folder = "midi_922_1700000000";
  await seed(folder);
  await post("/toy/listen-naming/name", { folder, name: "带时段的歌" });
  // 真实的映射形状是「时段槽位 → 变体键」：{"TOD12":"DEFAULT","TOD20":"DEFAULT_2"}
  // （见 midi/time-of-day.js 顶部注释；写反了界面上就会显示成「白天=TOD12」）
  const mapping = JSON.stringify({ TOD12: "DEFAULT", TOD20: "DEFAULT_2" });
  service.db.prepare("UPDATE user_songs SET time_of_day_mapping = ? WHERE id = ?").run(mapping, `${folder}-0`);

  const renamed = await post("/toy/listen-naming/rename", { folder, name: "改名后" });
  assert.equal(renamed.status, 200);
  assert.equal(dbRow(`${folder}-0`).time_of_day_mapping, mapping, "改名不该把时段抹掉");

  const list = await api("/toy/listen-naming/named?query=" + encodeURIComponent("改名后"));
  const item = list.body.data.songs.find(song => song.folder === folder);
  assert.ok(item, "清单里要有这首");
  assert.match(item.timeOfDay, /白天=DEFAULT/u, "清单要把时段说成人话，便于确认改的是哪首");
  assert.match(item.timeOfDay, /夜晚=DEFAULT_2/u);

  const undone = await post("/toy/listen-naming/undo", {});
  assert.equal(undone.status, 200);
  assert.equal(dbRow(`${folder}-0`).custom_name, "带时段的歌", "撤回改名要把旧名字写回去");
  assert.equal(dbRow(`${folder}-0`).time_of_day_mapping, mapping, "撤回改名同样不该动时段");
});

// ---------------------------------------------------------------- 边界

test("新名与旧名相同：返回 unchanged，不写库、不占撤回条目", async () => {
  const folder = "midi_923_1700000000";
  await seed(folder);
  await post("/toy/listen-naming/name", { folder, name: "一样的名字" });
  const before = await api("/toy/listen-naming/status");

  const same = await post("/toy/listen-naming/rename", { folder, name: "一样的名字" });
  assert.equal(same.status, 200);
  assert.equal(same.body.data.unchanged, true);
  assert.equal(same.body.data.written, 0);
  assert.equal(same.body.data.undoable, before.body.data.undoable, "名字没变就不该多出一条可撤回记录");
});

test("首尾空格会被裁掉：'  新名字  ' 与 '新名字' 等价", async () => {
  const folder = "midi_924_1700000000";
  await seed(folder);
  await post("/toy/listen-naming/name", { folder, name: "待改" });

  const renamed = await post("/toy/listen-naming/rename", { folder, name: "  空格名  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, "空格名");
  assert.equal(dbRow(`${folder}-0`).custom_name, "空格名");
});

test("边界：文件夹名互为前缀时不会误伤（midi_1_… 与 midi_1_…0001）", async () => {
  // LIKE 只写 `%<folder>%` 时是前缀匹配：改 midi_933_1700000000 会把
  // midi_933_17000000001 一起改掉。写入别人的作品比漏改严重得多，所以单独钉一条。
  const short = "midi_933_1700000000";
  const long = "midi_933_17000000001";
  await seed(short);
  await seed(long);
  await post("/toy/listen-naming/name", { folder: short, name: "短名那首" });
  await post("/toy/listen-naming/name", { folder: long, name: "长名那首" });

  const renamed = await post("/toy/listen-naming/rename", { folder: short, name: "短名改过" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(dbRow(`${short}-0`).custom_name, "短名改过");
  assert.equal(dbRow(`${long}-0`).custom_name, "长名那首", "前缀相同的邻居绝不能被一起改掉");
});

// ---------------------------------------------------------------- 反向

test("反向：没命名的作品不能走改名（404），且库里不会被写上名字", async () => {
  const folder = "midi_925_1700000000";
  await seed(folder);

  const response = await post("/toy/listen-naming/rename", { folder, name: "偷偷写一个" });
  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.body.code, "LISTEN_NAMING_NOT_NAMED");
  assert.equal(dbRow(`${folder}-0`).custom_name, null, "被拒绝的改名绝不能落库");
});

test("反向：空名 / 超长 / 控制字符 / 非法文件夹 一律 400，且原名字不变", async () => {
  const folder = "midi_926_1700000000";
  await seed(folder);
  await post("/toy/listen-naming/name", { folder, name: "原名" });

  const cases = [
    [{ folder, name: "" }, "LISTEN_NAMING_NAME_INVALID", "空名"],
    [{ folder, name: "   " }, "LISTEN_NAMING_NAME_INVALID", "全空格"],
    [{ folder, name: "长".repeat(201) }, "LISTEN_NAMING_NAME_INVALID", "超长"],
    [{ folder, name: "带\u0000控制字符" }, "LISTEN_NAMING_NAME_INVALID", "控制字符"],
    [{ folder: "../etc/passwd", name: "合法名" }, "LISTEN_NAMING_FOLDER_INVALID", "非法文件夹"],
    [{ folder: "", name: "合法名" }, "LISTEN_NAMING_FOLDER_INVALID", "空文件夹"],
  ];
  for (const [payload, code, label] of cases) {
    const response = await post("/toy/listen-naming/rename", payload);
    assert.equal(response.status, 400, `${label} 应该 400：${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code, `${label} 的错误码不对`);
  }
  assert.equal(dbRow(`${folder}-0`).custom_name, "原名", "所有被拒绝的请求都不能改动库里已有的名字");
});

// ---------------------------------------------------------------- 撤回 / 进度

test("撤回改名：名字改回旧名，且不会把「今天命名了多少」扣掉", async () => {
  const folder = "midi_927_1700000000";
  await seed(folder);
  const named = await post("/toy/listen-naming/name", { folder, name: "第一版" });
  assert.equal(named.status, 200);
  const todayAfterName = named.body.data.progress.today;
  assert.ok(todayAfterName >= 1, "写库之后今天至少 +1");

  const renamed = await post("/toy/listen-naming/rename", { folder, name: "第二版" });
  assert.equal(renamed.status, 200);
  const progressAfterRename = await api("/toy/listen-naming/progress");
  assert.equal(progressAfterRename.body.data.progress.today, todayAfterName, "改名不是新命名，今天计数不该变");

  const undone = await post("/toy/listen-naming/undo", {});
  assert.equal(undone.status, 200);
  assert.equal(undone.body.data.kind, "rename", "撤回的应该是那条改名记录");
  assert.equal(undone.body.data.restored, "第一版", "回执要告诉前端改回了什么");
  assert.equal(dbRow(`${folder}-0`).custom_name, "第一版");

  const progressAfterUndo = await api("/toy/listen-naming/progress");
  assert.equal(progressAfterUndo.body.data.progress.today, todayAfterName, "撤回改名不该把今天的计数扣掉");

  // 再撤一次：这次轮到那条"写库"记录 —— 行为必须还是老样子（清空曲名）
  const undoneAgain = await post("/toy/listen-naming/undo", {});
  assert.equal(undoneAgain.status, 200);
  assert.equal(undoneAgain.body.data.kind, "name", "老条目的 kind 缺省就是 name，语义不能变");
  assert.equal(dbRow(`${folder}-0`).custom_name, null, "撤回命名仍然是清空曲名");
});

// ---------------------------------------------------------------- 清单的搜索 / 排序 / 分页

test("清单：搜索能按曲名 / 文件夹 / 编号命中，排序与分页口径正确", async () => {
  const folders = ["midi_930_1700000000", "midi_931_1700000000", "midi_932_1700000000"];
  for (const folder of folders) await seed(folder);
  await post("/toy/listen-naming/name", { folder: folders[0], name: "千本樱" });
  await post("/toy/listen-naming/name", { folder: folders[1], name: "夜に駆ける" });
  await post("/toy/listen-naming/name", { folder: folders[2], name: "千本樱 钢琴版" });

  const byName = await api("/toy/listen-naming/named?query=" + encodeURIComponent("千本樱"));
  assert.equal(byName.body.data.total, 2, "按曲名搜应该命中两首");
  assert.deepEqual(byName.body.data.songs.map(song => song.name).sort(), ["千本樱", "千本樱 钢琴版"].sort());

  const byFolder = await api("/toy/listen-naming/named?query=midi_931");
  assert.equal(byFolder.body.data.total, 1, "按文件夹搜应该只命中一首");
  assert.equal(byFolder.body.data.songs[0].folder, folders[1]);

  const byNumber = await api("/toy/listen-naming/named?query=932");
  assert.equal(byNumber.body.data.total, 1, "按编号搜应该只命中一首");
  assert.equal(byNumber.body.data.songs[0].folder, folders[2]);

  const byNumberSort = await api("/toy/listen-naming/named?sort=number&pageSize=500");
  const numbers = byNumberSort.body.data.songs.map(song => song.number);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "sort=number 必须按编号升序");

  const page = await api("/toy/listen-naming/named?sort=number&pageSize=1");
  assert.equal(page.body.data.songs.length, 1);
  assert.equal(page.body.data.hasMore, true, "还有下一页时 hasMore 必须为 true");
  assert.equal(page.body.data.nextCursor, 1);

  const second = await api("/toy/listen-naming/named?sort=number&pageSize=1&cursor=1");
  assert.equal(second.body.data.songs.length, 1);
  assert.notEqual(second.body.data.songs[0].folder, page.body.data.songs[0].folder, "第二页不能和第一页重复");

  // 空搜索不该把"全库已命名"的总数算错
  const all = await api("/toy/listen-naming/named?pageSize=500");
  assert.ok(all.body.data.namedTotal >= 3, `namedTotal 应该是全库已命名数：${all.body.data.namedTotal}`);
});
