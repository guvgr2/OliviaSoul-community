// g23（实验性）：MP4 索引前置（faststart）缓存。
//
// 问题：本地作品多为 `ftyp + mdat + moov` 结构，moov（解码索引）落在文件末尾。
// 浏览器/内嵌播放器必须先拿到 moov 才知道怎么解，于是要先跳到文件末尾读一次 ——
// 表现就是切歌"卡几秒"，而同一首重播却很快（已经缓存过索引）。
//
// 做法：用随包的 ffmpeg 做一次**无损重封装**（-c copy -movflags +faststart），
// 把 moov 挪到文件头，产物放到 `<应用数据根>/.faststart-cache/<内容哈希>/<变体>.mp4`。
//   * 绝不修改原始媒体文件；
//   * 绝不写进用户的曲库目录（缓存只落在应用自己的数据目录）；
//   * 目录名用内容哈希 —— 文件内容一变哈希就变，旧缓存自动失效，不可能播错内容；
//   * 生成是后台的，不阻塞当前这次播放（这一首仍用原文件，之后的就是秒开）。
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function createFaststartCache({
  root,
  ffmpegPath,
  runProcess,
  log = () => {},
  maxConcurrent = 1,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  const cacheRoot = join(root, ".faststart-cache");
  const inFlight = new Set();
  const confirmed = new Set();
  let closed = false;

  function cachePathFor(contentHash, variantKey) {
    if (!HASH_PATTERN.test(String(contentHash ?? ""))) return null;
    const safeKey = String(variantKey ?? "DEFAULT").replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "DEFAULT";
    return join(cacheRoot, contentHash, `${safeKey}.mp4`);
  }

  /** 缓存可用：存在、非空、且不早于源文件（源文件被换掉时保险作废）。 */
  function usable(target, originalPath) {
    try {
      const cached = statSync(target);
      const original = statSync(originalPath);
      return cached.isFile() && cached.size > 0 && cached.mtimeMs >= original.mtimeMs - 1000;
    } catch { return false; }
  }

  function schedule(originalPath, target) {
    if (closed || inFlight.has(target) || inFlight.size >= maxConcurrent) return;
    inFlight.add(target);
    const temporary = `${target}.part`;
    void (async () => {
      try {
        mkdirSync(dirname(target), { recursive: true });
        rmSync(temporary, { force: true });
        await runProcess(ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", originalPath,
          "-c", "copy", "-movflags", "+faststart",
          temporary,
        ], { timeoutMs });
        if (existsSync(temporary) && statSync(temporary).size > 0) {
          renameSync(temporary, target);
          log(`[faststart] 已为 ${originalPath} 生成索引前置副本`);
        } else {
          throw new Error("产物为空");
        }
      } catch (error) {
        // 失败只是"这次优化没生效"，绝不能影响播放本身。
        log(`[faststart] 生成失败（不影响播放）：${error?.message ?? error}`);
        try { rmSync(temporary, { force: true }); } catch { /* 忽略 */ }
      } finally {
        inFlight.delete(target);
      }
    })();
  }

  /**
   * 播放时调用（同步）：能用缓存就返回缓存路径；否则返回 null 并后台生成一次。
   * 返回 null 时调用方继续用原文件，行为与优化前完全一致。
   */
  function prefer(originalPath, contentHash, variantKey) {
    if (closed || !ffmpegPath || !originalPath) return null;
    if (extname(originalPath).toLowerCase() !== ".mp4") return null;
    const target = cachePathFor(contentHash, variantKey);
    if (!target) return null;
    if (confirmed.has(target)) return target;
    if (usable(target, originalPath)) { confirmed.add(target); return target; }
    schedule(originalPath, target);
    return null;
  }

  return {
    prefer,
    cacheRoot,
    /** 供测试/诊断：当前有多少个生成任务在跑 */
    pendingCount: () => inFlight.size,
    close() { closed = true; },
  };
}
