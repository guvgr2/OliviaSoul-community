// 数据库打开自愈（只在真的打不开时才动手）。
//
// 背景（真实事故）：数据搬家时目标的 -shm/-wal 删不掉（被本进程长连接占着），
// 旧代码把删除失败吞掉、照样替换主库，于是「空库的 -shm + 真实主库」配成一对，
// SQLite 一打开就报 `database disk image is malformed`，用户以为数据没了。
//
// 设计原则：
//   1. 正常路径【一个文件都不碰】—— 不做预检探测（只读打开本身也会创建 -wal/-shm，那是副作用）；
//   2. 只有在"打开确实失败 + 错误是数据库损坏"时，才判断主库是否完好；
//   3. 主库完好 → 把可重建的 -wal/-shm 挪走（保留 .broken-* 备查），重开一次；
//   4. 主库自己也坏了 → 原样抛出，绝不擅自改动数据文件。
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_CORRUPTION = /malformed|not a database|unsupported file format/iu;

function sidecarPaths(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`];
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
 * 打开数据库；失败且属于「sidecar 与主库不匹配」时自愈一次。
 *
 * @param {string} databasePath
 * @param {() => any} open 真正打开数据库的函数（失败时会再次调用它）
 * @returns {{ db: any, healed: boolean, moved: string[] }}
 */
export function openDatabaseHealing(databasePath, open, { log = () => {} } = {}) {
  try {
    return { db: open(), healed: false, moved: [] };
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
      const parked = `${sidecar}.broken-${stamp}`;
      try {
        renameSync(sidecar, parked);
        moved.push(parked);
      } catch {
        try { rmSync(sidecar, { force: true }); moved.push(`${sidecar}（无法改名，已删除）`); }
        catch { /* 删不掉就放弃 */ }
      }
    }
    log(`[db-self-heal] 残留的 WAL/SHM 与主库不匹配，已移开：${moved.join("、") || "（目录里没有 sidecar）"}`);
    return { db: open(), healed: true, moved };
  }
}
