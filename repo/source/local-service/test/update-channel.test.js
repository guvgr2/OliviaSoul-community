// stable / beta 双通道更新（1.0.4）。
//
// 需求与真实痛点：
//   1. 不稳定功能只发测试版（GitHub 上用 prerelease 标记），用户自己选通道；通道存本机 settings，默认 stable。
//   2. stable 只认正式 Release；beta 额外接受 prerelease。
//   3. 降级方案：这台机器直连 github.com 的部分 IP 会被 SNI 阻断（gh CLI 也因此登录失败），
//      所以「检查更新失败」是常态 —— 必须给出明确提示 + 发布页链接，
//      绝不能让界面报错卡死，也绝不能假装成功（不许说「已经是最新版本」）。
//   4. 通道要可见（当前通道写在设置项旁边），切换后立刻生效。
//
// 本套件分三层：真实 HTTP（真服务 + 打桩的 GitHub）× 真实 UI（vm 里跑真 app.js）× 源码钉死。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createOliviaService } from "../server.js";
import { createTabNotices } from "../public/tab-notices.js";
import { createPatchLossNotice } from "../public/patch-loss-notice.js";
import { blockedFetchPorts } from "./fixtures/fetch-ports.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");
const serverSource = read("server.js");
const appSource = read("public/app.js");
const notesSource = read("public/update-notes.js");
const indexHtml = read("public/index.html");

const REPO = "example/project";
const CURRENT_TAG = "2008.2.7-linli.100";
const STABLE_TAG = "2008.2.7-linli.110";
const BETA_TAG = "2008.2.7-linli.112";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const installer = tag => ({
  id: 1, name: `OliviaSoul-${tag}-Setup.exe`, size: 4096,
  digest: `sha256:${"a".repeat(64)}`,
  browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/OliviaSoul-${tag}-Setup.exe`,
});
const release = (tag, { prerelease = false, draft = false, withAsset = true, body = "" } = {}) => ({
  tag_name: tag, draft, prerelease, body, name: `Olivia ${tag}`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  published_at: "2026-01-02T03:04:05Z",
  assets: withAsset ? [installer(tag)] : [],
});

/** 起一个真实服务；updateFetch 是打桩的 GitHub。open 里的实例由 makeRoot 统一收尾。 */
async function boot(root, open, { updateFetch, updateCurrentTag = CURRENT_TAG } = {}) {
  const service = await createOliviaService({
    root,
    dataDir: join(root, "data"),
    worker: false,
    runMemoryRefresh: false,
    delaySeconds: 300,
    updateDataRoot: join(root, "updates"),
    updateCurrentTag,
    updateRepository: REPO,
    updateFetch,
  });
  let address = await service.listen(0);
  while (blockedFetchPorts.has(address.port)) {
    await new Promise(resolve => service.server.close(resolve));
    address = await service.listen(0);
  }
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  async function request(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, body: await response.json() };
  }
  const instance = { service, base, request, async close() { await service.close(); } };
  open.push(instance);
  return instance;
}

/**
 * 建临时数据目录，并统一收尾：**先关服务、再删目录**。
 * 顺序反了会 EBUSY（sqlite 文件还被打开着），而且同一个数据目录上不能同时开两个服务（互相等锁）。
 */
async function makeRoot(t, label) {
  const root = await mkdtemp(join(tmpdir(), `olivia-update-${label}-`));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
  const open = [];
  t.after(async () => {
    for (const instance of [...open].reverse()) {
      try { await instance.close(); } catch { /* 测试里可能已经手动关过 */ }
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, open };
}

/** GitHub 打桩：/releases/latest 给正式版，/releases 列表给「最新在前」的完整列表。 */
function githubStub({ stable = release(STABLE_TAG), list = [release(BETA_TAG, { prerelease: true }), release(STABLE_TAG)], calls = [] } = {}) {
  return async url => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/releases/latest")) return Response.json(stable);
    if (target.includes("/releases?")) return Response.json(list);
    return new Response("not found", { status: 404 });
  };
}

// —— 1. 默认 stable ——

test("默认通道是 stable：只查正式 Release，prerelease 不算更新", async t => {
  const { root, open } = await makeRoot(t, "default");
  const calls = [];
  const { request } = await boot(root, open, { updateFetch: githubStub({ calls }) });

  const checked = await request("/admin/api/update");

  assert.equal(checked.status, 200);
  assert.equal(checked.body.data.channel, "stable", "没设置过通道时必须默认 stable");
  assert.equal(checked.body.data.degraded, false);
  assert.equal(checked.body.data.latestTag, STABLE_TAG, "stable 只能看到正式版");
  assert.equal(checked.body.data.updateAvailable, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/releases/latest"), `stable 必须用 /releases/latest，实际 ${calls[0]}`);
  assert.ok(!calls.some(url => url.includes("/releases?")), "stable 不得去读带 prerelease 的列表");
  assert.doesNotMatch(JSON.stringify(checked.body), /browser_download_url/u, "不得把直链原样漏给界面");
});

// —— 2. beta 接受 prerelease ——

test("beta 额外接受 prerelease：切通道后改用 /releases 列表并取到测试版", async t => {
  const { root, open } = await makeRoot(t, "beta");
  const calls = [];
  const { request } = await boot(root, open, { updateFetch: githubStub({ calls }) });

  const switched = await request("/admin/api/update/channel", {
    method: "POST", body: JSON.stringify({ channel: "beta" }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.data.channel, "beta");
  assert.equal(calls.length, 0, "切换通道本身不该访问 GitHub");

  const checked = await request("/admin/api/update");

  assert.equal(checked.body.data.channel, "beta");
  assert.equal(checked.body.data.latestTag, BETA_TAG, "beta 必须接受 prerelease");
  assert.equal(checked.body.data.updateAvailable, true);
  assert.ok(calls.some(url => url.includes("/releases?per_page=")), "beta 必须读 /releases 列表");
  assert.ok(!calls.some(url => url.endsWith("/releases/latest")), "beta 不该只看 latest");
});

test("beta 跳过没有安装包和草稿的条目，取有安装包的下一条", async t => {
  const { root, open } = await makeRoot(t, "beta-skip");
  const playlist = [
    release("2008.2.7-linli.114", { prerelease: true, withAsset: false }),   // 只有 Release，包还没传
    release("2008.2.7-linli.113", { prerelease: true, draft: true }),        // 草稿
    release(STABLE_TAG),
  ];
  const { request } = await boot(root, open, { updateFetch: githubStub({ list: playlist }) });

  await request("/admin/api/update/channel", { method: "POST", body: JSON.stringify({ channel: "beta" }) });
  const checked = await request("/admin/api/update");

  assert.equal(checked.body.data.latestTag, STABLE_TAG, "不能因为清单里前两条不可用就查不到更新");
  assert.equal(checked.body.data.updateAvailable, true);
});

// —— 3. 通道持久化 + 立刻生效 ——

test("通道存进本机 settings：重启服务后仍是 beta；非法通道被拒绝", async t => {
  const { root, open } = await makeRoot(t, "persist");
  const first = await boot(root, open, { updateFetch: githubStub({}) });
  const switched = await first.request("/admin/api/update/channel", {
    method: "POST", body: JSON.stringify({ channel: "beta" }),
  });
  assert.equal(switched.status, 200);
  await first.close();

  const second = await boot(root, open, { updateFetch: githubStub({}) });
  const afterRestart = await second.request("/admin/api/update");
  assert.equal(afterRestart.body.data.channel, "beta", "通道必须落盘（本机 settings），重启后还在");

  const invalid = await second.request("/admin/api/update/channel", {
    method: "POST", body: JSON.stringify({ channel: "nightly" }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.message, /stable|beta/u);
  assert.equal((await second.request("/admin/api/update")).body.data.channel, "beta", "非法值不得覆盖已保存的通道");

  const back = await second.request("/admin/api/update/channel", {
    method: "POST", body: JSON.stringify({ channel: "stable" }),
  });
  assert.equal(back.body.data.channel, "stable");
  await second.close();

  // 同一个数据目录上不能同时开两个服务实例（SQLite 会互相等锁），必须前一个关掉再开下一个。
  const calls = [];
  const third = await boot(root, open, { updateFetch: githubStub({ calls }) });
  await third.request("/admin/api/update");
  assert.ok(calls[0].endsWith("/releases/latest"), "切回 stable 后必须回到 /releases/latest");
});

// —— 4. 降级：连不上时给提示而不是报错卡死 ——

test("连不上更新服务：200 + degraded + 明确提示 + 发布页链接（不卡住、不假装成功）", async t => {
  const { root, open } = await makeRoot(t, "offline");
  const offline = () => { throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }); };
  const { request } = await boot(root, open, { updateFetch: offline });

  const started = Date.now();
  const checked = await request("/admin/api/update");
  const elapsed = Date.now() - started;

  assert.equal(checked.status, 200, "连不上 GitHub 不能变成 502 让界面报错");
  assert.ok(elapsed < 3000, `必须立刻返回降级结果，实际 ${elapsed}ms`);
  const data = checked.body.data;
  assert.equal(data.degraded, true);
  assert.equal(data.updateAvailable, false, "查不到更新时绝不能报「可更新」");
  assert.equal(data.latestTag, "", "不得编造版本号");
  assert.equal(data.channel, "stable");
  assert.equal(data.currentTag, CURRENT_TAG, "仍要告诉用户当前是什么版本");
  assert.match(data.message, /无法连接更新服务，可手动到发布页下载/u);
  assert.match(data.message, /fetch failed/u, "原因要留着，方便排障");
  assert.equal(data.releaseUrl, RELEASES_PAGE, "必须给出发布页链接，让用户手动下载");
  assert.equal(data.assetUrl, "");
  assert.equal(data.notes, "");
});

test("超时与 GitHub 报错同样走降级：都给原因 + 发布页链接，且不谎报「已是最新」", async t => {
  const { root, open } = await makeRoot(t, "offline-errors");
  const timeout = () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); };
  const failing = await boot(root, open, { updateFetch: timeout });
  const timedOut = await failing.request("/admin/api/update");
  await failing.close();

  assert.equal(timedOut.status, 200);
  assert.equal(timedOut.body.data.degraded, true);
  assert.match(timedOut.body.data.message, /无法连接更新服务，可手动到发布页下载/u);
  assert.match(timedOut.body.data.message, /请求超时/u);
  assert.equal(timedOut.body.data.releaseUrl, RELEASES_PAGE);

  const broken = await boot(root, open, { updateFetch: async () => new Response("boom", { status: 500 }) });
  const httpError = await broken.request("/admin/api/update");

  assert.equal(httpError.status, 200, "GitHub 5xx 也不能让界面报错卡死");
  assert.equal(httpError.body.data.degraded, true);
  assert.match(httpError.body.data.message, /检查更新失败/u);
  assert.match(httpError.body.data.message, /可手动到发布页下载/u);
  assert.match(httpError.body.data.message, /GitHub HTTP 500/u);
  assert.equal(httpError.body.data.releaseUrl, RELEASES_PAGE);
});

test("beta 下载也按通道走：点下载拿到的是测试版安装包", async t => {
  const { root, open } = await makeRoot(t, "beta-download");
  const payload = Buffer.from("beta-installer-bytes", "utf8");
  // 安装包必须自带可在下载后校验的 sha256（服务端会核对），所以摘要按真实字节算。
  const digest = createHash("sha256").update(payload).digest("hex");
  const betaRelease = release(BETA_TAG, { prerelease: true });
  betaRelease.assets[0] = { ...betaRelease.assets[0], size: payload.length, digest: `sha256:${digest}` };
  const downloads = [];
  const { request } = await boot(root, open, { updateFetch: async url => {
    const target = String(url);
    if (target.includes("/releases?")) return Response.json([betaRelease]);
    if (target.includes("/releases/latest")) return Response.json(release(STABLE_TAG));
    downloads.push(target);
    return new Response(payload);
  } });

  await request("/admin/api/update/channel", { method: "POST", body: JSON.stringify({ channel: "beta" }) });
  const started = await request("/admin/api/update/download", { method: "POST" });
  assert.equal(started.status, 200);
  let status;
  for (let index = 0; index < 200; index++) {
    status = await request("/admin/api/update/download/status");
    if (status.body.data.state === "completed" && !status.body.data.running) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.body.data.state, "completed", status.body.data.error);
  assert.equal(status.body.data.tag, BETA_TAG, "测试版通道下载的必须是测试版");
  assert.ok(downloads.some(url => url.includes(BETA_TAG)), `下载地址必须指向测试版，实际 ${downloads.join(", ")}`);
  assert.deepEqual(await readFile(status.body.data.path), payload);
});

// —— 5. 界面（vm 里跑真实 app.js）——

// 只隔离「下载进度面板」这一块（它有自己的套件），通道 / 降级逻辑仍然是真实 app.js。
const downloadUIPlaceholder = () => ({ refresh: async () => {}, setRelease() {}, start: async () => {} });
const OPTION_LABELS = Object.freeze({
  stable: "稳定版（只收正式 Release）",
  beta: "测试版（含 prerelease，可能不稳定）",
});

function uiFixture({ payload, channelReply } = {}) {
  const nodes = new Map();
  const requests = [];
  const node = selector => {
    const option = /^#updateChannel option\[value="(stable|beta)"\]$/u.exec(selector);
    if (option) {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: OPTION_LABELS[option[1]] });
      return nodes.get(selector);
    }
    if (!nodes.has(selector)) {
      const classes = new Set();
      const element = { hidden: true, disabled: false, value: selector === "#updateChannel" ? "stable" : "28111",
        textContent: "", className: "", dataset: {}, handlers: new Map(), style: {}, focus() {}, setAttribute() {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        addEventListener(type, handler) { this.handlers.set(type, handler); } };
      if (selector === "#updateFallbackUrl") element.textContent = RELEASES_PAGE;
      nodes.set(selector, element);
    }
    return nodes.get(selector);
  };
  const json = data => ({ ok: true, json: async () => ({ code: 0, message: "ok", data }) });
  const timers = new Map();
  let now = 0, nextTimer = 0;
  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: target, method: init.method ?? "GET", body });
    if (target.endsWith("/admin/api/update/channel")) return json(channelReply ?? { channel: body.channel, currentTag: CURRENT_TAG });
    if (target.endsWith("/admin/api/update")) return json(payload);
    if (target.includes("/admin/api/update/download/status")) {
      return json({ state: "idle", bytes: 0, totalBytes: 0, percent: 0, running: false, jobId: null, tag: null });
    }
    throw new Error(`No real HTTP requests in update-channel UI tests: ${target}`);
  };
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    location: { hash: "" },
    console, URL, AbortController,
    createUpdateDownloadUI: downloadUIPlaceholder, createTabNotices, createPatchLossNotice,
    fetch: fetchStub,
    requestAnimationFrame: callback => callback(),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {},
  });
  const bootstrap = appSource.lastIndexOf("Promise.all([refresh(), loadDesktopSettings()])");
  assert.ok(bootstrap > 0, "fixture must isolate admin startup from real services");
  vm.runInContext(appSource.slice(0, bootstrap).replace(/^import .*\r?\n/gmu, ""), context);
  const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
  return {
    node, requests, flush, context,
    render(data) { context.testUpdate = data; vm.runInContext("renderUpdateInformation(testUpdate)", context); },
    changeChannel() { return node("#updateChannel").handlers.get("change")({ target: node("#updateChannel") }); },
  };
}

test("界面：连不上更新服务时不回「已经是最新版本」，而是降级提示 + 发布页按钮", () => {
  const f = uiFixture();
  f.render({
    channel: "stable", degraded: true, currentTag: CURRENT_TAG, latestTag: "", updateAvailable: false,
    releaseUrl: RELEASES_PAGE, publishedAt: "", assetName: "", assetSize: 0, assetUrl: "", notes: "", releaseName: "",
    message: "无法连接更新服务，可手动到发布页下载（原因：fetch failed）",
  });

  const result = f.node("#updateResult").textContent;
  assert.match(result, /无法连接更新服务，可手动到发布页下载/u);
  assert.doesNotMatch(result, /已经是最新版本|高于 GitHub 公开版/u, "查不到更新时绝不能说已是最新");
  assert.equal(f.node("#downloadUpdate").hidden, true, "降级时不能给「下载安装包」");
  assert.equal(f.node("#updateFallback").hidden, false, "降级提示必须可见");
  assert.equal(f.node("#openReleasePage").hidden, false, "必须能打开发布页");
  assert.equal(f.node("#updateFallbackUrl").textContent, RELEASES_PAGE, "发布页链接要能看见、能复制");
  assert.match(f.node("#updateVersion").textContent, /当前 2008\.2\.7-linli\.100/u);
  assert.match(f.node("#updateVersion").textContent, /未能检查更新/u);
  assert.equal(f.node('.sideTab[data-tab="update"]').dataset.noticeKind, "fault", "页签要提示检查失败");
});

test("界面：能查到更新时按通道显示，降级提示收起；beta 通道写进「当前通道」", () => {
  const f = uiFixture();
  f.render({ channel: "beta", degraded: false, currentTag: CURRENT_TAG, latestTag: BETA_TAG, updateAvailable: true,
    releaseUrl: `${RELEASES_PAGE}/tag/${BETA_TAG}`, publishedAt: "2026-01-02T03:04:05Z",
    assetName: `OliviaSoul-${BETA_TAG}-Setup.exe`, assetSize: 4096, assetUrl: "https://github.com/x/y.exe",
    notes: "## 测试版\n- 不稳定功能", releaseName: "" });

  assert.equal(f.node("#updateChannel").value, "beta", "下拉框要停在当前通道上");
  assert.equal(f.node("#updateChannelHint").textContent, `当前通道：${OPTION_LABELS.beta}`);
  assert.equal(f.node("#updateFallback").hidden, true, "能查到更新就不该再显示降级提示");
  assert.equal(f.node("#downloadUpdate").hidden, false);
  assert.equal(f.node("#updateResult").textContent, "发现新版本，可以下载");
  assert.match(f.node("#updateVersion").textContent, /GitHub 最新 2008\.2\.7-linli\.112/u);
  assert.match(f.node("#updateVersion").textContent, /测试版/u);
  assert.equal(f.node('.sideTab[data-tab="update"]').dataset.noticeKind, "info");
});

test("界面：切换通道会存进本机 settings 并立刻按新通道重查（不用手动点「检查更新」）", async () => {
  const f = uiFixture({ payload: { channel: "beta", degraded: false, currentTag: CURRENT_TAG, latestTag: BETA_TAG,
    updateAvailable: true, releaseUrl: `${RELEASES_PAGE}/tag/${BETA_TAG}`, publishedAt: "", assetName: "", assetSize: 0,
    assetUrl: "https://github.com/x/y.exe", notes: "", releaseName: "" } });
  f.node("#updateChannel").value = "beta";
  await f.changeChannel();
  await f.flush();

  assert.equal(f.requests[0].url, "/admin/api/update/channel");
  assert.equal(f.requests[0].method, "POST");
  assert.deepEqual(f.requests[0].body, { channel: "beta" });
  const checkAfterSwitch = f.requests.slice(1).filter(request => request.url === "/admin/api/update");
  assert.ok(checkAfterSwitch.length >= 1, "切换后必须立刻按新通道重查一次");
  assert.equal(f.node("#updateChannelResult").textContent, `已切换到${OPTION_LABELS.beta}`);
  assert.equal(f.node("#updateChannel").value, "beta");
  assert.equal(f.node("#updateResult").textContent, "发现新版本，可以下载");
});

// —— 6. 源码钉死（防漂移）——

test("界面源码：通道选项写在下拉框里、切换后立刻重查、降级分支不谎报「已是最新」", () => {
  const select = /<select id="updateChannel"[\s\S]*?<\/select>/u.exec(indexHtml)?.[0] ?? "";
  assert.match(select, /<option value="stable" selected>稳定版/u, "默认必须是 stable（稳定版）");
  assert.match(select, /<option value="beta">测试版/u);
  assert.match(indexHtml, /id="updateChannelHint"[^>]*>当前通道：稳定版/u, "当前通道要写在设置项旁边");
  assert.match(indexHtml, /id="openReleasePage"/u, "降级出路要有个能直接打的发布页按钮");
  const fallbackBox = /<div id="updateFallback"[^>]*>/u.exec(indexHtml)?.[0] ?? "";
  assert.match(fallbackBox, /\bhidden\b/u, "没有降级时不该出现发布页兜底块");
  const repository = /const DEFAULT_UPDATE_REPOSITORY = "([^"]+)"/u.exec(serverSource)?.[1];
  assert.ok(repository, "读不到后端仓库常量");
  assert.ok(indexHtml.includes(`https://github.com/${repository}/releases`),
    "静态兜底发布页链接必须与后端仓库常量一致，否则离线时会指向错的仓库");

  const handlerAt = appSource.indexOf('$("#updateChannel").addEventListener("change"');
  assert.ok(handlerAt > 0, "缺少通道切换处理器");
  const handler = appSource.slice(handlerAt, handlerAt + 800);
  assert.match(handler, /\/admin\/api\/update\/channel/u);
  assert.match(handler, /await loadUpdate\(\)/u, "切换后必须立刻按新通道重查");

  const renderAt = appSource.indexOf("function renderUpdateInformation(data)");
  assert.ok(renderAt > 0);
  const renderBody = appSource.slice(renderAt, appSource.indexOf("\n}\n", renderAt));
  assert.match(renderBody, /data\.degraded === true/u, "渲染必须区分降级与正常");
  const degradedBranch = /#updateResult"\)\.textContent = degraded \? ([\s\S]*?)\n\s*: /u.exec(renderBody)?.[1] ?? "";
  assert.ok(degradedBranch, "降级结果必须是独立的三元分支");
  assert.doesNotMatch(degradedBranch, /最新版本|公开版/u);
  assert.match(degradedBranch, /data\.message/u);
  assert.ok(!/\.innerHTML\s*=/u.test(renderBody), "更新信息一律 textContent 渲染，不得 innerHTML");
});

test("更新说明面板源码：降级时同样说「未能检查更新」并给出发布页，不说已是最新", () => {
  const at = notesSource.indexOf("if (data.degraded === true) {");
  assert.ok(at > 0, "更新说明面板必须单独处理降级");
  const branch = notesSource.slice(at, notesSource.indexOf("return;", at));
  assert.doesNotMatch(branch, /已经是最新版本/u);
  assert.match(branch, /String\(data\.message/u);
  assert.match(branch, /发布页/u);
  assert.match(branch, /未能检查更新/u);
  assert.ok(!/\.innerHTML\s*=/u.test(notesSource), "更新说明一律 textContent 渲染");
});

test("服务端源码：更新检查不再 502，stable/beta 各走各的来源，通道落本机 settings", () => {
  const routeAt = serverSource.indexOf('path === "/admin/api/update")');
  assert.ok(routeAt > 0, "找不到 /admin/api/update 路由");
  const route = serverSource.slice(routeAt, routeAt + 1500);
  assert.match(route, /updateFailurePayload\(error, channel\)/u, "失败时必须走降级载荷");
  assert.doesNotMatch(route, /httpError\(502/u, "不得再抛 502 让界面报错");

  assert.match(serverSource, /const DEFAULT_UPDATE_CHANNEL = "stable";/u);
  assert.match(serverSource, /const UPDATE_CHANNEL_SETTING = "update_channel";/u);
  assert.match(serverSource, /const UPDATE_CHANNELS = Object\.freeze\(\["stable", "beta"\]\);/u);
  assert.match(serverSource, /releases\/latest/u, "stable 必须走正式版接口");
  assert.match(serverSource, /releases\?per_page=30/u, "beta 必须走列表接口才能看到 prerelease");
  assert.match(serverSource, /path === "\/admin\/api\/update\/channel"/u);
  assert.match(serverSource, /setSetting\(UPDATE_CHANNEL_SETTING, requested\)/u, "通道必须存进本机 settings");
  assert.match(serverSource, /draft !== true/u, "列表里必须显式排除草稿");
  assert.match(serverSource, /fetchLatestRelease\(signal, updateChannel\(\)\)/u,
    "下载也要跟着通道走，否则 beta 用户会下到正式版");
});
