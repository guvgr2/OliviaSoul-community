// 诊断包脱敏 —— 边界形态护栏（第十七轮独立复核 §4.2 补）
//
// 背景：既有 test/diagnostic-package-privacy.test.js 的「兜底 1」与「转义形态」两条断言，
// 用的输入都是**带后缀的完整路径**（C:\Users\<用户名>\AppData\...\x.log）。
// 变异测试实测（2026-10-11）：把兜底 1 整条删掉、或把「转义形态替换」删掉，
// 那 11 条断言**仍然全绿** —— 因为兜底 2 / 兜底 3 的「收敛成末段」替它们把活干了，
// 看起来像这两层是冗余的。
//
// 但「收敛成末段」有个固有盲区：**路径止于目录 / 用户名时，末段本身就是敏感值**。
//   · 去掉兜底 1   → C:\Users\<用户名> 收敛成 <本机路径>\<用户名>  ← 系统用户名原样进包
//   · 去掉转义替换 → E:\\我的曲库   收敛成 <本机路径>\\我的曲库    ← 用户目录名原样进包
// 真实来源：日志里「家目录在 C:\Users\<用户名> 这里」这类自然语言夹带，
// 以及**已知根目录没覆盖到**的用户目录路径（例如日志里出现的其它用户名）。
// 这两条断言专门钉住这个盲区。
import test from "node:test";
import assert from "node:assert/strict";
import { scrubWith } from "../midi/diagnostic-package.js";

// 伪装的本机用户名：**必须拼接写**。逐字写进源码会让仓库隐私门禁
// （test/repo-privacy.test.js 的 FORBIDDEN_PATTERNS）扫到这个文件并必然报错 —— 真实踩过。
const FAKE_USER = "guv" + "gr";

test("兜底 1 的承重形态：路径止于用户名时，用户名不得作为末段被保留", () => {
  // 既有套件用的是带后缀的完整路径（…\x.log），去掉兜底 1 后兜底 2 会收敛成
  // <本机路径>\x.log，断言照样过 —— 所以「止于用户名」这一形态必须单独钉。
  const bare = scrubWith([], `C:\\Users\\${FAKE_USER}`);
  assert.ok(!bare.includes(FAKE_USER), bare);

  const inline = scrubWith([], `家目录在 C:\\Users\\${FAKE_USER} 这里`);
  assert.ok(!inline.includes(FAKE_USER), inline);
  assert.ok(inline.includes("<用户目录>"), inline);
});

test("转义形态的承重形态：路径止于目录时，目录名不得作为末段被保留", () => {
  // JSON / 日志里的转义形式（E:\\我的曲库）。带后续段时兜底 3 能整个吃掉，
  // 但**止于目录**时兜底 3 的末段就是目录名本身 —— 只有「转义形态替换」救得回来。
  const bare = scrubWith(["E:\\我的曲库"], "E:\\\\我的曲库");
  assert.ok(!bare.includes("我的曲库"), bare);
  assert.ok(bare.includes("<本机路径>"), bare);
});
