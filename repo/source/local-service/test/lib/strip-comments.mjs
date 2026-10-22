// ★ 2026-10-19 第五轮复验 §3：静态「接线断言」挡不住**被注释掉**的规则。
//
// 形态：`assert.match(source, /someFunction\(arg\)/u)` —— 断言「源码里真的调了这个函数」。
//   把那一行前面加个 `// ` 注释掉，**正则照样匹配**（文本一个字没少）⇒ 测试全绿，
//   而功能其实被关掉了。「注释掉」恰好是最自然的临时禁用方式，而且它会**永久留在那里**。
//
// 这是本仓 §3 记过的同一条病，只是载体换了三次：
//   ① CSS：`/* .modal[hidden]{...} */` 里那几个字还在，静态 grep 全绿；
//   ② HTML：`<!-- <button id="restoreClient">… -->`，标签还在，就是不渲染；
//   ③ JS ：`// renderKeyError("#apiKeyError", profile.keyError);`。
// 修法一样：**匹配之前先把注释剥掉**。放在 `test/helpers/` 而不是每个文件各写一份 ——
//   「同一个病要一次治完所有处」。
//
// 实现要点（每一个都是会假红/假绿的地方）：
//   ① 必须**认得字符串**：`'https://x'` / `"a//b"` / 反引号模板里的 `//` 不是注释。
//   ② 必须**认得正则字面量**：`/[/]/`、`/\s+/u` 里的 `/` 和 `//` 不是注释起点。
//      判定办法：看 `/` 前面那个有意义的字符 —— 是运算符 / `(` / `,` / `:` / `[` / `return`
//      这类「后面只能跟值」的位置，才当正则起点；否则当除号。
//   ③ 模板串里的 `${ ... }` 是**代码**，要按代码状态继续走（里面可能有正则、可能有注释）。
//   ④ 剥掉的内容用**等长空白**替换 ⇒ 长度、行号、列号全部不变，
//      依赖偏移/行号的断言（以及「长度相同」这种自检）都不受影响。
//   ⑤ HTML 里 `//` 不是注释（`http://` 满地都是），只有 `<!-- -->` 是；
//      但 `<script>` / `<style>` **里面**又变回 JS / CSS 规则 ⇒ HTML 模式要分段处理。
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
]);
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "case",
]);

/** JS：`//` 行注释 + `/* *\/` 块注释，且要认字符串 / 模板串 / 正则字面量。 */
const JS_MODE = {
  line: "//",
  blockStart: "/*",
  blockEnd: "*/",
  strings: true,
  backslashEscape: true,
  templates: true,
  regex: true,
};
/** CSS：只有 `/* *\/`，没有行注释；要认字符串（`content: "/*"` 这类）。 */
const CSS_MODE = {
  line: null,
  blockStart: "/*",
  blockEnd: "*/",
  strings: true,
  backslashEscape: true,
  templates: false,
  regex: false,
};
/**
 * PowerShell：`#` 行注释 + `<# … #>` 块注释。
 * ★ 转义规则和 JS 不一样，写错就会整段跑偏：
 *     · 单引号串里 `\` **不是**转义，连写两个单引号 `''` 才是；
 *     · 双引号串里的转义是**反引号** `` ` ``，不是反斜杠（路径 `C:\a\` 里满地都是反斜杠）。
 */
const PS1_MODE = {
  line: "#",
  blockStart: "<#",
  blockEnd: "#>",
  strings: true,
  backslashEscape: false,
  backtickEscape: true,
  doubledSingle: true,
  templates: false,
  regex: false,
};
/** HTML 正文：只有 `<!-- -->`；`//` 不是注释（URL 里到处都是）。 */
const HTML_TEXT_MODE = {
  line: null,
  blockStart: "<!--",
  blockEnd: "-->",
  strings: false,
  templates: false,
  regex: false,
};

function isRegexStart(code, index) {
  // 往前找第一个非空白字符
  let i = index - 1;
  while (i >= 0 && /\s/u.test(code[i])) i -= 1;
  if (i < 0) return true; // 文件开头：只能是正则（除号在这儿没意义）
  const ch = code[i];
  if (REGEX_PRECEDERS.has(ch)) return true;
  // 关键字（return / typeof …）后面只能跟值 ⇒ 是正则
  const before = code.slice(Math.max(0, i - 16), i + 1);
  for (const keyword of REGEX_KEYWORDS) {
    if (before.endsWith(keyword) && !/[\w$]/u.test(before[before.length - keyword.length - 1] ?? "")) return true;
  }
  return false;
}

function blanks(count) {
  return " ".repeat(count);
}

/**
 * 按给定模式扫一遍文本，把注释替换成等长空白，其余字符原样吐出。
 * 保证 `out.length === text.length`，且所有换行位置不变。
 */
function scanCode(text, mode) {
  let out = "";
  let i = 0;
  // 模板串 / 插值的嵌套栈：`true` = 模板文本层，`"interp"` = `${}` 里的代码层
  const templateStack = [];
  let state = "code"; // code | line-comment | block-comment | single | double | template | regex
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    if (state === "line-comment") {
      if (ch === "\n") { state = "code"; out += ch; i += 1; continue; }
      out += ch === "\r" || ch === "\t" ? ch : " ";
      i += 1;
      continue;
    }

    if (state === "block-comment") {
      if (text.startsWith(mode.blockEnd, i)) {
        state = "code";
        out += blanks(mode.blockEnd.length);
        i += mode.blockEnd.length;
        continue;
      }
      out += ch === "\n" || ch === "\r" || ch === "\t" ? ch : " ";
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (ch === "\\") { out += ch + next; i += 2; continue; }
      if (ch === "[") { // 字符类里的 `/` 不结束正则
        out += ch;
        i += 1;
        while (i < text.length && text[i] !== "]") {
          if (text[i] === "\\") { out += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
          out += text[i];
          i += 1;
        }
        continue;
      }
      if (ch === "/") { state = "code"; out += ch; i += 1; continue; }
      out += ch;
      i += 1;
      continue;
    }

    // 字符串 / 模板串（三种的收尾与转义在这里统一处理）
    if (state === "single" || state === "double" || state === "template") {
      // PowerShell 单引号串：`''` 才是一个字面单引号（`\'` 不是转义）。
      // ⚠ 这一支对状态机是 **no-op**：`''` 解释成「字面引号」还是「闭串+开串」，
      //   经过两个引号后都停在「串内」，后续扫描逐字节相同（变异 M9 实测等价）。
      //   保留它只是为了把 PS 的规则写在明处 —— 别误以为删了会出错，也别指望它能挡住什么。
      if (state === "single" && mode.doubledSingle && ch === "'" && next === "'") {
        out += ch + next;
        i += 2;
        continue;
      }
      // PowerShell 双引号串：转义符是反引号（反斜杠是字面量，不能当转义吞掉下一个字符）
      if (mode.backtickEscape && ch === "`") { out += ch + next; i += 2; continue; }
      if (mode.backslashEscape && ch === "\\") { out += ch + next; i += 2; continue; }
      if (state === "single" && ch === "'") { state = "code"; out += ch; i += 1; continue; }
      if (state === "double" && ch === '"') { state = "code"; out += ch; i += 1; continue; }
      if (state === "template") {
        if (ch === "`") { templateStack.pop(); state = "code"; out += ch; i += 1; continue; }
        if (ch === "$" && next === "{") { // 进入内插代码；压栈，遇到配对的 } 回到模板文本
          state = "code";
          templateStack.push("interp");
          out += ch + next;
          i += 2;
          continue;
        }
      }
      out += ch;
      i += 1;
      continue;
    }

    // state === "code"
    // ★ 模板插值的收尾 `}` 必须**最先**判：否则它会被下面的普通代码分支吃掉，
    //   状态永远回不到 template，后面的模板文本就会被当成代码扫（假红/假绿都从这里来）。
    if (ch === "}" && templateStack[templateStack.length - 1] === "interp") {
      templateStack.pop();
      state = "template";
      out += ch;
      i += 1;
      continue;
    }
    if (mode.line && text.startsWith(mode.line, i)) {
      state = "line-comment";
      out += blanks(mode.line.length);
      i += mode.line.length;
      continue;
    }
    if (mode.blockStart && text.startsWith(mode.blockStart, i)) {
      state = "block-comment";
      out += blanks(mode.blockStart.length);
      i += mode.blockStart.length;
      continue;
    }
    if (mode.strings && (ch === "'" || ch === '"')) {
      state = ch === "'" ? "single" : "double";
      out += ch;
      i += 1;
      continue;
    }
    if (mode.templates && ch === "`") {
      templateStack.push(true);
      state = "template";
      out += ch;
      i += 1;
      continue;
    }
    if (mode.regex && ch === "/" && isRegexStart(text, i)) {
      state = "regex";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 剥掉 JS 源码里的注释（`//` 与 `/* *\/`）。 */
export function stripComments(code) {
  return scanCode(String(code ?? ""), JS_MODE);
}

/** 剥掉 CSS 里的注释（只有 `/* *\/`）。 */
export function stripCssComments(code) {
  return scanCode(String(code ?? ""), CSS_MODE);
}

/** 剥掉 PowerShell 里的注释（`#` 行注释 + `<# … #>` 块注释）。 */
export function stripPowerShellComments(code) {
  return scanCode(String(code ?? ""), PS1_MODE);
}

/**
 * 剥掉 HTML 里的注释（`<!-- -->`），且 `<script>` / `<style>` 正文按 JS / CSS 规则剥。
 * ★ 不能对整份 HTML 套 JS 规则：`http://`、`//cdn` 这类 URL 会被当成注释起点整段抹掉。
 */
export function stripHtmlComments(html) {
  const text = String(html ?? "");
  const tagPattern = /<\/?(script|style)\b[^>]*>/giu;
  let out = "";
  let pos = 0; // 下一段「还没处理过」的起点
  let inTag = null; // null | "script" | "style"
  let bodyStart = 0;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const isClose = match[0][1] === "/";
    if (inTag === null && !isClose) {
      out += scanCode(text.slice(pos, match.index), HTML_TEXT_MODE);
      out += match[0];
      inTag = name;
      bodyStart = match.index + match[0].length;
      pos = bodyStart;
      continue;
    }
    if (inTag !== null && isClose && name === inTag) {
      out += scanCode(text.slice(bodyStart, match.index), name === "script" ? JS_MODE : CSS_MODE);
      out += match[0];
      inTag = null;
      pos = match.index + match[0].length;
    }
  }
  // 收尾：还在 script/style 里（标签没闭合）就按对应语言剥，否则按 HTML 正文剥。
  out += scanCode(text.slice(pos), inTag === "style" ? CSS_MODE : inTag === "script" ? JS_MODE : HTML_TEXT_MODE);
  return out;
}
