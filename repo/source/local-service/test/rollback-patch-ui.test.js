// 回退补丁（还原原版）—— 补丁后的救援入口。
//
// 真实故障：补丁打歪之后游戏白屏 / 连不上，而界面上只有「启用服务 / 停用服务」两个词，
// 用户看不出哪个能「把游戏文件退回去」。本套件钉死三件事：
//   1. 按钮出现条件：只有游戏目录里确实存在本机补丁时才给回退入口（干净原版时不该出现）；
//   2. 二次确认：写清「会还原游戏文件 / 不会丢存档（存档在 UserData 里）」；
//   3. 走的是既有还原链路：界面只调 restoreClient（preload → ipc "client:restore" → main.js
//      → tools/restore-*-original.ps1），不新写还原逻辑，也不改走「重打补丁」那条路。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createUpdateDownloadUI } from "../public/update-download-ui.js";
import { createTabNotices } from "../public/tab-notices.js";
import { createPatchLossNotice } from "../public/patch-loss-notice.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = relative => readFileSync(join(here, "..", relative), "utf8");
const appSource = read("public/app.js");
const indexHtml = read("public/index.html");

const clean = { clientSelected: true, clientFound: true, webplayerFound: true, clientExe: "fixture.exe",
  mounted: false, feappMounted: false, webplayerMounted: false, port: null, servicePort: 28111 };
const patched = { ...clean, mounted: true, feappMounted: true, webplayerMounted: true, port: 28111 };
const onlyFeapp = { ...clean, feappMounted: true };
const onlyWebplayer = { ...clean, webplayerMounted: true };
const outdated = { ...clean, updateAvailable: true, feappRevision: "v58", webplayerRevision: "v19" };
const noClient = { clientSelected: false, clientExe: "", mounted: false, feappMounted: false,
  webplayerMounted: false, port: null, servicePort: 28111 };

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/**
 * 跑真实的 public/app.js（只砍掉末尾的页面启动请求），并把所有桥接调用记进 calls，
 * 这样「回退到底调了哪个入口」是可以断言的，而不是靠读源码猜。
 */
function fixture(bridge = {}) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { hidden: true, disabled: false, value: "28111", textContent: "", className: "",
        dataset: {}, handlers: new Map(), style: {}, focus() {}, setAttribute() {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        addEventListener(type, handler) { this.handlers.set(type, handler); } });
    }
    return nodes.get(selector);
  };
  const timers = new Map();
  let now = 0, nextTimer = 0;
  const calls = [];
  const overrides = { getSettings: async () => ({ autoStart: false, port: 28111 }),
    getClientStatus: async () => patched, mountClient: async () => patched,
    restoreClient: async () => clean, selectClient: async () => patched, ...bridge };
  const oliviaDesktop = {};
  for (const [name, implementation] of Object.entries(overrides))
    oliviaDesktop[name] = (...args) => { calls.push(name); return implementation(...args); };
  const context = vm.createContext({
    window: { addEventListener() {}, oliviaDesktop },
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    location: { hash: "" },
    console, URL, AbortController, createUpdateDownloadUI, createTabNotices, createPatchLossNotice,
    fetch: () => { throw new Error("No real HTTP requests in client UI tests"); },
    requestAnimationFrame: callback => callback(),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {},
  });
  const bootstrap = appSource.lastIndexOf("Promise.all([refresh(), loadDesktopSettings()])");
  assert.ok(bootstrap > 0, "fixture must isolate admin startup from real services");
  vm.runInContext(appSource.slice(0, bootstrap).replace(/^import .*\r?\n/gmu, ""), context);
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  return {
    node, calls, flush,
    click: selector => node(selector).handlers.get("click")({ target: node(selector) }),
    render(status) { context.testStatus = status; vm.runInContext("renderClientMountStatus(testStatus)", context); },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

/** 点回退 → 等确认框出现 → 点确认（或取消）。 */
async function clickRollback(f, { confirm = true } = {}) {
  const completion = f.click("#rollbackPatch");
  await f.flush();
  f.click(confirm ? "#noticeConfirm" : "#noticeCancel");
  await completion;
  await f.flush();
}

test("界面：静态页面上就有「回退补丁（还原原版）」按钮，默认隐藏，与「停用服务」是两个入口", () => {
  const button = /<button id="rollbackPatch"[^>]*>([^<]*)<\/button>/u.exec(indexHtml);
  assert.ok(button, "index.html 里缺少 #rollbackPatch 按钮");
  assert.equal(button[1].trim(), "回退补丁（还原原版）", "按钮文案必须写明它会还原原版");
  assert.match(button[0], /class="[^"]*danger/u, "回退是破坏性操作，视觉上要与普通按钮区分");
  const box = /<div id="rollbackPatchBox"[^>]*>/u.exec(indexHtml);
  assert.ok(box, "index.html 里缺少 #rollbackPatchBox 容器");
  assert.match(box[0], /\bhidden\b/u, "默认必须隐藏：没打补丁时不该出现回退入口");
  assert.match(indexHtml, /<button id="restoreClient"[^>]*>停用服务<\/button>/u,
    "「停用服务」必须还在，且与回退补丁是两个独立入口");
  assert.match(indexHtml, /id="rollbackPatchHint"[\s\S]{0,400}?UserData/u,
    "说明文案要点出存档在 UserData（才知道回退不会丢存档）");
  assert.match(indexHtml, /id="rollbackPatchHint"[\s\S]{0,400}?原版/u, "说明文案要写清会还原成原版");
});

test("界面：干净原版或没选客户端时不出现回退入口（不能让人以为还能再退一次）", () => {
  const f = fixture();
  for (const [label, status] of [["干净原版", clean], ["未选客户端", noClient]]) {
    f.render(status);
    assert.equal(f.node("#rollbackPatchBox").hidden, true, `${label}时不该给「回退补丁」入口`);
  }
  f.render(noClient);
  assert.equal(f.node("#rollbackPatch").disabled, true, "没选客户端时按钮不可点");
});

test("界面：已挂载 / 部分挂载 / 补丁待更新时回退入口必须可见", () => {
  const f = fixture();
  for (const [label, status] of [["已挂载", patched], ["只挂了 FE", onlyFeapp],
    ["只挂了 WP", onlyWebplayer], ["补丁待更新", outdated]]) {
    f.render(status);
    assert.equal(f.node("#rollbackPatchBox").hidden, false, `${label}时必须能回退`);
    assert.equal(f.node("#rollbackPatch").disabled, false, `${label}时按钮应可点`);
  }
});

test("二次确认：文案写清「会还原游戏文件」「不会丢存档」「存档在 UserData」", async () => {
  const f = fixture();
  f.render(patched);
  const completion = f.click("#rollbackPatch");
  await f.flush();

  assert.equal(f.node("#noticeLayer").hidden, false, "点回退必须先弹二次确认");
  const message = f.node("#noticeMessage").textContent;
  assert.match(message, /回退补丁（还原原版）/u);
  assert.match(message, /还原游戏文件/u, "要说清它会写游戏文件");
  assert.match(message, /feapp \/ webplayer/u, "要指名是哪两个文件");
  assert.match(message, /原版（补丁前状态）/u, "要说清退回到什么状态");
  assert.match(message, /不会丢存档/u, "必须点名「不会丢存档」");
  assert.match(message, /UserData/u, "要说明存档在哪，用户才敢点");
  assert.deepEqual(f.calls, [], "确认之前一个文件都不能动");

  f.click("#noticeConfirm");
  await completion;
});

test("二次确认：取消后不动游戏文件，按钮解锁且不报假结果", async () => {
  const f = fixture();
  f.render(patched);
  const completion = f.click("#rollbackPatch");
  await f.flush();
  f.click("#noticeCancel");
  await completion;

  assert.deepEqual(f.calls, [], "取消后不得调用任何还原入口");
  assert.equal(f.node("#serviceMountResult").textContent, "", "取消不该留下「已回退」之类的假结果");
  assert.equal(f.node("#rollbackPatch").disabled, false, "取消后按钮必须能再点");
  assert.equal(f.node("#mountService").disabled, false);
});

test("回退走的是既有还原链路 client:restore（restoreClient），且回退后用 getClientStatus 复查", async () => {
  const f = fixture({ restoreClient: async () => clean, getClientStatus: async () => clean });
  f.render(patched);
  await clickRollback(f);

  assert.equal(f.calls.filter(name => name === "restoreClient").length, 1,
    "回退必须且只调用一次既有还原入口（preload → ipc client:restore）");
  assert.equal(f.calls.includes("mountClient"), false, "回退不得改走「启用 / 重打补丁」那条路");
  assert.ok(f.calls.includes("getClientStatus"), "回退后必须复用 getClientStatus 复查状态");
});

test("回退成功后结果可读，状态跟着刷新（补丁没了 → 入口收起）", async () => {
  const f = fixture({ restoreClient: async () => clean, getClientStatus: async () => clean });
  f.render(patched);
  assert.equal(f.node("#rollbackPatchBox").hidden, false);
  await clickRollback(f);

  assert.match(f.node("#serviceMountResult").textContent, /已回退补丁：游戏文件已还原成本机备份里的原版/u);
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false, "不许留转圈");
  assert.equal(f.node("#serviceMountStatus").textContent, "服务未挂载", "徽章必须变成未挂载");
  assert.equal(f.node("#rollbackPatchBox").hidden, true, "已经是干净原版，回退入口应收起");
  assert.equal(f.node("#rollbackPatch").disabled, false);
});

test("回退未到位（仍报部分挂载）不谎报成功", async () => {
  const f = fixture({ restoreClient: async () => onlyFeapp, getClientStatus: async () => onlyFeapp });
  f.render(patched);
  await clickRollback(f);

  assert.doesNotMatch(f.node("#serviceMountResult").textContent, /已回退补丁/u);
  assert.match(f.node("#serviceMountResult").textContent, /回退补丁未完成/u);
  assert.equal(f.node("#rollbackPatchBox").hidden, false, "还挂着补丁，回退入口必须留着");
});

test("回退失败：沿用桌面层的 BACKUP_INVALID 分类给出可读原因", async () => {
  const failure = Object.assign(new Error("backup archive identity mismatch"), { code: "BACKUP_INVALID" });
  const f = fixture({ restoreClient: async () => { throw failure; }, getClientStatus: async () => patched });
  f.render(patched);
  await clickRollback(f);

  const result = f.node("#serviceMountResult").textContent;
  assert.match(result, /回退补丁失败/u);
  assert.match(result, /原版备份缺失、损坏或身份不匹配/u, "要把分类翻成用户能懂的原因");
  assert.match(result, /BACKUP_INVALID/u, "分类编号要留着，方便排障对号");
  assert.match(result, /请保留 UserData/u, "要告诉用户先别删什么");
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
  assert.equal(f.node("#rollbackPatch").disabled, false, "失败后要让用户能重试");
});

test("回退失败（没有分类 code）：只显示脱敏后的首行原因", async () => {
  const f = fixture({ getClientStatus: async () => patched,
    restoreClient: async () => { throw new Error("未找到原版备份 token=TEST_SECRET\n内部细节：C:\\secret\\path"); } });
  f.render(patched);
  await clickRollback(f);

  const result = f.node("#serviceMountResult").textContent;
  assert.match(result, /回退补丁失败.*未找到原版备份/u);
  assert.doesNotMatch(result, /TEST_SECRET|内部细节/u, "密钥与内部路径不得出现在界面上");
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
});

test("回退进行中：不重复触发还原，状态刷新也不能解锁按钮", async () => {
  const write = deferred();
  let restores = 0;
  const f = fixture({ restoreClient: () => { restores++; return write.promise; },
    getClientStatus: async () => clean });
  f.render(patched);
  const completion = f.click("#rollbackPatch");
  await f.flush();
  f.click("#noticeConfirm");
  await f.flush();

  assert.equal(f.node("#rollbackPatch").disabled, true, "写入进行中必须禁用");
  f.render(patched);
  assert.equal(f.node("#rollbackPatch").disabled, true, "进行中的状态快照不能解锁按钮");
  await f.click("#rollbackPatch");
  await f.flush();
  assert.equal(restores, 1, "重复点击不得触发第二次还原");

  write.resolve(clean);
  await completion;
  await f.flush();
  assert.equal(f.node("#rollbackPatch").disabled, false);
});

test("回退等待超时：文案说明结果未确认，且不释放写锁", async () => {
  const write = deferred();
  const f = fixture({ restoreClient: () => write.promise, getClientStatus: async () => clean });
  f.render(patched);
  const completion = f.click("#rollbackPatch");
  await f.flush();
  f.click("#noticeConfirm");
  await f.flush();
  await f.advance(120_000);

  assert.match(f.node("#serviceMountResult").textContent, /回退补丁等待超时/u);
  assert.match(f.node("#serviceMountResult").textContent, /请勿重复/u);
  assert.equal(f.node("#rollbackPatch").disabled, true, "超时不等于写完，锁不能放");

  write.resolve(clean);
  await completion;
  await f.flush();
  assert.match(f.node("#serviceMountResult").textContent, /已回退补丁/u,
    "晚到的真实成功要能纠正超时提示，而不是重放一次写入");
});

test("源码：preload → ipc client:restore → main.js restoreClient() 这条链没被绕开", () => {
  const preload = read("desktop/preload.cjs");
  assert.match(preload, /restoreClient: \(\) => ipcRenderer\.invoke\("client:restore"\)/u,
    "界面拿到的手柄必须还是 client:restore");
  const main = read("desktop/main.js");
  assert.match(main, /ipcMain\.handle\("client:restore", \(\) => restoreClient\(\)\)/u,
    "主进程必须仍然把 client:restore 交给既有 restoreClient()");
  assert.match(main, /restore-feapp-original\.ps1/u, "既有还原脚本必须还在用");
  assert.match(main, /restore-webplayer-original\.ps1/u, "播放器还原脚本必须还在用");

  assert.match(appSource, /window\.oliviaDesktop\.restoreClient\(\)/u, "界面侧只调既有手柄");
  // 界面层是浏览器代码：它不可能自己跑还原脚本、也拿不到 Node 能力 —— 还原逻辑只能有一条。
  for (const forbidden of ["child_process", "ipcRenderer", "require(", "spawn(", "execFile"])
    assert.ok(!appSource.includes(forbidden), `界面层不得出现 ${forbidden}：还原只能走既有桥接`);
  assert.ok(!/new DesktopController|restoreClientResources/u.test(appSource),
    "界面层不得新写还原逻辑");
  assert.match(appSource, /#rollbackPatch"\)\.addEventListener\("click", safely\(\(\) => runClientMountAction\("rollback"\)\)\)/u,
    "回退按钮必须接进既有的客户端操作流程（同一把写锁、同一套超时）");
  assert.match(appSource, /const patchPresent = status\.mounted === true \|\| partiallyMounted \|\| status\.updateAvailable === true;/u,
    "出现条件必须同时覆盖总挂载、部分挂载与补丁待更新三种现场");
});
