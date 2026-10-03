// 1.0.9：时段复核的「手动指定 / 重写」把备份写到了安装目录，而不是本次启动的数据目录。
//
// 现象（1.0.9 开发中用沙箱服务实测暴露）：显式指定 dataDir 时点「指定这一段为…」，
// 回执里给的备份路径是 <仓库>/repo/source/UserData/database/backup-tod-….sqlite ——
// 那是模块级默认值，跟这次真正在写的那份库（<异位数据目录>/olivia-local.sqlite）隔着十万八千里。
//
// 根因：midi/time-of-day.js 里 BACKUP_DIR 在模块加载时就有默认值
// （<安装目录>\UserData\database），于是两处兜底全都轮不到：
//   · configure()      BACKUP_DIR = pick(options.backupDir, BACKUP_DIR || dirname(DATABASE_PATH))
//   · 路由工厂          const backupDir = resolve(options.backupDir ?? BACKUP_DIR ?? dirname(databasePath))
// 而 server.js 传的是 { databasePath }（1.0.6 起就这样），从不传 backupDir。
// 标准安装下两者恰好同目录，所以一直没暴露；便携版 / --data-dir / 数据搬家之后就分叉了：
// 备份落进安装目录树，用户既找不到、也带不走（数据安全相关的文件跑到别处，比读不到更糟）。
//
// 为什么必须单独一个测试文件：server.js 的 timeOfDayRoutesPromise 是模块级缓存，
// 同一个进程里只有第一个 createOliviaService 实例能真正服务 /listen-naming 路由
// （time-of-day-variants.test.js 顶部有同款说明）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { TIME_OF_DAY_DEFAULTS, configure } from "../midi/time-of-day.js";
import { createOliviaService } from "../server.js";

test("configure({ databasePath }) 之后备份目录跟着那份库走", () => {
  const databasePath = join(tmpdir(), "olivia-tod-backup-unit", "database", "olivia-local.sqlite");
  configure({ databasePath });
  assert.equal(
    TIME_OF_DAY_DEFAULTS.backupDir,
    dirname(databasePath),
    "注入库路径之后，备份目录必须是那份库所在的目录（默认值不许再顶掉它）",
  );

  // 显式 backupDir 依然最高优先 —— 别为了修一个缺陷把既有契约改掉
  const explicit = join(tmpdir(), "olivia-tod-backup-explicit");
  configure({ databasePath, backupDir: explicit });
  assert.equal(TIME_OF_DAY_DEFAULTS.backupDir, explicit, "显式指定的备份目录必须原样生效");
});

test("真实服务：异位数据目录下，手动指定的备份写在那份库旁边", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-tod-backup-"));
  // 故意不是 <安装目录>\UserData：便携版 / 数据搬家之后就是这个形态
  const dataDir = join(root, "异位数据", "database");
  const databasePath = join(dataDir, "olivia-local.sqlite");
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
  const folder = "midi_911_1700000000";
  const folderDir = join(libraryRoot, folder);
  await mkdir(folderDir, { recursive: true });
  const videos = {};
  for (const key of ["DEFAULT", "DEFAULT_2", "DEFAULT_3"]) {
    videos[key] = join(folderDir, `${key}.mp4`);
    await writeFile(videos[key], `not-a-real-video-${key}`);
  }
  service.midiStore.upsertUserSong({
    id: "tod-backup-1",
    name: "备份目录测试曲",
    sourceKind: "official-import",
    videoPath: videos.DEFAULT,
    videoByTodView: videos,
    durationUs: 120_000_000,
    contentHash: "tod-backup".padEnd(64, "0").slice(0, 64),
  });
  service.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('midi_library_root', ?)").run(libraryRoot);

  const address = await service.listen(0);
  const base = `http://127.0.0.1:${address.port}`;

  // /status 直接报出它打算把备份写到哪：这就是缺陷的观测点
  const statusResponse = await fetch(`${base}/toy/listen-naming/time-of-day/status`);
  const status = await statusResponse.json();
  assert.equal(status.code, 0, JSON.stringify(status));
  assert.equal(status.data.databasePath, databasePath, "读的必须是本次启动的那份库");
  assert.equal(
    status.data.backupDir,
    dataDir,
    "备份目录必须跟着本次启动的库（修复前是模块级默认的安装目录 UserData\\database）",
  );

  // 再真写一次：回执里给的备份文件也必须落在那个目录下
  const response = await fetch(`${base}/toy/listen-naming/time-of-day/set-slot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder, slot: "TOD20", variant: "DEFAULT" }),
  });
  const posted = await response.json();
  assert.equal(posted.code, 0, JSON.stringify(posted));
  assert.ok(
    String(posted.data.backupFile).includes("backup-tod-"),
    `写库前必须真的备份：${posted.data.backupFile}`,
  );
  assert.equal(
    dirname(posted.data.backupFile),
    dataDir,
    `备份要写在那份库旁边，不能跑到安装目录：${posted.data.backupFile}`,
  );
});
