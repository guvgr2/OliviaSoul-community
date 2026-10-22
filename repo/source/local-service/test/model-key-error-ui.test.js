// ★ 2026-10-19 第四轮审查 N2 的回归护栏。
//
// 背景：`server.js` 早就产出 `keyError`（DPAPI 解不开已存的 Key），但 `public/` 里**没有任何
// 消费方** ⇒ `隐私说明.md` 承诺的「那时程序会提示你重新填 Key」是空头支票：用户看到的是
// 「我的 Key 凭空消失了」。本文件把这条链路钉住。
//
// 判据写法说明（照着本仓 §3 的教训来）：
//   · 不只在文件里 grep 字符串 —— 那是「字符串检查证不了写对地方」。
//     断言的是**某个函数体内**调了 renderKeyError，以及 **index.html 某个档案块内**有那个元素。
//   · renderKeyError 本身是**抽出来真跑一遍**（给 reason / 不给 reason 两种输入看结果），
//     不是看它长什么样。
import assert from "node:assert/strict";
import test from "node:test";
import { decodeConsoleText } from "../midi/secure-secret.js";
// ★ 读源码统一走 readSourceText（先剥注释再断言）：
//   否则「把那行前面加个 // 注释掉」这种变异，正则照样匹配得上 ⇒ 测试全绿而功能已关。
//   这是 2026-10-19 第五轮复验 §3 的 M4，本文件就是它被抓出来的地方。
import { readSourceText } from "./lib/read-source.mjs";

const appSource = () => readSourceText(new URL("../public/app.js", import.meta.url));
const htmlSource = () => readSourceText(new URL("../public/index.html", import.meta.url));

// 按**顶层函数**切块（app.js 的函数都顶格写，收尾 `}` 也顶格）—— 比数括号可靠。
function topLevelFunctions(source) {
  const blocks = new Map();
  for (const part of source.split(/\n(?=function [A-Za-z_$][\w$]*\s*\()/u)) {
    const name = part.match(/^function ([A-Za-z_$][\w$]*)\s*\(/u)?.[1];
    if (name) blocks.set(name, part);
  }
  return blocks;
}

/** 把 app.js 里的 renderKeyError 真身抽出来，注入桩 `$` 与引导语常量后返回可调用的函数。 */
async function loadRenderKeyError(element) {
  const source = await appSource();
  const block = topLevelFunctions(source).get("renderKeyError");
  assert.ok(block, "app.js 里应该有顶层函数 renderKeyError");
  const lead = source.match(/const KEY_ERROR_LEAD = "([^"]*)"/u)?.[1];
  assert.ok(lead, "引导语常量应该能从 app.js 里取出来");
  const factory = new Function("$", "KEY_ERROR_LEAD", `${block}\nreturn renderKeyError;`);
  return factory(() => element, lead);
}

test("两个模型档案各有一个默认隐藏的 keyError 提示位", async () => {
  const html = await htmlSource();
  for (const [profile, id] of [["deepseek", "apiKeyError"], ["local", "localApiKeyError"]]) {
    const block = html.match(
      new RegExp(`<div class="settingsSubcard modelProfile" data-model-profile="${profile}"[^>]*>([\\s\\S]*?)\\n\\s{10}</div>`, "u"),
    );
    assert.ok(block, `index.html 里应该能切出 data-model-profile="${profile}" 这一块`);
    const tag = block[1].match(new RegExp(`<p id="${id}"[^>]*>`, "u"));
    assert.ok(tag, `${profile} 档案里应该有 #${id}`);
    assert.match(tag[0], /\shidden(?=[\s>])/u, `#${id} 默认必须是隐藏的（平时不该占版面）`);
    assert.match(tag[0], /role="status"/u, `#${id} 应该是 role="status"，让读屏软件也能播报`);
  }
});

test("renderDeepSeek / renderLocalModel 都在**自己体内**把 profile.keyError 交给提示位", async () => {
  const blocks = topLevelFunctions(await appSource());
  for (const [fn, selector] of [["renderDeepSeek", "#apiKeyError"], ["renderLocalModel", "#localApiKeyError"]]) {
    const block = blocks.get(fn);
    assert.ok(block, `app.js 里应该有顶层函数 ${fn}`);
    assert.match(
      block,
      new RegExp(`renderKeyError\\("${selector}", profile\\.keyError\\)`, "u"),
      `${fn} 里应该把 profile.keyError 渲染到 ${selector}`,
    );
  }
});

test("renderKeyError 行为（真调用）：有原因就显示并带上「重新填」的引导语，没原因就整个隐藏", async () => {
  const element = { hidden: true, textContent: "" };
  const render = await loadRenderKeyError(element);

  render("#apiKeyError", "  Unprotect 失败：数据无效。  ");
  const lead = (await appSource()).match(/const KEY_ERROR_LEAD = "([^"]*)"/u)[1];
  assert.equal(element.hidden, false, "有原因时必须显示");
  assert.equal(element.textContent, `${lead}\nUnprotect 失败：数据无效。`, "引导语 + 去空白的原因，中间换行");
  assert.match(lead, /重新填/u, "引导语必须兑现隐私说明里「程序会提示你重新填 Key」那句承诺");

  render("#apiKeyError", "   ");
  assert.equal(element.hidden, true, "空原因（只有空白）必须重新隐藏");
  assert.equal(element.textContent, "", "隐藏时要把文案清掉，别留上一轮的残字");

  render("#apiKeyError", undefined);
  assert.equal(element.hidden, true, "keyError 缺省（正常情况）必须隐藏");
});

test("decodeConsoleText 能把 PowerShell 按 OEM 码页（GBK）写的报错解回中文", () => {
  // 「往返回程」的 GBK 字节：CD F9 B7 B5 BB D8 B3 CC —— 按 UTF-8 解必然失败（会变成 `往�?` 那类乱码）。
  const gbk = Buffer.from([0xcd, 0xf9, 0xb7, 0xb5, 0xbb, 0xd8, 0xb3, 0xcc]);
  assert.equal(decodeConsoleText(gbk), "往返回程", "GBK 字节必须按 GB18030 解，不能再出乱码");
  // 正常的 UTF-8 必须仍然按 UTF-8 解（不能因为加了兜底反而把对的解错）。
  assert.equal(decodeConsoleText(Buffer.from("往返回程", "utf8")), "往返回程");
  assert.equal(decodeConsoleText(Buffer.alloc(0)), "");
  assert.equal(decodeConsoleText(undefined), "");
});
