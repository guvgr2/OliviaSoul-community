// 发布审计 · 真实 UI 冒烟（无头 Edge + Playwright）
// 范式对齐本仓 test/management-layout-browser.mjs：chromium.launch({channel:'msedge', headless:true})，
// 用 boundingBox()/scrollWidth 做几何量测（横向溢出 / 关键按钮越界 = 截断检测），并截图落盘供人工复核。
//
// 触发：必须 OLIVIA_BROWSER_UI=1，否则直接 SKIP（与仓库其它 browser 脚本一致）。
// 输入（环境变量）：
//   OLIVIA_UI_PUBLIC  —— 指向"真包解包后的 public 目录"（默认回退到仓库 source/public，用于本地干跑）。
//   OLIVIA_UI_SHOTS  —— 截图输出目录（默认 $svc/ui-shots）。
// 退出码：发现 UI 问题（横向溢出/越界/pageerror）则 exit 1 并打印 AUDIT_UI_FAIL；否则 AUDIT_UI_PASS。
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';

if (process.env.OLIVIA_BROWSER_UI !== '1') {
  console.log('SKIP audit-ui-smoke: 未设 OLIVIA_BROWSER_UI（真包 UI 冒烟开关）');
  process.exit(0);
}

const chromium = createRequire(import.meta.url)('playwright').chromium;
// OLIVIA_UI_PUBLIC 在真包场景由 PowerShell 传入 Windows 反斜杠绝对路径
// （如 C:\Users\xxx\AppData\Local\Temp\ui-pub-xxx\app\public）。直接
// new URL(winPath, import.meta.url) 会抛 Invalid URL，必须先用 pathToFileURL
// 转成 file:// 再当 base；相对路径则照旧用 import.meta.url 解析。
// ★ new URL('index.html', base) 会把 base 末段当"文件名"丢掉，所以目录型 base
//   必须以 / 结尾，否则会解析到父目录（app/index.html 而非 app/public/index.html）。
const pubEnv = process.env.OLIVIA_UI_PUBLIC;
let base = pubEnv
  ? (isAbsolute(pubEnv) ? pathToFileURL(pubEnv) : new URL(pubEnv, import.meta.url))
  : new URL('../public/', import.meta.url);
if (!base.pathname.endsWith('/')) base = new URL(base.href + '/');
const shotDir = process.env.OLIVIA_UI_SHOTS || new URL('../ui-shots/', import.meta.url).pathname;
mkdirSync(shotDir, { recursive: true });

const ctOf = (name) => {
  if (name.endsWith('.css')) return 'text/css';
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'text/javascript';
  if (name.endsWith('.html')) return 'text/html';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.woff2') || name.endsWith('.woff')) return 'font/woff2';
  return 'application/octet-stream';
};

console.log('UI base = ' + base.pathname + '  index.html 存在=' + existsSync(new URL('index.html', base)));

const issues = [];
const viewports = [
  { width: 1280, height: 800 },
  { width: 1000, height: 650 },
  { width: 760, height: 650 },
  { width: 480, height: 800 },
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: viewports[0] });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (/Failed to load resource|net::ERR|404 \(Not Found\)|ERR_/i.test(t)) return; // 资源 404 / 网络错误非 JS 异常，不计入失败
      errors.push('console:' + t);
    }
  });

  await page.addInitScript(() => {
    window.oliviaDesktop = {
      getLyricsFontInfo: async () => ({ fonts: ['Arial', 'Microsoft YaHei', '楷体'], defaultFont: '楷体' }),
    };
  });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') {
      try {
        const html = await readFile(new URL('index.html', base), 'utf8');
        return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      } catch (e) { console.log('UI route / 读 index.html 失败: ' + e); return route.fulfill({ status: 404, body: '' }); }
    }
    if (p.startsWith('/admin/api/')) {
      const body = JSON.stringify({ code: 0, data: { settings: { enabled: false, fontSize: 28 }, status: 'ok' } });
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    const rel = p.replace(/^\/+/, '');
    const file = new URL(rel, base);
    if (existsSync(file)) {
      try {
        const buf = await readFile(file);
        return route.fulfill({ status: 200, contentType: ctOf(rel), body: buf });
      } catch { /* fallthrough */ }
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto('http://audit.local/', { waitUntil: 'domcontentloaded' });
  // 等脚本执行、tab 渲染出来（最多 8s，超时也不致命，照样量测已有的 DOM）。
  await page.waitForFunction(() => document.querySelectorAll('.tabPage').length > 0, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.tabPage')].map((e) => ({ page: e.dataset.page || e.id || 'tab', id: e.id }))
  );
  console.log(`UI 发现 tabs: ${tabs.length} 个 (${tabs.map((t) => t.page).join(', ') || '无 .tabPage，仅测首屏'})`);

  let shotCount = 0;
  const tabsArr = tabs.length ? tabs : [{ page: 'root', id: '' }];
  const firstId = tabsArr[0].id || '';
  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    // 默认视图（natural）截图 + 溢出/越界检查
    const ov0 = await page.evaluate(() => {
      const de = document.documentElement;
      const c = document.querySelector('.content');
      return { docSW: de.scrollWidth, winW: window.innerWidth, contentSW: c ? c.scrollWidth : 0, contentCW: c ? c.clientWidth : 0 };
    });
    if (ov0.docSW > ov0.winW + 1) issues.push(`视口 ${vp.width}x${vp.height} default: 文档横向溢出 docSW=${ov0.docSW} > winW=${ov0.winW}`);
    if (ov0.contentSW > ov0.contentCW + 1) issues.push(`视口 ${vp.width}x${vp.height} default: .content 横向溢出 ${ov0.contentSW} > ${ov0.contentCW}`);
    for (const id of ['mountService', 'restoreClient']) {
      const box = await page.locator('#' + id).boundingBox().catch(() => null);
      if (box && (box.y < -1 || box.y + box.height > vp.height + 1)) issues.push(`视口 ${vp.width}x${vp.height} default: #${id} 超出视口 (y=${Math.round(box.y)}, h=${Math.round(box.height)})`);
    }
    const defName = `default-${vp.width}x${vp.height}.png`;
    try { await page.screenshot({ path: shotDir + '/' + defName }); shotCount++; } catch {}

    // 逐 tab 强制显隐，做溢出/越界检查（不重复截图，空壳同图无意义）
    for (const t of tabsArr) {
      if (!t.id) continue;
      await page.evaluate((id) => {
        document.querySelectorAll('.tabPage').forEach((e) => { e.style.display = (e.id === id) ? '' : 'none'; });
        const el = document.getElementById(id); if (el) { el.hidden = false; el.style.display = ''; }
        window.scrollTo(0, 0);
      }, t.id);
      await page.waitForTimeout(200);
      const ov = await page.evaluate(() => {
        const de = document.documentElement;
        const c = document.querySelector('.content');
        return { docSW: de.scrollWidth, winW: window.innerWidth, contentSW: c ? c.scrollWidth : 0, contentCW: c ? c.clientWidth : 0 };
      });
      if (ov.docSW > ov.winW + 1) issues.push(`视口 ${vp.width}x${vp.height} tab=${t.page}: 文档横向溢出 docSW=${ov.docSW} > winW=${ov.winW}`);
      if (ov.contentSW > ov.contentCW + 1) issues.push(`视口 ${vp.width}x${vp.height} tab=${t.page}: .content 横向溢出 ${ov.contentSW} > ${ov.contentCW}`);
      for (const id of ['mountService', 'restoreClient']) {
        const box = await page.locator('#' + id).boundingBox().catch(() => null);
        if (box && (box.y < -1 || box.y + box.height > vp.height + 1)) issues.push(`视口 ${vp.width}x${vp.height} tab=${t.page}: #${id} 超出视界 (y=${Math.round(box.y)}, h=${Math.round(box.height)})`);
      }
      await page.evaluate((fid) => { document.querySelectorAll('.tabPage').forEach((e) => { e.style.display = (e.id === fid) ? '' : 'none'; }); }, firstId);
    }
  }

  if (errors.length) issues.push('页面错误(' + errors.length + '): ' + errors.slice(0, 5).join(' | '));

  console.log(`UI 截图已存 ${shotDir}（${shotCount} 张）`);
  if (issues.length) {
    console.log(`UI 问题 (${issues.length}):`);
    issues.forEach((i) => console.log('  - ' + i));
    console.log('AUDIT_UI_FAIL');
    process.exitCode = 1;
  } else {
    console.log('AUDIT_UI_PASS 无横向溢出/越界，无页面错误');
  }
} catch (e) {
  console.log('UI 冒烟异常: ' + (e && e.stack ? e.stack : e));
  console.log('AUDIT_UI_FAIL');
  process.exitCode = 1;
} finally {
  await browser.close();
}
