// 静态文件白名单一致性：public/ 顶层实际文件 == serveStatic 的白名单。
//
// 起因（1.0.5）：public/ 新增 patch-loss-notice.js 时，靠人手把文件名补进
// repo/source/local-service/server.js 的 serveStatic 白名单，当时漏掉不会有任何
// 启动期或测试期报错。一旦漏登记，app.js 的 ESM import 就 404 被浏览器拒绝，
// 整个管理界面白屏（不是局部功能失效，用户没有可用界面）。
// 1.0.5 把它记成 TODO(技术债 · 静态文件白名单硬编码)，1.1.0 补上这条双向比对：
//   · 白名单少了文件（漏登记）→ 这里失败
//   · 白名单多了文件（public/ 里删了文件却没删名单）→ 也失败
// 白名单本身仍是手工维护的（没改成目录扫描），只是漏改从此在门禁里暴露。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(HERE, "..");
const PUBLIC_DIR = join(SERVICE_ROOT, "public");

/** 从 server.js 抽 serveStatic 的白名单数组：唯一真相在源码里，不在测试里另抄一份 */
function whitelistFromSource(source) {
  const matched = /function serveStatic\([\s\S]*?if \(!\[([\s\S]*?)\]\.includes\(relative\)\)/u.exec(source);
  assert.ok(matched, "没能在 server.js 里定位 serveStatic 的白名单数组（抽取写法变了？）");
  const names = [...matched[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  assert.ok(names.length > 0, "白名单抽出来是空的，抽取正则有误");
  return names;
}

test("serveStatic 白名单与 public/ 顶层文件双向一致", async () => {
  const source = await readFile(join(SERVICE_ROOT, "server.js"), "utf8");
  const listed = [...new Set(whitelistFromSource(source))].sort();
  // 只比顶层文件：白名单里的名字都是 public/ 下的顶层名（serveStatic 只按顶层名匹配），
  // 所以 public/ 里的子目录不参与比对。
  const actual = (await readdir(PUBLIC_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(
    listed.filter((name) => !actual.includes(name)),
    [],
    "白名单里有 public/ 下不存在的文件（删了文件没删名单：这是永远 404 的死条目）",
  );
  assert.deepEqual(
    actual.filter((name) => !listed.includes(name)),
    [],
    "public/ 里有文件没进白名单（漏登记：该文件一律 404；app.js 用 ESM import 引它会导致整个管理界面白屏）",
  );
  assert.deepEqual(listed, actual, "白名单与 public/ 顶层文件必须一一对应");
});
