// 1.0.8：「曲名与时段」页在异位数据目录下读不到曲库（真实缺陷）。
//
// 现象：显式指定 dataDir（便携版、测试、数据搬家后的异位目录）时，这一页顶部报
// 「读取失败：unable to open database file」，列表是空的，于是「看这首的时段依据」
// 点了静默无反应（inspectCurrent() 在拿不到当前作品时直接 return）。
//
// 根因：server.js 起 listen-naming 路由时只注入了 libraryRoot，没有注入 databasePath；
// 而 midi/listen-naming.js 的 DATABASE_PATH 在模块加载时就已经有默认值
// （<安装目录>\UserData\database\olivia-local.sqlite），configure() 里
// 「用 dataDir 推导库路径」那句（if (USER_DATA_DIR && !DATABASE_PATH)）因此永远不成立 ——
// 模块去开安装目录下的库，而不是本次启动真正在用的库。
// 同一个 server.js 里的 time-of-day 路由在 ac30bb60（1.0.6）已经这样修过，
// 注释写的正是这件事：「数据库路径必须跟着本次启动的 dataDir 走，否则显式指定的
// dataDir（测试、便携版异位数据目录）会被模块级默认值顶掉」。当时只修了一半。
//
// 为什么必须单独一个测试文件、且本进程只起这一个服务：server.js 的路由 Promise
// 是**模块级缓存**（let listenNamingRoutesPromise = null），同一个进程里第二个
// createOliviaService 实例会复用第一个实例的闭包（绑定第一个实例的库）——
// time-of-day-variants.test.js 里有同款注释与说明。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOliviaService } from "../server.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, "..", "server.js"), "utf8");

test("源码接线：listen-naming 路由要跟 time-of-day 一样注入本次启动的 databasePath", () => {
  // 这条断言看着琐碎，但它是这个缺陷唯一的静态护栏：漏参数时单元测试全绿、
  // 只有「显式 dataDir + 真服务」的组合才会暴露（所以下面还有一条真服务测试）。
  assert.match(
    serverSource,
    /createListenNamingRoutes\(\{ libraryRoot: currentRoot, databasePath \}\)/u,
    "server.js 起 listen-naming 路由时必须带上 databasePath，否则异位数据目录下这一页读不到曲库",
  );
});

test("真实服务：显式 dataDir 下「曲名与时段」列表读的是本次启动的库", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-listen-dbpath-"));
  // 故意用一个不是 <安装目录>\UserData 的数据目录：这就是便携版/搬家后的形态，
  // 也是本缺陷唯一能被观测到的前提。
  const dataDir = join(root, "异位数据", "database");
  const service = await createOliviaService({
    root,
    dataDir,
    officialMediaRoot: join(root, "media"),
    worker: false,
    runMemoryRefresh: false,
    midiDurationProbe: async () => 120_000_000,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  const libraryRoot = service.midiStore.root;
  const folder = "midi_910_1700000000";
  await mkdir(join(libraryRoot, folder), { recursive: true });
  await writeFile(join(libraryRoot, folder, "DEFAULT.mp4"), "not-a-real-video");
  service.midiStore.upsertUserSong({
    id: "listen-dbpath-1",
    name: "异位数据目录测试曲",
    sourceKind: "official-import",
    videoPath: join(libraryRoot, folder, "DEFAULT.mp4"),
    durationUs: 120_000_000,
    contentHash: "listen-dbpath".padEnd(64, "0").slice(0, 64),
  });
  service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(libraryRoot);

  const address = await service.listen(0);
  const response = await fetch(`http://127.0.0.1:${address.port}/toy/listen-naming/list?pageSize=3000`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.code,
    0,
    `「曲名与时段」列表必须能从本次启动的库里读出来（这一页读不到库时前端就显示「读取失败」）：${body.message ?? ""}`,
  );
  assert.equal(
    body.data.songs.length,
    1,
    `列表里应该只有本次启动那份库里的一首：${JSON.stringify(body.data.songs?.map(song => song.folder))}`,
  );
  assert.equal(body.data.songs[0].folder, folder, "文件夹名要透出来（前端靠它取切片与时段依据）");
  // 最直接的观测点：接口自己报出它打开的是哪一份库（buildList() 的返回里有 databasePath）。
  // 修复前这里是 <安装目录>\UserData\database\olivia-local.sqlite，也就是那份不存在的库。
  assert.equal(
    body.data.databasePath,
    join(dataDir, "olivia-local.sqlite"),
    "「曲名与时段」必须读本次启动的库，而不是模块级默认的那份安装目录库",
  );
});
