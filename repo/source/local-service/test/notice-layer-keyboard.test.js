// #64 护栏：全局通知层（#noticeLayer）只能有一套 resolver。
//
// 真实故障（第四轮审核 · 审-5 §3.3 / §8 实验 7）：public/app.js 是 <script type="module">，
// 它内部的 openNotice / closeNotice 都不在 window 上；而 diagnostics-panel.js、folder-manager.js
// 这些普通脚本各自摸 #noticeLayer 的 DOM、自己 addEventListener("click") 并自持一个 Promise。
// app.js 的全局 keydown（app.js:1204 起）在 Esc / Enter 时直接 closeNotice ——
// 它只兑付自己的 resolver（那时是 null），自建框的 Promise 永远 pending：
// 删除备份、清理周期备份、删除歌单、分享同意框按 Esc / Enter 后流程静默挂起。
//
// 本套件钉死「修好之后不许退回去」：
//   1. app.js 必须把通知接口挂到 window 上（面板脚本才有得用）；
//   2. 四个自建过通知层的脚本，确认框入口必须优先使用它（自建路径只当兜底）；
//   3. app.js 的键盘关层与鼠标关层必须走同一个 closeNotice（resolver 只有一份）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");

const appSource = read("public/app.js");
const diagnosticsSource = read("public/diagnostics-panel.js");
const folderSource = read("public/folder-manager.js");
const listenNamingSource = read("public/listen-naming.js");
const legalSource = read("public/legal-notices.js");
const indexHtml = read("public/index.html");

test("app.js 必须把通知层接口挂到 window 上（面板脚本是普通脚本，拿不到 module 作用域）", () => {
  assert.match(appSource, /window\.OliviaSoulNotice\s*=\s*\{\s*openNotice\s*,\s*confirmNotice\s*\}/u,
    "app.js 要暴露 window.OliviaSoulNotice = { openNotice, confirmNotice }");
});

test("四个自建过通知层的脚本都必须优先走 window.OliviaSoulNotice", () => {
  const cases = [
    ["public/diagnostics-panel.js", diagnosticsSource, /function askNotice\([^)]*\)\s*\{[\s\S]{0,700}?global\.OliviaSoulNotice/u, "askNotice"],
    ["public/folder-manager.js", folderSource, /function confirmDialog\([^)]*\)\s*\{[\s\S]{0,700}?global\.OliviaSoulNotice/u, "confirmDialog"],
    ["public/listen-naming.js", listenNamingSource, /function ensureConsent\(\)\s*\{[\s\S]{0,900}?global\.OliviaSoulNotice/u, "ensureConsent"],
    ["public/legal-notices.js", legalSource, /function ensureAcknowledged\(\)\s*\{[\s\S]{0,900}?global\.OliviaSoulNotice/u, "ensureAcknowledged"],
  ];
  for (const [file, source, pattern, name] of cases) {
    assert.match(source, pattern,
      `${file} 的 ${name}() 必须先走 app.js 的 window.OliviaSoulNotice —— 自己摸 DOM + 自挂 click 时，`
      + "Esc / Enter 会被 app.js 的全局 keydown 关层，注册的 Promise 没人兑现（#64）");
  }
});

test("app.js 的键盘关层与鼠标关层必须兑付同一个 resolver", () => {
  // 键盘：Esc / Enter 都要 closeNotice；鼠标：三个按钮也要 closeNotice。
  assert.match(appSource, /document\.addEventListener\("keydown",[\s\S]{0,700}?\$\("#noticeLayer"\)\.hidden\) return;[\s\S]{0,200}?Escape[\s\S]{0,160}?closeNotice\(false\)[\s\S]{0,160}?Enter[\s\S]{0,160}?closeNotice\(true\)/u,
    "app.js 的全局 keydown 必须在通知层可见时用 closeNotice 兑付（Esc→false / Enter→true）");
  assert.match(appSource, /\$\("#noticeConfirm"\)\.addEventListener\("click",\s*\(\)\s*=>\s*closeNotice\(true\)\)/u);
  assert.match(appSource, /\$\("#noticeCancel"\)\.addEventListener\("click",\s*\(\)\s*=>\s*closeNotice\(false\)\)/u);
});

test("共享消息区每次都要清干净（合规声明 / 分享同意的富文本不许粘到下一条）", () => {
  assert.match(appSource, /messageNode\.style\.cssText = ""/u, "上一次弹层留下的内联样式必须每次重置");
  assert.match(appSource, /if \(html\) messageNode\.innerHTML = html;/u, "html 入参只给本地常量用（合规声明 / 分享同意）");
});

test("index.html 里 #noticeLayer 只有一个，app.js 以 module 方式最后加载", () => {
  const layers = indexHtml.match(/id="noticeLayer"/gu) ?? [];
  assert.equal(layers.length, 1, "通知层只有一份 DOM，多份就会各持一个 resolver");
  const moduleAt = indexHtml.indexOf('type="module"');
  const panelsAt = indexHtml.indexOf("diagnostics-panel.js");
  assert.ok(panelsAt > 0 && moduleAt > panelsAt,
    "面板脚本先加载、app.js（module）后加载 —— 所以面板只能在运行期读 window.OliviaSoulNotice");
});
