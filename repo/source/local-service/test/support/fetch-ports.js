// WHATWG Fetch blocks these ports before making a request. Windows ephemeral
// ranges can be customized, so listen(0) may occasionally select one of them.
export const blockedFetchPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

// ★ 2026-10-20 第六轮复验 §6d：上面这份**手抄名单漏过 6679**（Node 内嵌 82 条 / 这里 81 条），
//   而本机动态端口 1024 起、顺序 +1 扫描 ⇒ `listen(0)` 迟早落到它身上，
//   表现为 `TypeError: fetch failed / bad port`，**产品毫无问题**，但门禁对
//   relay-compatibility 是 Count=0 ⇒ 一次命中误拦一次发版（本轮压测已实测命中 1 次）。
//   名单只当**快速路径**，真正的判据来自运行时：
//     · `portIsFetchable()` 真发一次 fetch 问 Node「这个端口到底能不能用」；
//     · `listenOnFetchablePort()` 绑完端口后除了查名单，还要问一次运行时。
//   这样名单再烂掉也只是「多绕一圈」，不会再把假红放出去；Node 换版本也不用同步名单。
//
// ★ 探针地址用 **127.0.0.2**（另一个环回别名，通常没人监听）而不是 127.0.0.1：
//   ① 坏端口立刻 `bad port`（0–20ms），好端口立刻 `ECONNREFUSED`（1–5ms），区分度足够；
//   ② 更关键 —— 它**不会碰到 127.0.0.1 上测试自己刚绑好的服务**。
//      若探针打到自己服务上，等于每次 bind 都多一个 HTTP 请求，
//      会污染「请求计数 / 请求顺序 / 服务日志」这类断言，也会让慢响应拖长 bind。
//   （实测只有 fetch 拦禁用端口：`net.connect` / `http.get` 对 6679 都是 ECONNREFUSED，
//     所以探针必须走 fetch；而 127.0.0.2 保证这次 fetch 落到一个没人听的地方。）
const PROBE_HOST = "127.0.0.2";
const PROBE_TIMEOUT_MS = 2000;
const probeCache = new Map();

/**
 * 运行时问 Node：这个端口到底能不能被 fetch 用（不依赖任何名单）。
 * @returns {Promise<boolean>} true = 可以用；false = 会被 fetch 拒（bad port）。
 * ★ 只在拿到明确答案 `bad port` 时返回 false；其它一律 true（fail-open）——
 *   探针本身出错（网络栈异常等）不该把好端口也毙掉，那会造成另一种假红。
 */
export async function portIsFetchable(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return true;
  if (probeCache.has(port)) return probeCache.get(port);
  let usable = true;
  try {
    await fetch(`http://${PROBE_HOST}:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    usable = true; // 127.0.0.2 上真有服务在听（极罕见）⇒ 端口没问题
  } catch (error) {
    const cause = error?.cause;
    const code = cause?.code ?? cause?.message;
    usable = !(code === "bad port" || String(cause?.message ?? "") === "bad port");
  }
  probeCache.set(port, usable);
  return usable;
}

/** 仅供测试复位用：探针结果按端口缓存，避免同一端口反复 fetch。 */
export function resetPortProbeCache() {
  probeCache.clear();
}

// ★ 2026-10-19 第四轮审查 N1：只导出上面这份名单是不够的 —— 每个测试文件都得自己写
//   「绑到禁用端口就关掉重绑」的 while 循环，结果 41 个文件里只有 6 个写了 ⇒ 其余 35 个
//   全裸奔。这**不是小概率事件**：本机动态端口从 1024 起、且 Windows 是**顺序 +1 扫描**
//   （实测 3000 次采样相邻差恒为 1）⇒ 全局指针扫过 1024..65535 里那 18 个禁用端口的
//   时间窗口内，正在 bind 的测试**全中**。表现为 `TypeError: fetch failed / bad port`，
//   而产品毫无问题 —— 命中一次就误拦一次发版。
//   ⇒ 统一到这里：所有 `listen(0)` 都改调 `listenOnFetchablePort()`。
//
// 形态：既吃 `createOliviaService()` 的返回值（async `listen(port, host)` 返回 address，
// 本体在 `.server`），也吃原生 `http/net` 的 server（`listen(port, host, cb)` + `address()`）。
function bindOnce(target, server, host) {
  const result = target.listen(0, host);
  // service.listen 是 async，直接给 address；原生 server 同步返回自己，得等 'listening'。
  if (result && typeof result.then === "function") {
    return Promise.resolve(result).then(address => address ?? server.address());
  }
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address());
    };
    const onError = error => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

/**
 * 绑到一个 **fetch 允许**的端口，返回 address（含 `.port`）。
 * 撞上禁用端口就关掉重绑 —— 本机顺序扫描下，下一次几乎必然换个端口。
 *
 * 两道闸：先查手抄名单（快，毫秒级），再问一次运行时（真 fetch）。
 * 名单漏项（§6d 的 6679 就是这么漏的）由第二道兜住 ⇒ 名单降级成快速路径。
 */
export async function listenOnFetchablePort(target, host = "127.0.0.1", maxAttempts = 64) {
  const server = target.server ?? target;
  let lastPort = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const address = await bindOnce(target, server, host);
    lastPort = address?.port ?? null;
    if (!blockedFetchPorts.has(lastPort) && (await portIsFetchable(lastPort))) return address;
    await new Promise(resolve => server.close(resolve));
  }
  throw new Error(`listen(0) 连续 ${maxAttempts} 次都落在 fetch 的禁用端口上（最后一次是 ${lastPort}）`);
}
