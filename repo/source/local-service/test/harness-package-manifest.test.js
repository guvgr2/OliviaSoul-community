// 写信 harness 脚本的「打包清单 vs 目录实况」双向一致性 + BOM 规则。
//
// 起因（1.2.0 第十四轮）：B7 新建了 probe-prune.ps1，代码改好了、测试也加了，
// 但 packaging/build-release.ps1 那份手写清单没同步 —— 产物里根本没这个文件。
// harness-4step.ps1:49 在**脚本顶层**硬 dot-source 它（无 -ErrorAction 保护），
// 而 :28 是 $ErrorActionPreference = "Stop" ⇒ 缺文件 = 整个写回信启动即退出码 1，
// 用户点「写回信」必然失败。六阶段门禁全绿、真机冒烟也不写信，所以没人抓到。
//
// 这里的做法与 test/admin-static-whitelist.test.js 完全一致：
// 不把手写白名单改成目录扫描（那会把不该进包的东西也带进去），
// 而是**让"漏改清单"这件事在门禁里当场变红**。
//
// 三条断言：
//   1. harness 脚本 foreach 清单 <==> .cursor/skills/fit-letters/scripts/ 实际文件（双向）
//   2. 单独 Copy 到产物 scripts 目录的文件（现在只有 model-families.json，源在 local-service 根）
//      其源文件必须真实存在 —— 否则打进产物的是个空壳/复制失败
//   3. 含非 ASCII 字符的 .ps1 必须带 UTF-8 BOM（纯 ASCII 的可以不带）
//
// 第 3 条为什么写成"含非 ASCII 才必须 BOM"，而不是"列一份必须有 BOM 的文件名单"：
// Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按 ANSI(GBK) 解码 —— 文件纯 ASCII 时结果正确，
// 一旦有人往里加一句中文注释就会立刻乱码/假语法错。写成名单式护栏，以后谁给
// harness-live.ps1 / history-retrieval.ps1（这俩现在刻意保持纯 ASCII、无 BOM）加中文，
// 护栏不会响；写成规则式护栏，加中文的那一刻就红，逼人补 BOM。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(HERE, "..");
// harness 脚本住在 repo/source/.cursor 下（不是 local-service 下）
const SOURCE_ROOT = resolve(SERVICE_ROOT, "..");
const SCRIPTS_DIR = join(SOURCE_ROOT, ".cursor", "skills", "fit-letters", "scripts");
const BUILD_PS1 = join(SERVICE_ROOT, "packaging", "build-release.ps1");

/**
 * 抽 harness 脚本的 foreach 清单：这些文件是从 .cursor/skills/fit-letters/scripts/ 原样复制的。
 * 唯一真相在打包脚本里，不在测试里另抄一份名单（否则清单改了测试还绿，等于没护栏）。
 */
function scriptListFromSource(source) {
  const loop = /\$scriptTarget\s*=\s*Join-Path[^\n]*\n\s*foreach \(\$name in @\(([\s\S]*?)\)\)\s*\{/u.exec(source);
  assert.ok(
    loop,
    "没能在 build-release.ps1 里定位 harness 脚本的 foreach 清单（脚本结构变了？同步更新本测试的抽取正则）",
  );
  const names = [...loop[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  assert.ok(names.length > 0, "抽出来的清单是空的，抽取正则有误");
  return [...new Set(names)].sort();
}

/** 抽「单独 Copy-PublicFile 到产物 scripts 目录」的文件名（foreach 之外，源不一定在 scripts 目录） */
function extraTargetsFromSource(source) {
  return [...new Set([...source.matchAll(/\(Join-Path \$scriptTarget "([^"]+)"\)/gu)].map((m) => m[1]))].sort();
}

test("写信 harness 脚本：打包清单与目录实况双向一致（漏登记 = 产物里写回信启动即失败）", async () => {
  const source = await readFile(BUILD_PS1, "utf8");
  const listed = scriptListFromSource(source);
  const actual = (await readdir(SCRIPTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(
    actual.filter((name) => !listed.includes(name)),
    [],
    "目录里有文件没进打包清单 —— 产物里不会有它；若 harness 顶层 dot-source 了它，" +
      "写回信会在 $ErrorActionPreference=Stop 下启动即退出码 1（1.2.0 第十四轮 probe-prune.ps1 就是这么漏的）。" +
      "修法：把文件名加进 packaging/build-release.ps1 的 harness 脚本清单。",
  );
  assert.deepEqual(
    listed.filter((name) => !actual.includes(name)),
    [],
    "打包清单里有目录里不存在的文件 —— 这是永远复制不到的死条目（文件被删/改名后没清清单）。",
  );
  assert.deepEqual(listed, actual, "打包清单与 .cursor/skills/fit-letters/scripts/ 实际文件必须一一对应");
});

test("写信 harness 脚本：单独复制进产物 scripts 目录的文件，源文件必须真实存在", async () => {
  const source = await readFile(BUILD_PS1, "utf8");
  const extras = extraTargetsFromSource(source);
  assert.ok(extras.length > 0, "没抽到任何单独复制的文件（model-families.json 那行没了？）");

  const missing = extras.filter(
    (name) => !existsSync(join(SCRIPTS_DIR, name)) && !existsSync(join(SERVICE_ROOT, name)),
  );
  assert.deepEqual(
    missing,
    [],
    "这些文件被写进打包脚本要复制进产物 scripts 目录，但在 scripts 目录与 local-service 根都找不到源文件" +
      "（改名/移动后没同步打包脚本 ⇒ 产物里缺它，model-call.ps1 会退化到内置兜底家族表）。",
  );
});

test("写信 harness 脚本：含非 ASCII 字符的 .ps1 必须有 UTF-8 BOM（纯 ASCII 的可以不带）", async () => {
  const entries = (await readdir(SCRIPTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ps1"))
    .map((entry) => entry.name)
    .sort();

  assert.ok(entries.length > 0, "scripts 目录下没找到 .ps1（路径变了？）");

  const offenders = [];
  for (const name of entries) {
    const buf = await readFile(join(SCRIPTS_DIR, name));
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    if (hasBom) continue;
    // 无 BOM 只有在文件是纯 ASCII 时才安全（PS 5.1 会按 ANSI 解码，GBK 下 ASCII 字节不变）
    const body = buf.toString("latin1"); // 按字节看，避免解码本身掩盖问题
    const nonAscii = [...body].filter((ch) => ch.codePointAt(0) > 127).length;
    if (nonAscii > 0) offenders.push(`${name}（无 BOM 但含 ${nonAscii} 个非 ASCII 字符）`);
  }

  assert.deepEqual(
    offenders,
    [],
    "这些 .ps1 没有 UTF-8 BOM 却含有非 ASCII 字符：PowerShell 5.1 会按 ANSI(GBK) 解码，" +
      "轻则中文乱码、重则报假语法错。修法：用带 BOM 的 UTF-8 重新保存（受管 edit/write 会吞掉 BOM，改完要复查）。",
  );
});
