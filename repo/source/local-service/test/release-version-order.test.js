// 版本比较测试：确保「本支语义化版本（1.0）」与「旧格式（gXX）」能正确排序。
//
// 背景：程序版本标识从 gXX 改为语义化 1.0（上游部分 2008.2.7-linli9 不变）。
// 若按普通字符串比较，"1"(ASCII 49) 小于 "g"(103)，装了 g28 的用户会被误判为
// 「已是最新」而收不到 1.0 的更新提示。因此 releaseVersion 把本支标识统一映射为
// 可比较序号：gXX → XX；语义化 → major*1000 + minor*10 + patch。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");

function pick(name) {
  const pattern = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`, "u");
  const found = pattern.exec(source);
  assert.ok(found, `未能从 server.js 抽取 ${name}`);
  return found[0];
}

const context = {};
vm.runInNewContext(
  `${pick("stripTagPrefix")}\n${pick("releaseVersion")}\n${pick("isNewerRelease")}\nthis.newer = isNewerRelease; this.version = releaseVersion;`,
  context,
);
const newer = (current, latest) => context.newer(current, latest);
const T = suffix => `2008.2.7-linli9-${suffix}`;

test("本支语义化版本严格大于任何 gXX", () => {
  assert.equal(newer(T("g28"), T("1.0")), true, "装了 g28 应看到 1.0 的更新");
  assert.equal(newer(T("g30"), T("1.0")), true, "装了 g30 应看到 1.0 的更新");
  assert.equal(newer(T("1.0"), T("g30")), false, "1.0 不应被判为旧于 g30");
});

test("跨版本升级路径：g 系列 → 1.0 → 1.0.1 逐级都能检测到", () => {
  // 真实场景：老用户停在 g29，我们先后发了 1.0 和 1.0.1
  assert.equal(newer(T("g29"), T("1.0")), true, "g29 应看到 1.0");
  assert.equal(newer(T("g29"), T("1.0.1")), true, "g29 应看到 1.0.1（跨两级）");
  assert.equal(newer(T("1.0"), T("1.0.1")), true, "1.0 应看到 1.0.1");
  assert.equal(newer(T("1.0.1"), T("1.0.1")), false, "同版本不提示");
  assert.equal(newer(T("1.0.1"), T("1.0")), false, "不能提示回退");
});

test("语义化版本之间能正确排序", () => {
  assert.equal(newer(T("1.0"), T("1.1")), true);
  assert.equal(newer(T("1.1"), T("1.0")), false);
  assert.equal(newer(T("1.1"), T("1.2")), true);
  assert.equal(newer(T("1.9"), T("2.0")), true);
  assert.equal(newer(T("2.0"), T("1.9")), false);
});

test("相同版本不提示更新", () => {
  assert.equal(newer(T("1.0"), T("1.0")), false);
  assert.equal(newer(T("g28"), T("g28")), false);
});

test("旧格式仍按原语义比较", () => {
  assert.equal(newer(T("g04"), T("g28")), true);
  assert.equal(newer(T("g28"), T("g04")), false);
  assert.equal(newer("2008.2.7-linli.9", T("g28")), true);
});

test("上游版本提升仍然生效", () => {
  assert.equal(newer(T("1.0").replace("2008.2.7", "2008.2.6"), T("1.0")), true);
  assert.equal(newer(T("1.0"), T("1.0").replace("2008.2.7", "2008.2.6")), false);
});

test("解析结果形状一致（可直接逐段比较）", () => {
  assert.deepEqual(Array.from(context.version(T("g28"))), [2008, 2, 7, 9, 28]);
  assert.deepEqual(Array.from(context.version(T("1.0"))), [2008, 2, 7, 9, 1000]);
  assert.deepEqual(Array.from(context.version(T("1.1"))), [2008, 2, 7, 9, 1010]);
  assert.deepEqual(Array.from(context.version(T("2.0"))), [2008, 2, 7, 9, 2000]);
  assert.deepEqual(Array.from(context.version("2008.2.7-linli.9")), [2008, 2, 7, 9, 0]);
});

test("与历史小数字版本（如 g7）不会比较错", () => {
  // 用户担心：以前发过 g7，以后又出到 1.7，会不会混淆。
  // 由于新格式序号从 1000 起步，任何 gXX 都严格小于它。
  assert.equal(newer(T("g7"), T("1.0")), true, "装 g7 应看到 1.0 的更新");
  assert.equal(newer(T("g7"), T("1.7")), true, "装 g7 应看到 1.7 的更新");
  assert.equal(newer(T("1.7"), T("g7")), false, "1.7 不应被判为旧于 g7");
  assert.equal(newer(T("g7"), T("g8")), true, "旧格式之间仍然正确");
  assert.equal(newer(T("g99"), T("1.0")), true, "即使 g99 也小于 1.0");
  assert.equal(newer(T("g999"), T("1.0")), true, "g999 仍小于 1.0（新格式从 1000 起）");
});

// —— 真实事故回归（1.0.6）：GitHub tag 带 v 前缀 ——
//
// 事故现场：已装 2008.2.7-linli9-1.0.5，GitHub 上的 Release tag 是 v2008.2.7-linli9-1.0.5，
// 「软件更新」页却显示「发现新版本，可以下载」，进度 0.0%。
// 原因：releaseVersion 的正则要求字符串以数字开头，遇到 v 前缀直接返回 null；
// isNewerRelease 于是退回「字符串不同就当新版本」的兜底分支，
// "2008.2.7-linli9-1.0.5" !== "v2008.2.7-linli9-1.0.5" 恒为真 —— 装了最新版也永远提示可更新。
// 本支从 1.0 起的 tag 一直带 v（v2008.2.7-linli9-1.0.4、v…-1.0.5），也就是这个 bug 一直在。
test("GitHub tag 的 v 前缀不影响版本比较（1.0.5 真实事故）", () => {
  assert.deepEqual(
    Array.from(context.version(`v${T("1.0.5")}`)),
    Array.from(context.version(T("1.0.5"))),
    "带 v 与不带 v 必须解析成同一个版本号",
  );
  assert.equal(newer(T("1.0.5"), `v${T("1.0.5")}`), false, "带 v 的同版本必须判为「已是最新」");
  assert.equal(newer(`v${T("1.0.5")}`, T("1.0.5")), false, "反向同样不能提示更新");
  assert.equal(newer(T("1.0.5"), `v${T("1.0.6")}`), true, "带 v 的更高版本仍要正常提示");
  assert.equal(newer(`v${T("1.0.5")}`, `v${T("1.0.6")}`), true, "两边都带 v 时也要正确排序");
  assert.equal(newer(T("g28"), `v${T("1.0")}`), true, "带 v 的语义化版本仍大于 gXX");
  assert.equal(newer(T("1.0"), `v${T("g30")}`), false, "带 v 的旧格式仍小于 1.0");
});

test("v 前缀只剥版本位那一个 v，不误伤版本号正文", () => {
  // 只有「v 紧跟数字」才算前缀；别把正常文本里的 v 当版本前缀吃掉。
  assert.equal(context.version("verify-2008.2.7-linli9-1.0.5"), null, "前缀不是 v+数字 时不应被剥成合法版本");
  assert.deepEqual(
    Array.from(context.version(`V${T("1.0.5")}`)),
    Array.from(context.version(T("1.0.5"))),
    "大写 V 前缀同样要认（GitHub 上大小写都可能出现）",
  );
});