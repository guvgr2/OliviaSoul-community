// stripComments 的自检（第五轮复验 §3 的配套护栏）。
//
// ★ 这一层必须自己站得住：它要是「自己写错的判据」，后面 10 个文件的迁移就是建在沙子上。
//   所以自检测两类东西：
//   ① 合成片段：覆盖每一种会骗过朴素实现的形态（字符串里的 `//`、正则字面量、模板插值…）。
//   ② **真实仓库文件**：合成片段证明不了「对真代码也成立」（§3 第一条）。
//      真文件上验的是可证伪的性质（整行注释必须变空白 / URL 里的 `//` 一条不能少 / 仍能解析），
//      不是「我跑过了」。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readSourceText, readSourceTextSync, STRIPPED_EXTENSIONS, stripperForExtension } from "./lib/read-source.mjs";
import {
  stripComments,
  stripCssComments,
  stripHtmlComments,
  stripPowerShellComments,
} from "./lib/strip-comments.mjs";

const execFileAsync = promisify(execFile);

// ★ `codeUrls` 是「这份文件里**确实写在代码里**（不在注释里）的 URL」，逐条 grep 核过。
//   为什么不用「`http://` 出现次数剥前后必须相等」—— 那条判据是**错的**：
//   server.js 的注释正文里就有 3 个 `http://`（L581/L597/L638…），它们本来就该被剥掉，
//   数次数必然变少 ⇒ 会假红。改成钉住这些真实代码常量（§3：自己写错的判据会造假红）。
const REAL_JS_FILES = [
  {
    rel: "../server.js",
    codeUrls: [
      'http://${req.headers.host ?? ""}', // 模板串 + `${}` 插值里的 URL
      '"http://127.0.0.1/"',
      "https://api.github.com/repos/",
      "listening at http://127.0.0.1:27149/admin",
    ],
  },
  { rel: "../public/app.js", codeUrls: ["https://api.deepseek.com", "https://open.bigmodel.cn/api/paas/v4"] },
  { rel: "../midi/secure-secret.js", codeUrls: [] },
  { rel: "../model-config.js", codeUrls: ["https://api.deepseek.com", "http://127.0.0.1:8000/v1"] },
];

function escapeNeedle(needle) {
  return needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 剥完之后：长度不变、该消失的消失、该留下的留下。 */
function expectStrip(raw, { gone = [], kept = [] }, stripper = stripComments) {
  const stripped = stripper(raw);
  assert.equal(
    stripped.length,
    raw.length,
    "★ 剥注释必须等长替换（保行号/列号/偏移），否则依赖位置的断言会被这层自己带偏",
  );
  for (const needle of gone) {
    assert.doesNotMatch(stripped, new RegExp(escapeNeedle(needle), "u"), `应剥掉：${needle}`);
  }
  for (const needle of kept) {
    assert.match(stripped, new RegExp(escapeNeedle(needle), "u"), `应保留：${needle}`);
  }
  return stripped;
}

test("行注释与块注释都被剥掉，代码原样留下", () => {
  expectStrip("const a = 1; // 说明\nconst b = 2;\n", { gone: ["说明"], kept: ["const a = 1;", "const b = 2;"] });
  expectStrip("const a = 1; /* 说明 */ const b = 2;", { gone: ["说明"], kept: ["const a = 1;", "const b = 2;"] });
  // 块注释跨行：换行必须保留（否则行号全错位，后面按行切的断言全废）
  const multiline = "const a = 1;\n/* 第一段\n   第二段 */\nconst b = 2;";
  const stripped = expectStrip(multiline, { gone: ["第一段", "第二段"], kept: ["const a = 1;", "const b = 2;"] });
  assert.equal(stripped.split("\n").length, multiline.split("\n").length, "跨行块注释的换行数必须原样保留");
});

test("★ 被注释掉的调用必须消失 —— 这正是复验 §3 的 M4 变异形态", () => {
  // 变异的做法就是「整行前面加 // 」：文本一个字没少，朴素 assert.match 全绿。
  const raw = '  // renderKeyError("#apiKeyError", profile.keyError);\n';
  assert.match(raw, /renderKeyError\("#apiKeyError", profile\.keyError\)/u, "（前提）不剥注释时确实匹配得上");
  assert.doesNotMatch(
    stripComments(raw),
    /renderKeyError\("#apiKeyError", profile\.keyError\)/u,
    "剥完注释后必须匹配不上 —— 否则这层护栏等于没加",
  );
  expectStrip(raw, { gone: ["renderKeyError"] });
});

test("字符串里的 `//` 与 `/*` 不是注释，不能剥", () => {
  expectStrip('const u = "https://example.com/a//b";', { kept: ["https://example.com/a//b"] });
  expectStrip("const u = 'a/*b*/c';", { kept: ["a/*b*/c"] });
  expectStrip("const u = `http://x/${y}`;", { kept: ["http://x/"] });
  // 转义引号不能提前收尾字符串
  expectStrip('const u = "a\\"//b";', { kept: ['a\\"//b'] });
});

test("正则字面量里的 `/` 与 `//` 不是注释起点", () => {
  expectStrip("const re = /[/]/;", { kept: ["/[/]/"] });
  expectStrip("const re = /\\s+/u;", { kept: ["/\\s+/u"] });
  expectStrip("const re = /\\/\\//g;", { kept: ["/\\/\\//g"] });
  expectStrip("const x = /a[/]b/.test(s);", { kept: ["/a[/]b/"] });
  // 关键字后面只能跟值 ⇒ 是正则不是除号
  expectStrip("function f(){ return /\\d+/u; }", { kept: ["return /\\d+/u"] });
  // 除号：前面是标识符 ⇒ 不当正则（`// 平均` 才是注释）
  expectStrip("const r = total / count; // 平均", { gone: ["平均"], kept: ["total / count"] });
});

test("模板串里的 `${}` 是代码：里面的注释要剥，外面的 `//` 要留", () => {
  const raw = "const s = `${a /* 插值里的注释 */}//不是注释`;";
  expectStrip(raw, { gone: ["插值里的注释"], kept: ["//不是注释"] });
  // 插值里有对象字面量的花括号：不能提前把插值关掉
  expectStrip("const s = `${ {a: 1}.a }尾巴`;", { kept: ["{a: 1}.a", "尾巴"] });
  // 插值里再套一层模板
  expectStrip("const s = `${ `in` }out`;", { kept: ["in", "out"] });
});

test("边界：CRLF、文件末尾没换行的注释、空输入", () => {
  expectStrip("const a = 1; // 尾\r\nconst b = 2;", { gone: ["尾"], kept: ["const b = 2;"] });
  expectStrip("const a = 1; // 结尾没有换行", { gone: ["结尾没有换行"], kept: ["const a = 1;"] });
  assert.equal(stripComments(""), "");
  assert.equal(stripComments(undefined), "");
  assert.equal(stripComments("没有注释"), "没有注释", "没注释的文本必须逐字节不变");
});

test("HTML：`<!-- -->` 要剥，但 URL 里的 `//` 必须留；script/style 内按各自规则剥", () => {
  expectStrip(
    '<div><!-- <button id="restoreClient">停用服务</button> --></div>',
    { gone: ["restoreClient", "停用服务"], kept: ["<div>"] },
    stripHtmlComments,
  );
  expectStrip('<a href="http://x/y">z</a>', { kept: ["http://x/y"] }, stripHtmlComments);
  expectStrip(
    "<script>\n// 这行被注释掉了\nconst a = 1;\n</script>",
    { gone: ["这行被注释掉了"], kept: ["const a = 1;"] },
    stripHtmlComments,
  );
  expectStrip(
    "<style>\n/* .modal[hidden]{display:none} */\n.a{color:red}\n</style>",
    { gone: [".modal[hidden]"], kept: [".a{color:red}"] },
    stripHtmlComments,
  );
});

test("CSS：只有块注释；字符串里的 `/*` 要留", () => {
  expectStrip("/* 说明 */\n.a{color:red}", { gone: ["说明"], kept: [".a{color:red}"] }, stripCssComments);
  expectStrip('a::after{content:"/*"}', { kept: ['content:"/*"'] }, stripCssComments);
});

test("★ 真实仓库文件：整行 `//` 注释的行必须被剥成空白，且幂等、且不误伤代码里的 URL", async () => {
  for (const { rel, codeUrls } of REAL_JS_FILES) {
    const url = new URL(rel, import.meta.url);
    const raw = await readFile(url, "utf8");
    const stripped = stripComments(raw);
    assert.equal(stripped.length, raw.length, `${rel}：剥注释必须等长`);

    const rawLines = raw.split("\n");
    const strippedLines = stripped.split("\n");
    assert.equal(strippedLines.length, rawLines.length, `${rel}：行数不能变`);

    let commentLines = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      if (/^\s*\/\//u.test(rawLines[i])) {
        assert.equal(strippedLines[i].trim(), "", `${rel} 第 ${i + 1} 行是整行行注释，剥完必须只剩空白`);
        commentLines += 1;
      }
    }
    assert.ok(commentLines > 0, `${rel}：这份文件里一条整行注释都没有 ⇒ 这条自检是空的，换个文件`);

    assert.equal(stripComments(stripped), stripped, `${rel}：必须幂等（剥第二次不再变化）`);

    // 代码里的 URL 一条都不能少（少了就说明把字符串/模板内容当注释剥了）
    for (const codeUrl of codeUrls) {
      assert.ok(raw.includes(codeUrl), `（前提）${rel} 里应该有 ${codeUrl} —— 没有说明这份清单过期了，要更新`);
      assert.ok(stripped.includes(codeUrl), `${rel}：代码里的 ${codeUrl} 必须原样留下`);
    }
  }
});

test("★ 真实仓库文件：剥完之后仍然是一份能被 Node 解析的源码", async () => {
  // 「剥注释不能把代码剥坏」的真判据：解析器说了算，不是我说。
  // 临时目录里放一份 `{"type":"module"}`，让模块类型与源文件所在包一致（源文件都在 type:module 下）。
  const dir = await mkdtemp(join(tmpdir(), "olivia-stripcheck-"));
  try {
    await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
    for (const { rel } of REAL_JS_FILES) {
      const url = new URL(rel, import.meta.url);
      const raw = await readFile(url, "utf8");
      const name = rel.replace(/^.*\//u, "");

      // 前提：原文自己要先能解析。原文都过不了（比如属于别的模块体系）就不假装给结论。
      const probe = join(dir, `origin-${name}`);
      await writeFile(probe, raw, "utf8");
      try {
        await execFileAsync(process.execPath, ["--check", probe]);
      } catch {
        continue;
      }

      const target = join(dir, name);
      await writeFile(target, stripComments(raw), "utf8");
      await execFileAsync(process.execPath, ["--check", target]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSourceText：按扩展名派发规则；HTML 不能用 JS 规则（会把 URL 吃掉）", async () => {
  const jsUrl = new URL("../public/app.js", import.meta.url);
  const rawJs = await readFile(jsUrl, "utf8");
  const js = await readSourceText(jsUrl);
  assert.equal(js, stripComments(rawJs), "js 走 JS 规则");

  const htmlUrl = new URL("../public/index.html", import.meta.url);
  const rawHtml = await readFile(htmlUrl, "utf8");
  const html = await readSourceText(htmlUrl);
  assert.equal(html, stripHtmlComments(rawHtml), "html 走 HTML 规则");
  assert.equal(html.length, rawHtml.length);

  // ★ 这条是派发的意义所在：index.html 里有 `https://…` 的属性值，
  //   若误用 JS 规则，从 `//` 开始到行尾全被当成注释抹掉 ⇒ 两者必然不同。
  assert.match(rawHtml, /https?:\/\//u, "（前提）index.html 里确实有带 // 的 URL");
  assert.notEqual(html, stripComments(rawHtml), "HTML 绝不能按 JS 规则剥：URL 里的 // 会被整段吃掉");
  assert.equal(countOf(html, "https://"), countOf(rawHtml, "https://"), "HTML 里的 URL 一条都不能少");

  assert.equal(fileURLToPath(htmlUrl).endsWith("index.html"), true, "（前提）路径转换可用");
});

test("PowerShell：`#` 行注释与 `<# #>` 块注释；字符串里的 `#` 要留", () => {
  const ps = stripPowerShellComments;
  expectStrip("$a = 1 # 说明\n$b = 2", { gone: ["说明"], kept: ["$a = 1", "$b = 2"] }, ps);
  expectStrip("<# 块\n注释 #>\n$a = 1", { gone: ["块", "注释"], kept: ["$a = 1"] }, ps);
  expectStrip("$a = 'http://x#y'", { kept: ["http://x#y"] }, ps);
  expectStrip('$a = "abc#def"', { kept: ["abc#def"] }, ps);
  // ★ 双引号串里反斜杠**不是**转义符：PS 路径 `"C:\dir\"` 必须以最后一个引号闭合，
  //   后面的 `#` 才是注释。若按 JS 规则把 `\` 当转义，`\"` 被吞掉、字符串会一路吃到行尾
  //   ⇒ 注释根本剥不掉。（第一版判据只写了 `$p = "C:\dir\"`，后面没跟注释，
  //   误不误闭都看不出差别 ⇒ 变异 M8 仍然绿。判据要能看到后果。）
  expectStrip('$p = "C:\\dir\\" # 说明', { gone: ["说明"], kept: ['C:\\dir\\"'] }, ps);
  // 单引号串里连写两个单引号才是字面引号
  expectStrip("$a = 'it''s #x'", { kept: ["it''s #x"] }, ps);
});

test("C#：与 JS 同规则（`//` 与 `/* */`）", () => {
  // 已知盲区：逐字字符串 `@"C:\dir\"` 里的 `\"` 会被当成转义 —— 目前本仓 .cs 里没有这种写法，
  // 真出现了要单独给 C# 加 doubledDouble 规则，别直接改 JS 规则。
  expectStrip("// 注释\npublic int X { get; set; } /* 另注 */", {
    gone: ["注释", "另注"],
    kept: ["public int X { get; set; }"],
  });
});

test("派发表：只剥确认过规则的扩展名，其余原样返回（宁可漏剥，不可误剥）", () => {
  const table = {
    ".js": stripComments,
    ".mjs": stripComments,
    ".cjs": stripComments,
    ".cs": stripComments,
    ".css": stripCssComments,
    ".html": stripHtmlComments,
    ".htm": stripHtmlComments,
    ".ps1": stripPowerShellComments,
    ".psm1": stripPowerShellComments,
  };
  for (const [ext, fn] of Object.entries(table)) {
    assert.equal(stripperForExtension(`a${ext}`), fn, `${ext} 应走 ${fn.name}`);
  }
  // 这些没有确认过注释规则 ⇒ 一律原样返回（把 .ps1 当 JS 剥会把 URL 里的 // 整段抹掉，宁可不剥）
  for (const ext of [".md", ".json", ".iss", ".txt", ".csproj", ".isl", ".env", ""]) {
    assert.equal(stripperForExtension(`a${ext}`), null, `${ext} 没有确认过的规则 ⇒ 必须原样返回`);
  }
  assert.deepEqual(
    new Set(STRIPPED_EXTENSIONS),
    new Set(Object.keys(table)),
    "「已确认扩展名」清单要和派发表逐项一致，不能悄悄多剥或少剥",
  );
});

test("readSourceTextSync：同步版同样按扩展名剥；未知扩展名逐字节原样", () => {
  const htmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
  const rawHtml = readFileSync(htmlPath, "utf8");
  assert.equal(readSourceTextSync(htmlPath), stripHtmlComments(rawHtml), "index.html 走 HTML 规则");

  const jsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  assert.equal(
    readSourceTextSync(jsonPath),
    readFileSync(jsonPath, "utf8"),
    "未知扩展名必须逐字节原样（不能拿 JS 规则去剥 json）",
  );
});

function countOf(text, needle) {
  return text.split(needle).length - 1;
}
