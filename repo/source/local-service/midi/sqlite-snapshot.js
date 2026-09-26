// 数据库快照（g14 补充）：给"备份"提供一条真正可靠的路。
//
// 背景（实测发现）：node:sqlite 的 DatabaseSync **没有 backup() 方法**（Node v22.22 的
// 原型上只有 open/close/prepare/exec/function/location/aggregate/createSession/applyChangeset/
// enableLoadExtension/loadExtension），所以各模块里 `if (typeof source.backup === "function")`
// 那条分支**从未生效**，备份一直靠"直接复制主库文件"。
//
// 而库是 WAL 模式：刚写入还没 checkpoint 的数据只存在于 olivia-local.sqlite-wal 里，
// 此时复制主库文件会**漏掉最近的提交** —— "改时段前先备份""写曲名前先备份"恰恰最容易
// 撞在这个窗口上。所以复制前必须先把 WAL 合并回主库。
import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 把 WAL 里已提交的内容合并回主库文件（TRUNCATE 顺带清空日志）。
 * 不是 WAL 模式时是无害的 no-op；库打不开或被独占就返回 false，由调用方决定是否继续。
 */
export function checkpointWal(databasePath) {
  try {
    const db = new DatabaseSync(databasePath);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
    return true;
  } catch { return false; }
}

/** 生成一份自包含的数据库快照：先 checkpoint，再复制，最后原子改名到位。 */
export async function snapshotDatabase(databasePath, target) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  try { await unlink(temporary); } catch { /* 不存在正常 */ }
  checkpointWal(databasePath);
  await copyFile(databasePath, temporary);
  await rename(temporary, target);
  return target;
}

/**
 * 清掉"打开备份文件"时顺带产生的 -wal / -shm。
 * 备份文件继承了 WAL 模式，任何只读打开都会给它建一对日志文件（通常是 0 字节），
 * 留着会让用户以为多了两个奇怪的备份。主文件内容已完整，删除是安全的。
 */
export async function cleanSidecars(file) {
  for (const suffix of ["-wal", "-shm"]) {
    try { await unlink(`${file}${suffix}`); } catch { /* 不存在正常 */ }
  }
}
