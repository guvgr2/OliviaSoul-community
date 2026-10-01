// 模型预设的一致性回归（Kimi 加入时新增）。
//
// 真实风险：同一份模型清单分散在 3 个地方各写一份 ——
//   ① 前端预设（public/app.js）        用户能选到
//   ② 打包审计白名单（packaging/package-safety.ps1）  不在白名单 = 打包直接失败
//   ③ 文档（API配置使用说明.md / 使用说明.txt）        用户照着填
// 只改一处就会出现「界面能选、打包被拦」或「界面能选、文档对不上」。
// 本套件把它们钉在一起，新增模型家族时不用靠人记。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChatRequest, reasoningFamilyOf } from "../model-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const app = readFileSync(join(root, "public", "app.js"), "utf8");
const safety = readFileSync(join(root, "packaging", "package-safety.ps1"), "utf8");
const apiDoc = readFileSync(join(root, "packaging", "API配置使用说明.md"), "utf8");
const guide = readFileSync(join(root, "packaging", "使用说明.txt"), "utf8");

/** 本套件只钉 Kimi；以后新增家族照抄这份表即可。 */
const KIMI = [
  ["kimi-k3", "https://api.moonshot.cn/v1"],
  ["kimi-k2.6", "https://api.moonshot.cn/v1"],
  ["kimi-k2.7-code", "https://api.moonshot.cn/v1"],
];

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("前端模型清单里有 Kimi 三项，且 id / 地址 / 模型名一一对应", () => {
  for (const [model, baseUrl] of KIMI) {
    const re = new RegExp(`id: "${escape(model)}"[^}]*baseUrl: "${escape(baseUrl)}"[^}]*model: "${escape(model)}"`, "u");
    assert.match(app, re, `前端预设缺少 ${model}（或地址/模型名不匹配）`);
  }
});

test("打包审计白名单必须覆盖前端清单（否则打包被拦下）", () => {
  const line = /\$allowedRemoteModels = @\(([^)]*)\)/u.exec(safety);
  assert.ok(line, "找不到 $allowedRemoteModels");
  for (const [model] of KIMI) {
    assert.ok(line[1].includes(`'${model}'`),
      `白名单缺少 ${model}：只加了前端预设而漏了白名单，打包审计会直接失败`);
  }
});

test("文档必须覆盖 Kimi（用户照着填地址与模型名）", () => {
  assert.ok(apiDoc.includes("https://api.moonshot.cn/v1"), "《API配置使用说明》缺少 Kimi 的接口地址");
  assert.ok(guide.includes("Kimi"), "随包《使用说明》缺少 Kimi");
});

test("Kimi 的推理参数按官方文档分别发送（三个模型各不相同）", () => {
  const build = (model, payload = {}) => buildChatRequest(
    { provider: "deepseek", baseUrl: "https://api.moonshot.cn/v1", model, apiKey: "k" },
    { messages: [{ role: "user", content: "hi" }], ...payload },
  );

  // 地址与鉴权对三家都一样
  for (const [model] of KIMI) {
    const r = build(model);
    assert.equal(r.url, "https://api.moonshot.cn/v1/chat/completions", `${model} 的请求地址不对`);
    assert.match(r.headers.Authorization, /^Bearer /u, `${model} 应使用 Bearer 鉴权`);
    // 家族判定要能认出 Kimi（否则推理参数一个都发不出去）
    assert.ok(reasoningFamilyOf(model), `${model} 应被识别为已知家族`);
  }

  // kimi-k3：始终推理，只认顶层 reasoning_effort（默认 max）；发 thinking 会被拒
  const k3 = build("kimi-k3");
  assert.equal(k3.body.reasoning_effort, "max", "kimi-k3 默认推理强度应为 max");
  assert.equal(k3.body.thinking, undefined, "kimi-k3 不支持 thinking，发了会被拒");
  assert.equal(build("kimi-k3", { reasoning_effort: "low" }).body.reasoning_effort, "low", "kimi-k3 应可调推理强度");

  // kimi-k2.6：用 thinking.type 控制（默认 enabled、可 disabled）；不认 reasoning_effort
  assert.deepEqual(build("kimi-k2.6").body.thinking, { type: "enabled" });
  assert.deepEqual(build("kimi-k2.6", { thinking: { type: "disabled" } }).body.thinking, { type: "disabled" });
  assert.equal(build("kimi-k2.6").body.reasoning_effort, undefined, "kimi-k2.6 不支持 reasoning_effort");

  // kimi-k2.7-code：始终思考；传 thinking 会报错 → 什么都不发
  const k27 = build("kimi-k2.7-code");
  assert.equal(k27.body.thinking, undefined, "kimi-k2.7-code 不接受 thinking");
  assert.equal(k27.body.reasoning_effort, undefined, "kimi-k2.7-code 不接受 reasoning_effort");

  // 三家都不接受 temperature（官方「请勿传入」）
  for (const [model] of KIMI) {
    assert.equal(build(model, { temperature: 0.7 }).body.temperature, undefined, `${model} 不能发 temperature`);
  }
  // 反向：非 Kimi 家族仍应照常发送 temperature
  assert.equal(
    buildChatRequest({ provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "k" },
      { messages: [], temperature: 0.7 }).body.temperature,
    0.7,
    "非 Kimi 模型仍应发送 temperature",
  );
});
