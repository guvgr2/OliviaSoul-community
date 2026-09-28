// 数据库自愈测试：测逻辑本身，不依赖 SQLite 的具体报错措辞
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainDatabaseLooksIntact, openDatabaseHealing } from "../midi/db-self-heal.js";

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

test("正常数据库：直接打开，不产生也不改动任何文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-ok-"));
  try {
    const path = makeDatabase(dir);
    const before = readdirSync(dir).sort();
    const result = openDatabaseHealing(path, () => openPlain(path));
    try {
      assert.equal(result.healed, false, "正常库不应触发自愈");
      assert.equal(result.db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
    } finally { result.db.close(); }
    assert.deepEqual(readdirSync(dir).sort(), before, "目录内容不应变化");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("非损坏类错误：原样抛出，连完整性检查都不做", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-other-"));
  try {
    const path = makeDatabase(dir);
    const before = readdirSync(dir).sort();
    const failOpen = () => { throw new Error("EACCES: permission denied"); };
    assert.throws(() => openDatabaseHealing(path, failOpen), /EACCES/u);
    assert.deepEqual(readdirSync(dir).sort(), before, "不该动任何文件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("主库自身损坏：判为不完整，绝不擅自清理，原样抛出", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-bad-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(path, Buffer.alloc(8192, 0x41)); // 覆盖主库头部
    assert.equal(mainDatabaseLooksIntact(path), false, "损坏的主库不应判为完好");
    const shm = `${path}-shm`;
    writeFileSync(shm, Buffer.alloc(4096, 7)); // 放一个残留 sidecar
    const before = readdirSync(dir).sort();
    const failOpen = () => { throw new Error("database disk image is malformed"); };
    assert.throws(() => openDatabaseHealing(path, failOpen), /malformed/u);
    assert.deepEqual(readdirSync(dir).sort(), before, "主库坏了就不能动任何文件（含 sidecar）");
    assert.equal(existsSync(shm), true, "残留 sidecar 必须原样保留");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
