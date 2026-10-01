#!/usr/bin/env node
/**
 * bump-version 的命令行入口（薄）。真正的逻辑在 ./version-bump.mjs。
 *
 * 之所以单独留一个 CLI 文件：bump-version.ps1 只是「参数校验 + 透传退出码」的薄包装，
 * PowerShell 侧不复制任何判定逻辑，避免同一套规则两处实现（AGENTS.md 的单一来源要求）。
 *
 * 退出码：
 *   0 = 成功（无改动可做 / 已写完）
 *   1 = 出错（规则 0 命中、版本漂移、版本格式非法、文件读不到、用法错误……）
 *   2 = -Check 发现有待更新或漂移
 */

import { runVersionBump, planVersionBump, DEFAULT_SERVICE_ROOT } from "./version-bump.mjs";

function parseArgs(argv) {
  const options = { root: DEFAULT_SERVICE_ROOT, version: null, check: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" || arg === "-Root") {
      options.root = argv[++index] ?? "";
    } else if (arg === "--version" || arg === "-Version") {
      options.version = argv[++index] ?? "";
    } else if (arg === "--check" || arg === "-Check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h" || arg === "/?") {
      options.help = true;
    } else {
      options.unknown = arg;
      return options;
    }
  }
  return options;
}

const USAGE = [
  "用法：node version-bump-cli.mjs --root <local-service 目录> [--version <新版本>] [--check] [--json]",
  "",
  "  --version <新版本>  把仓库里所有「活动」版本号位置同步成该版本（先扫描、逐处打印、再写盘）",
  "  --check             只报不改：有 --version 时检查是否都已是该版本；不带 --version 时检查各处是否彼此一致",
  "  --root <目录>       服务根目录（默认 repo/source/local-service）",
  "  --json              以 JSON 输出（供脚本/门禁消费）",
  "",
  "退出码：0 成功；1 出错；2 -Check 发现有需要更新的位置。",
].join("\n");

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (options.unknown !== undefined) {
  process.stdout.write(`[错误] 不认识的参数：${options.unknown}\n\n${USAGE}\n`);
  process.exit(1);
}

if (options.version === "") {
  process.stdout.write(`[错误] --version 后面必须跟版本号\n\n${USAGE}\n`);
  process.exit(1);
}

if (options.version === null && !options.check) {
  process.stdout.write(`[错误] 必须给 --version <新版本> 或 --check 之一\n\n${USAGE}\n`);
  process.exit(1);
}

const buffered = [];
const result = runVersionBump({
  root: options.root,
  targetVersion: options.version,
  check: options.check,
  log: (line) => {
    if (options.json) buffered.push(line);
    else process.stdout.write(`${line}\n`);
  },
});

if (options.json) {
  const plan = result.plan ?? planVersionBump({ root: options.root, targetVersion: options.version });
  process.stdout.write(
    `${JSON.stringify(
      {
        exitCode: result.exitCode,
        ok: plan.ok,
        root: plan.root,
        oldVersion: plan.oldVersion,
        targetVersion: plan.targetVersion,
        baseVersion: plan.baseVersion,
        baseVersionSource: plan.baseVersionSource,
        edits: plan.edits,
        history: plan.history,
        advisories: plan.advisories,
        problems: plan.problems,
        written: result.written,
        needed: result.needed,
        logs: buffered,
      },
      null,
      2,
    )}\n`,
  );
}

process.exit(result.exitCode);
