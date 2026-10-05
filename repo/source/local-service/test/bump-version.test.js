/**
 * bump-version（版本号一键同步）测试。
 *
 * 铁律：**绝不动仓库里真实的版本号文件**。
 * 所有 case 都在 os.tmpdir() 的临时副本上跑，并用前后 sha256 证明真实文件字节未变。
 *
 * 跑法（沙箱必须加 --experimental-test-isolation=none，见任务书「通用要求」）：
 *   node --test --experimental-test-isolation=none repo/source/local-service/test/bump-version.test.js
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RULES,
  DEFAULT_SERVICE_ROOT,
  VERSION_SUFFIX_SOURCE,
  applyVersionBump,
  buildAdvisoryRules,
  escapeRegExp,
  isValidVersion,
  planVersionBump,
  readBaseVersion,
  runVersionBump,
  shortVersion,
  shortVersionProblem,
} from "../../tools/lib/version-bump.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = resolve(HERE, ".."); // repo/source/local-service

/** 规则表涉及的真实文件（去重） */
const RULE_FILES = [...new Set(DEFAULT_RULES.map((rule) => rule.file))];

/**
 * 真实仓库的当前版本：**动态读取**，发版之后这些测试不需要跟着改。
 * 以前这里写死「真实仓库是 1.0.4、测试改成 1.0.5」，结果真升到 1.0.5 的当天
 * 6 个用例集体失效（目标版本＝当前版本 → 无需改动 → 「第一次应当真的写了文件」失败）。
 */
const CURRENT = JSON.parse(readFileSync(join(REAL_ROOT, "package.json"), "utf8")).version;

/** 由当前版本推出一个**必然不同**的合法目标版本（只在副本上跑） */
function nextVersionOf(current) {
  const matched = /^(.*-linli9-)(\d+)\.(\d+)\.(\d+)$/u.exec(current);
  assert.ok(matched, `版本号格式无法推导下一版：${current}`);
  const [, prefix, major, minor, patch] = matched;
  return `${prefix}${major}.${minor}.${Number(patch) + 1}`;
}

const NEXT = nextVersionOf(CURRENT);
const NEXT_BETA = `${NEXT}-beta.1`;

const REAL_HASHES = new Map();
const TEMP_DIRS = [];

function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 造一份结构副本：只复制规则表涉及的文件，且都在临时目录里 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "olivia-bump-"));
  TEMP_DIRS.push(root);
  for (const relative of RULE_FILES) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REAL_ROOT, relative), target);
  }
  return root;
}

function hashAll(root) {
  const map = new Map();
  for (const relative of RULE_FILES) map.set(relative, hashOf(join(root, relative)));
  return map;
}

/** 从 build-release.ps1 里抠出它的版本格式正则（单一来源的对照物） */
function readBuildScriptSuffix() {
  const text = readFileSync(join(REAL_ROOT, "packaging", "build-release.ps1"), "utf8");
  const start = text.indexOf("'(?:-linli9-");
  assert.ok(start !== -1, "build-release.ps1 里找不到版本格式正则，请同步 VERSION_SUFFIX_SOURCE");
  return text.slice(start + 1, text.indexOf("'", start + 1));
}

/** 断言两个文本的差异**只**来自版本串替换（其它字节一律不许变） */
function assertOnlyVersionChanged(original, updated, oldVersion, newVersion, label) {
  const beforeLines = original.split("\n");
  const afterLines = updated.split("\n");
  assert.equal(afterLines.length, beforeLines.length, `${label}：行数不应变化`);
  let changed = 0;
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    changed += 1;
    assert.equal(
      afterLines[index],
      beforeLines[index].split(oldVersion).join(newVersion),
      `${label}:${index + 1} 只允许「${oldVersion} → ${newVersion}」这一种子串变化`,
    );
  }
  assert.ok(changed > 0, `${label}：应当至少有一行发生变化`);
}

before(() => {
  for (const relative of RULE_FILES) REAL_HASHES.set(relative, hashOf(join(REAL_ROOT, relative)));
});

after(() => {
  // 真实仓库文件必须一字节未变
  for (const relative of RULE_FILES) {
    assert.equal(
      hashOf(join(REAL_ROOT, relative)),
      REAL_HASHES.get(relative),
      `测试污染了仓库里的真实文件：${relative}`,
    );
  }
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

describe("规则表与单一来源", () => {
  test("规则表覆盖 8 个文件，且每条活动规则都带 %V% 占位符", () => {
    assert.equal(RULE_FILES.length, 8, `规则表应覆盖 8 个文件，实际 ${RULE_FILES.length}`);
    const live = DEFAULT_RULES.filter((rule) => (rule.mode ?? "live") === "live");
    assert.ok(live.length >= 11, `活动规则应至少 11 条，实际 ${live.length}`);
    for (const rule of live) {
      assert.ok(rule.pattern.includes("%V%"), `规则「${rule.id}」缺少 %V% 占位符`);
    }
    const history = DEFAULT_RULES.filter((rule) => rule.mode === "history");
    assert.equal(history.length, 1, "历史规则应恰好 1 条（发布说明.md 的历史节标题）");
  });

  test("package-lock.json 的期望命中数是 2（与 build-release.ps1 的 $lockVersionCount 校验一致）", () => {
    const lockRule = DEFAULT_RULES.find((rule) => rule.file === "package-lock.json");
    assert.equal(lockRule.expect, 2);
  });

  test("VERSION_SUFFIX_SOURCE 与 build-release.ps1 里的版本格式正则逐字一致", () => {
    const literal = readBuildScriptSuffix();
    assert.equal(
      literal,
      `${VERSION_SUFFIX_SOURCE}$`,
      "build-release.ps1 的版本格式正则变了（后缀片段 + 结尾 $ 锚点），version-bump.mjs 的 VERSION_SUFFIX_SOURCE 必须跟着改",
    );
  });

  test("isValidVersion 与 build-release.ps1 的正则口径一致（样本集）", () => {
    const suffix = readBuildScriptSuffix().replace(/\$$/u, "");
    const base = readBaseVersion(REAL_ROOT).baseVersion;
    const psLike = new RegExp(`^${escapeRegExp(base)}${suffix}$`, "u");
    const samples = [
      base,
      `${base}-linli9-1.0.4`,
      `${base}-linli9-1.0.5-beta.1`,
      `${base}-linli9-g56`,
      `${base}-linli9-1.0`,
      "1.0.5",
      "2008.2.8-linli9-1.0.4",
      `${base}-linli9-`,
      `${base}-linli9-1.0.5.6.7`,
      "",
    ];
    for (const sample of samples) {
      assert.equal(
        isValidVersion(sample, base),
        psLike.test(sample),
        `isValidVersion("${sample}") 与打包脚本正则不一致`,
      );
    }
  });

  test("readBaseVersion 从 build-release.ps1 现读，不写死第二份", () => {
    const info = readBaseVersion(REAL_ROOT);
    assert.equal(info.baseVersion, "2008.2.7");
    assert.match(info.source, /^packaging[\\/]build-release\.ps1:\d+$/u, "应报出 baseVersion 的出处行号");
    const text = readFileSync(join(REAL_ROOT, "packaging", "build-release.ps1"), "utf8");
    assert.match(text, new RegExp(`^\\$baseVersion[ \\t]*=[ \\t]*"${escapeRegExp(info.baseVersion)}"`, "mu"));
  });

  test("shortVersion / buildAdvisoryRules 只报告短号，不参与自动替换", () => {
    assert.equal(shortVersion("2008.2.7-linli9-1.0.4"), "1.0.4");
    const rules = buildAdvisoryRules("2008.2.7-linli9-1.0.4");
    assert.ok(rules.length >= 3, "三份打包文档都要提示短版本号");
    for (const rule of rules) assert.ok(!rule.pattern.includes("%V%"), "advisory 规则不参与替换");
  });

  test("位宽校验：minor / patch 超过 99 才是超限（1.0.100 会与 1.1.0 撞号）", () => {
    assert.equal(shortVersionProblem("2008.2.7-linli9-1.0.9"), null, "1.0.9 正常");
    assert.equal(
      shortVersionProblem("2008.2.7-linli9-1.0.10"),
      null,
      "1.0.10 在两位位宽内仍合法（10010 ≠ 1.1.0 的 10100，别被旧编码的撞号吓到）",
    );
    assert.equal(shortVersionProblem("2008.2.7-linli9-1.99.99"), null, "位宽上限本身合法");
    assert.equal(shortVersionProblem("2008.2.7-linli9-g28"), null, "gXX 是老格式，不适用本规则");
    assert.equal(shortVersionProblem("2008.2.7"), null, "上游裸版本号不适用本规则");
    const patchOver = shortVersionProblem("2008.2.7-linli9-1.0.100");
    assert.ok(patchOver, "1.0.100 应被判为超限");
    assert.equal(patchOver.limit, 99);
    assert.deepEqual(patchOver.parts, ["patch=100"]);
    const minorOver = shortVersionProblem("2008.2.7-linli9-1.100.0");
    assert.ok(minorOver, "minor 超限同样要拦");
    assert.deepEqual(minorOver.parts, ["minor=100"]);
    assert.deepEqual(
      shortVersionProblem("2008.2.7-linli9-1.100.100").parts,
      ["minor=100", "patch=100"],
      "两位都超限时都要报出来",
    );
  });
});

describe("版本号位宽闸门（防静默撞号）", () => {
  // 起因：客户端把短号编成 major*10000 + minor*100 + patch（各两位）。旧编码是一位，
  // 于是 1.0.10 与 1.1.0 编成同一个序号 → 两版互不提示更新（静默失效，发布后才由用户发现）。
  // 现在超位宽在发布前的 -Check 里直接失败。
  test("目标版本超位宽时失败，且不写盘", () => {
    const root = makeFixture();
    const lines = [];
    const result = runVersionBump({
      root,
      targetVersion: "2008.2.7-linli9-1.0.100",
      check: true,
      log: (line) => lines.push(line),
    });
    assert.equal(result.exitCode, 1, lines.join("\n"));
    assert.ok(
      result.plan.problems.some((problem) => problem.code === "short-version-part-overflow"),
      `应报 short-version-part-overflow，实际：${JSON.stringify(result.plan.problems)}`,
    );
    assert.equal(result.written.length, 0);
    assert.match(lines.join("\n"), /位宽超限/u, "失败信息要讲清是位宽问题");
  });

  test("位宽内的目标版本照常通过（1.0.10 不再被误拦）", () => {
    const root = makeFixture();
    const result = runVersionBump({
      root,
      targetVersion: "2008.2.7-linli9-1.0.10",
      check: true,
      log: () => {},
    });
    assert.equal(result.exitCode, 2, "1.0.10 合法：-Check 应正常报出需替换的位置");
    assert.equal(result.plan.problems.length, 0, JSON.stringify(result.plan.problems));
  });

  test("-Check 自查现状版本：package.json 已是超位宽号时失败", () => {
    const root = makeFixture();
    const packagePath = join(root, "package.json");
    const text = readFileSync(packagePath, "utf8");
    writeFileSync(
      packagePath,
      text.replace(shortVersion(CURRENT), "1.0.100"),
      "utf8",
    );
    const lines = [];
    const result = runVersionBump({ root, check: true, log: (line) => lines.push(line) });
    assert.equal(result.exitCode, 1, lines.join("\n"));
    assert.ok(
      result.plan.problems.some((problem) => problem.code === "short-version-part-overflow"),
      "现状版本超位宽必须报出来",
    );
  });
});

describe("扫描（-Check / 只报不改）", () => {
  test("副本上扫描：每处活动位置都命中，且逐处带 文件:行", () => {
    const root = makeFixture();
    const plan = planVersionBump({ root, targetVersion: NEXT });
    assert.equal(plan.ok, true, JSON.stringify(plan.problems, null, 2));
    const places = plan.edits.map((edit) => `${edit.file}:${edit.line}`);
    for (const expected of [
      "package.json:3",
      "package-lock.json:3",
      "package-lock.json:9",
      "native-host/OliviaSoul.csproj:15",
      "packaging/build-release.ps1:27",
      "public/listen-naming-feedback.js:15",
    ]) {
      assert.ok(places.includes(expected), `缺少版本位置 ${expected}（实际：${places.join("、")}）`);
    }
    assert.ok(plan.edits.length >= 10, `活动位置应至少 10 处，实际 ${plan.edits.length}`);
    // 逐处的「命中的那一行」确实含当前版本串（不依赖相邻行的假设）
    for (const edit of plan.edits) {
      const line = readFileSync(join(root, edit.file), "utf8").split("\n")[edit.line - 1];
      assert.ok(line.includes(edit.oldValue), `${edit.file}:${edit.line} 该行并不含 ${edit.oldValue}`);
    }
  });

  test("-Check（带目标版本）发现有需要更新的位置：退出码 2 且绝不写盘", () => {
    const root = makeFixture();
    const beforeHashes = hashAll(root);
    const lines = [];
    const result = runVersionBump({ root, targetVersion: NEXT, check: true, log: (line) => lines.push(line) });
    assert.equal(result.exitCode, 2, lines.join("\n"));
    assert.equal(result.written.length, 0);
    assert.deepEqual(hashAll(root), beforeHashes, "-Check 不应改动任何文件");
    const text = lines.join("\n");
    assert.match(
      text,
      new RegExp(`package\\.json:3\\s+${escapeRegExp(CURRENT)} → ${escapeRegExp(NEXT)}`, "u"),
    );
    assert.match(text, /\[历史·不改\]/u, "刻意不改的位置要显式打印，不能静默跳过");
    assert.match(text, /\[需人工判断\]/u, "短版本号要显式提示人工判断");
  });

  test("-Check（不带目标版本）只做一致性检查：一致时退出码 0", () => {
    const root = makeFixture();
    const lines = [];
    const result = runVersionBump({ root, check: true, log: (line) => lines.push(line) });
    assert.equal(result.exitCode, 0, lines.join("\n"));
    assert.equal(result.needed, 0);
    assert.match(lines.join("\n"), /\[检查\] 一致/u);
  });

  test("短版本号（散文里的短版本号）只进 advisory，不进替换清单", () => {
    const root = makeFixture();
    const plan = planVersionBump({ root, targetVersion: NEXT });
    assert.ok(
      plan.advisories.some(
        (item) => item.value === shortVersion(CURRENT) && item.file === "packaging/使用说明.txt",
      ),
      "使用说明.txt 里的短版本号应被提示人工判断",
    );
    for (const edit of plan.edits) {
      assert.ok(edit.newValue === NEXT, "替换清单里不应混入短版本号的替换");
    }
  });
});

describe("替换（-Version）", () => {
  test("替换后所有活动位置都是新版本，且只有版本串发生变化", () => {
    const root = makeFixture();
    const plan = planVersionBump({ root, targetVersion: NEXT });
    assert.equal(plan.ok, true, JSON.stringify(plan.problems, null, 2));

    const originals = new Map();
    for (const entry of plan.pending) originals.set(entry.file, entry.original);

    const lines = [];
    const result = runVersionBump({ root, targetVersion: NEXT, log: (line) => lines.push(line) });
    assert.equal(result.exitCode, 0, lines.join("\n"));

    for (const entry of plan.pending) {
      const after = readFileSync(join(root, entry.file), "utf8");
      assertOnlyVersionChanged(originals.get(entry.file), after, plan.oldVersion, NEXT, entry.file);
    }

    // 重新扫描：不能再有需要更新的位置
    const rescan = planVersionBump({ root, targetVersion: NEXT });
    assert.equal(rescan.ok, true, JSON.stringify(rescan.problems, null, 2));
    assert.equal(rescan.edits.length, 0, "替换后不应再有待更新位置");
    assert.equal(rescan.oldVersion, NEXT);
  });

  test("JSON 文件仍合法；package-lock.json 恰好 2 处新版本；依赖版本与 AssemblyVersion 未被误伤", () => {
    const root = makeFixture();
    const before = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const result = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(result.exitCode, 0, JSON.stringify(result.plan?.problems ?? [], null, 2));

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.version, NEXT);

    const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
    const lock = JSON.parse(lockText);
    assert.equal(lock.version, NEXT);
    assert.equal(lock.packages[""].version, NEXT);
    assert.equal(
      [...lockText.matchAll(new RegExp(`"version":\\s*"${escapeRegExp(NEXT)}"`, "gu"))].length,
      2,
      "package-lock.json 里应恰好 2 处新版本（顶层 + packages[\"\"]），与 build-release.ps1 校验一致",
    );
    assert.equal(lock.packages["node_modules/midi-file"].version, before.packages["node_modules/midi-file"].version);

    const csproj = readFileSync(join(root, "native-host", "OliviaSoul.csproj"), "utf8");
    assert.ok(csproj.includes(`<Version>${NEXT}</Version>`), "csproj 的 <Version> 应更新");
    assert.ok(csproj.includes("<AssemblyVersion>2008.2.7.0</AssemblyVersion>"), "AssemblyVersion 不该被改");
  });

  test("历史记录不被误伤：旧版本节标题与历史提法保持原样", () => {
    const root = makeFixture();
    const releaseBefore = readFileSync(join(root, "packaging", "发布说明.md"), "utf8");
    assert.ok(releaseBefore.includes("-linli9-1.0.3"), "前提：发布说明里有 1.0.3 的历史节");
    const historyPlan = planVersionBump({ root, targetVersion: NEXT });
    assert.ok(historyPlan.history.length >= 1, "历史节标题应被单独列出来报告");
    for (const item of historyPlan.history) {
      assert.ok(
        !historyPlan.edits.some((edit) => edit.file === item.file && edit.line === item.line),
        `${item.file}:${item.line} 是历史节标题，不该进替换清单`,
      );
    }

    const result = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(result.exitCode, 0);
    const releaseAfter = readFileSync(join(root, "packaging", "发布说明.md"), "utf8");
    assert.ok(releaseAfter.includes("-linli9-1.0.3"), "1.0.3 的历史节必须原样保留");
    assert.ok(releaseAfter.includes(`## ${historyPlan.oldVersion} ·`), "当前版本那一节的标题（历史）不该被改");
    assert.ok(
      releaseAfter.includes("OliviaSoul-2008.2.7-Setup.exe"),
      "历史附录「下载与升级方法」里的旧包名（用 baseVersion 命名）不该被当成版本身份改掉",
    );
  });

  test("不误伤其它数字：baseVersion、日期、前端版本号等保持原样", () => {
    const root = makeFixture();
    const snapshots = new Map();
    for (const relative of RULE_FILES) snapshots.set(relative, readFileSync(join(root, relative), "utf8"));
    const result = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(result.exitCode, 0);
    for (const relative of RULE_FILES) {
      const after = readFileSync(join(root, relative), "utf8");
      assertOnlyVersionChanged(snapshots.get(relative), after, CURRENT, NEXT, relative);
    }
    // baseVersion 那行本身不是版本串，行内替换也不会碰到它
    const build = readFileSync(join(root, "packaging", "build-release.ps1"), "utf8");
    assert.match(build, /^\$baseVersion[ \t]*=[ \t]*"2008\.2\.7"/mu);
    assert.ok(!build.includes("2008.2.7-linli9-2008"), "不许把 baseVersion 拼进版本串");
  });

  test("幂等：同一版本再跑一次 0 改动、退出码 0", () => {
    const root = makeFixture();
    const first = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(first.exitCode, 0);
    assert.ok(first.written.length > 0, "第一次应当真的写了文件");

    const afterFirst = hashAll(root);
    const lines = [];
    const second = runVersionBump({ root, targetVersion: NEXT, log: (line) => lines.push(line) });
    assert.equal(second.exitCode, 0, lines.join("\n"));
    assert.equal(second.written.length, 0, "第二次不应写任何文件");
    assert.equal(second.needed, 0);
    assert.deepEqual(hashAll(root), afterFirst, "第二次运行不应改动任何字节");
    assert.match(lines.join("\n"), /\[跳过\]/u);
  });

  test("beta 版本号（-beta.N）也是合法目标版本", () => {
    const root = makeFixture();
    const result = runVersionBump({ root, targetVersion: NEXT_BETA, log: () => {} });
    assert.equal(result.exitCode, 0, JSON.stringify(result.plan?.problems ?? [], null, 2));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.version, NEXT_BETA);
  });
});

describe("失败路径（防静默失效）", () => {
  test("一处都找不到：空目录 → 非零退出、不写盘", () => {
    const root = mkdtempSync(join(tmpdir(), "olivia-bump-empty-"));
    TEMP_DIRS.push(root);
    const lines = [];
    const result = runVersionBump({ root, targetVersion: NEXT, log: (line) => lines.push(line) });
    assert.notEqual(result.exitCode, 0, "找不到任何版本位置时必须非零退出");
    assert.equal(result.exitCode, 1);
    assert.equal(result.written.length, 0);
    const codes = result.plan.problems.map((problem) => problem.code);
    assert.ok(codes.includes("no-authoritative-version"), `应报出找不到权威版本，实际：${codes.join(",")}`);
    assert.ok(codes.includes("missing-file"), "应逐条报出缺失的身份文件");
    assert.match(lines.join("\n"), /未写盘/u);
  });

  test("单条规则 0 命中：非零退出并指名规则", () => {
    const root = makeFixture();
    const target = join(root, "public", "listen-naming-feedback.js");
    writeFileSync(target, readFileSync(target, "utf8").replace(/APP_VERSION/u, "APP_VERSION_DISABLED"), "utf8");
    const beforeHashes = hashAll(root);
    const result = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(result.exitCode, 1);
    const problem = result.plan.problems.find(
      (item) => item.code === "rule-no-match" && String(item.ruleId).includes("APP_VERSION"),
    );
    assert.ok(problem, `应报出「APP_VERSION 规则 0 命中」，实际：${JSON.stringify(result.plan.problems)}`);
    assert.equal(result.written.length, 0, "有任一规则 0 命中时不许写盘");
    assert.deepEqual(hashAll(root), beforeHashes);
  });

  test("版本漂移（某处版本与 package.json 不一致）：非零退出、不写盘", () => {
    const root = makeFixture();
    const target = join(root, "native-host", "OliviaSoul.csproj");
    writeFileSync(
      target,
      readFileSync(target, "utf8").replace(`${CURRENT}</Version>`, "2008.2.7-linli9-9.9.9</Version>"),
      "utf8",
    );
    const beforeHashes = hashAll(root);
    const result = runVersionBump({ root, targetVersion: NEXT, log: () => {} });
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.plan.problems.some((item) => item.code === "version-drift"),
      `应报出版本漂移，实际：${JSON.stringify(result.plan.problems)}`,
    );
    assert.deepEqual(hashAll(root), beforeHashes, "漂移时不许写盘（写了会把其它位置带偏）");
  });

  test("非法目标版本（如 1.0.5）：非零退出、不写盘", () => {
    const root = makeFixture();
    const beforeHashes = hashAll(root);
    const result = runVersionBump({ root, targetVersion: "1.0.5", log: () => {} });
    assert.equal(result.exitCode, 1);
    assert.ok(result.plan.problems.some((item) => item.code === "invalid-version"));
    assert.deepEqual(hashAll(root), beforeHashes);
  });

  test("既没给版本也没给 -Check：非零退出", () => {
    const result = runVersionBump({ root: makeFixture(), log: () => {} });
    assert.equal(result.exitCode, 1);
    assert.equal(result.plan, null);
  });

  test("写盘中途失败会回滚已写文件", () => {
    const root = makeFixture();
    const good = join(root, "package.json");
    const original = readFileSync(good, "utf8");
    const fakePlan = {
      ok: true,
      pending: [
        {
          file: "package.json",
          absPath: good,
          original,
          updated: original.replace(CURRENT, NEXT),
          changed: true,
        },
        {
          file: "nope/nowhere.json",
          absPath: join(root, "nope", "nowhere.json"), // 目录不存在 → 写失败
          original: "{}",
          updated: "{ }",
          changed: true,
        },
      ],
    };
    const result = applyVersionBump(fakePlan);
    assert.equal(result.aborted, true);
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.rolledBack, ["package.json"]);
    assert.equal(readFileSync(good, "utf8"), original, "写失败后必须把已写文件还原");
  });

  test("plan.ok=false 时 applyVersionBump 绝不写盘", () => {
    const root = makeFixture();
    const plan = planVersionBump({ root, targetVersion: "1.0.5" }); // 非法版本 → 不 ok
    assert.equal(plan.ok, false);
    const result = applyVersionBump(plan);
    assert.equal(result.aborted, true);
    assert.deepEqual(result.written, []);
    assert.equal(result.problems, plan.problems);
  });
});

describe("默认根目录", () => {
  test("DEFAULT_SERVICE_ROOT 指向 repo/source/local-service，且真实仓库当前版本可被解析", () => {
    assert.equal(DEFAULT_SERVICE_ROOT, REAL_ROOT);
    const info = readBaseVersion();
    assert.equal(info.baseVersion, "2008.2.7");
    // 只读校验：真实仓库的 -Check 跑得通（不带目标版本时应当一致）
    const lines = [];
    const result = runVersionBump({ root: DEFAULT_SERVICE_ROOT, check: true, log: (line) => lines.push(line) });
    assert.equal(result.exitCode, 0, lines.join("\n"));
  });
});
