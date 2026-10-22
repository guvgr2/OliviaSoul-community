// g24 自愈加强的测试：重点是「陈旧伴随文件被清掉」与「真实读探测能触发自愈」
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStaleSidecars, mainDatabaseLooksIntact, openDatabaseHealing } from "../midi/db-self-heal.js";
import { cleanupDirSync } from "./lib/cleanup.mjs";

// ★ 2026-10-19：目录比对必须**忽略主库名开头的所有条目**（主库 + `-wal`/`-shm`/`-journal`
//   以及它们的 `.tmp` 变体，例如实测出现过的 `OLIVIA-LOCAL.SQLITE-SHM.tmp`）。
//   这些东西的生命周期归 SQLite 管，测试拿去逐字比对就是在赌一个自己管不了的时钟。
const DB_BASENAME = "OLIVIA-LOCAL.SQLITE";
const listing = dir => readdirSync(dir)
  .filter(name => !name.toUpperCase().startsWith(DB_BASENAME))
  .sort();

function makeDatabase(dir) {
  const path = join(dir, "olivia-local.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE user_songs (id TEXT); INSERT INTO user_songs VALUES ('a')");
  db.close();
  return path;
}

test("陈旧伴随文件（-shm 在、-wal 为空）会被移开，主库一个字节都不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-stale-"));
  try {
    const path = makeDatabase(dir);
    const before = statSync(path).size;
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7)); // 陈旧索引
    writeFileSync(`${path}-wal`, Buffer.alloc(0));         // 空 WAL
    const moved = [];
    const result = cleanStaleSidecars(path, { log: message => moved.push(message) });
    assert.equal(result.cleaned, true, "应当清理");
    assert.equal(existsSync(`${path}-shm`), false, "陈旧 -shm 不该还在原位");
    assert.equal(existsSync(`${path}-wal`), false, "空 -wal 也应一并移开");
    assert.equal(statSync(path).size, before, "主库不能被改动");
    assert.equal(moved.length, 1, "应留下一行说明日志");
    const parked = readdirSync(dir).filter(name => name.includes(".broken-"));
    assert.ok(parked.length >= 1, `移开的文件应留档：${readdirSync(dir).join(",")}`);
  } finally { cleanupDirSync(dir); }
});

test("-wal 里有真实内容时绝不清理（避免丢数据）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-wal-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7));
    writeFileSync(`${path}-wal`, Buffer.alloc(4096, 3)); // 有真实 WAL 内容
    const result = cleanStaleSidecars(path);
    assert.equal(result.cleaned, false, "有 WAL 内容就不能动");
    assert.equal(existsSync(`${path}-shm`), true);
    assert.equal(existsSync(`${path}-wal`), true);
  } finally { cleanupDirSync(dir); }
});

test("没有 -shm 时不做事", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-none-"));
  try {
    const path = makeDatabase(dir);
    // ★ 2026-10-19：这里原来比的是 `readdirSync(dir).sort()`（包含 SQLite 的伴随文件）。
    //   SQLite 收尾时会瞬态造出 `OLIVIA-LOCAL.SQLITE-SHM.tmp`（连大小写都不跟主库一致），
    //   它的生命周期不归测试管 ⇒ 偶发红。判据改成「**跟主库无关**的文件集合不许变」，
    //   与 test/db-self-heal.test.js 的 listing() 同一条规则（同一个病，两处都得治）。
    const before = listing(dir);
    assert.equal(cleanStaleSidecars(path).cleaned, false);
    assert.deepEqual(listing(dir), before);
  } finally { cleanupDirSync(dir); }
});

test("打开成功但真实读探测失败时，也要触发自愈（而不是当成打开成功）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-probe-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7));

    let opened = 0;
    // 模拟：第一次“打开”成功，但 verify（真实读）抛损坏；清理后第二次打开并读通
    const result = openDatabaseHealing(path, () => {
      opened += 1;
      const stub = new DatabaseSync(path);
      return stub;
    }, {
      verify: db => {
        if (opened === 1) throw new Error("database disk image is malformed"); // close 交给被测代码
        db.prepare("SELECT COUNT(*) AS n FROM user_songs").get();
      },
    });
    try {
      assert.equal(result.healed, true, "真实读失败也应触发自愈");
      assert.equal(opened, 2, "清理后应重开一次");
      // 注意：重开数据库时 SQLite 会重新创建 -shm（WAL 模式的正常行为），
    // 所以断言「旧的被移开留档」，而不是「原位置没有 shm」。
    assert.ok(readdirSync(dir).some(name => name.includes("-shm.broken-")), "旧 -shm 应被移开留档");
    } finally { result.db.close(); }
  } finally { cleanupDirSync(dir); }
});

test("主库自身损坏时不擅自清理（与既有行为一致）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-bad-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(path, Buffer.alloc(8192, 0x41));
    assert.equal(mainDatabaseLooksIntact(path), false);
    const before = listing(dir);
    assert.throws(() => openDatabaseHealing(path, () => new DatabaseSync(path), {}));
    assert.deepEqual(listing(dir), before, "主库坏了就不能动任何文件");
  } finally { cleanupDirSync(dir); }
});

// ★ E2（2026-10-18 独立审查报告-1）：`.broken-*` 留档必须封顶。
// 审查实测：真实库目录 16 天攒了 224 份留档（-shm 112 + -wal 112，全 0 字节），只增不减。
// 这条用例造出「远超过上限」的历史留档，然后触发一次清理，断言总量被压回上限。
test("过旧的 .broken-* 留档会被清到上限（只增不减会让目录里堆 200+ 份 0 字节文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-prune-"));
  try {
    const path = makeDatabase(dir);
    const base = "olivia-local.sqlite";
    // 造 40 份历史留档，名字按时间戳递增（真实的命名格式）。
    // ★ 时间戳一律由「现在」倒推（40 天前 → 1 天前），绝不写死日期：
    //   2026-10-20 两小时压测实证，写死 `2026-10-1x` 的断言在 UTC 翻日那刻（本地 08:00）
    //   会确定性假红（产品行为完全正确），且常规跑测永远碰不到 ⇒ 只在压测里现形的定时炸弹。
    const day = 24 * 60 * 60 * 1000;
    const fixtureNames = [];
    for (let i = 0; i < 40; i += 1) {
      const stamp = new Date(Date.now() - (40 - i) * day).toISOString().replace(/[:.]/gu, "-");
      const name = `${base}-shm.broken-${stamp}`;
      writeFileSync(join(dir, name), Buffer.alloc(0));
      fixtureNames.push(name);
    }
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7));
    writeFileSync(`${path}-wal`, Buffer.alloc(0));

    const result = cleanStaleSidecars(path);
    assert.equal(result.cleaned, true, "本轮仍应正常清理");

    const parked = readdirSync(dir).filter(name => name.includes(".broken-"));
    // 40 份历史 + 本轮新移开 2 份 = 42，被砍到上限 12。
    assert.equal(parked.length, 12, `留档总量应被压到上限 12，实际 ${parked.length}`);

    // 保留的必须是**最新**的那批。判据本体：
    // ① 测试自己造的 40 份（名字已知）里，留下来的必须正好是最新的 10 份；
    // ② 本轮真实移开的 2 份（按当前时间打戳）也必须在。
    // 如果实现改成留最旧的，① 立刻红；如果真实留档被删空，② 立刻红。
    const fixtureSet = new Set(fixtureNames);
    const keptFixtures = parked.filter(name => fixtureSet.has(name)).sort();
    assert.deepEqual(
      keptFixtures,
      [...fixtureNames].sort().slice(-10),
      `保留下来的必须是那 40 份里最新的 10 份，实际：${keptFixtures.join("、")}`
    );
    const realParked = parked.filter(name => !fixtureSet.has(name)).sort();
    assert.equal(realParked.length, 2, `本轮移开的 2 份真实留档都应保留，实际：${realParked.join("、")}`);
    const stampOf = name => name.slice(name.indexOf(".broken-") + ".broken-".length);
    assert.equal(stampOf(realParked[0]), stampOf(realParked[1]), "同一次清理的两份留档应打同一个时间戳");
    assert.ok(realParked.some(name => name.includes("-shm.broken-")), "真实 -shm 留档应在");
    assert.ok(realParked.some(name => name.includes("-wal.broken-")), "真实 -wal 留档应在");
    // 最老的那份（40 天前）必须已被删掉
    assert.ok(!parked.includes([...fixtureNames].sort()[0]), "最老的那批应被删掉");
  } finally { cleanupDirSync(dir); }
});

test("留档没超过上限时一个都不删（不是每次都砍到 12）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-keep-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(join(dir, "olivia-local.sqlite-shm.broken-2026-10-18T00-00-00-000Z"), Buffer.alloc(0));
    writeFileSync(join(dir, "olivia-local.sqlite-wal.broken-2026-10-18T00-00-00-000Z"), Buffer.alloc(0));
    writeFileSync(`${path}-shm`, Buffer.alloc(32768, 7));
    writeFileSync(`${path}-wal`, Buffer.alloc(0));
    cleanStaleSidecars(path);
    const parked = readdirSync(dir).filter(name => name.includes(".broken-"));
    assert.equal(parked.length, 4, `2 份旧的 + 本轮 2 份都该在，实际 ${parked.length}`);
  } finally { cleanupDirSync(dir); }
});
