// 包新鲜度判据（2026-10-20 第六轮复验 §4.5 的 🟠 补丁，PoC 在 analysis/_mut-20261020/package-freshness-poc.py）。
//
// 病根：`repo/build-*/` 里的真包可以是**旧构建**，而全仓测试全绿 ——
//   ① packaging-artifact / release-privacy 用的是自建夹具（temp 里现造 stage），从不看真包；
//   ② 作者路径护栏只在**构建时**跑，包一旦建出来就再没有东西复核它。
//   ⇒ 2026-10-18 那个带 3 处作者路径的包，躺到 2026-10-20 才被发现，期间全仓绿色。
//
// 判据（可证伪）：把包里 `resources/workspace-template/harness/**` 的每个文件
// 与 `repo/source/harness/**` **逐字节**比对。harness 是原样拷进包的，
// 所以任何差异只能来自「源码改了、包没重建」。
// 复验已实证它正好命中当时修过的 2 个文件（行为参数.json / 主动信语料.md）。
//
// ★ 没有 build-*/ 下的 Portable 包时**跳过**（判据不适用，不假红）。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unzipEntries } from "../midi/data-safety.js";

// test/ → local-service → source → repo
const REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const HARNESS_SRC = join(REPO_DIR, "source", "harness");
const PKG_PREFIX = "resources/workspace-template/harness/";
// 设计上就不进包（打包时按 manifest 摘要另行生成/校验），见复验 §4.4
const NOT_IN_PACKAGE = new Set(["harness-manifest.json"]);

function listHarnessFiles() {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(HARNESS_SRC, full).split("\\").join("/"));
    }
  };
  walk(HARNESS_SRC);
  return out.sort();
}

function findPortableZips() {
  const zips = [];
  for (const name of readdirSync(REPO_DIR)) {
    if (!name.startsWith("build-")) continue;
    const dir = join(REPO_DIR, name);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith("-Portable.zip")) zips.push(join(dir, file));
    }
  }
  return zips.sort();
}

test("repo/build-* 里的 Portable 包必须与当前源码的 harness 逐字节一致（旧构建 = 红）", async t => {
  const zips = findPortableZips();
  if (zips.length === 0) {
    return t.skip("repo/ 下没有 build-*/…-Portable.zip，判据不适用（没打包就没有「旧包」可言）");
  }
  const sourceFiles = new Map(listHarnessFiles().map(rel => [rel, readFileSync(join(HARNESS_SRC, rel))]));

  for (const zipPath of zips) {
    const entries = unzipEntries(readFileSync(zipPath));
    const packaged = new Map();
    for (const [name, bytes] of entries) {
      if (name.startsWith(PKG_PREFIX)) packaged.set(name.slice(PKG_PREFIX.length), bytes);
    }

    const problems = [];
    for (const [rel, sourceBytes] of sourceFiles) {
      if (NOT_IN_PACKAGE.has(rel)) continue;
      const pkgBytes = packaged.get(rel);
      if (pkgBytes === undefined) {
        problems.push(`包里没有：${rel}（源码里有）`);
        continue;
      }
      if (!pkgBytes.equals(sourceBytes)) {
        problems.push(`内容不一致（源码改了、包没重建）：${rel}  包 ${pkgBytes.length}B / 源码 ${sourceBytes.length}B`);
      }
    }
    for (const rel of packaged.keys()) {
      if (!sourceFiles.has(rel)) problems.push(`包里有、源码里没有：${rel}`);
    }

    const label = zipPath.slice(REPO_DIR.length + 1);
    assert.deepEqual(
      problems,
      [],
      `${label} 是旧构建（或与当前源码不一致），发布前必须重新打包：\n${problems.join("\n")}`
        + `\n（修好源码后重新打包，并把旧包移出 repo/build-*/；本判据盯的就是「源码改了、包没重建」这个全绿盲区。）`,
    );
  }
});
