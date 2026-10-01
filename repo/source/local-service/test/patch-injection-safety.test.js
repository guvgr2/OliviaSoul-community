// 补丁注入安全性回归测试。
//
// 背景（真实教训）：
//   为了做「背景音让位」，注入代码调用了游戏的内部工厂 ns(...)。
//   当时全面检查**全部通过** —— marker 正确、18 个注入符号都在、注入后 JS 语法有效 ——
//   但游戏一启动就**黑屏**。因为「语法正确」不等于「运行时安全」。
//
// 本套件补上静态风险检查，任何会碰游戏内部机制的注入都会被拦下。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const patch = readFileSync(join(here, "..", "..", "tools", "patch-feapp-local.ps1"), "utf8");

test("不得包装或改写游戏的播放函数（真实踩过：游戏黑屏）", () => {
  for (const token of ["playSong:OliviaSoul", "OliviaSoulPlaySong", "playSonglistItem:OliviaSoul"]) {
    assert.ok(!patch.includes(token), `不得出现「${token}」：改写播放函数会导致游戏黑屏`);
  }
});

test("不得调用游戏内部工厂 ns(...)（真实踩过：游戏黑屏）", () => {
  const calls = patch.match(/(?<![A-Za-z0-9_$])ns\s*\(/gu) ?? [];
  assert.equal(calls.length, 0, `不得调用游戏内部工厂 ns()，实际 ${calls.length} 处`);
});

test("碰播放协调机制必须满足硬性条件（背景音让位，v57 起有条件放开）", () => {
  // 1.0.1 曾一刀切禁止引用这些名字 —— 因为当时不了解机制，两次尝试都黑屏。
  // v57 起有条件放开，依据是真机只读探针的实测结论：
  //   · 官方播放时 ambientSound 的 playState 变 stopped（即「让位=停氛围音」）
  //   · 本地作品播放时氛围音照常 playing（所以不让位）
  //   · ambientSound store 在运行时可按名字取到，且暴露 acquireExclusive / releaseExclusive
  // 但「条件」必须由测试守住，不是靠注释：
  //   ① 仍然禁止 startForeground / stopForeground / playbackCoordinator —— 那会动播放会话
  //   ② 只允许出现在 OliviaSoulDuckAmbience 这一个函数里
  //   ③ 必须整段 try/catch（取不到 store 就静默跳过，绝不影响播放）
  //   ④ 必须有幂等标志（acquire/release 是计数式的，失衡会让背景音一直不恢复）
  for (const token of ["startForeground", "stopForeground", "playbackCoordinator"]) {
    assert.ok(!patch.includes(token), `不得引用「${token}」：会动到播放会话，黑屏风险仍在`);
  }
  const duck = /OliviaSoulDuckAmbience=B=>\{([\s\S]*?)\},OliviaSoulSongIdFromItem=/u.exec(patch);
  assert.ok(duck, "应存在 OliviaSoulDuckAmbience（背景音让位）");
  const body = duck[1];
  assert.match(body, /try\s*\{/u, "必须包在 try 里：取不到 store 时静默跳过");
  assert.match(body, /catch/u, "必须有 catch 兜底，绝不能让异常冒到播放路径");
  assert.match(body, /__OliviaSoulAmbienceDucked/u, "必须有幂等标志，避免 acquire/release 计数失衡");
  for (const token of ["acquireExclusive", "releaseExclusive"]) {
    const total = (patch.match(new RegExp(token, "gu")) ?? []).length;
    const inside = (body.match(new RegExp(token, "gu")) ?? []).length;
    assert.equal(total, inside, `「${token}」只能出现在 OliviaSoulDuckAmbience 内（共 ${total} 处，区内 ${inside} 处）`);
  }
});

test("不得残留已撤销的实验功能（背景音让位）", () => {
  for (const token of ["OliviaSoulLocalFocus", "__OliviaSoulFocusActive", "olivia-local-playback"]) {
    assert.ok(!patch.includes(token), `不得残留「${token}」：该功能曾导致游戏黑屏，已撤销`);
  }
});

test("注入的全局函数必须有 try/catch 兜底", () => {
  const heads = patch.match(/window\.__OliviaSoul[A-Za-z]+\s*=\s*function/gu) ?? [];
  assert.ok(heads.length > 0, "应存在注入的全局函数");
  for (const head of heads) {
    const start = patch.indexOf(head);
    const slice = patch.slice(start, start + 240);
    assert.match(slice, /try\s*\{/u, `注入函数缺少 try 保护：${head}`);
  }
});

test("注入代码不得使用未定义的 OliviaSoul 全局函数", () => {
  const defined = new Set(
    (patch.match(/window\.__OliviaSoul[A-Za-z]+\s*=/gu) ?? [])
      .map(s => s.replace(/window\.__/u, "").replace(/\s*=$/u, "")),
  );
  const called = new Set(
    (patch.match(/window\.__OliviaSoul[A-Za-z]+\s*\(/gu) ?? [])
      .map(s => s.replace(/window\.__/u, "").replace(/\s*\($/u, "")),
  );
  const missing = [...called].filter(name => !defined.has(name));
  assert.deepEqual(missing, [], `调用了未定义的注入函数：${missing.join(", ")}`);
});

test("补丁 marker 不低于 v54（防止误回退）", () => {
  const marker = /mail-music-v(\d+)/u.exec(patch);
  assert.ok(marker, "缺少 patchMarker");
  assert.ok(Number(marker[1]) >= 54, `marker 不应低于 v54，实际 v${marker[1]}`);
});

test("注入替换必须带命中数断言（防止游戏更新后静默失效）", () => {
  const replaceCalls = patch.match(/\$text\s*=\s*\$text\.Replace\(/gu) ?? [];
  const guards = patch.match(/-ne\s+1\)/gu) ?? [];
  assert.ok(replaceCalls.length > 0, "应存在注入替换");
  assert.ok(
    guards.length >= Math.floor(replaceCalls.length / 3),
    `命中数断言偏少：替换 ${replaceCalls.length} 处，断言仅 ${guards.length} 处（游戏更新后容易静默失效）`,
  );
});
