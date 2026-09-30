// 版本一致性与 JSON 健康检查。
//
// 背景（真实踩过，而且逃过了 1.0 的发布）：
//   package-lock.json 被写坏过 —— 有人用「字符串替换 version 字段」的方式改版本号，
//   结果把整个 package.json 的内容粘进了 version 字段，文件变成非法 JSON：
//       { "name": "olivia-soul", "version": "{ "name": "olivia-soul", ... }", ... }
//   npm 会因此报错，但仓库里的测试全都没发现（没人校验过 lock 文件）。
//
// 本套件把「6 处版本号必须一致」和「两个 JSON 必须合法」钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function readJson(name) {
  const raw = readFileSync(join(root, name), "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/u, ""));
}

test("package.json 是合法 JSON", () => {
  const pkg = readJson("package.json");
  assert.ok(typeof pkg.version === "string" && pkg.version.length > 0, "package.json 缺少 version");
});

test("package-lock.json 是合法 JSON（曾在 1.0 里损坏）", () => {
  const lock = readJson("package-lock.json");
  assert.ok(typeof lock.version === "string" && lock.version.length > 0, "package-lock.json 缺少 version");
  assert.ok(lock.packages && lock.packages[""], "package-lock.json 缺少 packages[''] 根条目");
});

test("package.json 与 package-lock.json 版本一致", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, pkg.version, "lock 顶层 version 必须与 package.json 一致");
  assert.equal(lock.packages[""].version, pkg.version, "lock packages[''] version 必须与 package.json 一致");
});

test("package-lock.json 的 version 必须是纯版本串（不是被粘进去的整份文件）", () => {
  const lock = readJson("package-lock.json");
  // 损坏时的特征：version 里出现了 { 或换行，或者夹带了 name 字段内容
  assert.ok(!lock.version.includes("{"), `lock 的 version 被污染：${JSON.stringify(lock.version.slice(0, 60))}`);
  assert.ok(!lock.version.includes("\n"), "lock 的 version 不应含换行");
  assert.ok(lock.version.length < 64, `lock 的 version 异常长（${lock.version.length} 字符），疑似被粘入整份文件`);
});

test("6 处版本号完全一致", () => {
  const pkg = readJson("package.json");
  const expected = pkg.version;

  const csproj = readFileSync(join(root, "native-host", "OliviaSoul.csproj"), "utf8");
  const csprojVersion = /<Version>([^<]+)<\/Version>/u.exec(csproj)?.[1];
  assert.equal(csprojVersion, expected, "OliviaSoul.csproj 的 <Version> 与 package.json 不一致");

  const build = readFileSync(join(root, "packaging", "build-release.ps1"), "utf8");
  const buildVersion = /^\$version\s*=\s*"([^"]+)"/mu.exec(build)?.[1];
  assert.equal(buildVersion, expected, "build-release.ps1 的 $version 与 package.json 不一致");

  const feedback = readFileSync(join(root, "public", "listen-naming-feedback.js"), "utf8");
  const feedbackVersion = /APP_VERSION\s*=\s*"([^"]+)"/u.exec(feedback)?.[1];
  assert.equal(feedbackVersion, expected, "listen-naming-feedback.js 的 APP_VERSION 与 package.json 不一致");
});

test("package.json 声明的依赖都在 package-lock.json 里有解析记录", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const deps = Object.keys(pkg.dependencies ?? {});
  const rootDeps = Object.keys(lock.packages[""].dependencies ?? {});
  for (const name of deps) {
    assert.ok(rootDeps.includes(name), `lock 的 packages[''].dependencies 缺少 ${name}`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `lock 缺少 node_modules/${name} 解析记录`);
    assert.equal(entry.version, pkg.dependencies[name], `${name} 的锁定版本与 package.json 声明的范围不一致`);
  }
});
