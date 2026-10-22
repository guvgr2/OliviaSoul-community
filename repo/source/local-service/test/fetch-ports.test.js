// fetch 禁用端口 fixture 的自检（2026-10-20 第六轮复验 §6d）。
//
// 背景：手抄的 `blockedFetchPorts` 漏了 **6679**（Node 内嵌 82 条 / fixture 81 条），
// 本机动态端口 1024 起、顺序 +1 扫描 ⇒ `listen(0)` 迟早落到它身上，
// 报 `TypeError: fetch failed / bad port`，**产品毫无问题**，但门禁对
// relay-compatibility 是 Count=0 ⇒ 一次命中误拦一次发版。本轮压测已实测命中 1 次。
//
// 修法两层，这里两层都钉：
//   ① 名单补上 6679（快速路径）；
//   ② `portIsFetchable()` 运行时真 fetch 问 Node —— 名单再烂也只是多绕一圈。
//
// ★ 判据不依赖「手抄名单是对的」：第 3、4 条直接问运行时，名单只是被验的对象。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  blockedFetchPorts,
  listenOnFetchablePort,
  portIsFetchable,
  resetPortProbeCache,
} from "./support/fetch-ports.js";

test("★ 名单必须含 6679 —— 本轮实测命中、误拦发版的那个洞", () => {
  assert.ok(blockedFetchPorts.has(6679), "blockedFetchPorts 必须有 6679（放在 6669 与 6697 之间）");
});

test("★ 名单里每一条都必须在运行时真的不可用（挡幽灵条目）", async () => {
  // 若名单里混进一个其实能用的端口 ⇒ `listenOnFetchablePort` 会白白多绕一圈，
  // 更糟的是会掩盖「名单已经和 Node 脱节」这个事实。
  const ghosts = [];
  for (const port of blockedFetchPorts) {
    resetPortProbeCache();
    if (await portIsFetchable(port)) ghosts.push(port);
  }
  assert.deepEqual(ghosts, [], `这些端口在名单里但运行时其实可用（幽灵条目）：${ghosts.join(", ")}`);
});

test("★ portIsFetchable 直接问运行时：坏端口拒、好端口放", async () => {
  // 6679 就是本轮漏掉的那个；6697/10080 两份名单都有；6678/27149 是好端口。
  assert.equal(await portIsFetchable(6679), false, "6679 必须被拒（这是本轮实测命中的洞）");
  assert.equal(await portIsFetchable(6697), false, "6697 两份名单都有，必须被拒");
  assert.equal(await portIsFetchable(10080), false, "10080 两份名单都有，必须被拒");
  assert.equal(await portIsFetchable(6678), true, "6678 是好端口，必须放行（不能误伤）");
  assert.equal(await portIsFetchable(27149), true, "27149 是产品固定端口，必须放行（产品走它）");
  // fail-open：端口号本身不合法时不能把好端口毙掉
  for (const bad of [0, -1, 65536, 1.5, NaN, "6679", null, undefined]) {
    assert.equal(await portIsFetchable(bad), true, `非法端口 ${String(bad)} 必须 fail-open（返回 true）`);
  }
});

/** 假 service：只补「OS 分配端口」这一个真环境缺的绑定，函数本身全真。 */
function fakeService(ports) {
  const state = { calls: 0, closed: [] };
  const server = {
    address: () => null,
    close(cb) {
      state.closed.push(state.calls);
      if (cb) cb();
    },
  };
  const target = {
    server,
    listen(_port, _host) {
      const port = ports[Math.min(state.calls, ports.length - 1)];
      state.calls += 1;
      return Promise.resolve({ address: "127.0.0.1", family: "IPv4", port });
    },
  };
  return { target, state };
}

test("★ 运行时自保护：listen(0) 落到名单外的坏端口也必须重绑（§6d 的洞就是这么漏的）", async () => {
  resetPortProbeCache();
  // 6679 现在在名单里，所以这条同时覆盖「名单挡住」；真正验运行时自保护的是下一条。
  const { target, state } = fakeService([6679, 6679, 6678]);
  const address = await listenOnFetchablePort(target);
  assert.equal(address.port, 6678, "连撞两次 6679 后必须重绑到 6678");
  assert.equal(state.calls, 3, "应该 bind 了 3 次（6679 / 6679 / 6678）");
  assert.equal(state.closed.length, 2, "前两次必须关掉再重绑");
});

test("★ 运行时自保护的真判据：把端口从名单里删掉，也照样拦得住", async () => {
  // 这条是「名单降级成快速路径」的证明：即使 blockedFetchPorts 里**没有** 6679，
  // 运行时那次真 fetch 也必须把它毙掉。若谁把 portIsFetchable 那道闸删了，这条必红。
  resetPortProbeCache();
  const removed = blockedFetchPorts.delete(6679);
  assert.ok(removed, "（前提）临时把 6679 从名单里删掉");
  try {
    const { target, state } = fakeService([6679, 6678]);
    const address = await listenOnFetchablePort(target);
    assert.equal(address.port, 6678, "名单里没有 6679，也必须靠运行时拦住并重绑");
    assert.equal(state.calls, 2, "bind 两次：第一次 6679 被毙，第二次 6678 放行");
    assert.equal(state.closed.length, 1, "第一次必须关掉");
  } finally {
    blockedFetchPorts.add(6679); // 用完立刻还原，别把变异留给后面的用例
  }
});

test("阴性对照：好端口必须一次就放行（不能无故多绕）", async () => {
  resetPortProbeCache();
  const { target, state } = fakeService([6678, 6679]);
  const address = await listenOnFetchablePort(target);
  assert.equal(address.port, 6678);
  assert.equal(state.calls, 1, "好端口不该触发重绑");
  assert.equal(state.closed.length, 0, "好端口不该被关掉");
});

test("★ 探针不许碰到 127.0.0.1 上真实监听的服务（真起服务，不是合成片段）", async () => {
  // 这条钉的是「探针地址必须是 127.0.0.2」这个设计约束。
  // 为什么重要：`listenOnFetchablePort` 是给**测试自己刚绑好的服务**用的，
  //   若探针打 127.0.0.1，等于每次 bind 都往服务上多送一个 HTTP 请求 ——
  //   会污染「请求计数 / 请求顺序 / 服务日志」这类断言，慢响应还会拖长 bind。
  // 合成语境观测不到（假 service 没真监听，两种地址都是 ECONNREFUSED）⇒ 必须真起服务。
  resetPortProbeCache();
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    assert.equal(await portIsFetchable(port), true, "真有服务在听的端口必须判为可用");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hits, 0, "探针地址必须是 127.0.0.2 —— 不许打到 127.0.0.1 上真实监听的服务");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
