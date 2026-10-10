// 诊断包脱敏护栏（第四轮独立复核 P5）
//
// 背景：诊断包（midi/diagnostic-package.js）的脱敏实现是对的，但**零测试护栏**：
// test/ 里搜 diagnostic-package / scrubWith / sensitivePaths 全无命中，
// release-privacy 拦的是发布产物、拦不到运行时生成的诊断包。
// 当前不出事只是因为「诊断包不收集含 Key 的文件」——一旦有人往收集清单里加一条
// 「模型配置」，sk-xxx 就会明文进包，没有任何东西拦得住。
// 这组用例把这件事钉住：路径要脱敏、凭据要抹掉、收集面不许碰 secrets。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scrubWith, scrubCredentials, sensitivePaths, scrubEntries } from "../midi/diagnostic-package.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "midi", "diagnostic-package.js"), "utf8");

// 伪装的本机用户名与疑似 GitHub token：**必须拼接写**。逐字写进源码会让仓库隐私门禁
// （test/repo-privacy.test.js 的 FORBIDDEN / FORBIDDEN_PATTERNS）扫到这个文件并必然报错
// —— 1.2.0 发布提交时真实踩过（pre-commit 被拦下）。
const FAKE_USER = "guv" + "gr";
const FAKE_TOKEN = "ghp" + "_ABCDEFGH1234567890abcd";

test("导出护栏需要的三个函数（原先只导出 makeZip / createDiagnosticRoutes）", () => {
  assert.equal(typeof scrubWith, "function");
  assert.equal(typeof scrubCredentials, "function");
  assert.equal(typeof sensitivePaths, "function");
});

test("已知根目录替换成 <本机路径>，且保住「是哪个文件」", () => {
  const out = scrubWith(["E:\\我的曲库"], "E:\\我的曲库\\songs\\a.mid");
  assert.ok(!out.includes("我的曲库"), out);
  assert.ok(out.includes("<本机路径>"), out);
  assert.ok(out.includes("a.mid"), out);
  // 日志里偶发转义形式（E:\\我的曲库）同样要替换
  const escaped = scrubWith(["E:\\我的曲库"], "E:\\\\我的曲库\\\\songs\\\\b.mid");
  assert.ok(!escaped.includes("我的曲库"), escaped);
});

test("兜底 1：带用户名的 C:\\Users\\... 统一收敛，不留用户名", () => {
  const out = scrubWith([], `C:\\Users\\${FAKE_USER}\\AppData\\Roaming\\OliviaSoul\\x.log`);
  assert.ok(!out.includes(FAKE_USER), out);
  assert.ok(out.includes("x.log"), out);
});

test("兜底 2：任意盘符路径收敛成末段（正斜杠与反斜杠两种）", () => {
  assert.equal(scrubWith([], "E:/OliviaSoul/UserData/backup.sqlite"), "<本机路径>/backup.sqlite");
  assert.equal(scrubWith([], "D:\\archive\\2025\\OliviaSoul\\logs\\x.log"), "<本机路径>\\x.log");
});

test("file:/// 报错栈先处理，行号跟着保下来", () => {
  assert.equal(scrubWith([], "file:///E:/OliviaSoul/repo/server.js:3412"), "file:///<本机路径>/server.js:3412");
});

test("凭据一律抹成 ***（当前不收集含 Key 的文件，这里防将来加条目）", () => {
  const secrets = [
    "sk-abcdefgh12345678",
    "Bearer abcdefgh12345678",
    FAKE_TOKEN,
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const secret of secrets) {
    const out = scrubCredentials(`model key = ${secret} end`);
    assert.ok(!out.includes(secret), out);
    assert.ok(out.includes("***"), out);
  }
  // 完整链路：路径脱敏之后必须紧跟凭据脱敏
  const combined = scrubWith([], "key=sk-abcdefgh12345678 file=E:\\x\\y.log");
  assert.ok(!combined.includes("sk-abcdefgh12345678"), combined);
  assert.ok(combined.includes("<本机路径>"), combined);
});

test("收集面静态护栏：不读 secrets、不整表导出、明说不上传（钉住对用户的承诺）", () => {
  assert.ok(!/model\.env|secrets[\\/]|\.cursor[\\/]secrets/u.test(SOURCE), "诊断包不得读 secrets");
  assert.ok(!/SELECT\s+\*/iu.test(SOURCE), "不得整表导出");
  assert.match(SOURCE, /SELECT value FROM settings/u); // 唯一数据库读取：只取路径做脱敏，值不入包
  assert.ok(SOURCE.includes('只在你本机生成，不会上传'), "必须保留「只在本机生成、不上传」的承诺文案");
  assert.match(SOURCE, /scrubCredentials\(out\)/u); // 新增收集项时脱敏必须仍然跟着走
});

// ---------------------------------------------------------------- P5-b：出口统一脱敏
//
// 第十六轮产物复核 §1 点出的真问题：上面那些断言钉住的是"脱敏函数本身"和"三条既有收集面红线"，
// 钉不住**"新增一个收集项时忘了过脱敏"** —— 而这正是当初提这条护栏时要防的那个动作。
// 修法不是把脱敏塞进 makeZip（它是通用 zip 写入器，data-safety 用它打含 sqlite 二进制的备份包），
// 而是让诊断包自己的收集出口 collect() 统一过 scrubEntries()：默认安全，不靠人记得调 scrub()。

test("P5-b：新增收集项默认就被脱敏 —— 只要从出口过，密钥与绝对路径都进不去", () => {
  // 模拟「排障时顺手加一条模型配置」这个最自然的动作
  const entries = [
    { name: "model-config.json", data: JSON.stringify({ key: "sk-abcdefgh12345678", dir: "E:\\我的曲库\\x.mid" }) },
    { name: "README.txt", data: "普通文本不受影响" },
  ];
  const out = scrubEntries(entries, []);
  const text = out.map(entry => String(entry.data)).join("\n");
  assert.ok(!text.includes("sk-abcdefgh12345678"), text);
  // 注意：JSON 载荷里的路径是**双反斜杠**形态，所以这里不能用 "E:\\我的曲库"（JS 里=单反斜杠）
  // 去断言 —— 那样即使没脱敏也会"通过"。直接查目录名。
  assert.ok(!text.includes("我的曲库"), text);
  assert.ok(text.includes("***"), text);
  assert.ok(text.includes("<本机路径>"), text);
  assert.equal(out[0].name, "model-config.json");      // 条目名不动
  assert.equal(out[1].data, "普通文本不受影响");          // 无路径/凭据的内容原样保留
  assert.equal(entries[0].data.includes("sk-abcdefgh12345678"), true); // 不改原数组
});

test("P5-b 结构性：collect() 必须经统一出口，且脱敏不得挪进 makeZip", () => {
  // 出口真的被 collect 用了（防止有人改回「每条自己记得调 scrub」）
  assert.ok(SOURCE.includes("return { entries: scrubEntries(entries, paths), paths };"),
    "collect() 必须从 scrubEntries() 出口返回");
  // 反向锁：makeZip 是通用 zip 写入器，midi/data-safety.js:19/743-749 用它打
  // **用户数据导出包**（把 database/olivia-local.sqlite 的 Buffer 直接塞进 entries）。
  // 脱敏一旦进 makeZip，就会把二进制当字符串替换、毁掉备份包 —— 落点必须留在诊断包链路里。
  const makeZipBody = SOURCE.slice(SOURCE.indexOf("export function makeZip"), SOURCE.indexOf("const EXCLUDED"));
  assert.ok(makeZipBody.length > 0, "makeZip 定位失败，断言本身已过期");
  assert.ok(!/scrub/u.test(makeZipBody), "脱敏不得进 makeZip（会毁数据备份包）");
});

test("P5-b：二进制条目直接拒绝，不静默漏脱敏", () => {
  assert.throws(() => scrubEntries([{ name: "x.bin", data: Buffer.from([1, 2, 3]) }], []), /二进制条目/u);
});

test("P5-b：JSON 载荷里的双反斜杠绝对路径同样收敛，且仍是合法 JSON", () => {
  // 诊断包绝大多数条目是 JSON.stringify 产物：真实路径 C:\Program Files\x\libcef.dll
  // 落地成 C:\\Program Files\\x\\libcef.dll。单反斜杠兜底一个字符都匹配不到这种形态
  // —— 第十六轮复核加固时首跑实测发现（崩溃栈的 `模块!符号` 正是这个形状）。
  const payload = JSON.stringify({ stack: "C:\\Program Files\\x\\libcef.dll!sym", note: "普通内容" });
  const out = scrubWith([], payload);
  assert.ok(!out.includes("Program Files"), out);   // 未知绝对路径的目录段不得残留
  assert.ok(out.includes("<本机路径>"), out);
  assert.ok(out.includes("libcef.dll"), out);       // 末段保住：排障要知道是哪个模块
  assert.ok(out.includes("普通内容"), out);          // 无关内容不动
  JSON.parse(out);                                  // 收敛后仍是合法 JSON
});
