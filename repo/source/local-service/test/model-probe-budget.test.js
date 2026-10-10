// 连通性自测的「输出预算」回归（2026-10-08 审计：探测的放大条件漏掉了会思考的模型）。
//
// 真实故障（1.0.3 起，未发布）：`buildModelProbeCall()` 只在 `body.thinking.type === "enabled"`
// 时把探测的 `max_tokens` 从 128 放大到 4096。可是推理 token 与正文共享这个输出预算，于是
//   · kimi-k3        家族只发顶层 `reasoning_effort`（没有 thinking）
//   · kimi-k2.7-code 家族「发 thinking 会报错」，所以什么都不发
//   · 豆包（火山方舟）家族认不出，程序什么都不发，而方舟默认开启深度思考
// 这三种模型在探测时只拿到 128 token，思考链先吃光 ⇒ `finish_reason: "length"` ⇒
// `extractModelText()`（model-transport.js:13）抛「模型正文未完整生成」⇒ 用户点
// 「保存并测试远程模型」看到假失败，而 Key 和模型名其实都是对的。
//
// 本套件钉两件事：
//   ① 只要这个模型会思考就给足预算（判断按官方参数形态，不猜模型名 —— 猜名字已经漏过一次）
//   ② max_tokens 回退也认中文提示（厂商回「不支持的参数 max_tokens」时同样要换参数名）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChatRequest, probeNeedsReasoningBudget } from "../model-config.js";
import { executeChatRequest } from "../model-transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = readFileSync(join(root, "server.js"), "utf8");

/** 复刻 server.js 的 buildModelProbeCall（只差消息文本），改了源码这里会失败。 */
function probeCall(profile) {
  const call = buildChatRequest(profile, {
    messages: [{ role: "user", content: "只回复 OK，不要解释" }],
    maxTokens: 128,
  });
  if (probeNeedsReasoningBudget(profile, call)) call.body.max_tokens = 4096;
  call.body.stream = false;
  return call;
}

const remote = (model, baseUrl = "https://example.com/v1") => ({
  provider: "deepseek", baseUrl, model, apiKey: "k", authMode: "bearer",
});

test("会思考的模型在探测时一律给足输出预算（含 kimi-k3 / kimi-k2.7 / 认不出家族的豆包）", () => {
  const models = [
    "deepseek-flash",                 // thinking.type = enabled
    "glm-5.3",                        // thinking.type = enabled（不可关闭）
    "kimi-k2.6",                      // thinking.type = enabled
    "kimi-k3",                        // 顶层 reasoning_effort，没有 thinking
    "kimi-k2.7-code",                 // 发了会报错所以什么都不发，但始终思考
    "doubao-seed-character-260628",   // 家族认不出；方舟默认开启深度思考
    "doubao-seed-2-0-mini-260428",
    "M2-her",                         // 家族认不出（厂商是否思考由它自己决定，放大无害）
  ];
  for (const model of models) {
    assert.equal(probeCall(remote(model)).body.max_tokens, 4096,
      `${model} 探测时只给 128 token：思考链会吃光预算，用户会看到「模型正文未完整生成」的假失败`);
  }
});

test("用户明确关掉思考时不放大（保持 128，探测更快）", () => {
  const call = buildChatRequest(remote("deepseek-flash"),
    { messages: [{ role: "user", content: "hi" }], maxTokens: 128, thinking: { type: "disabled" } });
  assert.deepEqual(call.body.thinking, { type: "disabled" });
  assert.equal(probeNeedsReasoningBudget(remote("deepseek-flash"), call), false);
  assert.equal(probeCall({ ...remote("deepseek-flash") }).body.max_tokens, 4096, "默认（不开 disabled）仍应放大");

  const k26 = buildChatRequest(remote("kimi-k2.6"),
    { messages: [{ role: "user", content: "hi" }], maxTokens: 128, thinking: { type: "disabled" } });
  assert.equal(probeNeedsReasoningBudget(remote("kimi-k2.6"), k26), false);
});

test("本地档案不放大（那是用户自己的推理服务，不受厂商默认影响）", () => {
  const local = { provider: "local", baseUrl: "http://127.0.0.1:8000/v1", model: "local-model", apiKey: "", authMode: "none" };
  assert.equal(probeCall(local).body.max_tokens, 128);
});

test("server.js 的探测走共享判断，不许再硬编码 thinking / 模型名", () => {
  assert.match(server, /if \(probeNeedsReasoningBudget\(profile, call\)\) call\.body\.max_tokens = 4096;/u,
    "server.js 的探测必须用 model-config.js 的 probeNeedsReasoningBudget 判断");
  assert.doesNotMatch(server, /call\.body\.thinking\?\.type === "enabled"\) call\.body\.max_tokens/u,
    "旧的「只认 thinking」写法会漏掉 kimi-k3 / kimi-k2.7 / 豆包，不许回来");
  assert.match(server, /import \{[\s\S]*?probeNeedsReasoningBudget,[\s\S]*?\} from "\.\/model-config\.js";/u,
    "probeNeedsReasoningBudget 必须从 model-config.js 导入");
});

test("max_tokens 回退要认中文提示（厂商回「不支持的参数 max_tokens」也要换参数名）", async () => {
  const bodies = [];
  const replies = [
    () => new Response(JSON.stringify({ error: { message: "不支持的参数 max_tokens" } }),
      { status: 400, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ];
  const content = await executeChatRequest(
    { url: "https://example.com/v1/chat/completions", headers: {}, body: { model: "M2-her", messages: [], max_tokens: 32 } },
    { fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return replies[bodies.length - 1](); } },
  );
  assert.equal(content.content, "OK");
  assert.equal(bodies.length, 2, "认得出「不支持的参数」时应当重试一次");
  assert.equal(bodies[1].max_completion_tokens, 32, "重试时应改用 max_completion_tokens");
  assert.equal(bodies[1].max_tokens, undefined, "重试时不能同时带着 max_tokens");
});

test("无关的 400 不重试（别把普通错误也当成参数不支持）", async () => {
  let calls = 0;
  await assert.rejects(
    executeChatRequest(
      { url: "https://example.com/v1/chat/completions", headers: {}, body: { model: "M2-her", messages: [], max_tokens: 32 } },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { message: "模型不存在" } }),
            { status: 400, headers: { "content-type": "application/json" } });
        },
      },
    ),
    /HTTP 400/u,
  );
  assert.equal(calls, 1, "不是 max_tokens 不支持时不该重试");
});

test("403 分诊文案要提到火山方舟「先开通模型」（方舟最容易让人以为是程序坏了）", () => {
  assert.match(server, /if \(status === 403\)[\s\S]{0,200}火山方舟/u,
    "403 分诊举例里必须写上方舟：拿到 Key ≠ 能调，还要在控制台开通模型");
});
