// 补丁失效即时提醒（1.0.5）。
//
// 真实痛点：Steam / 官方更新游戏时会把 feapp.dat（有时还有 webplayer.dat）覆盖回原版，
// 补丁就没了 —— 游戏连不上本机服务：界面补丁不显示、歌词 / 续播 / 播放器命令都不生效。
// 而界面上唯一的提示只是「客户端与桌面」页签上的角标，用户没有任何理由去点它。
//
// 做法：记住上一次已知的挂载状态，界面加载 / 服务就绪后对比：
//   · 之前 mounted=true，现在 feappMounted 或 webplayerMounted 变 false（被覆盖 / 失效）→ 用既有通知提示**一次**；
//   · 之前也未挂载（首次安装、还没打过补丁）→ 不提示，免得吓人；
//   · 同一状态只提示一次：关掉后不再重复；状态再次变化（例如重打补丁后又失效）才再提示；
//   · 不阻塞启动与服务就绪（notify 只发起、不 await），出错只记日志。
//
// 存储复用既有的本地存储对象（app.js 的 noticeStorage，与 tab-notices 同一个 localStorage）。
// 必须跨重启记住：Steam 更新通常发生在程序没开的时候，重启后要能发现「上次还是挂载的，现在没了」。
// 本地存储不可用时退化为进程内记忆 —— 本次会话行为不变，只是不跨重启。
const KNOWN_KEY = "olivia.client-mount-known.v1";
const NOTIFIED_KEY = "olivia.client-mount-notified.v1";

export const PATCH_LOSS_KINDS = Object.freeze(["feapp", "webplayer"]);

function readRecord(storage, key, memory) {
  try {
    const raw = storage?.getItem(key);
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* 存储不可用或内容损坏：退回进程内记忆，别把提醒本身变成故障 */ }
  return memory;
}

function writeRecord(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* 写不进去就算了，最多下次多提示一次 */ }
}

function readText(storage, key, memory) {
  try {
    const raw = storage?.getItem(key);
    if (typeof raw === "string") return raw;
  } catch { /* 同上 */ }
  return memory;
}

function writeText(storage, key, value) {
  try { storage?.setItem(key, value); } catch { /* 同上 */ }
}

/**
 * 「上次状态 → 这次状态」之间哪几边的补丁失效了（没有则空数组）。
 * 只有「上次确实挂载过」才算失效：没打过补丁的用户不该被提醒。
 */
export function lostPatchKinds(previous, current) {
  if (!previous || previous.mounted !== true) return [];
  // 换了游戏客户端不算「补丁失效」：那是另一份游戏目录，本来就没打过补丁。
  if (previous.clientExe && current.clientExe && previous.clientExe !== current.clientExe) return [];
  const lost = [];
  if (previous.feappMounted === true && current.feappMounted !== true) lost.push("feapp");
  if (previous.webplayerMounted === true && current.webplayerMounted !== true) lost.push("webplayer");
  return lost;
}

function snapshot(status) {
  return {
    clientExe: typeof status.clientExe === "string" ? status.clientExe : "",
    mounted: status.mounted === true,
    feappMounted: status.feappMounted === true,
    webplayerMounted: status.webplayerMounted === true,
  };
}

export function createPatchLossNotice({ storage, notify, log = () => {} } = {}) {
  let memoryKnown = null;
  let memoryNotified = "";

  /**
   * 对比并（必要时）提醒一次。
   * expectedChange=true：这次状态变化是我们自己造成的（用户点「停用服务」/「回退补丁」），
   * 只记录、不提醒 —— 否则用户主动还原原版反而会收到「补丁失效」的惊吓。
   */
  function observe(status, { expectedChange = false } = {}) {
    try {
      if (!status || typeof status !== "object" || status.clientSelected !== true)
        return { notified: false, reason: "no-client" };
      const current = snapshot(status);
      const previous = readRecord(storage, KNOWN_KEY, memoryKnown);
      memoryKnown = current;
      writeRecord(storage, KNOWN_KEY, current);
      if (current.mounted) {
        // 补丁又装回去了：清掉「已提醒」标记，将来再失效才会重新提醒。
        memoryNotified = "";
        writeText(storage, NOTIFIED_KEY, "");
        return { notified: false, reason: "mounted" };
      }
      const lost = expectedChange ? [] : lostPatchKinds(previous, current);
      if (lost.length === 0)
        return { notified: false, reason: !previous ? "first-run" : expectedChange ? "expected" : "unchanged" };
      const signature = lost.join("+");
      if (readText(storage, NOTIFIED_KEY, memoryNotified) === signature)
        return { notified: false, reason: "already-notified", lost };
      memoryNotified = signature;
      writeText(storage, NOTIFIED_KEY, signature);
      if (typeof notify === "function") notify({ lost: [...lost], previous, current });
      return { notified: true, reason: "notified", lost };
    } catch (error) {
      // 提醒是锦上添花：任何异常都不许影响页面与启动，只记日志。
      try { log(error); } catch { /* 连日志都失败就彻底放弃 */ }
      return { notified: false, reason: "error" };
    }
  }

  return { observe };
}
