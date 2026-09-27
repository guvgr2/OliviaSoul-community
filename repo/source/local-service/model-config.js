import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

async function persist(root, config) {
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "model.env"), serialize(config), "utf8");
  return config;
}

export async function readModelConfig({ root, env = process.env }) {
  const secrets = join(root, ".cursor", "secrets");
  const [values, legacy] = await Promise.all([
    readEnvFile(join(secrets, "model.env")),
    readEnvFile(join(secrets, "deepseek.env")),
  ]);
  const activeProvider = normalizeProvider(values.MODEL_ACTIVE_PROVIDER ?? "deepseek");
  return {
    activeProvider,
    profiles: {
      deepseek: persistedProfile("deepseek", values, legacy, env),
      local: persistedProfile("local", values, legacy, env),
    },
  };
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
 * 各家的推理参数并不统一，所以按“模型家族”决定发什么：
 *   · DeepSeek：thinking {type: enabled|disabled} + reasoning_effort: low|medium|high
 *   · 智谱 GLM：thinking.type 只接受 enabled（不能发 disabled）+ 官方推荐 reasoning_effort: max
 * 认不出的模型一律不发厂商专用参数，避免被严格接口以 400 拒绝。
 */
const REASONING_FAMILIES = Object.freeze([
  Object.freeze({
    name: "deepseek",
    pattern: /(?:^|\/)deepseek(?:[-/]|$)/iu,
    effort: "high",
    canDisable: true,
  }),
  Object.freeze({
    name: "glm",
    pattern: /(?:^|\/)(?:glm|chatglm|zhipu)(?:[-/]|$)/iu,
    effort: "max",
    canDisable: false,
  }),
]);

/** 按模型名判断家族；认不出返回 null。 */
export function reasoningFamilyOf(model) {
  const value = String(model ?? "").trim();
  if (!value) return null;
  for (const family of REASONING_FAMILIES) if (family.pattern.test(value)) return family;
  return null;
}

export function buildChatRequest(profile, payload = {}) {
  const selected = normalizeProfile(profile.provider, profile, { requireBearerKey: true });
  const body = {
    model: selected.model,
    messages: payload.messages ?? [],
    stream: false,
  };
  if (payload.temperature !== undefined) body.temperature = payload.temperature;
  if (payload.maxTokens !== undefined) body.max_tokens = payload.maxTokens;
  // 通用/本地档案（中转站、本地推理）不发送任何厂商专用参数；
  // 远程档案再按模型家族决定，所以自定义远程档案里的非 DeepSeek / 非 GLM 模型也收不到这些字段。
  const family = selected.provider === "deepseek" ? reasoningFamilyOf(selected.model) : null;
  if (family) {
    const requested = payload.thinking ?? { type: "enabled" };
    body.thinking = family.canDisable ? requested : { type: "enabled" };
    if (body.thinking.type !== "disabled") body.reasoning_effort = payload.reasoning_effort ?? family.effort;
  }
  const headers = { "Content-Type": "application/json" };
  if (selected.authMode === "bearer") headers.Authorization = `Bearer ${selected.apiKey}`;
  return {
    url: `${selected.baseUrl}/chat/completions`,
    headers,
    body,
  };
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
