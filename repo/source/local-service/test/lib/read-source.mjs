// 静态源码断言的统一入口。
//
// 「先剥注释再断言」这件事，**最省事也最不容易漏的做法是在读文件的时候就剥掉**：
//   一个文件通常只在一个地方（或一个 `read()` 入口）读源码，下游几十条 assert 自动全部受益。
//   反过来，若要求每条 assert 自己记得剥，迟早会漏一条（§3：漏的那条就是假绿）。
//
// 所以：
//   `await readFile(new URL("../public/app.js", import.meta.url), "utf8")`
//     → `await readSourceText(new URL("../public/app.js", import.meta.url))`
//   `readFileSync(join(here, "..", "public", "app.js"), "utf8")`
//     → `readSourceTextSync(join(here, "..", "public", "app.js"))`
//
// ★ 派发表只列**确认过注释规则**的扩展名。没列出的扩展名**原样返回**（不剥）——
//   宁可漏剥，也不能按错的语言规则把正文吃掉（把 `.ps1` 当 JS 剥会把 URL 的 `//` 整段抹掉）。
//   目前没覆盖的：`.iss`（Inno Setup 脚本，注释是 `;`）、`.md`、`.json`、`.csproj`、`.isl`。
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments, stripHtmlComments, stripPowerShellComments } from "./strip-comments.mjs";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const CSS_EXTENSIONS = new Set([".css"]);
const PS1_EXTENSIONS = new Set([".ps1", ".psm1"]);
// C# 的 `//` 与 `/* */` 与 JS 一致，字符串转义也是反斜杠 ⇒ 复用 JS 规则。
// （已知盲区：逐字字符串 `@"C:\dir\"` 里的 `\"` 会被当成转义，见 strip-comments.test.js 的说明。）
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".cs"]);

function pathOf(url) {
  if (url instanceof URL) return fileURLToPath(url);
  // ★ 必须要求 `://`：Windows 盘符 `E:\…` 也会被 `[a-z]+:` 匹配上，
  //   当成 URL 去 new URL() 会抛错（这是本仓踩过的坑，别再踩）。
  if (typeof url === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) return fileURLToPath(new URL(url));
  return String(url);
}

/** 按扩展名选剥注释的规则；没有对应规则就返回 null（表示「原样返回，别动」）。 */
export function stripperForExtension(path) {
  const ext = extname(path).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return stripHtmlComments;
  if (CSS_EXTENSIONS.has(ext)) return stripCssComments;
  if (PS1_EXTENSIONS.has(ext)) return stripPowerShellComments;
  if (JS_EXTENSIONS.has(ext)) return stripComments;
  return null;
}

/** 已确认规则的扩展名（供自检用：派发表要与它一致，不能悄悄多剥或少剥）。 */
export const STRIPPED_EXTENSIONS = [...HTML_EXTENSIONS, ...CSS_EXTENSIONS, ...PS1_EXTENSIONS, ...JS_EXTENSIONS];

/**
 * 读一份源码，并把注释剥成等长空白后返回。
 * 扩展名没有对应规则时**原样返回**（见上：宁可漏剥，不可误剥）。
 */
export async function readSourceText(url, options = {}) {
  const raw = await readFile(url, "utf8");
  const stripper = options.stripper ?? stripperForExtension(pathOf(url));
  return stripper ? stripper(raw) : raw;
}

/** readSourceText 的同步版（本仓大量测试用 readFileSync 读源码）。 */
export function readSourceTextSync(path, options = {}) {
  const raw = readFileSync(path, "utf8");
  const stripper = options.stripper ?? stripperForExtension(String(path));
  return stripper ? stripper(raw) : raw;
}
