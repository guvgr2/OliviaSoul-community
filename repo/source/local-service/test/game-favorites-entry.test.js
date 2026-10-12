// 1.2.0 真机反馈（修复单 §二）：歌单的总入口原来只挂在歌曲行的「加播单」下拉里，
// 曲库页一个「歌单」字样都没有 —— 用户装完 1.2.0 找不到歌单功能，以为这版没做。
//
// 本套件锁四件事（都是「用户够不够得着」这一层，不是歌单数据的正确性）：
//   1. 常驻入口按钮存在、只挂一次、只在曲库页（页面上有歌曲行）显示；
//   2. 一个歌单都没有时，管理面板照样能打开 —— 它必须能通到「建一个」；
//   3. 面板自己就能新建，且建完当面提示入口路径；
//   4. 空歌单时不画播放 / 删除这些需要 folderId 的块，也确认分享码整块没有回退；
//   5. 歌单片上的 ▶ 是一键切播（1.2.1 第二十八轮，用户反馈「切换歌单播放还要手动点歌单」）。
//
// 为什么是源码静态断言：game-favorites.js 是补丁注入进游戏 CEF 的普通脚本，依赖游戏
// 自己的 DOM（[data-olivia-song] 行）与 document.currentScript.src，本机没有假 DOM 能
// 跑到「点开面板」那一步。所以这里只证明「写法没退回去」；真正的验收是真机点一遍
// （三组清单见 AGENTS.md）。每条断言都用 .test-twins/mut-config-fav-entry.json 验过会红。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "..", "public", "game-favorites.js");

const sourceOf = () => readFile(sourcePath, "utf8");

/* 从整份源码里切出一个函数体。切不到就直接红：靠切片定位的断言在定位失败时会退化成
   空字符串，后面的 match 全变成「不匹配」或「匹配空」—— 那是最典型的空转。 */
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `public/game-favorites.js 里找不到 ${signature} —— 改写了？本套件全靠它`);
  const rest = source.slice(at);
  const end = rest.indexOf("\n  }\n");
  assert.ok(end > 0, `${signature} 的结尾没找到，切不出函数体`);
  return rest.slice(0, end + 4);
}

test("常驻「歌单」入口：按钮只挂一次，且跟着歌曲行显隐", async () => {
  const source = await sourceOf();
  assert.match(source, /const ENTRY_ID = 'olivia-fav-entry'/u, "常驻入口按钮的 id 必须固定且唯一");

  const ensure = bodyOf(source, "function ensureEntryButton()");
  assert.match(ensure, /document\.getElementById\(ENTRY_ID\)/u, "ensureEntryButton 必须先查重，否则每次 start 都会再挂一个按钮");
  assert.match(ensure, /openManager\(\)/u, "按钮点击必须直接打开歌单管理面板");

  const sync = bodyOf(source, "function syncEntryButton()");
  assert.match(sync, /data-olivia-song/u, "入口只在曲库页显示 —— 判断依据是页面上有没有歌曲行");

  const start = bodyOf(source, "function start()");
  assert.match(start, /ensureEntryButton\(\)/u, "start() 必须挂上常驻入口，否则按钮永远不会出现");

  const refresh = bodyOf(source, "async function refreshAllChips()");
  const syncAt = refresh.indexOf("syncEntryButton()");
  const earlyReturn = refresh.indexOf("if (!ids.length) return;");
  assert.ok(syncAt >= 0, "refreshAllChips() 里必须同步入口显隐");
  assert.ok(earlyReturn >= 0, "refreshAllChips() 的提前返回锚点没了（改写了？）");
  assert.ok(
    syncAt < earlyReturn,
    "入口显隐必须排在 `if (!ids.length) return;` 之前 —— 排在后面时，离开曲库页（没有歌曲行）永远不会把按钮收起来",
  );
});

test("一个歌单都没有时，管理面板照样打开（不许只弹一句 toast 把人挡在门外）", async () => {
  const source = await sourceOf();
  const open = bodyOf(source, "async function openManager(folderId)");
  assert.doesNotMatch(
    open,
    /if \(!list\.length\) \{ toast\(/u,
    "openManager 不能再对空歌单早退 —— 入口正是给「还没有歌单」的人准备的，退出去了他连新建都够不着",
  );
  assert.match(open, /creating: !target/u, "空歌单时要把面板直接切到「新建」状态");
  assert.match(open, /if \(target\) void loadManagerItems\(\)/u, "没有歌单时不能拿空 folderId 去请求成员列表");
});

test("面板里能直接新建歌单，建完当面告诉用户入口在哪", async () => {
  const source = await sourceOf();

  const create = bodyOf(source, "async function createFolderInManager()");
  assert.match(create, /'\/toy\/folders'/u, "面板内新建必须走与下拉同一个接口");
  assert.match(create, /hintEntryOnce\(\)/u, "建完要提示入口路径 —— 他刚理解这个功能，此刻说最有用");
  assert.match(create, /await loadManagerItems\(\)/u, "建完要切到新歌单并读出它的成员列表");

  const render = bodyOf(source, "function renderManager()");
  // 必须钉住 `text: '＋ 新建歌单…'` 这个整体，不能只搜文案：emptyHint 里也写着
  // 「点上面的「＋ 新建歌单…」建一个」，只搜文案时把按钮文案改坏仍然全绿（F6 变异实测）。
  assert.match(render, /text: '＋ 新建歌单…'/u, "面板要有常驻的「＋ 新建歌单…」入口");
  assert.match(render, /createRow,/u, "createRow 必须真的挂进 DOM（只算出来不挂 = 空转）");
  assert.match(render, /emptyHint,/u, "空歌单要有一句说明，否则面板里是一片空白");
  assert.match(render, /还没有歌单。点上面的/u, "空态文案要说清下一步该点哪里");

  const pickerCreate = bodyOf(source, "async function createFolder()");
  assert.match(pickerCreate, /hintEntryOnce\(\)/u, "下拉里的「＋新建歌单…」建完也要提示入口");
});

test("没有歌单时，面板不画播放 / 删除这些需要 folderId 的块（分享码整块已撤下）", async () => {
  const source = await sourceOf();
  const render = bodyOf(source, "function renderManager()");
  assert.match(
    render,
    /folder \? h\('button', \{\s*class: 'tp-el-button tp-el-button--primary',\s*style: \{ width: '100%'/u,
    "「播放这个歌单」按钮必须被 folder 条件包住 —— 空歌单时它没有可播的对象",
  );
  assert.match(
    render,
    /folder \? h\('button', \{\s*class: 'tp-el-button tp-el-button--default',\s*style: \{ color: 'var\(--tp-error\)'/u,
    "「删除歌单」按钮必须被 folder 条件包住 —— folderId 为空时它没有可删的对象",
  );
  assert.match(render, /playRow,/u, "播放行必须真的挂进 DOM（只算出来不挂 = 空转）");
  /* 1.2.1 第二十八轮：分享码整块从游戏端面板撤下（用户要求「把这个前端隐藏了」）。
     否定断言 —— 它守的是「别哪天又加回来」；真要加回来，必须同步改本段说明与三处用户文档。
     ★ 口径收紧（第二十八轮复核定）：原来写成裸词 exportData —— 它是个通用命名，将来任何
     「导出数据」功能都可能自然叫它，会把无关改动判红；现在只认分享码那套专有标识符
     （olivia-fav-share-info / olivia-fav-share-text / 复制分享码 / paintExport / fillExport /
     copyShare）与限定到 managerState 的那个字段。配套的变异代理 F14 同步改成
     managerState.exportData = null（不跟着改的话，收紧之后 F14 会变绿 = 代理失效）。 */
  assert.doesNotMatch(
    source,
    /olivia-fav-share-info|olivia-fav-share-text|复制分享码|paintExport|fillExport|copyShare|managerState\.exportData/u,
    "游戏端面板不该再有分享码块（导出去程序端「歌单与收藏 → 导出歌单」）",
  );
});

test("歌单片上的 ▶ 是一键切播：点它就换正在放的那一夹，不必先选中", async () => {
  const source = await sourceOf();
  const render = bodyOf(source, "function renderManager()");
  assert.match(render, /void playFolder\(one\.id\);/u, "▶ 必须直接对「这一夹」调 playFolder —— 播成当前选中那夹就不是一键切播了");
  assert.match(render, /playingFolderId === one\.id/u, "正在放的那一夹要能被认出来（画「播放中」）");
  assert.match(render, /text: '播放中'/u, "认出来之后要真的标在界面上，否则用户看不出自己在听哪一夹");
  assert.match(render, /stripHint,/u, "▶ 的用法说明行必须挂进 DOM（空转的话第一次用的人还是看不懂）");

  const play = bodyOf(source, "async function playFolder(folderId)");
  assert.match(play, /playingFolderId = folderId;/u, "播放成功后要记住是哪一夹 —— 不记就没有「播放中」");
  /* 这一条必须连着 `playingIdsKey = …` 一起钉：playFolder 里现在有两处 renderManager
     （「再点即停」那支里也有一处），只写 /if \(managerState\) renderManager\(\);/ 会命中那一处，
     于是删掉「点播成功后立刻重画」仍然全绿（F12 变异实测）。 */
  assert.match(
    play,
    /playingIdsKey = idsKeyOf\(items\.map\(songKey\)\);\n      if \(managerState\) renderManager\(\);/u,
    "面板开着时要立刻重画，否则「播放中」要等下一次操作才出现",
  );
});

test("入口提示只出现一次（记在 localStorage，不每次进游戏都唠叨）", async () => {
  const source = await sourceOf();
  const hint = bodyOf(source, "function hintEntryOnce()");
  assert.match(hint, /if \(entryHinted\) return;/u, "必须有个「已经提示过」的开关");
  assert.match(hint, /localStorage\.setItem\(ENTRY_HINT_KEY/u, "提示过就记下来，下次进游戏不再提示");
  assert.match(hint, /setTimeout/u, "提示要稍作延后，别把「已新建《××》」那条 toast 顶掉");
});

test("管理面板仍然导出给游戏端自己调用", async () => {
  const source = await sourceOf();
  assert.match(source, /window\.OliviaSoulFavorites = \{[^}]*openManager/u, "openManager 必须在导出名单里");
});

/* ---------- 1.2.1 第三十轮：三件用户点名的事 ---------- */

test("「正在播放」读游戏播放器的真实状态，不再是自己记账", async () => {
  const source = await sourceOf();

  /* 桥是这轮新加的（patch-feapp-local.ps1 注入在播放器工厂内，看得见 h/m/x/u/f）。
     老补丁没有它 —— 那种情况下必须「什么都不改」，不能反过来把「播放中」清掉。 */
  const state = bodyOf(source, "function playerState()");
  assert.match(state, /window\.OliviaSoulPlayerState/u, "必须读注入桥，而不是继续用自己记的 playingFolderId 当唯一依据");
  assert.match(state, /catch \{ return null; \}/u, "桥抛异常时要返回 null —— 面板不能因为读状态失败就崩");
  assert.match(state, /function playerState\(\) \{\s*if \(typeof window\.OliviaSoulPlayerState !== 'function'\) return null;/u,
    "没有桥（老补丁）要提前返回 null");

  const sync = bodyOf(source, "function syncPlayingState()");
  assert.match(sync, /const state = playerState\(\);\s*if \(!state\) return;/u,
    "老补丁没有桥时保持现状 —— 这里清空反而会把「播放中」弄没");
  assert.match(sync, /state\.playing && idsKeyOf\(state\.ids\) === playingIdsKey/u,
    "要同时用桥的 playing 与「当前列表指纹」判断；只看 playing 会把「换到别的列表还在放」误判成这一夹");
  assert.match(sync, /if \(!playingFolderId\) return;/u, "没在放任何夹时不必巡检，省掉没意义的比对");

  const play = bodyOf(source, "async function playFolder(folderId)");
  assert.match(play, /playingIdsKey = idsKeyOf\(items\.map\(songKey\)\);/u,
    "点播时要记下这一夹的曲目指纹 —— 不记就没有东西可跟播放器的当前列表比对");

  const open = bodyOf(source, "async function openManager(folderId)");
  assert.match(open, /startPlayingWatch\(\);/u, "打开面板要挂上巡检，否则「在原生界面停止」这类面板外的变化永远发现不了");

  const close = bodyOf(source, "function closeManager()");
  assert.match(close, /stopPlayingWatch\(\);/u, "关面板要停掉巡检（没人看的时候不该每 2 秒跑一轮）");
});

test("每一片的 ▶ 再点一次就是停", async () => {
  const source = await sourceOf();
  const play = bodyOf(source, "async function playFolder(folderId)");
  assert.match(play, /if \(playingFolderId === folderId\) \{/u,
    "「正在放这一夹」的判断必须在 playFolder 里，且以播放器真实状态为准");
  assert.match(play, /window\.OliviaSoulStopPlayback\(\)/u, "停要调注入桥（照抄游戏原生停止），不能自己瞎清游戏状态");
  assert.match(play, /toast\('已停止播放', true\)/u, "停下来要有反馈 —— 静悄悄地停，用户会以为没点上");

  const render = bodyOf(source, "function renderManager()");
  assert.match(render, /'data-olivia-play': '1'/u,
    "▶ 热区要有稳定的定位属性 —— 靠 title 文案定位时，文案一改（这轮就改成了双态）验收设施会全部失准");
  assert.match(render, /title: playing \? '再点一下停止播放' : /u, "正在放时 hover 提示要说「再点一下停止」");
  assert.match(render, /playing \? \[svgGlyph\(PAUSE_GLYPH, 10\)\] : \[h\('span', \{ text: '▶' \}\)\]/u,
    "正在放的那一夹图标要变（▶ → 暂停），光靠「播放中」三个小字不足以说明它现在能点成停");
  assert.match(render, /const rowPlaying = Boolean\(folder\) && playingFolderId === folder\.id;/u,
    "整行主按钮也要跟着变文案（否则「正在播放」和可点的「停止」两处对不上）");
  assert.match(render, /: `▶ 播放《\$\{folder\.name\}》（夹内循环）`/u, "没在放时整行按钮保持原来的播放文案");
});

test("歌单入口搬到了「音乐桌面」面板标题行右侧", async () => {
  const source = await sourceOf();
  assert.match(source, /const DESK_TAB_CLASS = 'olivia-desk-tab'/u, "切换键需要一个固定的 class（既用于判重，也用于给右下角按钮让位）");
  assert.match(source, /const DESK_TITLE = '音乐桌面'/u,
    "「音乐桌面」是游戏语言包 playlist_my_songs 渲染出来的文字；认它，不认游戏内部的组件名/类名");

  const mount = bodyOf(source, "function mountDeskTab()");
  assert.match(mount, /querySelectorAll\('h2'\)/u, "从 h2 里找标题 —— 游戏那行是 <h2>音乐桌面 <span>N</span></h2>");
  assert.match(mount, /startsWith\(DESK_TITLE\)/u, "按文字前缀认（标题后面还跟着一个曲目数 span）");
  assert.match(mount, /row\.append\(button\)/u, "必须真的挂进标题行 —— 只算出来不挂就是空转（这条正是 F18 抓的）");
  assert.match(mount, /void openManager\(\)/u, "点这个键要打开歌单面板");
  assert.match(mount, /if \(!row\) return null;[\s\S]{0,90}row\.querySelector/u,
    "标题行取不到时必须提前返回：原写法 `if (!row || row.querySelector(…)) return row.querySelector(…)` 在 row 为 null 时自己抛 TypeError");

  const sync = bodyOf(source, "function syncEntryButton()");
  assert.match(sync, /hasDeskTab/u, "页面上有「音乐桌面」面板时，右下角那个常驻按钮要让位，两处同时出现等于没说清哪个是主入口");

  const refresh = bodyOf(source, "async function refreshAllChips()");
  const mountAt = refresh.indexOf("mountDeskTab()");
  const earlyReturn = refresh.indexOf("if (!ids.length) return;");
  assert.ok(mountAt >= 0, "refreshAllChips() 里必须补挂切换键 —— 游戏是 Vue 渲染的，重挂会把我们的按钮冲掉");
  assert.ok(
    mountAt < earlyReturn,
    "补挂必须排在 `if (!ids.length) return;` 之前 —— 「音乐桌面」里可能一首本地歌都没有，排在后面就永远补不上",
  );
});
