// midi/secure-secret.js 的直接断言（2026-10-19 数据安全审计新增）。
//
// 为什么单独一个文件而不是塞进 model-config 的测试：落盘加密是**独立的密码学边界**，
// 它的失败模式（前缀判断错、把密文当明文用、静默退回明文）与「配置读写」不是一类问题。
// 这里只测这个模块本身；「写盘后磁盘上没有明文」由 test/model-config.test.js 端到端守。
//
// ⚠️ 夹具刻意**不写成 `sk-` 开头的假 Key**：2026-10-19 本机杀软把含有这种形态字符串的
//    测试文件直接删掉过（`test/relay-compatibility.test.js` 与这个文件都被删过一次），
//    删掉之后表现出来的是「测试跑少了」，而不是任何报错 —— 极难发现。断言本身与 Key 的形态无关。
import test from "node:test";
import assert from "node:assert/strict";
import {
  REVEAL_CACHE_LIMIT,
  SECRET_PREFIX,
  isEncrypted,
  powerShellInvokeCount,
  protectSecret,
  resetSecretCaches,
  revealSecret,
  secretBackendStatus,
} from "../midi/secure-secret.js";

test("加密后的串带 dpapi-v1 前缀，且不含明文", async () => {
  const plain = "olivia-round-trip-abcdef";
  const sealed = await protectSecret(plain);
  assert.ok(sealed.startsWith(SECRET_PREFIX), `落盘必须带版本前缀，实际=${sealed.slice(0, 16)}…`);
  assert.equal(sealed.includes(plain), false, "密文里不能出现明文片段");
  assert.equal(isEncrypted(sealed), true);
  assert.equal(isEncrypted(plain), false);
});

test("加密再解密能还原（同一个 Windows 账户，含中文与控制字符）", async () => {
  // 这条是 2026-10-19 实测抓到的编码 bug 的回归：PowerShell 控制台按 OEM 代码页解 stdin，
  // 中文会被拆成 `往�?`。改成全程原始字节之后才通。
  const plain = "olivia-往返-中文也要能过-\u0001no-newline";
  const sealed = await protectSecret(plain);
  assert.equal(await revealSecret(sealed), plain);
});

test("不带前缀的值原样返回（兼容老版本的明文配置）", async () => {
  assert.equal(await revealSecret("olivia-legacy-plain"), "olivia-legacy-plain");
});

test("空值不进 DPAPI，直接回空串", async () => {
  assert.equal(await protectSecret(""), "");
  assert.equal(await revealSecret(""), "");
});

test("两次加密同一串得到不同密文，但都能解回原文", async () => {
  const plain = "olivia-same-input";
  const a = await protectSecret(plain);
  const b = await protectSecret(plain);
  assert.notEqual(a, b, "DPAPI 每次都带随机量，密文不该相同（相同说明它压根没加密）");
  assert.equal(await revealSecret(a), plain);
  assert.equal(await revealSecret(b), plain);
});

test("解不开的密文要抛错，不能把乱码当明文返回", async () => {
  const alien = `${SECRET_PREFIX}${Buffer.from("not-a-dpapi-blob").toString("base64")}`;
  await assert.rejects(() => revealSecret(alien), /DPAPI|解密|Unprotect/u);
});

test("并发解同一份密文只起一个 PowerShell（缓存 + 串行队列真的生效）", async () => {
  // ★ 2026-10-19 第四轮审查 N3：这条原来判「6 路并发在 60s 内跑完」—— **把缓存删掉它也绿**
  //   （实测全 miss 也只要 3.4s）。判据改成**数这一进程里起了几个 powershell**：
  //   与机器负载无关，且缓存/队列任一失效都会立刻变红。
  const plain = "olivia-concurrent";
  const sealed = await protectSecret(plain);
  const before = powerShellInvokeCount();
  const results = await Promise.all(Array.from({ length: 6 }, () => revealSecret(sealed)));
  assert.deepEqual(results, Array(6).fill(plain), "6 路都要拿到正确明文");
  assert.equal(
    powerShellInvokeCount() - before,
    1,
    "同一份密文并发 6 次只该起 1 个 PowerShell；多出来就说明缓存没兜住并发（或者队列没了）",
  );
  // 再来一次必须纯命中缓存：一个进程都不起。
  const beforeSecond = powerShellInvokeCount();
  assert.equal(await revealSecret(sealed), plain);
  assert.equal(powerShellInvokeCount() - beforeSecond, 0, "第二次必须命中缓存");
});

test("revealCache 有上限：老密文会被挤掉（明文不会无限常驻内存）", async () => {
  // 同上轮 N6：每次保存都产生一份新密文 ⇒ 一条新缓存。规模很小，但「明文 + 无上限」
  // 这两件事放一起要收口。判据同样**数进程**，不看内存。
  resetSecretCaches();
  const oldest = await protectSecret("olivia-evict-oldest");
  await revealSecret(oldest);
  const hitBefore = powerShellInvokeCount();
  await revealSecret(oldest);
  assert.equal(powerShellInvokeCount() - hitBefore, 0, "刚解过的必须命中缓存");
  // 再解 REVEAL_CACHE_LIMIT 份**不同**的密文，把最老那条挤出去。
  for (let i = 0; i < REVEAL_CACHE_LIMIT; i += 1) {
    await revealSecret(await protectSecret(`olivia-evict-${i}`));
  }
  const before = powerShellInvokeCount();
  await revealSecret(oldest);
  assert.equal(
    powerShellInvokeCount() - before,
    1,
    "最老那条被挤掉后应该重新起一个进程 —— 若这里是 0，说明缓存根本没有上限",
  );
});

test("本机 DPAPI 后端可用（不可用时界面就无法保存 Key，必须显式知道）", async () => {
  const status = await secretBackendStatus();
  assert.equal(status.ok, true, `DPAPI 不可用：${status.reason}`);
});
