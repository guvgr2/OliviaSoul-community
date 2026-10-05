// 仓库文件健康检查。
//
// 为什么需要（真实教训）：
//   package-lock.json 曾被写坏（整个 package.json 被粘进 version 字段），变成非法 JSON，
//   而这个损坏**一路逃过了 1.0 的发布** —— 因为没有任何测试校验过它。
//   我是靠"凑巧去看了一眼文件头"才发现的。这种"靠运气"的检查方式必须被替代。
//
// 设计要点（第一版踩过的坑）：
//   · **不要**递归扫描整个 repo/source —— 那里有 dist-native/package-work/*/stage/**，
//     是打包时生成的临时副本（上万份），既慢又会误报。
//   · 只检查**真正的源码目录**（显式列举），构建产物一律排除。
//   · 不要在 JS 里手写"花括号配对"来判断 PowerShell 语法 —— 字符串里的花括号会误判。
//     PowerShell 语法交给 PowerShell 自己的 Parser（在打包门禁里已做）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, "..");            // repo/source/local-service
const sourceRoot = join(serviceRoot, "..");      // repo/source

// 只检查这些目录（真正的源码），其余一律不看。
const SOURCE_DIRS = [
  { root: serviceRoot, label: "local-service", exts: [".js", ".json", ".ps1"] },
  { root: join(sourceRoot, "tools"), label: "tools", exts: [".js", ".ps1"] },
  { root: join(sourceRoot, "midi-renderer"), label: "midi-renderer", exts: [".js", ".json", ".ps1"] },
];

// 即便是源码目录，也要跳过的子目录名。
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-native", "_build", "package-work", "stage", "frozen-stage"]);

function collect(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, exts, out);
    else if (exts.some(ext => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function allSourceFiles(exts) {
  const out = [];
  for (const { root, exts: dirExts } of SOURCE_DIRS) {
    const wanted = exts.filter(ext => dirExts.includes(ext));
    if (wanted.length > 0) collect(root, wanted, out);
  }
  return out;
}

test("所有 JSON 都是合法 JSON（package-lock.json 曾损坏并逃过发布）", () => {
  const files = allSourceFiles([".json"]);
  assert.ok(files.length > 0, "应找到 JSON 文件");
  const broken = [];
  for (const file of files) {
    try {
      JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
    } catch (error) {
      broken.push(`${relative(sourceRoot, file)}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], `以下 JSON 非法：\n${broken.join("\n")}`);
});

test("所有 .ps1 带 UTF-8 BOM（仓库规范：否则中文乱码）", () => {
  const files = allSourceFiles([".ps1"]);
  assert.ok(files.length > 0, `应找到 .ps1 文件`);
  const missing = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) missing.push(relative(sourceRoot, file));
  }
  assert.deepEqual(missing, [], `以下 .ps1 缺 BOM（用 node .test-twins/add-bom.mjs 补）：\n${missing.join("\n")}`);
});

test("packaging/OliviaSoul.iss 带 UTF-8 BOM（否则安装器界面中文乱码）", () => {
  // 真实教训（1.1.0）：.iss 不在 allSourceFiles 的扩展名白名单里（只收 .js/.json/.ps1），
  // 所以上面那条「.ps1 必须带 BOM」管不到它；而顺手改 .iss 的编辑工具会吞掉 BOM，
  // 结果安装器里所有中文字符串（CustomMessages、MsgBox 提示）变成乱码 —— 只有装机的人才会发现。
  const file = join(serviceRoot, "packaging", "OliviaSoul.iss");
  const bytes = readFileSync(file);
  assert.ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    "packaging/OliviaSoul.iss 缺 UTF-8 BOM（用 node .test-twins/add-bom.mjs 补）");
});

test("所有 JS/MJS 语法有效（只查源码目录，不查构建产物）", () => {
  const files = allSourceFiles([".js"]).filter(f => !f.includes(".min."));
  assert.ok(files.length > 0, "应找到 JS 文件");
  const broken = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      const msg = String(result.stderr ?? "").split("\n").find(line => line.includes("Error")) ?? "语法错误";
      broken.push(`${relative(sourceRoot, file)}: ${msg.trim()}`);
    }
  }
  assert.deepEqual(broken, [], `以下 JS 语法错误：\n${broken.join("\n")}`);
});

test("packaging/ 目录干净（不得留临时文件）", () => {
  const pkgDir = join(serviceRoot, "packaging");
  let entries;
  try {
    entries = readdirSync(pkgDir);
  } catch {
    return;
  }
  const junk = entries.filter(name =>
    /^_tmp/u.test(name) || /\.tmp$/u.test(name) || /~$/u.test(name) || /\.bak$/u.test(name) || /\.orig$/u.test(name));
  assert.deepEqual(junk, [], `packaging/ 下残留临时文件：${junk.join(", ")}`);
});

test("源码里没有 debugger 或明显的调试输出残留", () => {
  const files = allSourceFiles([".js"]).filter(f => !f.includes(".test.") && !f.includes(".min."));
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/\bdebugger\s*;/u.test(text)) hits.push(`${relative(sourceRoot, file)}: debugger`);
    if (/console\.log\(\s*["'`](?:DEBUG|debug|XXX|xxx)/u.test(text)) hits.push(`${relative(sourceRoot, file)}: debug 输出`);
  }
  assert.deepEqual(hits, [], `发现调试残留：\n${hits.join("\n")}`);
});

test("test/ 下每个 .test.js 都非空且包含 test() 调用", () => {
  const testDir = join(serviceRoot, "test");
  const files = readdirSync(testDir).filter(name => name.endsWith(".test.js"));
  assert.ok(files.length > 0, "应找到测试文件");
  const suspicious = [];
  for (const name of files) {
    const full = join(testDir, name);
    const text = readFileSync(full, "utf8");
    if (statSync(full).size < 100) suspicious.push(`${name}（文件过小 ${statSync(full).size}B）`);
    // 用例声明风格多样：test( / it( / describe(，以及
    // 先取别名再调用（如 const browserTest = ... ? test : test.skip; browserTest(...)）。
    // 因此只要求出现「以 test/it 结尾的标识符 + 调用」。
    if (!/[A-Za-z_$]*[Tt]est[A-Za-z_$]*\s*\(|\bit\s*\(/u.test(text)) {
      suspicious.push(`${name}（未发现任何用例声明）`);
    }
  }
  assert.deepEqual(suspicious, [], `以下测试文件可疑：${suspicious.join(", ")}`);
});

test("源码目录里不残留 .bak/.orig/.tmp 之类的手工备份", () => {
  const files = allSourceFiles([".js", ".json", ".ps1"]);
  const junk = files.filter(f => /\.(?:bak|orig|tmp|old|save)$/iu.test(f)).map(f => relative(sourceRoot, f));
  assert.deepEqual(junk, [], `发现手工备份残留：${junk.join(", ")}`);
});
