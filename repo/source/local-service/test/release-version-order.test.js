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
  `${pick("releaseVersion")}\n${pick("isNewerRelease")}\nthis.newer = isNewerRelease; this.version = releaseVersion;`,
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