// 数据库打开自愈（g24 加强版）
//
// 背景（真实事故 ×2）：
//   ① 数据搬家时旧 -shm 没清掉、主库却换了 → SQLite 打开即报
//      `database disk image is malformed`；g21 为此加了一层自愈。
//   ② 但 g21 那版**漏了两种形态**，导致用户又遇到一次（g23 上实测）：
//
//   漏洞①：自愈只在 `initDatabase()` **抛错**时才动手。SQLite 是**惰性读取**的，
//          启动时那句 `SELECT 1` 根本碰不到出问题的页 → "打开成功" → 自愈睡过去了，
//          等 20 秒后时长修复 / storage-refresh 真读数据时才满屏报 malformed。
//          → 本版把探测换成**真实读**（默认读 sqlite_master，可传入业务查询）。
//
//   漏洞②：实际形态常常是「主库完好 + 陈旧的 -shm（-wal 是 0 字节）」。
//          空的 WAL 不可能有有效的共享内存索引，这种 -shm 必然是崩溃/强杀/换版遗留的。
//          → 本版在启动打开之前，主动清掉这种**明显不一致**的伴随文件。
//
// 设计原则不变：
//   1. 正常路径【一个文件都不碰】；
//   2. 只在"打不开 / 真实读失败 / 形态明显矛盾"时动手；
//   3. 只碰 -wal / -shm 这两个可重建的伴随文件，**永不改动主库**；
//   4. 主库自身也坏了 → 原样抛出，绝不擅自清理。
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_CORRUPTION = /malformed|not a database|unsupported file format|file is encrypted/iu;

function sidecarPaths(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`];
}

/** 把伴随文件挪到 .broken-<时间戳> 留档；挪不动就删；都不行返回 null。 */
function parkSidecar(file, stamp) {
  const parked = `${file}.broken-${stamp}`;
  try {
    renameSync(file, parked);
    return parked;
  } catch {
    try { rmSync(file, { force: true }); return `${file}（无法改名，已删除）`; }
    catch { return null; }
  }
}

/**
 * g24：启动打开数据库之前，清掉「明显不一致」的残留伴随文件。
 *
 * 判据：`-shm` 存在，但 `-wal` 不存在或为 **0 字节** —— 空的 WAL 不可能有有效的共享内存
 * 索引，这种 -shm 必然是陈旧的（崩溃、被强杀、换版遗留）。**主库不动。**
 *
 * 只应在服务启动、确认没有其它实例占用该库时调用。
 */
export function cleanStaleSidecars(databasePath, { log = () => {} } = {}) {
  try {
    if (!existsSync(databasePath)) return { cleaned: false, moved: [] };
    const shm = `${databasePath}-shm`;
    if (!existsSync(shm)) return { cleaned: false, moved: [] };

    const wal = `${databasePath}-wal`;
    const walSize = existsSync(wal) ? statSync(wal).size : -1;
    if (walSize > 0) return { cleaned: false, moved: [] }; // WAL 里有真实内容 → 不能动

    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const moved = [];
    const parkedShm = parkSidecar(shm, stamp);
    if (parkedShm) moved.push(parkedShm);
    if (existsSync(wal)) {
      const parkedWal = parkSidecar(wal, stamp);
      if (parkedWal) moved.push(parkedWal);
    }
    if (moved.length) {
      log(`[db-self-heal] 发现陈旧的伴随文件（-shm 在、-wal 为空），已移开：${moved.join("、")}`);
    }
    return { cleaned: moved.length > 0, moved };
  } catch (error) {
    log(`[db-self-heal] 清理陈旧伴随文件失败（继续启动）：${error instanceof Error ? error.message : error}`);
    return { cleaned: false, moved: [] };
  }
}

/** 主库自身是否完好：复制到临时目录（刻意不带 sidecar）后再只读检查。 */
export function mainDatabaseLooksIntact(databasePath) {
  if (!existsSync(databasePath)) return false;
  const sandbox = mkdtempSync(join(tmpdir(), "olivia-dbcheck-"));
  let db = null;
  try {
    const copy = join(sandbox, "probe.sqlite");
    copyFileSync(databasePath, copy);
    db = new DatabaseSync(copy, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all();
    return rows.length > 0 && rows.every(row => String(Object.values(row)[0]).toLowerCase() === "ok");
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * 打开数据库；打不开、或**真实读探测**发现惰性损坏时，自愈一次。
 *
 * @param {string} databasePath
 * @param {() => any} open 真正打开数据库的函数（需要时会再次调用）
 * @param {{ log?: (message: string) => void, verify?: (db: any) => void }} [options]
 *        verify 传真实读探测；不传则读 sqlite_master（比 SELECT 1 深，能碰到 schema 页）
 * @returns {{ db: any, healed: boolean, moved: string[] }}
 */
export function openDatabaseHealing(databasePath, open, { log = () => {}, verify } = {}) {
  // 关键：必须"真读一次"——否则 SQLite 的惰性损坏会被当成"打开成功"
  const probe = db => {
    if (typeof verify === "function") verify(db);
    else db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
  };

  const openAndVerify = () => {
    const db = open();
    try {
      probe(db);
    } catch (error) {
      try { db.close(); } catch { /* 忽略 */ }
      throw error;
    }
    return db;
  };

  try {
    return { db: openAndVerify(), healed: false, moved: [] };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!SQLITE_CORRUPTION.test(message)) throw error;
    if (!mainDatabaseLooksIntact(databasePath)) {
      log("[db-self-heal] 主库自身也不完整，未做任何自动清理（请从备份恢复）");
      throw error;
    }

    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const moved = [];
    for (const sidecar of sidecarPaths(databasePath)) {
      if (!existsSync(sidecar)) continue;
      const parked = parkSidecar(sidecar, stamp);
      if (parked) moved.push(parked);
    }
    log(`[db-self-heal] 残留的 WAL/SHM 与主库不匹配，已移开：${moved.join("、") || "（目录里没有 sidecar）"}`);

    // 重开后同样真读验证；仍然失败就抛给上层，不再掩盖
    return { db: openAndVerify(), healed: true, moved };
  }
}
