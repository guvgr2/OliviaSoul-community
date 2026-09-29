// g24 自愈加强的测试：重点是「陈旧伴随文件被清掉」与「真实读探测能触发自愈」
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStaleSidecars, mainDatabaseLooksIntact, openDatabaseHealing } from "../midi/db-self-heal.js";

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("没有 -shm 时不做事", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-none-"));
  try {
    const path = makeDatabase(dir);
    const before = readdirSync(dir).sort();
    assert.equal(cleanStaleSidecars(path).cleaned, false);
    assert.deepEqual(readdirSync(dir).sort(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("主库自身损坏时不擅自清理（与既有行为一致）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heal-bad-"));
  try {
    const path = makeDatabase(dir);
    writeFileSync(path, Buffer.alloc(8192, 0x41));
    assert.equal(mainDatabaseLooksIntact(path), false);
    const before = readdirSync(dir).sort();
    assert.throws(() => openDatabaseHealing(path, () => new DatabaseSync(path), {}));
    assert.deepEqual(readdirSync(dir).sort(), before, "主库坏了就不能动任何文件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
