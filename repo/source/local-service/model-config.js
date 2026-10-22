import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isEncrypted, protectSecret, revealSecret, decodeConsoleText } from "./midi/secure-secret.js";

export const DEFAULT_DEEPSEEK_PROFILE = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  authMode: "bearer",
  apiKey: "",
});

export const DEFAULT_LOCAL_PROFILE = Object.freeze({
  provider: "local",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "local-model",
  authMode: "none",
  apiKey: "",
});

const PROVIDERS = new Set(["deepseek", "local"]);
const AUTH_MODES = new Set(["bearer", "none"]);

function assertSingleLine(value, label) {
  const text = String(value ?? "");
  if (/[\r\n]/u.test(text)) throw new Error(`${label} 不能包含换行`);
  return text.trim();
}

function normalizeProvider(provider) {
  const value = assertSingleLine(provider, "provider");
  if (!PROVIDERS.has(value)) throw new Error("provider 只能是 deepseek 或 local");
  return value;
}

/** 回环 / 局域网 / 本机域名 —— 这些地址走明文 http 不构成"经过互联网被抓包"。 */
function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/gu, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home")) return true;
  if (host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 192 && second === 168) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 169 && second === 254) return true;   // 链路本地
    return false;
  }
  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;     // IPv6 ULA
  if (/^fe80:/u.test(host)) return true;                 // IPv6 链路本地
  return false;
}

function normalizeBaseUrl(value) {
  const text = assertSingleLine(value, "模型地址").replace(/\/+$/u, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("请填写有效的模型地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("请填写有效的模型地址");
  if (url.username || url.password || /[?#]/u.test(text))
    throw new Error("模型地址不能包含账号密码、查询参数或片段；密钥请填写到 API Key");
  // 公网地址必须走 https：明文 http 时 API Key 会作为请求头明文经过网络，
  // 同网段、出口链路上的任何程序都能抓到。本机与局域网地址不受此限制。
  if (url.protocol === "http:" && !isPrivateHost(url.hostname))
    throw new Error("公网地址请改用 https：明文 http 会让 API Key 在网络上明着传输（本机与局域网地址不受此限制）");
  if (/\/(messages|responses)$/iu.test(url.pathname.replace(/\/+$/u, "")))
    throw new Error("当前仅支持 Chat Completions 兼容接口，不支持原生 Messages / Responses 地址");
  return text.replace(/\/chat\/completions$/iu, "");
}

function normalizeProfile(provider, profile, { requireBearerKey = false } = {}) {
  const selected = normalizeProvider(provider);
  const authMode = assertSingleLine(profile.authMode, "鉴权方式") || (selected === "deepseek" ? "bearer" : "none");
  if (!AUTH_MODES.has(authMode)) throw new Error("鉴权方式只能是 bearer 或 none");
  const apiKey = assertSingleLine(profile.apiKey, "API Key");
  if (requireBearerKey && authMode === "bearer" && !apiKey) throw new Error("Bearer 鉴权需要填写 API Key");
  const model = assertSingleLine(profile.model, "模型名");
  if (!model) throw new Error("请填写模型名");
  return {
    provider: selected,
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    model,
    authMode,
    apiKey,
    keyConfigured: Boolean(apiKey),
  };
}

async function readEnvFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const values = {};
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return values;
}

function persistedProfile(provider, values, legacy, env) {
  const prefix = provider === "deepseek" ? "MODEL_DEEPSEEK" : "MODEL_LOCAL";
  const defaults = provider === "deepseek" ? DEFAULT_DEEPSEEK_PROFILE : DEFAULT_LOCAL_PROFILE;
  const legacyValues = provider === "deepseek" ? {
    apiKey: legacy.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY,
    model: legacy.DEEPSEEK_MODEL ?? env.DEEPSEEK_MODEL,
    baseUrl: legacy.DEEPSEEK_BASE ?? env.DEEPSEEK_BASE,
  } : {};
  return normalizeProfile(provider, {
    baseUrl: values[`${prefix}_BASE`] ?? legacyValues.baseUrl ?? defaults.baseUrl,
    model: values[`${prefix}_MODEL`] ?? legacyValues.model ?? defaults.model,
    authMode: values[`${prefix}_AUTH_MODE`] ?? defaults.authMode,
    apiKey: values[`${prefix}_API_KEY`] ?? legacyValues.apiKey ?? defaults.apiKey,
  });
}

function serialize(config) {
  const deepseek = config.profiles.deepseek;
  const local = config.profiles.local;
  return [
    `MODEL_ACTIVE_PROVIDER=${config.activeProvider}`,
    `MODEL_DEEPSEEK_BASE=${deepseek.baseUrl}`,
    `MODEL_DEEPSEEK_MODEL=${deepseek.model}`,
    `MODEL_DEEPSEEK_AUTH_MODE=${deepseek.authMode}`,
    `MODEL_DEEPSEEK_API_KEY=${deepseek.apiKey}`,
    `MODEL_LOCAL_BASE=${local.baseUrl}`,
    `MODEL_LOCAL_MODEL=${local.model}`,
    `MODEL_LOCAL_AUTH_MODE=${local.authMode}`,
    `MODEL_LOCAL_API_KEY=${local.apiKey}`,
    "",
  ].join("\n");
}

// ── 落盘加密（2026-10-19 数据安全审计）───────────────────────────────────────────────
// 原来 `MODEL_DEEPSEEK_API_KEY=sk-...` 是**明文**写在 `<UserData>\.cursor\secrets\model.env` 里的。
// 现在写盘前用 Windows DPAPI（CurrentUser）加密成 `dpapi-v1:<base64>`；读的时候解回来。
// 对外行为不变（内存里仍是明文 apiKey），变的是**磁盘上没有明文密钥**。

// 收紧 secrets 目录的 ACL：默认它继承了盘根的 `BUILTIN\Users:(RX)` / `Authenticated Users:(M)`
// ⇒ 同机其他标准用户可以读（读到的是密文，价值不大），更麻烦的是**可以改写** `MODEL_*_BASE`
// 这个明文公开字段，把你的信引到他的服务器上去。DPAPI 挡不住这种完整性攻击，ACL 才行。
// 只授予：当前用户 + SYSTEM + Administrators。失败一律不阻断保存（先保证能用），但要留日志。
// 幂等：目录已经保护过就走人，不重复起进程。
const TIGHTEN_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$d = $env:OLIVIA_SECRET_DIR
$acl = Get-Acl -LiteralPath $d
if ($acl.AreAccessRulesProtected) { 'ALREADY'; exit 0 }
$backup = $acl
try {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { if (-not $r.IsInherited) { [void]$acl.RemoveAccessRule($r) } }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($who in @($me, 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $d -AclObject $acl
  $null = Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop
  'OK'
} catch {
  # 万一新 ACL 让自己都读不了，立刻把继承恢复回去 —— 宁可权限宽松，也不能让程序读不到自己的配置。
  try { $backup.SetAccessRuleProtection($false, $true); Set-Acl -LiteralPath $d -AclObject $backup } catch {}
  "FAILED: $($_.Exception.Message)"
}
`;

function tightenSecretDirAcl(dir) {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise(resolve => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", TIGHTEN_ACL_SCRIPT],
      // 同上：PowerShell 的报错按 OEM 代码页写，按字节拿回来自己解，别让日志变乱码。
      { encoding: "buffer", windowsHide: true, timeout: 20_000, env: { ...process.env, OLIVIA_SECRET_DIR: dir } },
      (error, stdout, stderr) => {
        const text = `${decodeConsoleText(stdout)}${decodeConsoleText(stderr)}`.trim();
        if (error || /FAILED/u.test(text)) {
          console.warn(`[model-config] 收紧 secrets 目录权限失败（不影响保存）：${text || error?.message || ""}`);
        }
        resolve();
      },
    );
  });
}

/** 把内存里的明文密钥加密成落盘形态；DPAPI 不可用时**抛错**（绝不静默退回明文）。 */
async function sealProfile(profile) {
  const key = String(profile.apiKey ?? "");
  if (!key || isEncrypted(key)) return { ...profile, apiKey: key };
  try {
    return { ...profile, apiKey: await protectSecret(key) };
  } catch (error) {
    throw new Error(`无法加密保存 API Key（本机 Windows DPAPI 不可用）：${error instanceof Error ? error.message : String(error)}。为避免把密钥明文写到磁盘，本次保存已拒绝。`);
  }
}

async function persist(root, config) {
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(secrets, { recursive: true });
  // ① 写盘形态：密钥加密
  const sealed = {
    activeProvider: config.activeProvider,
    profiles: {
      deepseek: await sealProfile(config.profiles.deepseek),
      local: await sealProfile(config.profiles.local),
    },
  };
  // ② 原子写（tmp + rename）：半截文件会让下次启动读不到配置。
  const target = join(secrets, "model.env");
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, serialize(sealed), "utf8");
  await rename(temporary, target);
  // ③ 收紧目录权限（幂等、失败不阻断）
  await tightenSecretDirAcl(secrets);
  // ④ 返回**明文**配置：调用方要靠它构造 Authorization 头
  return config;
}

/**
 * 老版本升级上来的兼容：把 model.env 里的**明文** Key 原地加密。
 * 只在启动时调一次；没有明文就什么都不做（没有写入、没有进程）。
 * DPAPI 不可用时只告警、**不删明文** —— 删了用户就再也用不了；
 * 但新保存会被 persist() 拒绝（fail-closed），所以不会产生新的明文。
 */
export async function migratePlaintextSecrets({ root, log = () => {} }) {
  const secrets = join(root, ".cursor", "secrets");
  const file = join(secrets, "model.env");
  const values = await readEnvFile(file);
  const plain = ["MODEL_DEEPSEEK_API_KEY", "MODEL_LOCAL_API_KEY"]
    .map(name => String(values[name] ?? "").trim())
    .filter(value => value && !isEncrypted(value));
  if (plain.length === 0) return { migrated: false, plaintext: 0 };
  try {
    const config = await readModelConfig({ root });
    await persist(root, config);
    log(`[model-config] 已把 ${plain.length} 个明文 API Key 加密（dpapi-v1）：${file}`);
    return { migrated: true, plaintext: plain.length };
  } catch (error) {
    log(`[model-config] 明文 API Key 加密失败，本次保持原样（请在能运行 PowerShell 的环境重试）：${error instanceof Error ? error.message : error}`);
    return { migrated: false, plaintext: plain.length, error: String(error?.message ?? error) };
  }
}

export async function readModelConfig({ root, env = process.env }) {
  const secrets = join(root, ".cursor", "secrets");
  const [values, legacy] = await Promise.all([
    readEnvFile(join(secrets, "model.env")),
    readEnvFile(join(secrets, "deepseek.env")),
  ]);
  const activeProvider = normalizeProvider(values.MODEL_ACTIVE_PROVIDER ?? "deepseek");
  const config = {
    activeProvider,
    profiles: {
      deepseek: persistedProfile("deepseek", values, legacy, env),
      local: persistedProfile("local", values, legacy, env),
    },
  };
  // 密文的解一遍（revealSecret 内部按密文缓存，反复读不会反复起进程）。
  for (const provider of ["deepseek", "local"]) {
    const profile = config.profiles[provider];
    if (isEncrypted(profile.apiKey)) {
      try {
        profile.apiKey = await revealSecret(profile.apiKey);
        profile.keyConfigured = Boolean(profile.apiKey);
      } catch (error) {
        // 解不开（换了 Windows 账户 / 拷到别的机器）：当成「没配 Key」，由界面提示重填。
        profile.apiKey = "";
        profile.keyConfigured = false;
        // 解不开的原因要能给人看：PowerShell 侧写的是 OEM 码页文本，必须按字节解回来
        // （见 decodeConsoleText），否则界面上会是一整屏 `ʹá3á…`。
        profile.keyError = decodeConsoleText(error instanceof Error ? error.message : String(error)).trim();
      }
    }
  }
  return config;
}

export async function resetModelConfig({ root }) {
  const secrets = join(root, ".cursor", "secrets");
  await Promise.all([
    rm(join(secrets, "model.env"), { force: true }),
    rm(join(secrets, "deepseek.env"), { force: true }),
  ]);
  return readModelConfig({ root, env: {} });
}

export async function writeModelProfile({ root, provider, profile }) {
  const selected = normalizeProvider(provider);
  const config = await readModelConfig({ root });
  config.profiles[selected] = normalizeProfile(selected, profile, { requireBearerKey: true });
  return persist(root, config);
}

export async function setActiveProvider({ root, provider }) {
  const selected = normalizeProvider(provider);
  const config = await readModelConfig({ root });
  config.activeProvider = selected;
  return persist(root, config);
}

export function activeModelProfile(config) {
  const provider = normalizeProvider(config.activeProvider);
  return config.profiles[provider];
}

/**
 * 家族表的**单一真相源**是 `model-families.json`（B2，2026-10-09 复审）：
 * 以前 JS 与写信 harness（`repo/source/.cursor/skills/fit-letters/scripts/model-call.ps1`）各写一份正则，
 * 结果 PS 侧只认 deepseek/glm，Kimi 三条全缺 ⇒「点保存并测试」通过、真写回信却走厂商默认参数。
 * 现在两边都读这一份文件（打包脚本会把它复制到 harness 脚本目录旁边），改动只改 JSON。
 */
const REASONING_FAMILIES = Object.freeze(
  JSON.parse(readFileSync(new URL("./model-families.json", import.meta.url), "utf8")).families.map(family =>
    Object.freeze({
      ...family,
      pattern: new RegExp(family.pattern, family.flags ?? "u"),
    }),
  ),
);

/** 按模型名判断家族；认不出返回 null。 */
export function reasoningFamilyOf(model) {
  const value = String(model ?? "").trim();
  if (!value) return null;
  for (const family of REASONING_FAMILIES) if (family.pattern.test(value)) return family;
  return null;
}

export function buildChatRequest(profile, payload = {}) {
  const selected = normalizeProfile(profile.provider, profile, { requireBearerKey: true });
  // 家族要在构造 body 之前算出来：Kimi 的 temperature 不可修改，发不发取决于家族。
  const family = selected.provider === "deepseek" ? reasoningFamilyOf(selected.model) : null;
  const body = {
    model: selected.model,
    messages: payload.messages ?? [],
    stream: false,
  };
  // Kimi 三家都明确不接受 temperature（官方「请勿传入」）→ 家族标记了 noTemperature 就不发。
  if (payload.temperature !== undefined && !family?.noTemperature) body.temperature = payload.temperature;
  if (payload.maxTokens !== undefined) body.max_tokens = payload.maxTokens;
  // 通用/本地档案（中转站、本地推理）不发送任何厂商专用参数；
  // 远程档案再按模型家族决定，所以自定义远程档案里的未知模型也收不到这些字段。
  if (family?.topLevelEffort) {
    // kimi-k3：始终推理，只认顶层 reasoning_effort；发 thinking 会被拒。
    body.reasoning_effort = payload.reasoning_effort ?? family.effort;
  } else if (family && !family.noThinkingParam) {
    const requested = payload.thinking ?? { type: "enabled" };
    body.thinking = family.canDisable ? requested : { type: "enabled" };
    // kimi-k2.6 只认 thinking，不认 reasoning_effort（thinkingOnly）。
    if (!family.thinkingOnly && body.thinking.type !== "disabled") {
      body.reasoning_effort = payload.reasoning_effort ?? family.effort;
    }
  }
  const headers = { "Content-Type": "application/json" };
  if (selected.authMode === "bearer") headers.Authorization = `Bearer ${selected.apiKey}`;
  return {
    url: `${selected.baseUrl}/chat/completions`,
    headers,
    body,
  };
}

/**
 * 连通性自测要不要放大 max_tokens：推理 token 与正文共享这个输出预算，
 * 128 会被思考链吃光 ⇒ finish_reason=length ⇒ extractModelText() 抛「模型正文未完整生成」，
 * 用户看到的是假失败（Key 与模型名其实都对）。
 * 判断只看官方参数形态，不猜模型名（猜名字漏过一次，别再犯）：
 *   · body.reasoning_effort 存在            → kimi-k3 这类顶层 effort，始终推理 ⇒ 放大
 *   · body.thinking.type = "enabled"        → deepseek / 智谱 / kimi-k2.6 ⇒ 放大
 *   · body.thinking.type = "disabled"       → 用户明确关掉了思考 ⇒ 不放大
 *   · 家族 noThinkingParam（kimi-k2.7-*）   → 始终思考但发了会报错所以不发 ⇒ 放大
 *   · 家族认不出的远程档案（豆包等）        → 厂商可能默认开深度思考（火山方舟就是）⇒ 放大
 * 本地档案（provider=local）不放大：那是用户自己的推理服务，探测不受厂商默认影响。
 */
export function probeNeedsReasoningBudget(profile, call = {}) {
  const body = call?.body ?? {};
  if (body.reasoning_effort !== undefined) return true;
  if (body.thinking?.type === "enabled") return true;
  if (body.thinking?.type === "disabled") return false;
  const selected = normalizeProfile(profile?.provider, profile ?? {}, { requireBearerKey: true });
  if (selected.provider !== "deepseek") return false;
  // 走到这里说明 body 里没有任何推理参数，只有两种可能：家族标记了「发了会被拒」
  // （kimi-k2.7-*），或家族压根认不出（豆包等）。两种都可能始终推理 —— 放大最多多花
  // 几个 token，不放大却会让用户以为 Key / 模型名填错了。
  return true;
}

/**
 * 长文本任务的输出预算（AI 信件识别这类「一次要吐很多 JSON」的接口）。
 * 不传 max_tokens 就等于把输出上限交给厂商默认值，而智谱 GLM 与火山方舟官方默认都只给 4k
 * ⇒ 往来一多必然 finish_reason=length ⇒ extractModelText() 抛「模型正文未完整生成」，
 * 用户看到的是「识别失败」，而不是「识别了一部分」。
 * 取的是「保守的显式预算」，不是模型上限：宁可写小一点也不要用超限值换回 400
 * （model-transport.js 的 max_tokens → max_completion_tokens 回退只处理参数名不支持，不处理值超限）。
 * ⚠️ 连通性自测那条不要改用这里：它的 4096 被 test/model-probe-budget.test.js 与
 * test/relay-compatibility.test.js 逐字钉住，改这里会让两个套件当场变红。
 */
export function outputBudgetFor(model) {
  const family = reasoningFamilyOf(model);
  if (family?.name === "deepseek") return 65536; // DeepSeek 输出上限 384K，取保守值
  if (family?.name === "glm") return 32768;      // 智谱「最大回答 128k」，取保守值
  return 8192;                                    // 认不出的厂商（方舟 / Kimi / MiniMax）取更小值
}

export function buildModelListRequest(profile) {
  const selected = normalizeProvider(profile.provider);
  const authMode = assertSingleLine(profile.authMode, "鉴权方式") || (selected === "deepseek" ? "bearer" : "none");
  if (!AUTH_MODES.has(authMode)) throw new Error("鉴权方式只能是 bearer 或 none");
  const apiKey = assertSingleLine(profile.apiKey, "API Key");
  if (authMode === "bearer" && !apiKey) throw new Error("Bearer 鉴权需要填写 API Key");
  const headers = { Accept: "application/json" };
  if (authMode === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  return {
    url: `${normalizeBaseUrl(profile.baseUrl)}/models`,
    headers,
  };
}
