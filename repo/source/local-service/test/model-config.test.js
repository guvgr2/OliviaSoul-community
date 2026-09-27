import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DEEPSEEK_PROFILE,
  activeModelProfile,
  buildChatRequest,
  readModelConfig,
  setActiveProvider,
  writeModelProfile,
} from "../model-config.js";

test("模型档案从旧 DeepSeek 配置迁移且两套配置互不覆盖", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(secrets, { recursive: true });
  const legacyPath = join(secrets, "deepseek.env");
  const legacyBytes = Buffer.from([
    "DEEPSEEK_API_KEY=legacy-key",
    "DEEPSEEK_CUSTOM=1",
    "DEEPSEEK_MODEL=legacy-model",
    "DEEPSEEK_BASE=https://legacy.example/v1/",
    "",
  ].join("\n"), "utf8");
  await writeFile(legacyPath, legacyBytes);

  const before = await readModelConfig({ root, env: {} });
  assert.equal(before.activeProvider, "deepseek");
  assert.deepEqual(before.profiles.deepseek, {
    provider: "deepseek",
    baseUrl: "https://legacy.example/v1",
    model: "legacy-model",
    authMode: "bearer",
    apiKey: "legacy-key",
    keyConfigured: true,
  });
  assert.deepEqual(before.profiles.local, {
    provider: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local-model",
    authMode: "none",
    apiKey: "",
    keyConfigured: false,
  });

  const after = await writeModelProfile({
    root,
    provider: "local",
    profile: {
      baseUrl: "http://127.0.0.1:8000/v1/",
      model: "gemma-local",
      authMode: "none",
      apiKey: "",
    },
  });
  assert.equal(after.activeProvider, "deepseek");
  assert.deepEqual(after.profiles.deepseek, before.profiles.deepseek);
  assert.equal(after.profiles.local.baseUrl, "http://127.0.0.1:8000/v1");
  assert.deepEqual(await readFile(legacyPath), legacyBytes);

  const activated = await setActiveProvider({ root, provider: "local" });
  assert.equal(activated.activeProvider, "local");
  assert.equal(activeModelProfile(activated).model, "gemma-local");
  assert.equal((await readModelConfig({ root, env: {} })).activeProvider, "local");
});

test("模型请求按当前档案构造且本地无鉴权不携带 DeepSeek 字段", () => {
  const messages = [{ role: "user", content: "只回复 OK" }];
  const local = buildChatRequest({
    provider: "local",
    baseUrl: "http://127.0.0.1:8000/v1/",
    model: "gemma-local",
    authMode: "none",
    apiKey: "",
  }, {
    messages,
    temperature: 0.2,
    maxTokens: 64,
    thinking: { type: "disabled" },
    reasoning_effort: "low",
  });
  assert.equal(local.url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.deepEqual(local.headers, { "Content-Type": "application/json" });
  assert.deepEqual(local.body, {
    model: "gemma-local",
    messages,
    stream: false,
    temperature: 0.2,
    max_tokens: 64,
  });

  const deepseek = buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-pro",
    authMode: "bearer",
    apiKey: "ds-key",
  }, {
    messages,
    temperature: 0.3,
    maxTokens: 128,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.equal(deepseek.headers.Authorization, "Bearer ds-key");
  assert.deepEqual(deepseek.body.thinking, { type: "enabled" });
  assert.equal(deepseek.body.reasoning_effort, "high");
});

test("内置默认模型是 deepseek-flash", () => {
  assert.equal(DEFAULT_DEEPSEEK_PROFILE.provider, "deepseek");
  assert.equal(DEFAULT_DEEPSEEK_PROFILE.baseUrl, "https://api.deepseek.com");
  assert.equal(DEFAULT_DEEPSEEK_PROFILE.model, "deepseek-flash");
});

test("智谱 GLM 用自己那套推理参数，且不会被要求关闭思考", () => {
  const glm = buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3-flash",
    authMode: "bearer",
    apiKey: "glm-key",
  }, { messages: [], thinking: { type: "disabled" } });
  assert.equal(glm.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.deepEqual(glm.body.thinking, { type: "enabled" });   // GLM 的 thinking.type 只接受 enabled
  assert.equal(glm.body.reasoning_effort, "max");             // 官方推荐值

  // 通用 / 本地档案照旧完全不发厂商专用参数
  const local = buildChatRequest({
    provider: "local",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3-flash",
    authMode: "none",
    apiKey: "",
  }, { messages: [] });
  assert.equal(local.body.thinking, undefined);
  assert.equal(local.body.reasoning_effort, undefined);

  // 认不出的模型名也一个都不发，避免被严格接口 400 拒绝
  const unknown = buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://relay.example/v1",
    model: "some-relay-model",
    authMode: "bearer",
    apiKey: "relay-key",
  }, { messages: [] });
  assert.equal(unknown.body.thinking, undefined);
  assert.equal(unknown.body.reasoning_effort, undefined);
});

test("公网明文 http 被拒绝（否则 API Key 明文过网），本机与局域网仍允许", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = baseUrl => writeModelProfile({
    root,
    provider: "local",
    profile: { baseUrl, model: "local-model", authMode: "none", apiKey: "" },
  });

  // 公网地址必须 https
  await assert.rejects(save("http://api.example.com/v1"), /https/u);
  await assert.rejects(save("http://203.0.113.9:8000/v1"), /https/u);
  await assert.rejects(save("http://8.8.8.8/v1"), /https/u);

  // 本机与局域网照旧允许（本地推理、局域网推理服务器都是明文 http 的常见用法）
  for (const allowed of [
    "http://127.0.0.1:8000/v1",
    "http://localhost:8000/v1",
    "http://192.168.1.50:8000/v1",
    "http://10.0.0.7:8000/v1",
    "http://172.16.5.5:8000/v1",
    "http://ollama.local:11434/v1",
    "https://api.deepseek.com",
    "https://open.bigmodel.cn/api/paas/v4",
  ]) {
    const saved = await save(allowed);
    assert.equal(saved.profiles.local.baseUrl, allowed.replace(/\/+$/u, ""), allowed);
  }
});

test("模型档案拒绝非法 provider 地址换行和缺失的 Bearer 密钥", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    setActiveProvider({ root, provider: "automatic" }),
    /provider/u,
  );
  await assert.rejects(
    writeModelProfile({
      root,
      provider: "local",
      profile: { baseUrl: "file:///tmp/model", model: "gemma", authMode: "none", apiKey: "" },
    }),
    /地址/u,
  );
  await assert.rejects(
    writeModelProfile({
      root,
      provider: "local",
      profile: { baseUrl: "http://127.0.0.1:8000/v1", model: "gemma\nunsafe", authMode: "none", apiKey: "" },
    }),
    /换行/u,
  );
  assert.throws(() => buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    authMode: "bearer",
    apiKey: "",
  }, { messages: [] }), /API Key/u);
});

test("重置模型配置只删除两个模型文件并返回中性状态", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(join(root, "database"), { recursive: true });
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "model.env"), "MODEL_ACTIVE_PROVIDER=local\nMODEL_LOCAL_MODEL=private-model\n", "utf8");
  await writeFile(join(secrets, "deepseek.env"), "DEEPSEEK_API_KEY=private-key\n", "utf8");
  await writeFile(join(secrets, "keep.txt"), "保留秘密目录中的其他文件", "utf8");
  await writeFile(join(root, "database", "olivia-local.sqlite"), "database-sentinel", "utf8");
  await writeFile(join(root, "信件往来", "用户.md"), "letter-sentinel", "utf8");

  const modelModule = await import("../model-config.js");
  assert.equal(typeof modelModule.resetModelConfig, "function", "model-config must expose a narrow reset operation");
  const reset = await modelModule.resetModelConfig({ root });

  await assert.rejects(readFile(join(secrets, "model.env")), error => error.code === "ENOENT");
  await assert.rejects(readFile(join(secrets, "deepseek.env")), error => error.code === "ENOENT");
  assert.equal(await readFile(join(secrets, "keep.txt"), "utf8"), "保留秘密目录中的其他文件");
  assert.equal(await readFile(join(root, "database", "olivia-local.sqlite"), "utf8"), "database-sentinel");
  assert.equal(await readFile(join(root, "信件往来", "用户.md"), "utf8"), "letter-sentinel");
  assert.equal(reset.activeProvider, "deepseek");
  assert.equal(reset.profiles.deepseek.keyConfigured, false);
  assert.equal(reset.profiles.local.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(reset.profiles.local.model, "local-model");
});
