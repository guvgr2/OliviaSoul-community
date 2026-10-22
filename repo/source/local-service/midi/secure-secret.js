// 敏感值落盘（API Key）——Windows DPAPI，按「当前用户 + 当前机器」绑定。
//
// 为什么要有这个文件（2026-10-19 数据安全审计）：
//   `model.env` 原来是明文 `MODEL_DEEPSEEK_API_KEY=sk-...`，而 UserData 目录的 ACL 默认是
//   `BUILTIN\Users:(RX)` —— 同一台机器上的**其他标准用户**能直接读到；用户手动打包/同步
//   UserData 时 Key 也会跟着走（导出包与诊断包已排除它，手动拷贝不受控）。
//
// 设计取舍（与竞品 bside-olivia 的差异，写清楚免得后人以为是漏做）：
//   · 竞品把「配置」与「密文」拆成两个文件（`llm.json` + `api_key.dpapi`）。
//     我们没有拆：写信 harness（`.cursor/skills/fit-letters/scripts/model-call.ps1`）是**直接读
//     model.env** 取 Key 的 PowerShell 脚本，拆文件就得让两处真相同时在线；保持单文件 +
//     `dpapi-v1:` 前缀，改一处、验一处。安全目标（磁盘上没有明文 Key）与拆文件完全等价。
//   · 前缀带版本号（`dpapi-v1:`）是为了将来换算法/换作用域时能识别旧数据。
//
// 调用方式：`powershell -NoProfile -NonInteractive -Command <script>`，值走 **stdin**
// （命令行参数会出现在进程列表里，等于把 Key 明码写在任务管理器上）。
import { execFile } from "node:child_process";

export const SECRET_PREFIX = "dpapi-v1:";

// 单次调用实测约 600ms（本机 PowerShell 冷启动为主）。所以：
//   ① 探测只做一次（`probe` 缓存 Promise）；
//   ② 解出来的明文按**密文串**缓存 —— DPAPI 每次加密结果都不同，密文本身就是天然的缓存键，
//      同一份配置反复读不会反复起进程。
// ⚠️ 编码坑（2026-10-19 实测踩到）：PowerShell 的 `[Console]::In.ReadToEnd()` 用的是**控制台
//   OEM 代码页**（本机 936/GBK），而 node 往 stdin 写的是 UTF-8 字节 ⇒ 非 ASCII 的 Key（或任何
//   带中文的测试串）会被按 GBK 解成乱码：`sk-往返-…` 变成 `sk-往�?…`。
//   所以两边都**走原始字节**：stdin 用 OpenStandardInput 读字节、stdout 用 base64 回传，
//   全程不经过任何文本编码。Key 本身通常是 ASCII，但这个坑不能等到「有人说中文密码用不了」才修。
const READ_STDIN_BYTES = [
  "Add-Type -AssemblyName System.Security;",
  "$ms=New-Object System.IO.MemoryStream;",
  "[Console]::OpenStandardInput().CopyTo($ms);",
  "$bytes=$ms.ToArray();",
].join(" ");
const PROTECT_SCRIPT = [
  READ_STDIN_BYTES,
  "$p=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Convert]::ToBase64String($p))",
].join(" ");
const UNPROTECT_SCRIPT = [
  READ_STDIN_BYTES,
  "$raw=[Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($bytes));",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join(" ");

// ★ 2026-10-19 第四轮审查 N2：PowerShell 的**错误文本**是按控制台 OEM 代码页（本机 936/GBK）
//   写出来的，而 `encoding:"utf8"` 会把 GBK 字节当 UTF-8 解 ⇒ 中文报错变成一整屏 `ʹá3á…`。
//   以前没人显示它（keyError 没有消费方），所以一直没暴露；一旦把它接上界面就是一屏乱码。
//   修法：先把子进程输出当**字节**，按 UTF-8 严格解，解不开再按 GB18030（覆盖 GBK/GB2312）解。
export function decodeConsoleText(chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
  if (!bytes.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return bytes.toString("utf8");
    }
  }
}

export class SecretError extends Error {
  constructor(message, code = "SECRET_DPAPI_FAILED") {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}

function runPowerShell(script, input) {
  psInvokeCount += 1;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        // 见 decodeConsoleText：按字节拿回来再自己解，别让 node 按 UTF-8 硬解 GBK 报错。
        encoding: "buffer",
        windowsHide: true,
        // ★ 20s → 60s（2026-10-19 门禁实测）：并行跑全套测试时机器上有十几个 node 进程各自
        //   起 PowerShell，冷启动被拖到 10s 以上，20s 的预算会偶发超时（secure-secret 套件在门禁里
        //   跑了 125s 才判失败，单跑只要 10s）。这个函数只在「存/读配置」时调用，不该让用户看到超时。
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // 不要把 input（可能是密钥）带进错误信息里。
          reject(new SecretError(`DPAPI 调用失败：${decodeConsoleText(stderr).trim() || error.message}`, "SECRET_DPAPI_UNAVAILABLE"));
          return;
        }
        resolve(decodeConsoleText(stdout).replace(/\r?\n$/u, ""));
      },
    );
    child.on("error", error => reject(new SecretError(`无法启动 powershell：${error.message}`, "SECRET_DPAPI_UNAVAILABLE")));
    child.stdin.end(input, "utf8");
  });
}

// ★ 串行化：PowerShell 冷启动本身就要 600ms 上下，并行起 N 个只会互相抢 CPU、把每个都拖到秒级。
//   用一条 Promise 链把它们排成一队（同时最多一个子进程）。加解密本身是毫秒级操作，
//   排队带来的延迟远小于「N 个 PowerShell 抢 CPU」的代价。
let psQueue = Promise.resolve();
function runPowerShellSerial(script, input) {
  const next = psQueue.then(() => runPowerShell(script, input), () => runPowerShell(script, input));
  // 队列本身不能被拒绝态卡死：无论成败，下一位都能继续。
  psQueue = next.then(() => {}, () => {});
  return next;
}

/** 这个值是不是已经加密过（带 dpapi-v1: 前缀）。 */
export function isEncrypted(value) {
  return String(value ?? "").startsWith(SECRET_PREFIX);
}

/** 把明文加密成 `dpapi-v1:<base64>`；不可用时抛 SecretError（**绝不静默退回明文**）。 */
export async function protectSecret(plain) {
  const text = String(plain ?? "");
  if (!text) return "";
  const base64 = await runPowerShellSerial(PROTECT_SCRIPT, text);
  if (!base64) throw new SecretError("DPAPI 返回空密文", "SECRET_DPAPI_EMPTY");
  return `${SECRET_PREFIX}${base64}`;
}

// 密文 -> **解出的明文**。DPAPI 每次加密结果都不同，密文本身就是天然的缓存键。
//
// ★ 存的是 Promise 不是明文（2026-10-19 第四轮审查 N3）：原来存明文，`Promise.all` 里并发 6 次
//   解同一份密文时，6 个调用**同时**跑到缓存查询这一步（都还没写入），于是 6 个一起进队列
//   ⇒ 起 6 个 PowerShell。当时那条用例的阈值是 60s，所以「把缓存删掉它还是绿」。
//   存 Promise 之后并发是 1 个进程，且断言可以改成**数进程个数**（与机器负载无关）。
//
// ★ 有上限（同轮 N6）：每次保存都产生一份新密文 ⇒ 一条新缓存，明文常驻内存且**无上限**。
//   规模很小，但「明文 + 无上限」这两件事放一起值得收口：只留最近 MAX_REVEAL_CACHE 条。
export const REVEAL_CACHE_LIMIT = 32;
const revealCache = new Map();

// 单测/自查用：这一进程里到底起过几个 powershell。判据要能证伪，就得数「起了几个」，
// 而不是测「花了多久」（后者随机器负载漂，门禁并发下会假红）。
let psInvokeCount = 0;
export function powerShellInvokeCount() {
  return psInvokeCount;
}

/**
 * 解出明文。没带前缀的值**原样返回**（兼容老版本留下的明文配置，迁移由调用方负责）。
 */
export async function revealSecret(stored) {
  const value = String(stored ?? "");
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  const hit = revealCache.get(value);
  if (hit !== undefined) return hit;
  const pending = runPowerShellSerial(UNPROTECT_SCRIPT, value.slice(SECRET_PREFIX.length))
    .then(base64 => Buffer.from(String(base64).trim(), "base64").toString("utf8"))
    .catch(error => {
      // 失败的别留在缓存里：否则同一个坏密文会被永久记住「解不开」，换了机器也回不来。
      revealCache.delete(value);
      throw error;
    });
  revealCache.set(value, pending);
  if (revealCache.size > REVEAL_CACHE_LIMIT) {
    // Map 的迭代顺序 = 插入顺序，第一个就是最老的。
    revealCache.delete(revealCache.keys().next().value);
  }
  return pending;
}

let probe = null;
/**
 * DPAPI 在本机是否可用（结果缓存）。返回 `{ ok, reason }`，不抛。
 * 用途：启动时**主动报一次**，别等用户保存 Key 时才发现存不了。
 */
export function secretBackendStatus() {
  if (!probe) {
    probe = (async () => {
      try {
        const encrypted = await protectSecret("olivia-dpapi-probe");
        const back = await revealSecret(encrypted);
        if (back !== "olivia-dpapi-probe") return { ok: false, reason: "DPAPI 往返结果不一致" };
        return { ok: true, reason: "" };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    })();
  }
  return probe;
}

/** 单测用：清掉缓存（改了实现或换了机器后重测）。 */
export function resetSecretCaches() {
  probe = null;
  revealCache.clear();
  psInvokeCount = 0;
}
