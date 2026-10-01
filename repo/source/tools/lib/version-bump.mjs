/**
 * 版本号一键同步（bump-version）核心逻辑 —— 可被直接 import，不在内部起任何子进程。
 *
 * 为什么需要它：本支版本号（形如 `2008.2.7-linli9-1.0.4`）散落在 6 个代码文件与 3 份打包文档里，
 * 每次发版靠人肉改 10 处；漏改只能靠 test/version-sync.test.js 事后发现（而且它不认识文档）。
 *
 * 设计要点（对应 AGENTS.md 第六节「不许短期凑合 / 单一来源」）：
 *  1. **单一来源**：baseVersion（`2008.2.7`）在运行时从 `packaging/build-release.ps1` 现读，
 *     不在本文件里写死第二份；版本串的合法格式与 build-release.ps1:33 的正则**逐字一致**，
 *     测试 test/bump-version.test.js 会把这段字符串与脚本原文比对，不一致就红（防两处漂移）。
 *  2. **只替换「值 == 当前版本」的版本串**：历史段落里的旧版本串（如 `1.0.3`）不会被误伤；
 *     依赖版本号（如 midi-file `1.2.4`）不匹配版本串通配，也不会被误伤。
 *  3. **先扫描 → 校验 → 再落盘（两阶段提交）**：任何一项校验不过就整体不写；
 *     写入途中抛错会把已写的文件按原文回滚。
 *  4. **刻意不改的地方显式打印**：`发布说明.md` 的历史节标题、散文里的短版本号（`1.0.4`）
 *     都会被列出来提示人工判断，不静默跳过（静默跳过 = 漏改没人知道）。
 *  5. 规则表就是「哪些位置是版本身份」的唯一定义，新增版本号位置时改这张表 + 加测试。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本模块所在目录：repo/source/tools/lib */
export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
/** 默认服务根：repo/source/local-service（规则表里的路径都相对它）；本模块位于 tools/lib/ 下，所以往上两级 */
export const DEFAULT_SERVICE_ROOT = resolve(TOOLS_DIR, "..", "..", "local-service");
/** baseVersion 的取值来源（单一来源） */
export const BUILD_SCRIPT = "packaging/build-release.ps1";
/** 读不到 build-release.ps1 时的兜底值（只会导致「找不到版本串 → 非零退出」，不会误改） */
export const DEFAULT_BASE_VERSION = "2008.2.7";

/**
 * 本支版本串的后缀片段 —— **必须与 packaging/build-release.ps1:33 的正则逐字一致**。
 * 测试会断言 build-release.ps1 的原文里包含这段字符串，脚本改了而这里没跟着改就会红。
 */
export const VERSION_SUFFIX_SOURCE = "(?:-linli9-(?:g\\d{2}|\\d+(?:\\.\\d+){0,2}(?:-beta\\.\\d+)?))?";

const TOKEN = "%V%";
/** 行尾前瞻：兼容 CRLF（`$` 在 m 模式下停在 `\n` 前，`\r` 必须显式吃掉/前瞻掉） */
const EOL = "(?=\\r?$)";
/** 行内缩进/尾随空白统一用 [ \t]，**不能**用 \s —— \s 会吃掉换行，把两行并成一个 match */
const BLANK = "[ \\t]";

/**
 * 文档头部的边界 = 第一个二级标题。打包文档的「本版信息」（更新标识、附件文件名）写在头部，
 * 之后是按版本倒序累积的**历史附录**，那里也会有同名的「附件：」行（用 baseVersion 命名的旧包名，
 * 例如 发布说明.md 的「下载与升级方法」节）。规则标 head=true 时只扫头部，历史上那些同名行不参与。
 */
const HEAD_BOUNDARY = /^## /mu;

/**
 * 版本身份位置表。每条：
 *   id      规则名（报错时会打出来，必须能一眼看出是哪个位置）
 *   file    相对 DEFAULT_SERVICE_ROOT 的路径
 *   mode    "live" = 必须随发版更新；"history" = 历史记录，刻意不改、只报告
 *   pattern 定位模式，含 %V% 占位符（展开为「版本串通配」，非捕获）
 *   expect  期望命中数：数字 = 精确；{min,max} = 区间（文档类给人改动留余地，但仍要求至少 min 处）
 *   doc     文档类（人写的正文），出现处数不稳定
 *   head    true = 只扫文档头部（第一个 `## ` 之前）；文档正体是按版本倒序累积的历史附录，
 *           里面的同名行（如旧的「附件：」行）不属于本版信息
 */
export const DEFAULT_RULES = Object.freeze([
  {
    id: "package.json 的 version",
    file: "package.json",
    mode: "live",
    expect: 1,
    pattern: `^${BLANK}*"version":${BLANK}*"${TOKEN}"${BLANK}*,?${EOL}`,
    note: "版本号的权威来源：所有其它位置都以它为准",
  },
  {
    id: "package-lock.json 的 version（顶层 + packages[\"\"] 共 2 处）",
    file: "package-lock.json",
    mode: "live",
    expect: 2,
    pattern: `^${BLANK}*"version":${BLANK}*"${TOKEN}"${BLANK}*,?${EOL}`,
    note: "依赖项的 version（如 midi-file 1.2.4）不匹配本支版本串，不会被误伤；2 处这个数字与 build-release.ps1 的 $lockVersionCount 校验一致",
  },
  {
    id: "native-host/OliviaSoul.csproj 的 <Version>",
    file: "native-host/OliviaSoul.csproj",
    mode: "live",
    expect: 1,
    pattern: `^${BLANK}*<Version>${TOKEN}</Version>${BLANK}*${EOL}`,
    note: "AssemblyVersion / FileVersion 用的是 baseVersion（2008.2.7.0），刻意不随本支版本号走",
  },
  {
    id: "packaging/build-release.ps1 的 $version",
    file: "packaging/build-release.ps1",
    mode: "live",
    expect: 1,
    pattern: `^\\$version${BLANK}*=${BLANK}*"${TOKEN}"${BLANK}*${EOL}`,
    note: "打包脚本第 31 行会自己校验它与 package.json 一致",
  },
  {
    id: "public/listen-naming-feedback.js 的 APP_VERSION",
    file: "public/listen-naming-feedback.js",
    mode: "live",
    expect: 1,
    pattern: `APP_VERSION${BLANK}*=${BLANK}*"${TOKEN}"`,
  },
  // 下面 6 条是打包文档（人写的）：只要求「至少 N 处」，逐处打印供发版者核对
  {
    id: "packaging/使用说明.txt 的更新标识行",
    file: "packaging/使用说明.txt",
    mode: "live",
    expect: { min: 1 },
    doc: true,
    pattern: `^更新标识：${TOKEN}${EOL}`,
  },
  {
    id: "packaging/使用说明.txt 的安装包文件名",
    file: "packaging/使用说明.txt",
    mode: "live",
    expect: { min: 2 },
    doc: true,
    pattern: `OliviaSoul-${TOKEN}-`,
    note: "Setup.exe 与 Portable.zip 两个文件名",
  },
  {
    id: "packaging/使用说明.txt 正文里的更新标识",
    file: "packaging/使用说明.txt",
    mode: "live",
    expect: { min: 1 },
    doc: true,
    pattern: `本次更新标识为 ${TOKEN}，`,
  },
  {
    id: "packaging/发布说明.md 的本次更新标识",
    file: "packaging/发布说明.md",
    mode: "live",
    expect: { min: 1 },
    doc: true,
    head: true,
    pattern: `^\\*\\*本次更新标识：\`${TOKEN}\`\\*\\*`,
  },
  {
    id: "packaging/发布说明.md 的附件文件名",
    file: "packaging/发布说明.md",
    mode: "live",
    expect: { min: 1 },
    doc: true,
    head: true,
    pattern: `^附件：.*${TOKEN}.*${EOL}`,
    note: "整行命中，行内两个文件名（Setup/Portable）都会换；只认头部这一行 —— 历史附录里的附件行用的是 baseVersion 命名的旧包名",
  },
  {
    id: "packaging/API配置使用说明.md 的适用版本",
    file: "packaging/API配置使用说明.md",
    mode: "live",
    expect: { min: 1 },
    doc: true,
    pattern: `适用：本支 \`${TOKEN}\``,
  },
  {
    id: "packaging/发布说明.md 的历史节标题（刻意不改）",
    file: "packaging/发布说明.md",
    mode: "history",
    expect: { min: 0 },
    pattern: `^## ${TOKEN} ·`,
    note: "这是按版本倒序累积的历史节；发新版应在顶部**新增**一节，而不是把旧节标题改掉",
  },
]);

/** 正则元字符转义 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 版本串的正则源码（字符串形式）：baseVersion + 后缀片段 */
export function versionSource(baseVersion) {
  return `${escapeRegExp(baseVersion)}${VERSION_SUFFIX_SOURCE}`;
}

/** 版本串正则（每次新建，避免 lastIndex 状态共享） */
export function versionRegExp(baseVersion, flags = "gu") {
  return new RegExp(versionSource(baseVersion), flags);
}

/** 是否是合法版本串（与 build-release.ps1:33 同一口径） */
export function isValidVersion(value, baseVersion) {
  return new RegExp(`^${versionSource(baseVersion)}$`, "u").test(String(value));
}

/** 从完整版本串取短版本号：2008.2.7-linli9-1.0.4 → 1.0.4 */
export function shortVersion(version) {
  const marker = "-linli9-";
  const index = String(version).indexOf(marker);
  return index === -1 ? String(version) : String(version).slice(index + marker.length);
}

/**
 * 短版本号（散文里的 `1.0.4`）只报告、不自动改：文档里出现短号的地方可能是历史段落，
 * 机器分不清「本版提法」和「历史提法」，所以交给发版者逐处判断。
 */
export function buildAdvisoryRules(version) {
  const short = shortVersion(version);
  const files = ["packaging/使用说明.txt", "packaging/发布说明.md", "packaging/API配置使用说明.md"];
  if (!short || short === String(version)) return [];
  const escaped = escapeRegExp(short);
  return files.map((file) => ({
    id: `短版本号 ${short}（需人工判断是否属于本版）`,
    file,
    pattern: `(?<![0-9A-Za-z.\\-])${escaped}(?![0-9A-Za-z.\\-])`,
  }));
}

/** 读 baseVersion：单一来源 = packaging/build-release.ps1 的 $baseVersion */
export function readBaseVersion(root = DEFAULT_SERVICE_ROOT) {
  const relative = BUILD_SCRIPT;
  let text = null;
  try {
    text = readFileSync(join(resolve(root), relative), "utf8");
  } catch {
    text = null;
  }
  const match = text === null ? null : /^\$baseVersion[ \t]*=[ \t]*"([^"]+)"/mu.exec(text);
  if (!match) {
    return {
      baseVersion: DEFAULT_BASE_VERSION,
      source: "fallback",
      detail: `读不到 ${relative} 里的 $baseVersion，已回退到默认值 ${DEFAULT_BASE_VERSION}（这只会导致「找不到版本串 → 非零退出」，不会误改文件）`,
    };
  }
  const line = text.slice(0, match.index).split("\n").length;
  return { baseVersion: match[1], source: `${relative}:${line}` };
}

function normalizeExpect(expect) {
  if (expect === undefined || expect === null) return { min: 1, max: Infinity };
  if (typeof expect === "number") return { min: expect, max: expect };
  return { min: expect.min ?? 0, max: expect.max ?? Infinity };
}

function describeExpect({ min, max }) {
  if (min === max) return String(min);
  if (max === Infinity) return `至少 ${min}`;
  return `${min}~${max}`;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function clamp(text, width = 120) {
  const oneLine = String(text).replace(/\r?\n/gu, "\\n");
  return oneLine.length <= width ? oneLine : `${oneLine.slice(0, width)}…`;
}

/** 用一条规则扫一个文件，返回命中（含行号与命中区内的所有版本串） */
function scanRule(rule, text, baseVersion) {
  const pattern = rule.pattern.split(TOKEN).join(`(?:${versionSource(baseVersion)})`);
  const re = new RegExp(pattern, "gmu");
  // head 规则只扫文档头部：截掉的是尾部，命中索引与行号仍与原文一一对应
  const boundary = rule.head ? HEAD_BOUNDARY.exec(text) : null;
  const limit = boundary ? boundary.index : text.length;
  const hits = [];
  for (const match of text.matchAll(re)) {
    if (match.index >= limit) continue;
    const segment = match[0];
    const values = [...segment.matchAll(versionRegExp(baseVersion, "gu"))].map((m) => m[0]);
    hits.push({
      ruleId: rule.id,
      file: rule.file,
      index: match.index,
      line: lineNumberAt(text, match.index),
      text: segment,
      values,
      mode: rule.mode ?? "live",
      doc: Boolean(rule.doc),
      note: rule.note ?? "",
    });
  }
  return hits;
}

function parseJsonLenient(text) {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/u, "")) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 递归找出两个 JSON 值之间所有不同的路径 */
function diffJson(before, after, path = [], out = []) {
  if (before === after) return out;
  const bothObjects = before !== null && after !== null && typeof before === "object" && typeof after === "object";
  if (!bothObjects) {
    out.push({ path: path.join("."), from: before, to: after });
    return out;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!(key in before) || !(key in after)) {
      out.push({ path: [...path, key].join("."), from: before[key], to: after[key] });
      continue;
    }
    diffJson(before[key], after[key], [...path, key], out);
  }
  return out;
}

/**
 * 扫描 + 制定计划（**不写盘**）。
 * @param {object} options
 * @param {string} [options.root] 服务根（默认 repo/source/local-service）
 * @param {string} [options.targetVersion] 目标版本；不传 = 只做一致性检查
 * @param {string} [options.baseVersion] 覆盖 baseVersion（一般不用，测试用）
 * @param {Array}  [options.rules] 覆盖规则表
 */
export function planVersionBump(options = {}) {
  const {
    root = DEFAULT_SERVICE_ROOT,
    targetVersion = null,
    baseVersion = null,
    rules = DEFAULT_RULES,
  } = options;

  const serviceRoot = resolve(root);
  const problems = [];
  const baseInfo = baseVersion ? { baseVersion, source: "参数覆盖" } : readBaseVersion(serviceRoot);
  const base = baseInfo.baseVersion;

  const textCache = new Map();
  const readText = (relative) => {
    if (textCache.has(relative)) return textCache.get(relative);
    let text = null;
    try {
      text = readFileSync(join(serviceRoot, relative), "utf8");
    } catch {
      text = null;
    }
    textCache.set(relative, text);
    return text;
  };

  // 1. 权威版本：package.json
  const packageText = readText("package.json");
  let oldVersion = null;
  if (packageText === null) {
    problems.push({
      code: "no-authoritative-version",
      file: "package.json",
      message: `读不到 ${join(serviceRoot, "package.json")}，没有权威版本号可用`,
    });
  } else {
    const parsed = parseJsonLenient(packageText);
    if (!parsed.ok || typeof parsed.value?.version !== "string") {
      problems.push({
        code: "no-authoritative-version",
        file: "package.json",
        message: `package.json 里的 version 读不出来（${parsed.ok ? "类型不是字符串" : parsed.error}）`,
      });
    } else {
      oldVersion = parsed.value.version;
    }
  }

  // 2. 目标版本格式校验（与打包脚本同口径）
  if (targetVersion !== null && targetVersion !== undefined) {
    if (!isValidVersion(targetVersion, base)) {
      problems.push({
        code: "invalid-version",
        message: `目标版本 ${targetVersion} 不符合打包脚本的版本格式（应为 ${base} 或 ${base}-linli9-x.y[.z][-beta.N]，见 ${BUILD_SCRIPT}:33）`,
      });
    }
  }

  // 3. 逐规则扫描
  const liveHits = [];
  const historyHits = [];
  for (const rule of rules) {
    if (!rule.pattern.includes(TOKEN)) {
      problems.push({
        code: "rule-without-token",
        ruleId: rule.id,
        message: `规则「${rule.id}」的定位模式里没有 ${TOKEN} 占位符，无法定位版本串`,
      });
      continue;
    }
    const text = readText(rule.file);
    if (text === null) {
      problems.push({
        code: "missing-file",
        ruleId: rule.id,
        file: rule.file,
        message: `规则「${rule.id}」要求的文件读不到：${rule.file}`,
      });
      continue;
    }
    const hits = scanRule(rule, text, base);
    const expect = normalizeExpect(rule.expect);
    if (hits.length < expect.min || hits.length > expect.max) {
      problems.push({
        code: hits.length === 0 ? "rule-no-match" : "rule-count-mismatch",
        ruleId: rule.id,
        file: rule.file,
        message:
          `规则「${rule.id}」期望命中 ${describeExpect(expect)} 处，实际 ${hits.length} 处（${rule.file}）` +
          (hits.length === 0
            ? " —— 一处都没找到；文件结构或路径变了，工具拒绝静默跳过"
            : " —— 数量与预期不符，先核对规则表再动手"),
      });
    }
    if ((rule.mode ?? "live") === "live") {
      for (const hit of hits) {
        if (hit.values.length === 0) {
          problems.push({
            code: "rule-match-without-version",
            ruleId: rule.id,
            file: rule.file,
            line: hit.line,
            message: `${rule.file}:${hit.line} 命中了「${rule.id}」却看不到版本串：${clamp(hit.text)}`,
          });
        }
        for (const value of hit.values) {
          if (oldVersion !== null && value !== oldVersion) {
            problems.push({
              code: "version-drift",
              ruleId: rule.id,
              file: rule.file,
              line: hit.line,
              message: `${rule.file}:${hit.line} 的版本值是 ${value}，与 package.json 的 ${oldVersion} 不一致（漂移）`,
            });
          }
        }
        liveHits.push(hit);
      }
    } else {
      historyHits.push(...hits);
    }
  }

  // 4. 短版本号等「只报告」的位置
  const advisories = [];
  if (oldVersion !== null) {
    for (const rule of buildAdvisoryRules(oldVersion)) {
      const text = readText(rule.file);
      if (text === null) continue;
      for (const match of text.matchAll(new RegExp(rule.pattern, "gmu"))) {
        advisories.push({
          ruleId: rule.id,
          file: rule.file,
          line: lineNumberAt(text, match.index),
          value: match[0],
          text: clamp(text.split("\n")[lineNumberAt(text, match.index) - 1] ?? ""),
        });
      }
    }
  }

  // 5. 变更清单（逐处：文件:行 旧值 → 新值）
  const edits = [];
  const shouldRewrite = targetVersion !== null && targetVersion !== undefined && targetVersion !== oldVersion;
  if (shouldRewrite) {
    for (const hit of liveHits) {
      for (const value of hit.values) {
        if (value !== oldVersion) continue;
        edits.push({
          ruleId: hit.ruleId,
          file: hit.file,
          line: hit.line,
          oldValue: oldVersion,
          newValue: targetVersion,
          text: clamp(hit.text),
        });
      }
    }
  }

  // 6. 生成新内容（内存里），并做写入前校验
  const pending = [];
  if (shouldRewrite && problems.length === 0) {
    const byFile = new Map();
    for (const hit of liveHits) {
      if (!byFile.has(hit.file)) byFile.set(hit.file, []);
      byFile.get(hit.file).push(hit);
    }
    for (const [file, hits] of byFile) {
      const original = readText(file);
      const sorted = [...hits].sort((a, b) => a.index - b.index);
      let updated = "";
      let cursor = 0;
      for (const hit of sorted) {
        if (hit.index < cursor) {
          problems.push({
            code: "rule-match-overlap",
            file,
            line: hit.line,
            message: `${file}:${hit.line} 被多条规则同时命中且替换区间重叠，工具拒绝猜测，先修正规则表`,
          });
          continue;
        }
        updated += original.slice(cursor, hit.index) + hit.text.split(oldVersion).join(targetVersion);
        cursor = hit.index + hit.text.length;
      }
      updated += original.slice(cursor);
      pending.push({ file, absPath: join(serviceRoot, file), original, updated, changed: original !== updated });
    }
  }

  // 7. 写入前校验：新内容必须 (a) 行数不变 (b) 所有活动位置都是目标版本 (c) JSON 只有 version 路径变化
  if (pending.length > 0) {
    const updatedText = (relative) => pending.find((entry) => entry.file === relative)?.updated ?? readText(relative);
    const filesToRewrite = new Set(pending.map((entry) => entry.file));

    for (const entry of pending) {
      if (entry.original.split("\n").length !== entry.updated.split("\n").length) {
        problems.push({
          code: "post-check-line-count",
          file: entry.file,
          message: `${entry.file} 替换后行数发生了变化（${entry.original.split("\n").length} → ${entry.updated.split("\n").length}），本工具只做行内替换，已中止`,
        });
      }
      if (entry.file.endsWith(".json")) {
        const before = parseJsonLenient(entry.original);
        const after = parseJsonLenient(entry.updated);
        if (!after.ok) {
          problems.push({
            code: "json-parse-failed",
            file: entry.file,
            message: `${entry.file} 替换后不是合法 JSON（${after.error}），已中止写入 —— 这正是 1.0 发布时 package-lock.json 被写坏的那类事故`,
          });
        } else if (before.ok) {
          for (const change of diffJson(before.value, after.value)) {
            if (change.from === oldVersion && change.to === targetVersion) continue;
            problems.push({
              code: "json-structure-changed",
              file: entry.file,
              message: `${entry.file} 的 JSON 在 ${change.path || "<根>"} 处出现了非版本号的改动：${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}，已中止写入`,
            });
          }
        }
      }
    }

    // 用新内容重扫：活动位置必须全部等于目标版本（同时保证幂等）
    for (const rule of rules) {
      if ((rule.mode ?? "live") !== "live") continue;
      if (!filesToRewrite.has(rule.file)) continue;
      const hits = scanRule(rule, updatedText(rule.file), base);
      const expect = normalizeExpect(rule.expect);
      if (hits.length < expect.min || hits.length > expect.max) {
        problems.push({
          code: "post-check-count",
          ruleId: rule.id,
          file: rule.file,
          message: `替换后规则「${rule.id}」在 ${rule.file} 里命中 ${hits.length} 处，不在期望的 ${describeExpect(expect)} 范围内`,
        });
      }
      for (const hit of hits) {
        for (const value of hit.values) {
          if (value !== targetVersion) {
            problems.push({
              code: "post-check-version",
              ruleId: rule.id,
              file: rule.file,
              line: hit.line,
              message: `替换后 ${rule.file}:${hit.line} 的值仍是 ${value}，不是目标版本 ${targetVersion}`,
            });
          }
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    root: serviceRoot,
    baseVersion: base,
    baseVersionSource: baseInfo.source,
    baseVersionFallback: baseInfo.source === "fallback" ? baseInfo.detail : null,
    oldVersion,
    targetVersion: targetVersion ?? null,
    rules: rules.length,
    files: [...new Set(rules.map((rule) => rule.file))],
    edits,
    history: historyHits.map((hit) => ({
      ruleId: hit.ruleId,
      file: hit.file,
      line: hit.line,
      values: hit.values,
      text: clamp(hit.text),
      note: hit.note,
    })),
    advisories,
    problems,
    pending,
  };
}

/**
 * 落盘。仅在 plan.ok 时写；写入途中抛错会把已写文件按原文回滚。
 * @returns {{written: string[], aborted: boolean, problems: Array, rolledBack: string[]}}
 */
export function applyVersionBump(plan) {
  if (!plan.ok) return { written: [], aborted: true, rolledBack: [], problems: plan.problems };
  const written = [];
  try {
    for (const entry of plan.pending) {
      if (!entry.changed) continue;
      writeFileSync(entry.absPath, entry.updated, "utf8");
      written.push(entry.file);
    }
  } catch (error) {
    const rolledBack = [];
    for (const file of written.reverse()) {
      const entry = plan.pending.find((item) => item.file === file);
      try {
        writeFileSync(entry.absPath, entry.original, "utf8");
        rolledBack.push(file);
      } catch {
        // 回滚失败也必须让调用方看到：把已写列表原样带回去
      }
    }
    return {
      written: [],
      aborted: true,
      rolledBack,
      problems: [
        {
          code: "write-failed",
          message: `写盘失败：${String(error?.message ?? error)}（已尝试回滚 ${rolledBack.length}/${written.length + rolledBack.length} 个文件）`,
        },
      ],
    };
  }
  return { written, aborted: false, rolledBack: [], problems: [] };
}

/**
 * 一站式入口（CLI 与测试共用）。
 * @param {object} options {root, targetVersion, check, log}
 * @returns {{exitCode:number, plan:object, written:string[], needed:number}}
 */
export function runVersionBump(options = {}) {
  const { root = DEFAULT_SERVICE_ROOT, targetVersion = null, check = false, log = () => {} } = options;

  if (targetVersion === null && !check) {
    log("[错误] 必须给 -Version <新版本> 或 -Check 之一");
    return { exitCode: 1, plan: null, written: [], needed: 0 };
  }

  const plan = planVersionBump({ root, targetVersion });

  if (plan.baseVersionFallback) log(`[提醒] ${plan.baseVersionFallback}`);
  log(`[根目录] ${plan.root}`);
  log(`[基准] 当前版本 ${plan.oldVersion ?? "<读不到>"}（package.json）｜baseVersion ${plan.baseVersion}（${plan.baseVersionSource}）`);
  log(`[扫描] 规则 ${plan.rules} 条，覆盖 ${plan.files.length} 个文件`);

  if (!plan.ok) {
    log(`[失败] ${plan.problems.length} 个问题，未写盘：`);
    for (const problem of plan.problems) {
      log(`  ✗ ${problem.file ? `${problem.file}${problem.line ? `:${problem.line}` : ""} — ` : ""}${problem.message}`);
    }
    return { exitCode: 1, plan, written: [], needed: plan.edits.length };
  }

  if (check) {
    if (plan.targetVersion !== null && plan.edits.length > 0) {
      log(`[检查] 有 ${plan.edits.length} 处需要更新到 ${plan.targetVersion}（-Check 不写盘）：`);
      for (const edit of plan.edits) log(`  ${formatEdit(edit)}`);
      logNotices(plan, log);
      return { exitCode: 2, plan, written: [], needed: plan.edits.length };
    }
    log(`[检查] 一致：所有活动位置都等于 ${plan.targetVersion ?? plan.oldVersion}`);
    logNotices(plan, log);
    return { exitCode: 0, plan, written: [], needed: 0 };
  }

  if (plan.targetVersion === plan.oldVersion) {
    log(`[跳过] 当前版本已是 ${plan.oldVersion}，无改动（幂等）`);
    logNotices(plan, log);
    return { exitCode: 0, plan, written: [], needed: 0 };
  }

  log(`[将替换] ${plan.edits.length} 处：`);
  for (const edit of plan.edits) log(`  ${formatEdit(edit)}`);
  logNotices(plan, log);

  const result = applyVersionBump(plan);
  if (result.aborted) {
    log(`[失败] 写盘中止：`);
    for (const problem of result.problems) log(`  ✗ ${problem.message}`);
    return { exitCode: 1, plan, written: [], needed: plan.edits.length };
  }
  log(`[写入] ${result.written.length} 个文件：${result.written.join("、")}`);
  log(`[校验] 通过：行数不变、JSON 合法且只有 version 变化、所有活动位置都等于 ${plan.targetVersion}`);
  return { exitCode: 0, plan, written: result.written, needed: plan.edits.length };
}

function formatEdit(edit) {
  const where = `${edit.file}:${edit.line}`.padEnd(44, " ");
  return `${where} ${edit.oldValue} → ${edit.newValue}`;
}

/**
 * 打印「刻意不改」与「需人工判断」的位置。
 * 这几类信息在**每一条**成功路径（含 -Check、含幂等跳过）上都要打出来：
 * 静默跳过 = 漏改没人知道，正是这个工具要消灭的失效方式。
 */
function logNotices(plan, log) {
  if (plan.history.length > 0) {
    // 说明只打一次（19 个历史节逐行重复同一句提示 = 噪音，人就不看了）
    const hint = plan.history[0].note ? `（${plan.history[0].note}）` : "";
    log(`[历史·不改] ${plan.history.length} 处${hint}：`);
    for (const item of plan.history) log(`  ${item.file}:${item.line} ${item.values.join(", ")}`);
  }
  if (plan.advisories.length > 0) {
    log(`[需人工判断] 短版本号出现 ${plan.advisories.length} 处（机器分不清本版/历史提法）：`);
    for (const item of plan.advisories) {
      log(`  ${item.file}:${item.line} ${item.value}：${item.text}`);
    }
  }
}
