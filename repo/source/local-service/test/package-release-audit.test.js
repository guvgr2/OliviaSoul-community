// 发布产物复核判据（2026-10-21 补）。病根与取舍见 test/lib/package-audit.mjs 头部。
//
// 为什么要新开这一条，而不是改 package-freshness.test.js：
//   既有判据 package-freshness 只比对 resources/workspace-template/harness/**（15 个文件），
//   实证漏检了「旧包整段缺命名纠错」（app/midi/listen-naming.js 包 98782B / 源码 111221B）。
//   本判据把核对范围扩到包内**全部**源码文件（app/public、app/midi、app/desktop、app/lyrics、
//   app 顶层、resources/workspace-template/harness），并对自己的源码文件做敏感信息扫描。
//   三处同类缺口（freshness 只盯 harness / packaging-artifact 不看真包 /
//   package-author-path 不扫真包）在这里一并收口。
//
// ★ 判据不能是恒绿的：下面第 2、3 条是配对的——改坏必须红、正确必须绿，
//   第 4 条带阴性对照（必须能扫到产品名），证明扫描器真在读内容。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupDir } from "./lib/cleanup.mjs";
import {
  auditZipAgainstSource,
  makeStoreZip,
  mapToSource,
  readZipEntry,
  readZipIndex,
  scanBufferForSensitive,
} from "./lib/package-audit.mjs";

// test/ → local-service → source → repo
const REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const LOCAL_SERVICE = join(REPO_DIR, "source", "local-service");
const HARNESS = join(REPO_DIR, "source", "harness");
const ROOTS = { localService: LOCAL_SERVICE, harness: HARNESS };

function findPortableZips() {
  const zips = [];
  for (const name of readdirSync(REPO_DIR)) {
    if (!name.startsWith("build-")) continue;
    const dir = join(REPO_DIR, name);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (file.endsWith("-Portable.zip")) zips.push(join(dir, file));
    }
  }
  return zips.sort();
}

test("repo/build-* 的 Portable 包内全部源码文件必须与当前源码逐字节一致（覆盖 app/**，不只是 harness）", async t => {
  const zips = findPortableZips();
  if (zips.length === 0) {
    return t.skip("repo/ 下没有 build-*/…-Portable.zip，判据不适用（没打包就没有「旧包」可言）");
  }
  for (const zipPath of zips) {
    const r = auditZipAgainstSource(zipPath, ROOTS);
    assert.ok(
      r.checked > 0,
      `${r.label}：判据一个文件都没核对到 —— 判据是空的，等于恒绿，必须先修判据本身`);
    assert.deepEqual(
      r.problems,
      [],
      `${r.label} 与当前源码不一致，发布前必须重新打包：\n${r.problems.join("\n")}\n` +
      `（本次核对 ${r.checked} 个文件，跳过 ${r.skipped} 个第三方/生成物）\n` +
      `（本判据盯的就是「源码改了、包没重建」这个全绿盲区；2026-10-21 实证过旧包整段缺命名纠错却一路绿灯。）`);
  }
});

test("判据有牙齿：故意改坏的包必须被检出（否则判据恒绿，等于没有护栏）", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-audit-bad-"));
  t.after(() => cleanupDir(root));
  // 用本轮真正漏检的那个文件做样本：app/midi/listen-naming.js
  const srcBytes = readFileSync(join(LOCAL_SERVICE, "midi", "listen-naming.js"));
  const tampered = Buffer.concat([
    srcBytes,
    Buffer.from("\n// 故意植入的差异：模拟「源码改了、包没重建」\n"),
  ]);
  const zipPath = join(root, "fake-Portable.zip");
  writeFileSync(zipPath, makeStoreZip([["app/midi/listen-naming.js", tampered]]));

  const r = auditZipAgainstSource(zipPath, ROOTS);
  assert.ok(r.checked >= 1, "判据应当核对到至少 1 个文件（否则是空判据）");
  assert.ok(
    r.problems.length >= 1,
    "故意改坏的包必须被检出不一致 ⇒ 如果这里过了，说明判据是恒绿的，保护不了任何东西");
});

test("判据不误报：内容与源码完全一致的包必须判定为通过", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-audit-good-"));
  t.after(() => cleanupDir(root));
  const srcBytes = readFileSync(join(LOCAL_SERVICE, "midi", "listen-naming.js"));
  const zipPath = join(root, "fake-Portable.zip");
  writeFileSync(zipPath, makeStoreZip([["app/midi/listen-naming.js", srcBytes]]));

  const r = auditZipAgainstSource(zipPath, ROOTS);
  assert.ok(r.checked >= 1, "判据应当核对到至少 1 个文件");
  assert.deepEqual(r.problems, [], "内容与源码一致时不该报错（否则每次都假红，护栏会被人当豁免容忍掉）");
});

test("发布产物里我们自己的源码文件不含作者路径/个人信息（带阴性对照）", async t => {
  const zips = findPortableZips();
  if (zips.length === 0) {
    return t.skip("repo/ 下没有 build-*/…-Portable.zip，判据不适用");
  }
  let sawProductName = false;
  const hits = [];
  for (const zipPath of zips) {
    const zip = readZipIndex(zipPath);
    for (const name of zip.index.keys()) {
      const norm = name.split("\\").join("/");
      if (norm.endsWith("/")) continue;
      // 只扫我们自己的源码文件：node_modules 是第三方依赖，里面本就带各种许可证邮箱，
      // 扫它只会产生噪音（2026-10-21 实测 107 处命中里有一批就是 Node/Inno 的许可证信息）。
      if (mapToSource(norm, ROOTS) === null) continue;
      const bytes = readZipEntry(zip, name);
      if (bytes.includes("OliviaSoul")) sawProductName = true;
      hits.push(...scanBufferForSensitive(bytes, name));
    }
  }
  assert.ok(
    sawProductName,
    "阴性对照失败：扫描器在这些文件里连产品名 OliviaSoul 都没看到 ⇒ 它没真的在读内容，'0 命中'不能当结论");
  assert.deepEqual(
    hits,
    [],
    `发布产物里发现敏感信息：\n${hits.map(h => `  ${h.label} [${h.kind}/${h.channel}] ${h.sample} x${h.count}`).join("\n")}`);
});
