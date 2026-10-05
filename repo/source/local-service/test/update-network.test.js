import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateFetch, isUpdateFallbackHost, planUpdateRoutes, selectSystemProxy } from '../update-network.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const seen = [], via = [], sockets = new Set();
  const target = createServer((req, res) => {
    seen.push({ path: req.url, range: req.headers.range });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); }
    else if (req.url === '/stall') { res.writeHead(200); res.write('start'); }
    else { res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'application/octet-stream', ...(req.headers.range ? { 'Content-Range': 'bytes 2-5/6' } : {}) }); res.end(req.headers.range ? 'cdef' : 'abcdef'); }
  });
  const targetUrl = await listen(target);
  const proxy = createServer((req, res) => {
    via.push(req.url);
    const url = new URL(req.url);
    const outgoing = httpRequest(url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    }); outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
  });
  proxy.on('connect', (req, socket, head) => {
    via.push(req.url); const [host, port] = req.url.split(':');
    const upstream = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); sockets.add(socket);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { for (const socket of sockets) socket.destroy(); target.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve)))); });
  return { targetUrl, proxyUrl, seen, via };
}

test('system proxy formats select explicit HTTPS endpoint and fail closed for unsupported settings', () => {
  assert.equal(selectSystemProxy({ enabled: false }, 'https://github.com'), null);
  assert.equal(selectSystemProxy({ enabled: true, server: 'localhost:8123' }, 'https://github.com'), 'http://localhost:8123/');
  assert.equal(selectSystemProxy({ enabled: true, server: 'http=localhost:8123;https=localhost:8124' }, 'https://github.com'), 'http://localhost:8124/');
  assert.throws(() => selectSystemProxy({ enabled: true, server: 'socks=localhost:8123' }, 'https://github.com'), /代理/);
  assert.throws(() => selectSystemProxy({ enabled: false, pac: 'https://example.test/proxy.pac' }, 'https://github.com'), /PAC/);
  assert.throws(() => selectSystemProxy({ enabled: true, server: 'bad host/name' }, 'https://github.com'), /代理/);
});

test('only update requests use the proxy; redirect and Range remain correct', async t => {
  const f = await fixture(t); let directCalls = 0;
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }),
    directFetch: async () => { directCalls++; throw new Error('unexpected direct request'); } });
  const response = await update(f.targetUrl + '/redirect', { headers: { Range: 'bytes=2-' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), 'cdef');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/6');
  assert.equal(f.via.length, 2); assert.equal(directCalls, 0);
  assert.deepEqual(f.seen.map(item => item.range), ['bytes=2-', 'bytes=2-']);
  const normal = await fetch(f.targetUrl + '/file'); assert.equal(await normal.text(), 'abcdef');
  assert.equal(f.via.length, 2, 'ordinary model/media fetch must not inherit the update proxy');
});

test('proxy disabled next request returns to existing direct transport', async t => {
  const f = await fixture(t); let enabled = true, reads = 0;
  const update = createUpdateFetch({ readProxySettings: async () => { reads++; return { enabled, server: f.proxyUrl }; } });
  assert.equal(await (await update(f.targetUrl + '/file')).text(), 'abcdef');
  enabled = false; assert.equal(await (await update(f.targetUrl + '/file')).text(), 'abcdef');
  assert.equal(f.via.length, 1); assert.equal(reads, 2);
});

test('unavailable enabled proxy never falls back to direct', async t => {
  const f = await fixture(t); let direct = 0;
  const stopped = createServer(); const unused = await listen(stopped); await new Promise(resolve => stopped.close(resolve));
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: unused }),
    directFetch: async () => { direct++; return new Response('unsafe fallback'); } });
  await assert.rejects(update(f.targetUrl + '/file', { signal: AbortSignal.timeout(2000) }), /代理/);
  assert.equal(direct, 0); assert.equal(f.seen.length, 0);
});

// —— 更新分路（1.1.2）——
//
// 实测背景：api.github.com 直连能通、经代理吃共享配额（403），github.com 的资产直连被 SNI 阻断、
// 必须走代理。所以「所有更新请求一律走系统代理」必然坏一半。分路规则 + 边界都锁在这里。

test('分路规则：api 直连优先、资产代理优先；其他主机与带凭据请求保持 fail-closed', () => {
  const proxy = 'http://127.0.0.1:7890/';
  assert.deepEqual(planUpdateRoutes({ host: 'api.github.com', proxy }), ['direct', 'proxy']);
  assert.deepEqual(planUpdateRoutes({ host: 'github.com', proxy }), ['proxy', 'direct']);
  assert.deepEqual(planUpdateRoutes({ host: 'objects.githubusercontent.com', proxy }), ['proxy', 'direct']);
  // 记住上次成功的路：不再白等一次超时
  assert.deepEqual(planUpdateRoutes({ host: 'api.github.com', proxy, remembered: 'proxy' }), ['proxy', 'direct']);
  assert.deepEqual(planUpdateRoutes({ host: 'github.com', proxy, remembered: 'direct' }), ['direct', 'proxy']);
  // 边界 1：非 GitHub 公开端点绝不偷偷直连
  assert.deepEqual(planUpdateRoutes({ host: 'example.test', proxy }), ['proxy']);
  // 边界 2：带凭据的请求只有代理一条路
  assert.deepEqual(planUpdateRoutes({ host: 'api.github.com', proxy, credentials: true }), ['proxy']);
  // 没配代理 → 只有直连（与上游一致）
  assert.deepEqual(planUpdateRoutes({ host: 'api.github.com', proxy: null }), ['direct']);
  assert.equal(isUpdateFallbackHost('raw.githubusercontent.com'), true);
  assert.equal(isUpdateFallbackHost('api.github.com.evil.test'), false);
  assert.equal(isUpdateFallbackHost('evil-github.com'), false);
});

test('首选路被限流时换另一条路，并把通的那条记住', async t => {
  const f = await fixture(t); const plans = []; let direct = 0;
  const reset = Math.floor(Date.now() / 1000) + 600;
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }),
    planRoutes: ({ remembered }) => { plans.push(remembered); return remembered === 'proxy' ? ['proxy', 'direct'] : ['direct', 'proxy']; },
    directFetch: async () => { direct++; return new Response('{"message":"API rate limit exceeded for 183.179.43.252"}',
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }); },
  });
  const first = await update(f.targetUrl + '/releases/latest');
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'abcdef');
  assert.equal(direct, 1); assert.equal(f.via.length, 1, '直连被限流后必须换走代理');
  const second = await update(f.targetUrl + '/releases/latest');
  assert.equal(second.status, 200);
  assert.deepEqual(plans, [undefined, 'proxy'], '第二次必须直接用记住的代理，不再试直连');
  assert.equal(direct, 1, '记住之后不得再碰直连');
});

test('首选路被拖住时只等一小段预算，随后换另一条路成功', async t => {
  const f = await fixture(t);
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }), attemptTimeoutMs: 60,
    planRoutes: () => ['direct', 'proxy'],
    directFetch: (input, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });
  const started = Date.now();
  assert.equal(await (await update(f.targetUrl + '/file')).text(), 'abcdef');
  assert.ok(Date.now() - started < 3000, '首选路被黑洞掉时不许吃满整段预算');
  assert.equal(f.via.length, 1);
});

test('两条路都限流：报「限流 + 恢复时间」，不回退成假成功', async t => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const limited = createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    res.end('{"message":"API rate limit exceeded for 183.179.43.252"}');
  });
  const url = await listen(limited);
  t.after(() => new Promise(resolve => { limited.closeAllConnections(); limited.close(resolve); }));
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: url }),
    planRoutes: () => ['direct', 'proxy'],
    directFetch: async () => new Response('{"message":"API rate limit exceeded"}',
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }),
  });
  await assert.rejects(update(url + '/releases/latest'), error => {
    assert.equal(error.code, 'UPDATE_RATE_LIMITED');
    assert.equal(error.status, 403);
    assert.equal(error.resetAt, reset);
    assert.match(error.message, /限流/u);
    assert.match(error.message, /60 次/u);
    assert.match(error.message, /共用的/u);
    assert.match(error.message, /\d\d:\d\d/u, '要有恢复时间，用户才知道什么时候再来');
    return true;
  });
});

test('代理网关回的非限流 403：按原样报 GitHub HTTP 403，不误导用户等配额', async t => {
  const gateway = createServer((req, res) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Forbidden by gateway'); });
  const url = await listen(gateway);
  t.after(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: url }),
    planRoutes: () => ['direct', 'proxy'],
    directFetch: async () => new Response('Forbidden by gateway', { status: 403 }),
  });
  await assert.rejects(update(url + '/releases/latest'), error => {
    assert.equal(error.code, undefined);
    assert.match(error.message, /GitHub HTTP 403/u);
    assert.doesNotMatch(error.message, /限流/u);
    return true;
  });
});

test('带凭据的请求只有代理一条路：代理不通也绝不改走直连', async t => {
  const f = await fixture(t); let direct = 0;
  const stopped = createServer(); const unused = await listen(stopped); await new Promise(resolve => stopped.close(resolve));
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: unused }),
    planRoutes: ({ credentials }) => planUpdateRoutes({ host: 'api.github.com', proxy: 'http://127.0.0.1:1/', credentials }),
    directFetch: async () => { direct++; return new Response('unsafe fallback'); },
  });
  await assert.rejects(update(f.targetUrl + '/file', { headers: { Authorization: 'Bearer secret' }, signal: AbortSignal.timeout(2000) }),
    /代理/);
  assert.equal(direct, 0, '带凭据时系统代理就是边界，绝不能直连');
});

test('代理挂掉时 GitHub 公开端点改走直连（不再整条更新通道死掉）', async t => {
  let direct = 0;
  const stopped = createServer(); const unused = await listen(stopped); await new Promise(resolve => stopped.close(resolve));
  const update = createUpdateFetch({
    readProxySettings: async () => ({ enabled: true, server: unused }),
    planRoutes: ({ remembered }) => (remembered === 'direct' ? ['direct', 'proxy'] : ['proxy', 'direct']),
    directFetch: async () => { direct++; return new Response('asset-bytes'); },
  });
  assert.equal(await (await update('https://github.com/example/project/releases/download/t/f.exe')).text(), 'asset-bytes');
  assert.equal(direct, 1);
});

test('cancelling a proxied streaming response closes its request', async t => {
  const f = await fixture(t);
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }) });
  const controller = new AbortController();
  const response = await update(f.targetUrl + '/stall', { signal: controller.signal });
  const body = response.text(); await delay(10); controller.abort();
  await assert.rejects(body);
});
