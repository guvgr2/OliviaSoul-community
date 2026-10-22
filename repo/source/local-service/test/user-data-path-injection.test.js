// 「数据目录必须由调用方注入」——E4（2026-10-18 独立审查报告-1）
//
// 病根：`midi/dependency-check.js` 与 `midi/logs.js` 把数据路径写成**模块级常量**
//   `process.env.OLIVIA_USER_DATA || join(INSTALL_ROOT, "UserData")`，
// 而 `server.js` 从不设那个环境变量、也从不传 dataDir ⇒ 两处一律指向**安装树**。
// 实测后果：
//   ① 界面「依赖检查」报 `E:\...\repo\source\UserData\database\olivia-local.sqlite` ENOENT；
//   ② 安装树里躺着 633,887 B / 6671 行的 `listen-naming.log`。
// 同一类 bug 在 1.0.8（listen-naming）与 1.0.9（time-of-day）各修过一次 —— 这两处是漏修的。
//
// 这组用例守三层：
//   行为层 —— 传了 dataDir，报告与日志文件就都得跟着走；
//   契约层 —— 调用方（server.js）真的传了（源码断言，防止将来又写成无参调用）；
//   反向层 —— 不传时不会炸（独立调用仍可用），但会明确指向默认值。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dependencyReport, createDependencyCheckRoutes } from "../midi/dependency-check.js";
import { setUserDataDir, logFilePath, log } from "../midi/logs.js";
import { cleanupDirSync } from "./lib/cleanup.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const serviceRoot = join(here, "..");
const source = name => readFileSync(join(serviceRoot, name), "utf8");

function withTempDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "userdata-inject-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => cleanupDirSync(dir));
}

test("依赖自检：传了 dataDir，数据库路径就指向它（不再报安装树里的假路径）", async () => {
  await withTempDataDir(async dir => {
    const report = await dependencyReport({ dataDir: dir });
    const dbItem = report.items.find(item => item.name === "数据库");
    assert.ok(dbItem, "报告里应当有「数据库」一项");
    assert.equal(
      dbItem.path, join(dir, "database", "olivia-local.sqlite"),
      `数据库路径必须跟着 dataDir 走，实际 ${dbItem.path}`);
    assert.equal(report.userData, dir, "报告里的 userData 也必须是注入的那个");
    // ★ 反向断言：不能出现「程序目录\UserData」这种安装树路径
    assert.ok(
      !dbItem.path.includes(join("local-service", "UserData")),
      `不该再指向安装树：${dbItem.path}`);
  });
});

test("依赖自检：databasePath 可以单独指定（不跟着 dataDir 的默认布局走）", async () => {
  await withTempDataDir(async dir => {
    const custom = join(dir, "nested", "custom.sqlite");
    const report = await dependencyReport({ dataDir: dir, databasePath: custom });
    const dbItem = report.items.find(item => item.name === "数据库");
    assert.equal(dbItem.path, custom, "显式传的 databasePath 必须优先");
  });
});

test("依赖自检：路由工厂把 options 透传下去（不能只在地毯上支持、路由里忘了传）", async () => {
  await withTempDataDir(async dir => {
    const handle = await createDependencyCheckRoutes({ dataDir: dir });
    const result = await handle({ method: "GET" }, "/toy/listen-naming/dependencies");
    assert.ok(result, "GET /toy/listen-naming/dependencies 应当有响应");
    assert.equal(result.userData, dir, "路由返回的 userData 必须是注进去的那个");
  });
});

test("运行日志：设定 dataDir 之后，日志文件就写到那里（不再落到安装树）", async () => {
  await withTempDataDir(async dir => {
    setUserDataDir(dir);
    assert.equal(logFilePath(), join(dir, "listen-naming.log"), "日志路径必须跟着注入的目录走");
    log("info", "路径注入自检");
    // persist 是刻意 fire-and-forget 的；给它一个事件循环周期落盘
    await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
    const file = join(dir, "listen-naming.log");
    assert.ok(existsSync(file), `日志文件应当已落盘：${file}`);
    assert.match(readFileSync(file, "utf8"), /路径注入自检/u);
  });
});

test("依赖自检：社区名单缓存也读注入的目录（不是模块级默认值）", async () => {
  await withTempDataDir(async dir => {
    const report = await dependencyReport({ dataDir: dir });
    const cacheItem = report.items.find(item => item.name === "社区名单缓存");
    assert.ok(cacheItem, "报告里应当有「社区名单缓存」一项");
    // 没有缓存时 path 是空串；有缓存时必须是注入目录下那个文件。两种都允许，
    // 但不许它去摸一个 undefined（旧实现的 existsSync(undefined) 就是这个症状）。
    if (cacheItem.path) {
      assert.equal(cacheItem.path, join(dir, "community-catalog.json"),
        "社区名单缓存的路径必须跟着 dataDir 走");
    }
    // ★ 直接钉住模块内部：不给 catalogCache 就会走 existsSync(undefined)。
    //   用「造一份缓存」把它从空串分支逼出来。
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "community-catalog.json"), JSON.stringify({ songs: [{ id: "a" }, { id: "b" }] }));
    const again = await dependencyReport({ dataDir: dir });
    const item = again.items.find(entry => entry.name === "社区名单缓存");
    assert.equal(item.path, join(dir, "community-catalog.json"), "缓存存在时必须报出注入目录里的那个文件");
    assert.match(item.detail, /条/u);
  });
});

test("契约：server.js 必须把真实 dataDir 传给两处（源码断言，防止退回无参调用）", () => {
  const src = source("server.js");
  assert.equal(
    (src.match(/createDependencyCheckRoutes\(\{ dataDir, databasePath \}\)/gu) ?? []).length, 1,
    "server.js 必须以 { dataDir, databasePath } 调用 createDependencyCheckRoutes");
  assert.equal(
    (src.match(/createDependencyCheckRoutes\(\)/gu) ?? []).length, 0,
    "不许再出现无参调用 createDependencyCheckRoutes()");
  assert.equal(
    (src.match(/setUserDataDir\(dataDir\)/gu) ?? []).length, 1,
    "server.js 必须在日志路由前调用 setUserDataDir(dataDir)");
});

test("根因：两个模块里都不许再有「模块级数据路径常量」", () => {
  const dep = source("midi/dependency-check.js");
  const logs = source("midi/logs.js");
  // 允许的形态是函数/参数；一旦有人把 join(...) 再提到模块级 const，这里就红
  assert.equal(
    (dep.match(/^const (USER_DATA|DATABASE_PATH|CATALOG_CACHE)\b/mu) ?? []).length, 0,
    "dependency-check.js 不许再有模块级 USER_DATA / DATABASE_PATH / CATALOG_CACHE 常量");
  assert.equal(
    (logs.match(/^const (USER_DATA|LOG_FILE)\b/mu) ?? []).length, 0,
    "logs.js 不许再有模块级 USER_DATA / LOG_FILE 常量");
  // 且必须保留「每次现算」的入口
  assert.match(logs, /function logFile\(\)/u, "logs.js 必须每次现算日志文件路径");
});
