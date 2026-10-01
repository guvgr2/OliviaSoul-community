// 补丁失效即时提醒（1.0.5）—— 游戏更新覆盖补丁后主动告知。
//
// 真实故障：Steam / 官方更新游戏会把 feapp.dat（有时还有 webplayer.dat）覆盖回原版，补丁就没了，
// 游戏连不上本机服务（界面补丁不显示、歌词与续播不生效）。而界面上唯一的提示只是「客户端与桌面」
// 页签上的角标 —— 用户没有任何理由去点它，于是只会觉得「程序坏了」。
//
// 本套件钉死四类行为（任务书第 2 节）：
//   ① 上次已挂载、这次 feappMounted / webplayerMounted 变 false → 提醒一次；
//   ② 无变化（仍然挂载）→ 不提醒；
//   ③ 首次安装（之前也没挂载）→ 不提醒；
//   ④ 同一状态只提醒一次：用户关掉后不重复、重启后不重复；状态再次变化才再提醒。
// 另钉死：提醒复用既有通知（openNotice）与既有「重打补丁」入口、不阻塞启动、出错只记日志、
// 界面层不碰 server.js 既有契约。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createOliviaService } from "../server.js";
import { createPatchLossNotice, lostPatchKinds } from "../public/patch-loss-notice.js";
import { createTabNotices } from "../public/tab-notices.js";
import { createUpdateDownloadUI } from "../public/update-download-ui.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");
const appSource = read("public/app.js");
const KNOWN_KEY = "olivia.client-mount-known.v1";

const clientExe = "C:\\Games\\OliviaSoul\\FeApp.exe";
const mounted = { clientSelected: true, clientFound: true, webplayerFound: true, clientExe,
  mounted: true, feappMounted: true, webplayerMounted: true, port: 28111, servicePort: 28111 };
// 被更新覆盖：整份补丁都没了
const stopped = { ...mounted, mounted: false, feappMounted: false, webplayerMounted: false, port: null };
const lostFeapp = { ...mounted, mounted: false, feappMounted: false, port: null };
const lostWebplayer = { ...mounted, mounted: false, webplayerMounted: false, port: null };
const noClient = { ...stopped, clientSelected: false, clientExe: "" };

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

/** 一次「打开程序」：同一个本地存储 + 新的观察器实例（真实里就是重启程序）。 */
function session(storage, { record = null, log = () => {} } = {}) {
  const notices = [];
  const notice = createPatchLossNotice({ storage, log, notify: payload => notices.push(payload) });
  if (record) assert.equal(notice.observe(record).notified, false, "记录已知状态不该提醒");
  return { notice, notices };
}

// —— 行为层：直接测提醒器本体 ——

test("行为③：首次安装（之前也没挂载、现在也没挂载）→ 不提醒", () => {
  const storage = memoryStorage();
  const first = session(storage);
  assert.equal(first.notice.observe(stopped).reason, "first-run");
  assert.deepEqual(first.notices, [], "第一次打开程序不该被「补丁失效」吓到");

  const second = session(storage);
  const result = second.notice.observe(stopped);
  assert.equal(result.notified, false);
  assert.equal(result.reason, "unchanged");
  assert.deepEqual(second.notices, []);
});

test("行为②：状态没变化（仍然挂载）→ 不提醒", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  assert.equal(next.notice.observe(mounted).reason, "mounted");
  assert.deepEqual(next.notices, []);
});

test("行为①：上次已挂载、这次 FE 补丁没了 → 提醒一次（靠本地存储跨重启记住）", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  const result = next.notice.observe(lostFeapp);

  assert.equal(result.notified, true);
  assert.deepEqual(result.lost, ["feapp"]);
  assert.equal(next.notices.length, 1);
  assert.deepEqual(next.notices[0].lost, ["feapp"], "要说清是哪一边的补丁没了");
  assert.equal(next.notices[0].previous.mounted, true);
  assert.equal(next.notices[0].current.mounted, false);
});

test("行为①：WP 失效、以及两边同时失效，都能发现且说清是谁", () => {
  const wp = memoryStorage();
  session(wp, { record: mounted });
  const next = session(wp);
  assert.deepEqual(next.notice.observe(lostWebplayer).lost, ["webplayer"]);
  assert.deepEqual(next.notices[0].lost, ["webplayer"]);

  const both = memoryStorage();
  session(both, { record: mounted });
  const after = session(both);
  assert.deepEqual(after.notice.observe(stopped).lost, ["feapp", "webplayer"]);
  assert.equal(after.notices.length, 1, "两边一起失效也只提醒一次");
});

test("行为④：同一失效状态只提醒一次 —— 关掉后不重复，重启后也不重复", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  assert.equal(next.notice.observe(lostFeapp).notified, true);

  const again = next.notice.observe(lostFeapp);
  assert.equal(again.notified, false, "用户关掉提醒后再刷新状态，不得重复弹");
  assert.equal(again.reason, "unchanged");
  assert.equal(next.notices.length, 1);

  const restarted = session(storage);
  assert.equal(restarted.notice.observe(lostFeapp).notified, false, "重启程序也不该重复提醒同一状态");
  assert.deepEqual(restarted.notices, []);
});

test("行为④：状态再次变化（重打补丁后又失效）→ 会再提醒一次", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  assert.equal(next.notice.observe(lostFeapp).notified, true);

  assert.equal(next.notice.observe(mounted).reason, "mounted", "用户重打补丁：状态恢复");
  assert.equal(next.notice.observe(lostFeapp).notified, true, "再次被覆盖时必须再提醒");
  assert.equal(next.notices.length, 2);
});

test("用户自己点的「停用服务 / 回退补丁」造成的变化 → 不提醒", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  const result = next.notice.observe(stopped, { expectedChange: true });

  assert.equal(result.notified, false);
  assert.equal(result.reason, "expected");
  assert.deepEqual(next.notices, [], "主动还原原版之后反而收到「补丁失效」就是在吓人");
  // 状态已记录：之后同样的状态刷新也不会补一次提醒
  assert.equal(next.notice.observe(stopped).reason, "unchanged");
  assert.deepEqual(next.notices, []);
});

test("换了游戏客户端（另一份游戏目录）→ 不算补丁失效", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const next = session(storage);
  const result = next.notice.observe({ ...stopped, clientExe: "D:\\Other\\OliviaSoul\\FeApp.exe" });

  assert.equal(result.notified, false);
  assert.deepEqual(next.notices, []);
});

test("还没选游戏客户端 → 不提醒，也不记状态（否则选完客户端会被误判成失效）", () => {
  const storage = memoryStorage();
  const { notice, notices } = session(storage);
  assert.equal(notice.observe(noClient).reason, "no-client");
  assert.deepEqual(notices, []);
  assert.equal(storage.data.size, 0);
});

test("判断规则（纯函数）：只有「上次确实挂载过」才算失效", () => {
  assert.deepEqual(lostPatchKinds(null, stopped), [], "没有上次记录 = 首次");
  assert.deepEqual(lostPatchKinds({ mounted: false, feappMounted: true }, stopped), [],
    "上次没挂载（旧版本残留的半截记录）不算失效");
  assert.deepEqual(lostPatchKinds({ mounted: true, feappMounted: true, webplayerMounted: true }, stopped),
    ["feapp", "webplayer"]);
  assert.deepEqual(lostPatchKinds({ mounted: true, feappMounted: true, webplayerMounted: true },
    { clientExe, mounted: false, feappMounted: true, webplayerMounted: false }),
  ["webplayer"], "只报真正失效的那一边");
});

test("不阻塞：notify 弹窗未关闭时 observe 也立刻返回（不 await 弹窗）", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  let pending = null;
  const notice = createPatchLossNotice({ storage,
    notify: () => { pending = new Promise(() => {}); return pending; } });

  const result = notice.observe(lostFeapp);
  assert.equal(result.notified, true);
  assert.ok(pending, "提醒应该已经发起");
});

test("本地存储不可用：不抛错、退回进程内记忆、本次会话仍只提醒一次", () => {
  const broken = { getItem() { throw new Error("storage disabled"); },
    setItem() { throw new Error("storage disabled"); } };
  const first = createPatchLossNotice({ storage: broken });
  assert.equal(first.observe(mounted).notified, false);
  assert.equal(first.observe(lostFeapp).notified, true, "同一实例内记得上次状态，仍能发现失效");
  assert.equal(first.observe(lostFeapp).reason, "unchanged", "已记录成「未挂载」，不会重复提醒");
});

test("防御：已知状态仍写着 mounted=true 且已提醒过同一状态 → 不重复提醒", () => {
  // 正常路径由「已知状态」自己兜住去重；这条是兜底：万一只写进了「已提醒」标记
  // （例如旧版本残留、或写记录失败），同一失效状态也不许再弹一次。
  const storage = memoryStorage({
    [KNOWN_KEY]: JSON.stringify({ clientExe, mounted: true, feappMounted: true, webplayerMounted: true }),
    "olivia.client-mount-notified.v1": "feapp",
  });
  const { notice, notices } = session(storage);
  assert.equal(notice.observe(lostFeapp).reason, "already-notified");
  assert.deepEqual(notices, []);
});

test("本地存储内容损坏（非法 JSON / 数组）→ 当首次处理，不提醒也不崩", () => {
  const broken = memoryStorage({ [KNOWN_KEY]: "{not json" });
  const { notice, notices } = session(broken);
  assert.equal(notice.observe(lostFeapp).reason, "first-run");
  assert.deepEqual(notices, []);

  const array = memoryStorage({ [KNOWN_KEY]: "[1,2,3]" });
  assert.equal(createPatchLossNotice({ storage: array }).observe(lostFeapp).reason, "first-run");
});

test("提醒本身出错（弹窗层炸了）→ 只记日志、不抛给界面，也不会无限重试", () => {
  const storage = memoryStorage();
  session(storage, { record: mounted });
  const logged = [];
  const notices = [];
  const notice = createPatchLossNotice({ storage, log: error => logged.push(error),
    notify: payload => { notices.push(payload); throw new Error("notice layer exploded"); } });

  const result = notice.observe(lostFeapp);
  assert.equal(result.notified, false);
  assert.equal(result.reason, "error");
  assert.equal(logged.length, 1, "出错只记日志");
  assert.match(String(logged[0].message), /notice layer exploded/u);
  assert.equal(notice.observe(lostFeapp).reason, "unchanged", "不该反复重试弹窗");
  assert.equal(notices.length, 1);
});

// —— 界面层：跑真实的 public/app.js ——

/**
 * 跑真实 app.js（只砍掉末尾的页面启动请求），带上可用的 localStorage 与桌面桥接，
 * 这样「启动时会不会提醒」是实测出来的，而不是读源码猜的。
 */
function fixture({ status = stopped, storage = null, ...bridge } = {}) {
  const nodes = new Map();
  const clicks = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { hidden: true, disabled: false, checked: false, value: "", textContent: "",
        className: "", dataset: {}, handlers: new Map(), style: {}, focus() {}, setAttribute() {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        addEventListener(type, handler) { this.handlers.set(type, handler); },
        click() { clicks.set(selector, (clicks.get(selector) ?? 0) + 1); this.handlers.get("click")?.({ target: this }); } });
    }
    return nodes.get(selector);
  };
  const local = storage ?? memoryStorage();
  const calls = [];
  const implementations = { getSettings: async () => ({ autoStart: false, port: 28111 }),
    getClientStatus: async () => status, mountClient: async () => status,
    restoreClient: async () => status, selectClient: async () => status, ...bridge };
  const oliviaDesktop = {};
  for (const [name, implementation] of Object.entries(implementations))
    oliviaDesktop[name] = (...args) => { calls.push(name); return implementation(...args); };
  const context = vm.createContext({
    window: { addEventListener() {}, oliviaDesktop, localStorage: local },
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    location: { hash: "" },
    console, URL, AbortController, createUpdateDownloadUI, createTabNotices, createPatchLossNotice,
    fetch: () => { throw new Error("No real HTTP requests in client UI tests"); },
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  const bootstrap = appSource.lastIndexOf("Promise.all([refresh(), loadDesktopSettings()])");
  assert.ok(bootstrap > 0, "fixture must isolate admin startup from real services");
  vm.runInContext(appSource.slice(0, bootstrap).replace(/^import .*\r?\n/gmu, ""), context);
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  return {
    node, calls, local, flush,
    clicks: selector => clicks.get(selector) ?? 0,
    click: selector => node(selector).click(),
    render(value) { context.testStatus = value; vm.runInContext("renderClientMountStatus(testStatus)", context); },
    async load() { await vm.runInContext("loadDesktopSettings()", context); await flush(); },
  };
}

const knownMounted = () => memoryStorage({ [KNOWN_KEY]: JSON.stringify({ clientExe,
  mounted: true, feappMounted: true, webplayerMounted: true }) });

test("界面：程序启动时发现补丁被更新覆盖 → 用既有通知提醒一次，确认后切到「重打补丁」所在页签", async () => {
  const f = fixture({ status: lostFeapp, storage: knownMounted() });
  // 这里 await 得下来，本身就是「提醒不阻塞启动」的证据（弹窗开着不关也不卡住）。
  await f.load();

  assert.equal(f.node("#noticeLayer").hidden, false, "补丁被覆盖必须主动提醒，不能只在页签上留角标");
  assert.match(f.node("#noticeTitle").textContent, /补丁/u);
  const message = f.node("#noticeMessage").textContent;
  assert.match(message, /更新覆盖/u, "要说清为什么补丁没了");
  assert.match(message, /feapp\.dat/u, "要指名是哪个文件");
  assert.match(message, /连不上本机服务/u, "要说清后果，用户才知道为什么要管");
  assert.equal(f.node("#noticeConfirm").textContent, "去重打补丁", "复用既有「重打补丁」入口的说法");
  assert.equal(f.node("#noticeCancel").hidden, false, "必须能「稍后再说」");
  assert.equal(f.calls.filter(name => name === "mountClient").length, 0, "提醒绝不能偷偷替用户打补丁");
  assert.equal(f.node("#serviceMountStatus").textContent, "服务部分挂载", "角标/状态照旧渲染");

  f.click("#noticeConfirm");
  await f.flush();
  assert.equal(f.clicks('.sideTab[data-tab="desktop"]'), 1, "确认后切到「客户端与桌面」用现成按钮重打");
});

test("界面：首次安装（之前从未挂载）→ 启动不弹任何提醒", async () => {
  const f = fixture({ status: stopped });
  await f.load();

  assert.equal(f.node("#noticeLayer").hidden, true, "没打过补丁的用户不该被吓");
  assert.equal(f.node("#serviceMountStatus").textContent, "服务未挂载");
});

test("界面：用户关掉提醒后不再重复；后台再刷新同一状态也不弹", async () => {
  const f = fixture({ status: lostFeapp, storage: knownMounted() });
  await f.load();
  assert.equal(f.node("#noticeLayer").hidden, false);

  f.click("#noticeCancel");
  await f.flush();
  assert.equal(f.node("#noticeLayer").hidden, true, "「稍后再说」要能关掉");

  f.render(lostFeapp);
  assert.equal(f.node("#noticeLayer").hidden, true, "同一状态只提醒一次");
});

test("界面：用户主动「回退补丁（还原原版）」→ 不弹失效提醒（那是他自己退的）", async () => {
  const f = fixture({ status: mounted, storage: memoryStorage(),
    restoreClient: async () => stopped, getClientStatus: async () => stopped });
  await f.load();
  assert.equal(f.node("#noticeLayer").hidden, true);

  const completion = f.click("#rollbackPatch");
  await f.flush();
  f.click("#noticeConfirm");
  await completion;
  await f.flush();

  assert.match(f.node("#serviceMountResult").textContent, /已回退补丁/u);
  assert.equal(f.node("#noticeLayer").hidden, true, "主动回退之后不该被判成「补丁失效」");
});

test("界面：本地存储不可用不影响状态渲染（提醒只记日志，不报错、不卡启动）", async () => {
  const broken = { getItem() { throw new Error("storage disabled"); },
    setItem() { throw new Error("storage disabled"); } };
  const f = fixture({ status: mounted, storage: broken });
  await f.load();
  assert.equal(f.node("#serviceMountStatus").textContent, "服务已挂载");
  assert.equal(f.node("#noticeLayer").hidden, true);

  f.render(stopped);
  assert.equal(f.node("#noticeLayer").hidden, false, "同一实例内仍记得上次状态，能提醒");
});

// —— 源码防漂移 ——

test("源码：提醒接在状态渲染上、复用既有本地存储与既有通知，不新造弹窗体系", () => {
  assert.match(appSource, /import \{ createPatchLossNotice \} from '\.\/patch-loss-notice\.js';/u,
    "提醒逻辑必须放在可单独测试的模块里");
  assert.match(appSource, /const patchLossNotice = createPatchLossNotice\(\{\s*\n\s*storage: noticeStorage,/u,
    "复用既有本地存储机制（与 tab-notices 同一个），不新造一套");
  assert.match(appSource, /patchLossNotice\.observe\(status, \{ expectedChange \}\);/u,
    "必须在状态渲染后对比上次已知状态");
  assert.match(appSource, /void openNotice\(\{\s*\n\s*title: "游戏补丁已失效",/u, "复用既有通知样式");
  assert.match(appSource, /document\.querySelector\('\.sideTab\[data-tab="desktop"\]'\)\?\.click\(\)/u,
    "确认后走既有页签，不新造「重打补丁」入口");
  assert.doesNotMatch(appSource, /window\.confirm\(|\balert\(/u, "不得新造浏览器原生弹窗");
  assert.match(appSource, /renderClientMountStatus\(status, \{ expectedChange: true \}\)/u,
    "用户主动启停/回退造成的变化要标记为「预期变化」");
  assert.match(appSource, /async function loadDesktopSettings\(\)[\s\S]{0,300}?refreshClientMountStatus\(\)/u,
    "启动路径（loadDesktopSettings）必须触发对比");
});

test("源码：界面层不碰 server.js 既有契约，也不引入新依赖", () => {
  const module = read("public/patch-loss-notice.js");
  assert.doesNotMatch(module, /from ["']http|require\(/u, "前端模块不得引入依赖");
  assert.doesNotMatch(module, /document\.|window\./u, "判断逻辑与 DOM 解耦，才能单独测");
  for (const forbidden of ["/admin/api/", "fetch("])
    assert.ok(!module.includes(forbidden), `提醒模块不得直接打服务端接口（${forbidden}）`);
  const server = read("server.js");
  assert.match(server, /"\/admin\/api\/update"/u, "既有更新接口保持不变");
  assert.match(server, /const UPDATE_CHANNELS = Object\.freeze\(\["stable", "beta"\]\)/u,
    "1.0.4 的通道契约不受本任务影响");
});

// —— 真实服务：新模块必须真的能从 /admin/ 取到 ——
// 管理界面是按 ESM import 加载 app.js 的：这个文件取不到，整页（连既有角标和按钮一起）会直接白屏，
// 所以「能取到」得有真实 HTTP 断言，不能只看源码里写了 import。
test("真实服务：/admin/patch-loss-notice.js 取得到且不缓存，app.js 也引用了它", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-patch-loss-"));
  await mkdir(join(root, "信件往来"), { recursive: true });
  await mkdir(join(root, "信件往来_原始语料"), { recursive: true });
  const service = await createOliviaService({
    root,
    dataDir: join(root, "database"),
    worker: false,
    runMemoryRefresh: false,
    deferStorageRefresh: true,
  });
  t.after(async () => {
    await service.close(); // 必须先关服务再删目录（顺序反了 sqlite 会 EBUSY）
    await rm(root, { recursive: true, force: true });
  });
  const address = await service.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;

  const module = await fetch(`${base}/admin/patch-loss-notice.js`);
  assert.equal(module.status, 200, "取不到这个文件，整个管理界面会白屏");
  assert.equal(module.headers.get("cache-control"), "no-store");
  assert.match(await module.text(), /export function createPatchLossNotice/u);

  const page = await fetch(`${base}/admin/app.js`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /from '\.\/patch-loss-notice\.js';/u, "app.js 必须引用这个模块");
});
