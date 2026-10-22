// 错误号护栏（2026-10-17）
//
// 起因（用户原话）：「程序报错代码一定要有能让程序快速识别的报错号和方便用户查看的显式报错」。
// 建立前实测：144 处 httpError 里 **132 处吃默认 code = -1** —— 响应体有 code 字段，
// 但 132 种错共用一个号，程序区分不了、日志检索不到。
//
// 本套件钉死四件事，任何一条破了就是「错误号体系又开始退化」：
//   ① 每处 httpError 调用都给了号（不许再出现两实参调用）
//   ② 号一律取自 ERR 表（不许写裸字符串/数字字面量 —— 否则表形同虚设）
//   ③ 号是唯一的：一个号不对应两种语义不同的错（同号不同 message 只放行"同义不同措辞"）
//   ④ 用户看得见：httpError 把号拼进 message（前端 20 个文件都是直接上屏 body.message）
//
// 反向验证方法（改了 server.js 必须跑）：
//   把任意一处 `ERR.XXX` 删掉 ⇒ ① 必须红；把 httpError 的拼号删掉 ⇒ ④ 必须红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.js");
const src = readFileSync(SERVER, "utf8");
const lines = src.split(/\r?\n/u);

function splitArgs(text) {
  const out = [];
  let cur = ""; let depth = 0; let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]; const prev = text[i - 1];
    if (quote) { cur += ch; if (ch === quote && prev !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 收集所有 httpError( ... ) 调用（同行内括号配对）。
// ⚠️ 2026-10-17 发版前必修清单 O2：旧写法对**跨行**调用 `continue` 跳过，注释却说「③ 有兜底」——
// 而 ③ 是 ERR 表自身的一致性检查，根本不覆盖调用点 ⇒ 将来有人写一个跨行的无号调用，本套件不会红。
// 现在改成**显式计数并断言为 0**：真有跨行调用出现时，测试直接报出来（而不是静默漏扫）。
function collectCalls() {
  const re = /httpError\s*\(/gu;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const lineNo = src.slice(0, m.index).split(/\r?\n/u).length;
    const line = lines[lineNo - 1] ?? "";
    const at = line.search(/httpError\s*\(/u);
    if (at < 0) continue;
    const open = at + line.slice(at).indexOf("(");
    let depth = 0; let end = -1;
    for (let i = open; i < line.length; i += 1) {
      if (line[i] === "(") depth += 1;
      else if (line[i] === ")") { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) {
      MULTILINE_CALLS.push(lineNo);
      continue;
    }
    out.push({ lineNo, args: splitArgs(line.slice(open + 1, end)) });
  }
  return out;
}
const MULTILINE_CALLS = [];

// 抠 ERR 表的键
function errKeys() {
  const m = /const ERR = \{[\s\S]*?\n\};/u.exec(src);
  assert.ok(m, "server.js 里找不到 const ERR = { … } 表");
  return [...m[0].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gmu)].map(x => x[1]);
}

test("① 每处 httpError 都给了错误号（不许再吃默认 -1）", () => {
  const calls = collectCalls();
  assert.ok(calls.length >= 140, `只扫到 ${calls.length} 处，扫描器可能失效了`);
  assert.deepEqual(MULTILINE_CALLS, [],
    `这些 httpError 调用是跨行的，本扫描器扫不到它们（= 没人校验它们有没有给号）：${MULTILINE_CALLS.map(n => ":" + n).join("、")} —— 改成单行，或把本套件升级成跨行解析`);
  const missing = calls.filter(c => c.args.length < 3).map(c => `:${c.lineNo}`);
  assert.deepEqual(missing, [],
    `这些 httpError 调用没给错误号（会退化成 code=-1，程序无法区分）：${missing.join("、")} —— 从 server.js 的 ERR 表里取一个，语义不同就新加一个`);
});

test("② 错误号一律取自 ERR 表（不许写裸字符串/数字字面量）", () => {
  const calls = collectCalls();
  const keys = new Set(errKeys());
  const bad = [];
  for (const c of calls) {
    const code = c.args[2];
    if (code === undefined) continue;
    if (code === "error.code") continue; // 透传下游错误号，是合法写法
    // 定义处（`function httpError(status, message, code = -1)`）与包装处
    // （`playbackMediaError` 的默认参数 `code`）不是调用，跳过 —— 它们的参数名就叫 code。
    if (code === undefined || code === "code" || /^code\s*=/u.test(code)) continue;
    if (code === "error.code") continue; // 透传下游错误号，是合法写法
    const mm = /^ERR\.([A-Z][A-Z0-9_]*)$/u.exec(code);
    if (!mm) { bad.push(`:${c.lineNo} 写了 ${code}`); continue; }
    if (!keys.has(mm[1])) bad.push(`:${c.lineNo} 用了表外的 ERR.${mm[1]}`);
  }
  assert.deepEqual(MULTILINE_CALLS, [],
    `这些 httpError 调用是跨行的，本扫描器扫不到它们（= 没人校验它们有没有给号）：${MULTILINE_CALLS.map(n => ":" + n).join("、")}`);
  assert.deepEqual(bad, [],
    `这些错误号不是 ERR 表里的（表就形同虚设，后人无法一眼看全）：${bad.join("、")}`);
});

test("③ ERR 表自身：键与值一致、无重复值", () => {
  const keys = errKeys();
  assert.ok(keys.length >= 100, `ERR 表只有 ${keys.length} 项，是不是被误删了`);
  assert.equal(new Set(keys).size, keys.length, "ERR 表有重复的键");
  // 键必须等于值（保持 `ERR.X` 与 `"X"` 两种写法都指向同一个字符串）
  const m = /const ERR = \{[\s\S]*?\n\};/u.exec(src)[0];
  const mismatch = [...m.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*"([^"]+)"/gmu)]
    .filter(x => x[1] !== x[2]).map(x => `${x[1]}→${x[2]}`);
  assert.deepEqual(mismatch, [], `ERR 表的键与值必须相同（否则同一错误会有两个号）：${mismatch.join("、")}`);
});

test("④ 用户看得见：httpError 把号拼进 message", () => {
  const fn = /function httpError\(status, message, code = -1\) \{[\s\S]*?\n\}/u.exec(src);
  assert.ok(fn, "找不到 httpError 定义");
  const body = fn[0];
  // 必须拼号（前端 20 个文件都是 `throw new Error(body.message)` 直接上屏）
  assert.match(body, /`\$\{message\}\$\{suffix\}`/u,
    "httpError 必须把错误号拼进 message —— 前端直接上屏 body.message，不拼用户就看不见号");
  // 号缺失 / 是默认 -1 时不拼（那是没登记号的路径，别污染文案）
  assert.match(body, /code !== "-1"/u, "code 为 -1（未登记号）时不要拼，否则满屏都是（-1）");
  // rawMessage 保留原文，供日志与测试比对
  assert.match(body, /error\.rawMessage = message/u,
    "必须保留 rawMessage —— 拼了号之后，按原文断言的测试与日志需要它");
});

test("⑤ 一个号不对应两种语义不同的错（同号不同 message 只允许同义改写）", () => {
  const calls = collectCalls();
  const byCode = new Map();
  for (const c of calls) {
    const code = c.args[2] ?? "";
    if (!/^ERR\./u.test(code)) continue;
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add((c.args[1] ?? "").replace(/\$\{[^}]*\}/gu, "…"));
  }
  // 允许同号多消息的清单：这些是**同一语义的不同措辞**（例如都表示"这封信不存在"），
  // 新增条目必须在这里写清理由 —— 否则就是"看不出是哪种错"，必须拆成两个号。
  const ALLOWED_SAME_MEANING = new Set([
    "ERR.LETTER_NOT_FOUND",      // 「信件不存在」在 3 个路由里重复出现，措辞一致
    "ERR.COMMON_FILE_NOT_FOUND", // 「文件不存在」与动态 missingMessage，同一语义
    "ERR.MODEL_CONFIG_INVALID",  // 都是「模型配置不可用：${原因}」，原因不同但错误类型相同
    "ERR.MODEL_CONNECTIVITY_FAILED", // 三个连通性测试，失败原因各异但同属"连不上"
    "ERR.PLAYLIST_ITEM_INCOMPLETE",  // 播单条目不完整（toy/admin 两处同文案）
    "ERR.FOLDER_METHOD_NOT_ALLOWED", // 歌单接口不支持这个方法（三个方法位同文案）
    "ERR.SOUL_TRUNCATED",        // .soul 文件不完整（三处判据不同、结论相同）
    "ERR.SOUL_FILE_TOO_LARGE",   // .soul 超过 10 GB（两个判据点）
    "ERR.SOUL_FORMAT_INVALID",   // .soul 格式不正确（魔数/清单两处）
    "ERR.VIDEO_TOO_LARGE",       // 视频超过 512 MB（声明长度与实际长度两处）
    "ERR.VIDEO_FORMAT_INVALID",  // MP4 格式不正确（ftyp 与 moov 两处）
    "ERR.LETTER_DAILY_QUOTA_EXCEEDED", // 每日上限（两处入口同文案）
    "ERR.SETTING_DOWNLOAD_JOB_MISSING", // 缺少下载任务标识（两处入口同文案）
    "ERR.SOUL_VIDEO_DATA_TRUNCATED", // 视频数据不完整（长度与 offset 两处判据）
    "ERR.COMMON_ROUTE_NOT_FOUND",   // 接口不存在（admin/toy 两处兜底同文案）
  ]);
  const bad = [];
  for (const [code, set] of byCode) {
    if (set.size > 1 && !ALLOWED_SAME_MEANING.has(code)) {
      bad.push(`${code} → ${[...set].map(s => s.slice(0, 40)).join(" | ")}`);
    }
  }
  assert.deepEqual(bad, [],
    `这些错误号对应了语义不同的多种错（程序拿到号也无法区分是哪一种）：\n  ${bad.join("\n  ")}\n拆成两个号，或把理由写进 ALLOWED_SAME_MEANING`);
});

test("⑥ 响应体把号带回给调用方（程序识别的通道必须是通的）", () => {
  // server.js:5982 附近：sendJson(req, res, { code: error.code ?? -1, message: error.message, data: null }, …)
  assert.match(src, /code: error\.code \?\? -1/u,
    "错误响应必须把 error.code 放进响应体的 code 字段 —— 这是程序端识别错误的唯一通道");
  assert.match(src, /message: error\.message/u,
    "错误响应必须带 message（已由 httpError 拼好「中文（号）」）");
  // 号不得是数组/对象（调用方会拿它做 === 比较）
  const keys = errKeys();
  // 防空转：表里必须真有键（定位失败时空数组会让下面 every 恒真）
  assert.ok(keys.length >= 100, `ERR 表解析出 ${keys.length} 个键，少于 100 —— 解析可能失败了`);
  assert.ok(keys.every(k => /^[A-Z][A-Z0-9_]*$/u.test(k)), "错误号必须是大写下划线形式（便于日志检索）");
});

test("⑦ E5：/toy/* 的错误回真实状态码，不再强制 HTTP 200（2026-10-18）", () => {
  // 旧实现（已删）：const responseStatus = req.url.startsWith("/toy/") && !error.mediaResponse ? 200 : status;
  // 强制 200 会让前端 6 处 `if (!response.ok)`（song-editor.js / game-lyrics.js / lyrics-settings.js /
  // game-letter-export.js / listen-naming-tools.js）与游戏端注入侧的 response.ok 判断永不触发。
  assert.doesNotMatch(src, /startsWith\("\/toy\/"\)[^\n]*\? 200/u,
    "统一 catch 里不得再按 /toy/ 前缀把错误强制成 HTTP 200");
  // 响应状态码必须来自真实 status（mediaResponse 的媒体流路径例外，仍由各自分支处理）
  assert.match(src, /const responseStatus = status;/u,
    "错误响应必须回真实状态码（responseStatus = status）");
  // envelope 结构不变：调用方只判 code 的行为完全不受影响
  assert.match(src, /code: error\.code \?\? -1, message: error\.message, data: null/u,
    "envelope {code,message,data} 结构必须保持不变");
});
