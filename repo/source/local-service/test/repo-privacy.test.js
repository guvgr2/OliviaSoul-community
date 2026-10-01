// 仓库隐私门禁：**会被提交的文件**里不得再出现作者本机私有路径 / 工具链目录 / 习惯盘符。
//
// 背景：1.0.4 发布后发现有公开文档与测试把作者本机路径（X:\OliviaSoulLocal、
// X:\Tools\<参考仓库前缀>-*、X:\SteamLibrary\...\BSide Olivia Lin Test、
// X:\CodexTemp 等）写进了公开仓库。打包侧早有 release-privacy.test.js 守住产物，
// 但仓库源码/文档侧一直没有门禁，所以才会漏出去。
//
// 修法：把命中内容脱敏成中性值——盘符统一写 X:\（或 C:\、%TEMP%），
// 相对位置改用相对路径，临时目录用 os.tmpdir()。
//
// 本文件自身：注释里只用 X:\ 占位，特征字面量一律拼接（见下方 FORBIDDEN /
// FORBIDDEN_PATTERNS 的注释）——否则这个门禁会扫到自己并必然失败，把干净提交也拦下。
//
// 两条实现约束（都踩过坑，别改回去）：
//   1) 只扫 `git ls-files` 的集合。作者本机有大量被 .gitignore 忽略的私有脚本
//      （根 tools/*.py、repo/source/_build/**），扫文件系统会永久误报。
//   2) 取 git 输出走**文件重定向**而不是 pipe：受限沙箱里 child_process 的
//      stdio: "pipe" 会 EPERM，文件 fd 可以。
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 只放“能联想到某台具体机器”的特征。刻意不放：
//   - 通用占位与测试假数据（C:\Users\<你>、D:\Music、N:\Games\Example）
//   - 注册表路径（HKCU:\Software\Valve\Steam）
//   - 游戏自身的 Steam 目录名 "BSide Olivia Lin Test"（所有玩家都一样，不是隐私）
//   - 裸 "OliviaSoulLocal…"：这是产品注入的函数名前缀（OliviaSoulLocalPlaybackFailed）
//
// 约束：本数组里的特征字面量必须写成拼接形式（"a" + "b"），一旦逐字写出，
// 门禁扫到自己（这个文件也在 git ls-files 里）就会必然报错——真实踩过。
const FORBIDDEN = [
  ["e:\\linlimusic", "作者私有音乐目录"],
  ["e:\\olivia_tool", "作者工具目录"],
  ["oliviasoul-" + "reference-", "作者参考仓库目录"],
  ["i:\\oliviasoullocal", "作者独立运行目录"],
  ["e:\\steamlibrary", "作者 Steam 库盘符"],
  ["z:\\steamlibrary", "作者 Steam 库盘符"],
  ["i:\\codextemp", "作者工具链临时目录"],
  ["i:\\codexdata", "作者工具链数据目录"],
  ["d:\\oliviasoul", "作者开发目录"],
  ["i:\\oliviasouldata", "作者固定数据盘约定"],
  ["i " + "盘", "作者习惯盘符（文字描述）"],
  ["i" + "-drive", "作者习惯盘符（英文描述）"],
  // 拼接写法：避免门禁文件自己命中自己
  ["ghp" + "_", "疑似 GitHub token"],
  ["github" + "_pat_", "疑似 GitHub token"],
];

// 需要词边界的特征：直接子串匹配会误命中产品必需的 GitHub 账号 "guvgr2"，
// 而作者本机 Windows 用户名恰好是它的前缀。
// 同样必须拼接：正则字面量里的用户名会逐字出现在门禁文件里，导致自己命中自己。
const FORBIDDEN_PATTERNS = [
  [new RegExp("(?<![0-9a-z_])" + "guv" + "gr(?![0-9a-z_])", "iu"), "作者 Windows 用户名"],
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function findRepoRoot(start) {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (statSync(join(dir, ".git")).isDirectory()) return dir;
    } catch {
      // 继续上溯
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitTrackedFiles(root) {
  const dump = join(tmpdir(), `repo-privacy-ls-files-${process.pid}.txt`);
  const fd = openSync(dump, "w");
  let status;
  let errored = false;
  try {
    const result = spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], {
      cwd: root,
      stdio: ["ignore", fd, "ignore"],
    });
    status = result.status;
    errored = Boolean(result.error);
  } catch {
    errored = true;
  } finally {
    closeSync(fd);
  }
  if (errored || status !== 0) {
    try {
      unlinkSync(dump);
    } catch {
      // 忽略
    }
    return null;
  }
  const raw = readFileSync(dump, "utf8");
  try {
    unlinkSync(dump);
  } catch {
    // 忽略
  }
  return raw.split("\0").filter(Boolean);
}

const root = findRepoRoot(here);
const tracked = root === null ? null : gitTrackedFiles(root);
const skip = root === null
  ? "不在 git 工作区（如打包产物环境）"
  : tracked === null
    ? "拿不到 git 跟踪文件列表（受限沙箱）"
    : false;

test("会被提交的源码与文档里不得出现作者本机私有路径", { skip }, () => {
  const hits = [];
  for (const relative of tracked) {
    const absolute = join(root, relative);
    let text;
    try {
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // 二进制
    const lower = text.toLowerCase();
    for (const [needle, why] of FORBIDDEN) {
      if (!lower.includes(needle)) continue;
      text.split(/\r?\n/u).forEach((line, index) => {
        if (line.toLowerCase().includes(needle)) {
          hits.push(`${relative}:${index + 1} 命中「${needle}」（${why}）:: ${line.trim().slice(0, 140)}`);
        }
      });
    }
    for (const [pattern, why] of FORBIDDEN_PATTERNS) {
      if (!pattern.test(text)) continue;
      text.split(/\r?\n/u).forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(`${relative}:${index + 1} 命中「${pattern.source}」（${why}）:: ${line.trim().slice(0, 140)}`);
        }
      });
    }
  }

  assert.deepEqual(
    hits,
    [],
    `发现 ${hits.length} 处本机私有信息，请脱敏后再提交：\n${hits.join("\n")}`,
  );
});
