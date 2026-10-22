// 来源闸门回归（2026-10-19 数据安全与个人信息审计）
//
// 这套件守的是本轮审计发现的那条**读泄露**：
//   旧实现只给写方法（POST/PUT/PATCH/DELETE）加来源校验，读接口完全不设防；
//   而 `corsHeaders()` 对 `/toy/*` 是**反射任意 Origin** 的。
//   ⇒ 用户在任意网站打开的页面，只要执行
//        fetch('http://127.0.0.1:27149/toy/letter/list')
//     浏览器就会把信件正文交给它（ACAO 反射回它的源，还带 Credentials）。
//   本机监听 127.0.0.1 挡不住这一条 —— 请求是用户自己的浏览器发出去的。
//
// 判据（与生产代码同一套，不另立标准）：
//   ① 没有 Origin / Referer（本机脚本、curl、node 测试、WebView 主进程、
//      `<video src>`/`<img>` 这类不带 Origin 的子资源请求）→ 放行；
//   ② 自身源 / 环回地址 / 游戏页面的源 → 放行；
//   ③ 其余（含 Origin: null）→ 403，且**响应里不带 ACAO**。
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOliviaService } from "../server.js";
import { cleanupDir } from "./lib/cleanup.mjs";
import { listenOnFetchablePort } from "./support/fetch-ports.js";

const EVIL = "https://evil.example";
const GAME = "https://olivia.local";

async function start() {
  const root = await mkdtemp(join(tmpdir(), "olivia-guard-"));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
  const service = await createOliviaService({
    root,
    dataDir: join(root, "data"),
    delaySeconds: 300,
    generator: async ({ content }) => `回信：${content}`,
    updateDataRoot: join(root, "updates"),
    worker: false,
  });
  const address = await listenOnFetchablePort(service);
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await service.close();
      await cleanupDir(root);
    },
  };
}

// 刻意用 node:http 而不是 fetch：undici 对 Origin 这类「禁止的头」有额外处理，
// 用它测来源闸门等于让被测对象以外的因素决定结果。
function call(base, path, { method = "GET", origin, host, headers = {}, body } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(host ? { Host: host } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("无 Origin 的读请求照旧放行（本机脚本 / node 测试 / <video> 子资源）", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list");
    assert.equal(res.status, 200, "没有 Origin 的读请求不该被闸门拦");
    assert.equal(JSON.parse(res.text).code, 0);
  } finally { await ctx.close(); }
});

test("恶意来源读信件列表：403，且响应里不能有 ACAO", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list", { origin: EVIL });
    assert.equal(res.status, 403, "外部站点的跨域读必须被拒");
    assert.equal(res.headers["access-control-allow-origin"], undefined,
      "被拒的响应不能再反射 Origin —— 否则这一道等于没加");
  } finally { await ctx.close(); }
});

test("恶意来源读用户信息与诊断/日志入口：同样 403", async () => {
  const ctx = await start();
  try {
    for (const path of ["/toy/getUserInfo", "/toy/letter/unread_count", "/toy/listen-naming/logs", "/toy/player-state"]) {
      const res = await call(ctx.base, path, { origin: EVIL });
      assert.equal(res.status, 403, `${path} 不该对任意来源开放读取`);
    }
  } finally { await ctx.close(); }
});

test("恶意来源读管理接口（含已保存的 API Key）：403", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/admin/api/model", { origin: EVIL });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  } finally { await ctx.close(); }
});

test("游戏页面自己的源仍然可用（否则游戏里加歌/读信会挂）", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list", { origin: GAME });
    assert.equal(res.status, 200, "被打过补丁的游戏页面跑在 https://olivia.local 上，必须放行");
    assert.equal(res.headers["access-control-allow-origin"], GAME, "放行时要把来源反射回去，浏览器才肯把响应交出来");
  } finally { await ctx.close(); }
});

test("环回来源（同机其它端口）仍然可用", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list", { origin: "http://127.0.0.1:59999" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:59999");
  } finally { await ctx.close(); }
});

test("Origin: null 视为不可信", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list", { origin: "null" });
    assert.equal(res.status, 403);
  } finally { await ctx.close(); }
});

test("预检请求不反射不可信来源（浏览器会因此拒发实际请求）", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list", {
      method: "OPTIONS",
      origin: EVIL,
      headers: { "Access-Control-Request-Method": "GET" },
    });
    // OPTIONS 本身照常 204（预检要能回来），**但绝不能带 ACAO** ——
    // 浏览器拿不到 ACAO 就会拒绝发出真正的 GET，这才是拦住跨域读的那一环。
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  } finally { await ctx.close(); }
});

test("写请求的旧契约不变：恶意来源 403、无来源放行", async () => {
  const ctx = await start();
  try {
    const denied = await call(ctx.base, "/toy/letter/send", {
      method: "POST",
      origin: EVIL,
      body: JSON.stringify({ content: "不该写进去" }),
    });
    assert.equal(denied.status, 403);
    const allowed = await call(ctx.base, "/toy/letter/send", {
      method: "POST",
      body: JSON.stringify({ content: "本机脚本发的信" }),
    });
    assert.equal(allowed.status, 200, "无来源的写请求（本机脚本）必须继续可用");
  } finally { await ctx.close(); }
});

test("管理界面静态文件不过闸门（避免误伤从外部链接点进来的导航）", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/admin/index.html", { origin: EVIL });
    assert.equal(res.status, 200, "静态资源不含用户数据，不该因为 Referer 是外部站点就 403 掉整个界面");
  } finally { await ctx.close(); }
});

test("DNS rebinding：Host 不是环回地址时一律拒绝（此时 Origin 校验会被绕过）", async () => {
  const ctx = await start();
  try {
    // rebinding 的形态：Host 与 Origin 都是攻击者域名，两边"同源" ⇒ 只靠 Origin 判不出来。
    const rebound = await call(ctx.base, "/toy/letter/list", {
      host: "evil.example:27149",
      origin: "http://evil.example:27149",
    });
    assert.equal(rebound.status, 403, "Host 指向外部域名时必须拒 —— 服务只监听 127.0.0.1");
    // 连"不发 Origin"的形态也要挡：rebinding 页面里的同源请求本来就不发 Origin。
    const noOrigin = await call(ctx.base, "/toy/letter/list", { host: "evil.example:27149" });
    assert.equal(noOrigin.status, 403);
    // 正常形态不能误伤。
    const normal = await call(ctx.base, "/toy/letter/list", { host: `127.0.0.1:${new URL(ctx.base).port}` });
    assert.equal(normal.status, 200);
  } finally { await ctx.close(); }
});

test("JSON 响应带 nosniff，不让浏览器猜 MIME", async () => {
  const ctx = await start();
  try {
    const res = await call(ctx.base, "/toy/letter/list");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  } finally { await ctx.close(); }
});
