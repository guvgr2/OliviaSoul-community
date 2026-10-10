// 豆包（火山方舟）预设的一致性回归（2026-10-08 委派《委派-豆包模型ID核实结果与追加要求》§3）。
//
// 同一份模型清单分散在 4 个地方各写一份，漏一处就是「界面能选、打包被拦」或「界面能选、文档对不上」：
//   ① 前端预设（public/app.js）                        用户能选到
//   ② 打包审计白名单（packaging/package-safety.ps1）   不在白名单 = 打包直接失败
//   ③ 文档（API配置使用说明.md / 使用说明.txt）         用户照着填
//   ④ 界面提示：方舟「拿到 Key ≠ 能调，要先去控制台开通模型」，不提示用户会以为程序坏了
// 本套件同时钉住「只追加、不动既有项」：既有 9 项 + M2-her 一个都不能被改动或删掉。
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

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DOUBAO = [
  ["doubao-seed-character-260628", ARK_BASE],
  ["doubao-seed-character-251128", ARK_BASE],
  ["doubao-seed-2-0-mini-260428", ARK_BASE],
];

/** 官方已标「即将下线」，不许出现在清单 / 白名单 / 文档里。 */
const RETIRING = ["doubao-seed-2-0-mini-260215", "doubao-seed-character-251128-"];

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("前端模型清单里有豆包三项，且 id / 地址 / 模型名一一对应、地址是方舟 OpenAI 兼容端点", () => {
  for (const [model, baseUrl] of DOUBAO) {
    const re = new RegExp(`id: "${escape(model)}"[^}]*baseUrl: "${escape(baseUrl)}"[^}]*model: "${escape(model)}"`, "u");
    assert.match(app, re, `前端预设缺少豆包 ${model}（或地址/模型名不匹配）`);
  }
});

test("既有 9 项 + M2-her 一个都没被动过（只许在尾部追加）", () => {
  const existing = [
    "deepseek-flash", "deepseek-v4-pro", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.3",
    "kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "M2-her",
  ];
  for (const model of existing) {
    assert.ok(app.includes(`model: "${model}"`), `既有预设 ${model} 不见了：本轮只允许在清单尾部追加`);
  }
  // 退役名不许回来（DeepSeek 旧名 2026-09 / 2026-07 已退役，方舟 260215 即将下线）
  for (const dead of ["deepseek-chat", "deepseek-reasoner", ...RETIRING]) {
    assert.ok(!new RegExp(`model: "${escape(dead)}"`, "u").test(app), `${dead} 已退役/即将下线，不该出现在前端清单里`);
  }
});

test("界面必须提示「先到火山方舟控制台开通模型」（否则 403 会被当成程序坏了）", () => {
  for (const [model] of DOUBAO) {
    const re = new RegExp(`id: "${escape(model)}"[^}]*?label: "([^"]*)"`, "u");
    const label = re.exec(app)?.[1] ?? "";
    assert.match(label, /开通模型/u, `${model} 的选项文字里要写「需先在火山方舟控制台开通模型」`);
  }
});

test("打包审计白名单必须覆盖豆包三项（漏了就是「界面能选、打包被拦」）", () => {
  const line = /\$allowedRemoteModels = @\(([^)]*)\)/u.exec(safety);
  assert.ok(line, "找不到 $allowedRemoteModels");
  for (const [model] of DOUBAO) {
    assert.ok(line[1].includes(`'${model}'`), `白名单缺少 ${model}，打包审计会直接失败`);
  }
});

test("两份文档都要写到豆包：地址、Model ID、方舟要开通模型、别用即将下线的 ID", () => {
  assert.ok(apiDoc.includes(ARK_BASE), "《API配置使用说明》缺少方舟接口地址");
  assert.ok(guide.includes(ARK_BASE), "随包《使用说明》缺少方舟接口地址");
  for (const [model] of DOUBAO) {
    assert.ok(apiDoc.includes(model), `《API配置使用说明》缺少 ${model}`);
  }
  assert.ok(guide.includes("doubao-seed-character-260628"), "随包《使用说明》缺少豆包示例 Model ID");
  assert.match(apiDoc, /开通模型/u, "《API配置使用说明》必须写清「先在方舟控制台开通模型」");
  assert.match(guide, /开通模型/u, "随包《使用说明》必须写清「先在方舟控制台开通模型」");
  assert.ok(apiDoc.includes("doubao-seed-2-0-mini-260215"), "文档要明确点名 260215 即将下线，别让人填进去");
});

test("豆包的请求形态：地址由程序拼 /chat/completions，且不发任何厂商专用推理参数、temperature 照发", () => {
  for (const [model, baseUrl] of DOUBAO) {
    const r = buildChatRequest(
      { provider: "deepseek", baseUrl, model, apiKey: "k" },
      { messages: [{ role: "user", content: "hi" }], temperature: 0.8 },
    );
    assert.equal(r.url, `${baseUrl}/chat/completions`, `${model} 的请求地址不对（baseUrl 里不要再带 /chat/completions）`);
    assert.match(r.headers.Authorization, /^Bearer /u, `${model} 应使用 Bearer 鉴权`);
    assert.equal(reasoningFamilyOf(model), null,
      `${model} 不应被识别为已知推理家族：认错家族会发出方舟不认的 thinking / reasoning_effort 而被 400 拒`);
    assert.equal(r.body.thinking, undefined, `${model} 不该收到 thinking`);
    assert.equal(r.body.reasoning_effort, undefined, `${model} 不该收到 reasoning_effort`);
    assert.equal(r.body.temperature, 0.8, `${model} 接受 temperature，应当照发`);
  }
});
