// Windows 上 SQLite 的伴随文件（-wal / -shm）在连接关闭后，内核句柄还会延迟释放一小段时间
// （实测 10~24ms）。这期间 unlink 会"成功"但目录项进入 pending-delete，紧接着 rmdir 父目录
// 就会报 ENOTEMPTY —— 表现是测试清理阶段偶发红，与被测行为无关。
//
// Node 的 fs.rm 自带针对 EBUSY / EMFILE / ENFILE / ENOTEMPTY / EPERM 的退避重试，
// 只是默认 maxRetries = 0。这里把它打开即可，不需要自己写循环。
//
// ★ 只对上述几个"资源暂时不可用"的错误码重试，其它错误（EACCES 等真问题）原样抛出，
//   绝不掩盖真实缺陷。
import { rm } from "node:fs/promises";
import { rmSync } from "node:fs";

// ★ 2026-10-20 两小时压测补：本机安全软件的 safe-delete 垫片（`genie-trash`）在满负载下会报
//   **ETIMEDOUT** —— 它不在 Node rm 的内建重试表里（EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM），
//   于是清理阶段的偶发超时被算到测试头上（A#020 一次，同文件 3 个用例连锁红，其中一条本该豁免）。
//   这里在外面再套一层**只针对 ETIMEDOUT** 的有界重试：删除是幂等的，重试不会掩盖产品缺陷；
//   真删不掉（6 次都超时）仍然原样抛出，不吞错。
const TIMEOUT_RETRIES = 5;
const timeoutBackoff = attempt => 200 * (attempt + 1);

const retryOnTimeout = async run => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== "ETIMEDOUT" || attempt >= TIMEOUT_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, timeoutBackoff(attempt)));
    }
  }
};

const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const retryOnTimeoutSync = run => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (error?.code !== "ETIMEDOUT" || attempt >= TIMEOUT_RETRIES) throw error;
      sleepSync(timeoutBackoff(attempt));
    }
  }
};

export const cleanupDir = (dir) =>
  retryOnTimeout(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// ★ 2026-10-19 补：第一批改造时故意跳过了 3 个「没写 force:true」的清理点，
//   理由是加 force 会把 ENOENT 一起吞掉 —— 那三处的语义是「这个路径必须存在，不存在就是前提被破坏」。
//   但不给重试同样等于把 ENOTEMPTY 的风险留在那儿。所以补一个不带 force 的版本：
//   retryDelay/maxRetries 只对 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM 生效，
//   ENOENT 仍然立刻抛出（Node 的 retry 列表里没有它），语义与原调用完全一致。
export const cleanupDirStrict = (dir) =>
  retryOnTimeout(() => rm(dir, { recursive: true, maxRetries: 10, retryDelay: 100 }));

// ★ 2026-10-19 压测补：上一轮只扫了异步 `rm`，**同步 `rmSync` 整族 23 处漏网**。
//   阶段 B 在 db-self-heal.test.js 上抓到 4 次 ENOTEMPTY（`heal-ok-*` / `heal-other-*` 临时目录），
//   根因就是这批。rmSync 同样支持 maxRetries / retryDelay（Node 14.14+），一并打开。
export const cleanupDirSync = (dir) =>
  retryOnTimeoutSync(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// 单文件版（原来写的是 rmSync(file, { force: true })，不带 recursive —— 保持原样，只加重试）
export const cleanupFileSync = (file) =>
  retryOnTimeoutSync(() => rmSync(file, { force: true, maxRetries: 10, retryDelay: 100 }));
