// 数据库自愈测试：测逻辑本身，不依赖 SQLite 的具体报错措辞
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainDatabaseLooksIntact, openDatabaseHealing } from "../midi/db-self-heal.js";
import { cleanupDirSync } from "./lib/cleanup.mjs";

function makeDatabase(dir) {
  const path = join(dir, "olivia-local.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)");
  db.close();
  return path;
}

const openPlain = path => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
};

// ★ B5（2026-10-19 第三轮独立审查）：这里原来有三处 `assert.deepEqual(readdirSync(dir).sort(), before)`。
//   被它误伤的正是这个：SQLite 在收尾时会**瞬态**造出 `OLIVIA-LOCAL.SQLITE-SHM.tmp`
//   （2026-10-19 门禁 shard 3 实测抓到一次，文件名的 `.tmp` 后缀连大小写都不跟主库一致）。
//   `-wal` / `-shm` / `-journal` 以及它们的 `.tmp` 变体，生命周期都归 SQLite 管
//   （内核句柄延迟释放 10~24ms，见 test/helpers/cleanup.mjs 的注释），测试对它做「逐字相等」
//   比对就是在赌一个自己管不了的时钟 ⇒ 偶发红。
//   判据改成：① 目录里**跟主库无关**的文件集合必须一字不差（这才是「没被碰过」）；
//   ② 主库本身大小与 mtime 不变（这才是「自愈没改写库」）；③ 需要时**显式**断言某个伴随文件还在。
const DB_BASENAME = "olivia-local.sqlite";
const listing = dir => readdirSync(dir)
  .filter(name => !name.toLowerCase().startsWith(DB_BASENAME))
  .sort();

test("正常数据库：直接打开，不产生也不改动任何文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-ok-"));
  try {
    const path = makeDatabase(dir);
    const before = listing(dir);
    const beforeStat = statSync(path);
    const result = openDatabaseHealing(path, () => openPlain(path));
    try {
      assert.equal(result.healed, false, "正常库不应触发自愈");
      assert.equal(result.db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
    } finally { result.db.close(); }
    assert.deepEqual(listing(dir), before, "目录内容不应变化（只比非伴随文件）");
    const afterStat = statSync(path);
    assert.equal(afterStat.size, beforeStat.size, "主库大小不应变化");
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "主库不应被改写");
  } finally { cleanupDirSync(dir); }
});

test("非损坏类错误：原样抛出，连完整性检查都不做", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-other-"));
  try {
    const path = makeDatabase(dir);
    const before = listing(dir);
    const failOpen = () => { throw new Error("EACCES: permission denied"); };
    assert.throws(() => openDatabaseHealing(path, failOpen), /EACCES/u);
    assert.deepEqual(listing(dir), before, "不该动任何文件");
  } finally { cleanupDirSync(dir); }
});

test("主库自身损坏：判为不完整，绝不擅自清理，原样抛出", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-bad-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(path, Buffer.alloc(8192, 0x41)); // 覆盖主库头部
    assert.equal(mainDatabaseLooksIntact(path), false, "损坏的主库不应判为完好");
    const shm = `${path}-shm`;
    writeFileSync(shm, Buffer.alloc(4096, 7)); // 放一个残留 sidecar
    const before = listing(dir);
    const failOpen = () => { throw new Error("database disk image is malformed"); };
    assert.throws(() => openDatabaseHealing(path, failOpen), /malformed/u);
    // 伴随文件在这里**单独断言**（下一行），不混进目录逐字比对里 —— 理由见 listing() 的注释。
    assert.deepEqual(listing(dir), before, "主库坏了就不能动任何文件（伴随文件另见下一条断言）");
    assert.equal(existsSync(shm), true, "残留 sidecar 必须原样保留");
  } finally { cleanupDirSync(dir); }
});

test("残留 sidecar 导致打不开：只移开 sidecar，重开一次", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-fix-"));
  try {
    const path = makeDatabase(dir);
    const shm = `${path}-shm`;
    const wal = `${path}-wal`;
    writeFileSync(shm, Buffer.alloc(32768, 7));
    writeFileSync(wal, Buffer.alloc(0));

    let calls = 0;
    const flakyOpen = () => {
      calls += 1;
      if (calls === 1) throw new Error("database disk image is malformed");
      return openPlain(path);
    };
    const result = openDatabaseHealing(path, flakyOpen);
    try {
      assert.equal(result.healed, true, "应当自愈");
      assert.equal(calls, 2, "应当在清理后重开一次");
      assert.ok(result.moved.some(name => name.includes("-shm.broken-")), `应移开 shm：${result.moved.join("、")}`);
      // 注意：重开数据库时 SQLite 会【重新创建】-shm（WAL 模式的正常行为），
      // 所以不能断言"原位置没有 shm"，而要断言"旧的那个被移走并留档备查"。
      const parked = result.moved.find(name => name.includes("-shm.broken-"));
      assert.ok(parked && existsSync(parked), `被移开的 sidecar 应留档备查：${result.moved.join("、")}`);
      assert.ok(result.moved.every(name => name.includes("olivia-local.sqlite")), "只能动 sidecar，不能动主库");
      assert.equal(existsSync(path), true, "主库文件必须还在");
      assert.equal(result.db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1, "重开后数据可读");
    } finally { result.db.close(); }
  } finally { cleanupDirSync(dir); }
});
