import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const execute = promisify(execFile);

// Read only WinINET's explicit proxy configuration. Never change process-wide agents.
export async function readWindowsProxySettings() {
  if (process.platform !== 'win32') return { enabled: false };
  try {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=($p.ProxyEnable -eq 1);server=[string]$p.ProxyServer;pac=[string]$p.AutoConfigURL}|ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (error) {
    // 读不到代理配置 != 必须用代理：按"没配代理"处理，让直连去试。
    // 否则完全离线的机器、或安全软件拦了 powershell 的机器，一启动就弹"操作失败"。
    // 真正的网络错误仍会在直连时如实报出来。
    if (error?.status != null) throw new Error('无法读取 Windows 系统代理，请检查代理设置后重试');
    return { enabled: false, unreadable: true, reason: String(error?.code || error?.message || error) };
  }
}

export function selectSystemProxy(settings, target) {
  if (!settings?.enabled) {
    if (settings?.pac) throw new Error('更新暂不支持 PAC 自动代理，请在代理软件中启用系统 HTTP 代理');
    return null;
  }
  let server = String(settings.server ?? '').trim();
  if (server.includes('=')) {
    const entries = Object.fromEntries(server.split(';').filter(Boolean).map(part => {
      const i = part.indexOf('='); return [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
    }));
    server = entries[new URL(target).protocol.slice(0, -1)] ?? '';
  }
  try {
    if (!server || /\s/.test(server)) throw new Error();
    const proxy = new URL(server.includes('://') ? server : `http://${server}`);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/'
      || proxy.search || proxy.hash || proxy.username || proxy.password) throw new Error();
    return proxy.href;
  } catch { throw new Error('系统代理地址无效或不支持，请启用 HTTP/HTTPS 系统代理后重试'); }
}

function proxyRequest(url, init, proxy, redirects = 0) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major === 22 && minor >= 21 || major === 24 && minor >= 5 || major > 24))
    throw new Error('当前 Node.js 运行时不支持系统代理，请使用 OliviaSoul 随附的新版运行时');
  const transport = url.protocol === 'https:' ? https : http;
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('更新代理不支持此下载协议');
  const agent = new transport.Agent({ keepAlive: false,
    proxyEnv: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '' } });
  const headers = new Headers(init.headers);
  headers.set('Accept-Encoding', 'identity');
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent, signal: init.signal }, res => {
      res.once('close', () => agent.destroy());
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.destroy();
        try {
          const next = new URL(res.headers.location, url);
          if (redirects >= 5) throw new Error('更新代理重定向次数过多');
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('更新代理拒绝不安全的降级跳转');
          if (next.origin !== url.origin) { headers.delete('Authorization'); headers.delete('Cookie'); }
          resolve(proxyRequest(next, { ...init, headers }, proxy, redirects + 1));
        } catch (error) { reject(error); }
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const noBody = init.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      let body = res;
      const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[res.headers['content-encoding']];
      if (!noBody && decoder) {
        body = decoder(); res.on('error', error => body.destroy(error));
        body.once('close', () => res.destroy()); res.pipe(body);
        responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
      }
      try {
        resolve(new Response(noBody ? null : Readable.toWeb(body), { status: res.statusCode, headers: responseHeaders }));
        if (noBody) res.resume();
      } catch (error) { res.destroy(); reject(error); }
    });
    req.once('error', error => { agent.destroy(); reject(init.signal?.aborted ? init.signal.reason
      : new Error(`更新代理连接失败（${error.code || 'NETWORK_ERROR'}），请检查代理软件或节点后重试`)); });
    req.end();
  });
}

// —— 更新走哪条路：直连 / 系统代理 ——
//
// 2026-10-06 本机实测（1.1.1 更新失败排障）：
//   * api.github.com 直连可用；经代理也能通，但吃的是「未登录 60 次/小时、按出口 IP 共享」的配额，
//     撞满就是 403，body 写着 `API rate limit exceeded for <节点 IP>`（实测经代理 remaining=0，
//     同一请求直连 remaining=54）。
//   * github.com / *.githubusercontent.com（Release 资产与网页）直连被 SNI 阻断（实测读超时 /
//     fetch failed），必须走代理（实测经代理 Range 拿到 206，直连直接失败）。
// 所以「所有更新请求一律交给系统代理」在开着代理的机器上必然坏一半：检查更新 403、下载反而正常。
// 这里按主机分路 + 首选路失败就换另一条，并把「这台机器上哪条路通」记在内存里，之后不再试错。
//
// 两条边界照样守住（与上游一致，不许被换路绕过）：
//   1. 只有 GitHub 的公开更新端点允许换路；其他主机维持 fail-closed —— 系统代理开着就绝不偷偷直连。
//   2. 请求带凭据（Authorization / Cookie / Proxy-Authorization）时只有代理一条路，凭据绝不越过代理。
const FALLBACK_HOSTS = Object.freeze([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
]);
const RATE_LIMIT_STATUS = Object.freeze([403, 429]);

export function isUpdateFallbackHost(host) {
  const name = String(host ?? '').toLowerCase();
  return FALLBACK_HOSTS.some(allowed => name === allowed || name.endsWith(`.${allowed}`));
}

/** 返回探路顺序（第一条是首选）。remembered 是上次成功的路。 */
export function planUpdateRoutes({ host, proxy, remembered, credentials = false } = {}) {
  if (!proxy) return ['direct'];
  if (credentials) return ['proxy'];
  if (!isUpdateFallbackHost(host)) return ['proxy'];
  const preferred = remembered ?? (String(host).toLowerCase() === 'api.github.com' ? 'direct' : 'proxy');
  return preferred === 'direct' ? ['direct', 'proxy'] : ['proxy', 'direct'];
}

function hasCredentials(headers) {
  return ['authorization', 'cookie', 'proxy-authorization'].some(name => headers.has(name));
}

// 403/429 一律换路重试，但只有响应自己说了「rate limit」才敢对用户讲「接口限流」——
// 代理网关/安全软件也会回 403，那种得按原样报 `GitHub HTTP 403`，不能让用户去等配额恢复。
async function readRateLimitFacts(response) {
  let text = '';
  try { text = (await response.text()).slice(0, 600); } catch { text = ''; }
  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetAt = Number(response.headers.get('x-ratelimit-reset')) || 0;
  return { status: response.status, resetAt,
    rateLimited: response.status === 429 || remaining === '0' || /rate[-\s]?limit|too many requests/iu.test(text) };
}

function rateLimitError({ status, resetAt }) {
  const at = resetAt ? new Date(resetAt * 1000) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? `，约 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 后恢复` : '';
  const error = new Error(`${status === 429 ? 'GitHub 接口请求过于频繁' : 'GitHub 接口限流'}`
    + `（未登录时每个出口 IP 每小时 60 次，代理节点上的额度还是和其他人共用的）${when}；`
    + '可稍后重试、换一个代理节点，或直接到发布页手动下载');
  error.code = 'UPDATE_RATE_LIMITED';
  error.status = status;
  error.resetAt = resetAt;
  return error;
}

export function createUpdateFetch({ readProxySettings = readWindowsProxySettings, directFetch = fetch,
  attemptTimeoutMs = 12_000, planRoutes = planUpdateRoutes } = {}) {
  // 一个进程记一份：首次探路可能要白等一次超时，之后就按记住的路走。
  const remembered = new Map();
  return async (input, init = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(input);
    const proxy = selectSystemProxy(await readProxySettings(), url);
    init.signal?.throwIfAborted();
    if (!proxy) return directFetch(input, init);
    if (init.body || !['GET', 'HEAD'].includes(init.method ?? 'GET')) throw new Error('更新代理仅允许读取请求');
    const host = url.hostname.toLowerCase();
    const routes = planRoutes({ host, proxy, remembered: remembered.get(host),
      credentials: hasCredentials(new Headers(init.headers)) });
    let lastError = null, limited = null, refused = 0;
    for (const [index, route] of routes.entries()) {
      init.signal?.throwIfAborted();
      // 非最后一条路只给一小段预算：首选路被黑洞掉时要留时间试另一条，
      // 否则整次请求会被调用方的 30 秒上限吃掉，换路等于白做。
      const signal = index === routes.length - 1 || !attemptTimeoutMs ? init.signal
        : AbortSignal.any([init.signal, AbortSignal.timeout(attemptTimeoutMs)].filter(Boolean));
      try {
        const options = { ...init, ...(signal ? { signal } : {}) };
        const response = route === 'proxy' ? await proxyRequest(url, options, proxy) : await directFetch(input, options);
        if (!RATE_LIMIT_STATUS.includes(response.status)) { remembered.set(host, route); return response; }
        const facts = await readRateLimitFacts(response);
        if (facts.rateLimited) limited = facts; else refused = response.status;
      } catch (error) {
        if (init.signal?.aborted) throw error;
        lastError = error;
      }
    }
    if (limited) throw rateLimitError(limited);
    if (lastError) throw lastError;
    throw new Error(`GitHub HTTP ${refused || 'UNKNOWN'}`);
  };
}
