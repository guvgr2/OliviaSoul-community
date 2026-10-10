// 1.2.0：曲库目录还没设置时，用户看到的应该是「去哪儿设置」，不是开发者的字眼。
//
// 起因（1.2.0 第二轮外部审核 · 新用户安装模拟报告 2.2 / 2.3）：
//   1. 空数据目录启动后，试听台的标签栏显示「读取标签失败：接口不存在」。
//      根因：曲库目录为空时 midi/listen-naming.js 只在硬编码的 7 个路径上回
//      { needsLibrary: true, message: … }，/listen-naming/health（曲库体检页）与
//      /listen-naming/tags（试听台标签栏）不在名单里 → 返回 null → 落到 server.js
//      兜底的 404「接口不存在」，把开发者字眼直接甩给了新用户。
//   2. 无库提示那句话又指错了地方：「请到「基础设置」里设置」，可「基础设置」页里
//      根本没有曲目存储路径这一项 —— 真正的位置是「客户端与歌词 → 客户端挂载与存储」
//      页里的「数据与曲目保存位置」。同一句错指引在四个模块里各写了一遍（共 5 处），
//      上一轮只改对了一处，于是用户还是被指到错页面。
//
// 本套件锁三件事：
//   · 行为：无库时 health / tags 必须回 needsLibrary + 真实入口的指引；
//     别的模块（dependencies / logs / diagnostics / data / game-stability）共用
//     /listen-naming/ 前缀，不能被本模块截胡（FOREIGN 名单另有静态护栏）。
//   · 文案：midi/ 四个模块的无库指引必须指向真实入口，且不许再出现「基础设置」。
//   · 前端：七个会收到 needsLibrary 的页面脚本必须真的处理它（不能静默当成功），
//     且曲库体检的状态条不许把「还没设置目录」笼统说成「检查失败，请重试」。
//
// 为什么单独一个测试文件、且本进程只起一个服务：server.js 的路由 Promise 是模块级
// 缓存（let listenNamingRoutesPromise = null），一个进程里第二个 createOliviaService
// 会复用第一个实例的闭包（绑定第一个实例的库）—— 详见
// listen-naming-database-path.test.js 与 time-of-day-variants.test.js 的同款注释。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOliviaService } from "../server.js";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, "..");
const GUIDANCE_ENTRY = "客户端与歌词 → 客户端挂载与存储";
const GUIDANCE_ITEM = "数据与曲目保存位置";

// 七个会收到 needsLibrary 卡片的页面脚本（服务端把指引塞在 { code:0, data:{ needsLibrary:true } } 里）。
const FRONTEND_FILES = [
  "public/library-health-panel.js",
  "public/listen-naming-player.js",
  "public/listen-naming.js",
  "public/listen-naming-tools.js",
  "public/twin-groups-panel.js",
  "public/time-of-day-inspect.js",
  "public/listen-naming-feedback.js",
];

// #66 加固（第四轮 · 审-2 处理复核 §2.1）：护栏原来只断言「文件里出现过 needsLibrary 这个词」，
// 复核的变体 A2 把取数函数里的守卫整段删掉、只留下显示层（failureText / 状态条）里的同名文本，
// 护栏照样绿 —— 而那正是真回退。这里钉死**取数函数里的守卫本身**：
//   if (…data.needsLibrary) { const error = new Error(…); error.needsLibrary = true; throw error; }
const NEEDS_LIBRARY_GUARD = /if \([^\n]{0,70}?\.data\.needsLibrary\)\s*\{[\s\S]{0,240}?error\.needsLibrary = true;[\s\S]{0,120}?throw error;/u;


async function sourceOf(relative) {
  return readFile(join(serviceRoot, relative), "utf8");
}

// ---------------------------------------------------------------- 文案护栏

const MIDI_FILES = [
  "midi/listen-naming.js",
  "midi/community-catalog.js",
  "midi/time-of-day.js",
  "midi/dependency-check.js",
];

for (const relative of MIDI_FILES) {
  test(`无库指引必须指向真实入口：${relative}`, async () => {
    const source = await sourceOf(relative);
    assert.ok(
      !source.includes("基础设置"),
      `${relative} 里还有「基础设置」这个错入口：曲目存储路径不在那一页，用户会照着找不到`,
    );
    assert.ok(
      source.includes(GUIDANCE_ENTRY) && source.includes(GUIDANCE_ITEM),
      `${relative} 的无库指引必须说清入口是「${GUIDANCE_ENTRY}」→「${GUIDANCE_ITEM}」`,
    );
  });
}

test("前端七个页面脚本都要认 needsLibrary（不能当成成功数据画出来）", async () => {
  // 服务端把指引放在 { code: 0, data: { needsLibrary: true, message } } 里，
  // 前端「code!==0 才算失败」的写法会把这张卡片当数据用：体检页画成干净曲库、
  // 试听台标签栏画成 0 首。七个文件都必须显式判断这个字段。
  // （第四个是「试听工具」页：1.2.0 第三轮外部审查 N7 指出它也会拿到这张卡片。
  //   第五个是「同款群」页：1.2.0 第四轮外部审核 P1 —— 本模块把无库兜底从「7 个固定
  //   路径」改成「凡是 /listen-naming/* 都算我的」之后 /groups/* 也开始拿到这张卡片，
  //   而它只判 code!==0，于是面板画出「已核验 undefined / undefined 首」。）
  //   第六、七个是第四轮审核期间自查顺带发现的同类漏网（都不是本轮引入，但同样是
  //   「服务端刚改对的指路话到不了用户眼前」）：public/time-of-day-inspect.js 把卡片
  //   当成「拿不到这首歌的时段依据」，显示成「查看失败，请重试」；
  //   public/listen-naming-feedback.js 把卡片当数据，诊断信息写成
  //   「社区名单：0 条 / 本地未命名：未知 首」。这两个前缀的中文指引由各自模块提供
  //   （midi/time-of-day.js、midi/community-catalog.js，listen-naming.js 的 FOREIGN
  //   名单把它们放行），所以前端不认这张卡片，用户就永远看不到那句话。）
  for (const relative of FRONTEND_FILES) {
    const source = await sourceOf(relative);
    assert.ok(
      /needsLibrary/u.test(source),
      `${relative} 没有处理服务端的 needsLibrary：无库时用户只会看到空数据或「接口不存在」`,
    );
  }
});

test("曲库体检把「接口不存在」翻成人话时，也要一起打上 needsLibrary 标志", async () => {
  // 1.2.0 第三轮外部审查 N4：needsLibrary 卡片那条路径设了标志，但「接口不存在」这条
  // 兜底翻译路径漏设 —— 于是正文说「还没选曲库目录」、状态条却写「检查失败，请重试」，
  // 同一屏自相矛盾，用户会反复点「重新检查」。
  const source = await sourceOf("public/library-health-panel.js");
  const branch = /if \(\/接口不存在\/\.test\(message\)\)[\s\S]{0,600}?\n    \}/u.exec(source);
  assert.ok(branch, "没能从 public/library-health-panel.js 里切出「接口不存在」的翻译分支（改写了？）");
  assert.ok(
    branch[0].includes("needsLibrary = true"),
    "「接口不存在」翻译分支必须设 error.needsLibrary = true，否则状态条与正文说法不一致",
  );
});

test("游戏端新建歌单要精确聚焦到创建输入框（不许再依赖 :last-of-type）", async () => {
  // 1.2.0 第三轮外部审查 N5：搜索框在它自己的容器里也是「唯一的 .tp-el-input__inner」，
  // querySelector('input.tp-el-input__inner:last-of-type') 会先命中文档序在前的搜索框，
  // 于是点「新建歌单…」之后打的字变成了过滤歌单。
  const source = await sourceOf("public/game-favorites.js");
  assert.ok(
    source.includes("#olivia-fav-create-input"),
    "public/game-favorites.js 的创建输入框要有专有 id，聚焦才能精确选中它",
  );
  assert.ok(
    !source.includes("input.tp-el-input__inner:last-of-type"),
    "public/game-favorites.js 还在用 :last-of-type 找创建框 —— 那是按父元素各自判断的，会命中搜索框",
  );
});

test("曲库体检的状态条要按具体原因说话（needsLibrary 时不是「检查失败，请重试」）", async () => {
  const source = await sourceOf("public/library-health-panel.js");
  const matched = /function buildStamp\(\)[\s\S]*?\n  \}/u.exec(source);
  assert.ok(matched, "没能从 public/library-health-panel.js 里切出 buildStamp()（函数改名了？）");
  assert.ok(
    matched[0].includes("needsLibrary"),
    "buildStamp() 必须区分「还没设置曲库目录」与「检查真的失败」，否则同一条状态条会和正文自相矛盾",
  );
});

test("时段依据复核把 needsLibrary 当指路话显示，不许写成「查看失败，请重试」", async () => {
  // 用户并没有做错什么，只是还没设曲库目录；把服务端那句指引套上「××失败：」前缀，
  // 或者让 renderReport 的兜底把它换成「请重试」，都会把用户指到错误方向。
  const source = await sourceOf("public/time-of-day-inspect.js");
  assert.ok(
    /function failureText\(prefix, error\)[\s\S]{0,200}?needsLibrary/u.test(source),
    "public/time-of-day-inspect.js 要有 failureText()：needsLibrary 时原样显示服务端的指路话",
  );
  for (const prefix of ["写入失败", "查看失败"]) {
    assert.ok(
      source.includes(`failureText("${prefix}", error)`),
      `public/time-of-day-inspect.js 的「${prefix}」也要走 failureText()，否则用户只会看到「请重试」`,
    );
  }
});

test("问题反馈的诊断信息不许把 needsLibrary 卡片当成「社区名单 0 条」", async () => {
  // 拿这张卡片当数据时，用户看到的诊断信息是「社区名单：0 条，更新于 未知 /
  // 本地未命名：未知 首」—— 他会拿着这份失真信息去报障，而真实原因只是还没设目录。
  const source = await sourceOf("public/listen-naming-feedback.js");
  const matched = /async function diagnostics\(\)[\s\S]*?\n  \}/u.exec(source);
  assert.ok(matched, "没能从 public/listen-naming-feedback.js 里切出 diagnostics()（函数改名了？）");
  assert.ok(
    matched[0].includes("needsLibrary"),
    "diagnostics() 必须区分「曲库目录还没设置」与「社区名单读取失败」，否则诊断信息写成 0 条",
  );
});

// ---------------------------------------------------------------- 行为护栏

test("真实服务：曲库目录没设置时，health / tags 回 needsLibrary + 指引，别的模块前缀不被截胡", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-library-guidance-"));
  const dataDir = join(root, "异位数据", "database");
  const service = await createOliviaService({
    root,
    dataDir,
    officialMediaRoot: join(root, "media"),
    worker: false,
    runMemoryRefresh: false,
    midiDurationProbe: async () => 120_000_000,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  // 故意**不**写 settings.midi_library_root：新装用户就是这种状态。
  const address = await service.listen(0);
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200, `${path} 在 /toy/ 下一律是 HTTP 200 + 信封里的 code`);
    return response.json();
  };

  for (const path of ["/toy/listen-naming/health", "/toy/listen-naming/tags"]) {
    const body = await get(path);
    assert.equal(body.code, 0, `${path} 无库时不该报错，而是回一张 needsLibrary 卡片：${body.message ?? ""}`);
    assert.equal(body.data?.needsLibrary, true, `${path} 无库时必须回 needsLibrary，否则前端画成空数据`);
    assert.match(
      String(body.data?.message ?? ""),
      /还没设置曲目存储路径/u,
      `${path} 的提示要直接说结论（用户看的第一行）`,
    );
    assert.ok(
      String(body.data?.message ?? "").includes(GUIDANCE_ENTRY) &&
        String(body.data?.message ?? "").includes(GUIDANCE_ITEM),
      `${path} 的提示必须给出真实入口，否则用户照着找不到（这是上一轮漏掉的那条）`,
    );
  }

  // 下面五个都是**别的模块**，共用 /listen-naming/ 前缀、且挂载在 listen-naming 之后：
  // 一旦本模块把匹配放宽成「凡是 /listen-naming/* 都算我的」，它们就会被截胡（表现为
  // 列表永远显示 needsLibrary）。这里只断言「没被截胡」，不追究探测结果本身。
  //
  // 别顺手把 /listen-naming/time-of-day 与 /listen-naming/community 也加进来：那两个模块
  // **自己**在无库时就回同一句指引（midi/time-of-day.js、midi/community-catalog.js 各自的
  // 兜底），响应上分不出是被截胡还是自己答的 —— 它们由下面的静态名单断言兜住。
  for (const path of [
    "/toy/listen-naming/dependencies",
    "/toy/listen-naming/logs",
    "/toy/listen-naming/diagnostics/system",
    "/toy/listen-naming/data/status",
    "/toy/listen-naming/game-stability/status",
  ]) {
    const body = await get(path);
    assert.notEqual(
      body.data?.needsLibrary,
      true,
      `listen-naming 的无库分支不能吞掉 ${path}（那是另一个模块的路由）`,
    );
  }

  // 静态护栏：FOREIGN 名单要把全部 7 个外部前缀都列出来。漏掉任何一个，那个模块在无库时
  // 就会被本模块的兜底卡片吞掉 —— 上面那 5 个能测出来，time-of-day / community 测不出来
  // （它们自己回同一句话），只能靠这条把名单钉死。
  const listenNaming = await sourceOf("midi/listen-naming.js");
  const foreign = /const FOREIGN = \[([\s\S]*?)\];/u.exec(listenNaming);
  assert.ok(foreign, "没能从 midi/listen-naming.js 里切出 FOREIGN 名单（改名了？）");
  const expectedForeign = [
    "/listen-naming/logs",
    "/listen-naming/dependencies",
    "/listen-naming/diagnostics",
    "/listen-naming/data",
    "/listen-naming/game-stability",
    "/listen-naming/time-of-day",
    "/listen-naming/community",
  ];
  const listedForeign = [...foreign[1].matchAll(/"([^"]+)"/gu)].map(match => match[1]);
  // #67 加固（第四轮 · 审-2 处理复核 §2.2）：原来只查「这 7 个都在」，往名单里**多加**一项不会变红。
  // 多出来的那个前缀就不再回指路卡、退回 server.js 的 404「接口不存在」—— 不画假数据，但这个功能
  // 在新装状态下等于没有。这里改成「不多不少、集合相等」。
  assert.deepEqual(
    [...listedForeign].sort(),
    [...expectedForeign].sort(),
    `FOREIGN 名单必须恰好是这 7 个前缀（多一个会让该模块在无库时退回「接口不存在」）实际：${listedForeign.join("、")}`,
  );
});

// #66（第四轮 · 审-2 处理复核 §2.1）：名单断言钉的是「取数函数里的守卫本身」，不是「文件里出现过这个词」。
test("七个文件的取数守卫都必须真的抛错（不是「文件里出现过这个词」）", async () => {
  for (const relative of FRONTEND_FILES) {
    const source = await sourceOf(relative);
    assert.match(source, NEEDS_LIBRARY_GUARD,
      `${relative} 的取数函数里必须有「needsLibrary ⇒ 抛错」的守卫：`
      + "只删守卫、留下 failureText() / 状态条里的同名文案，是复核验证过的静默回退方式（变体 A2）");
  }
});

test("变异自测：删掉取数守卫、只留显示层文案时，上面那条断言必须失败", async () => {
  const relative = "public/twin-groups-panel.js";
  const source = await sourceOf(relative);
  const mutated = source.replace(NEEDS_LIBRARY_GUARD, "/* 变异：守卫整段删除 */");
  assert.notEqual(mutated, source, `变异没能命中 ${relative} 的守卫（正则与代码脱节了？）`);
  assert.match(mutated, /needsLibrary/u,
    "变异后的文件里仍要有显示层的 needsLibrary 文案（注释 + failureText），才复刻复核的变体 A2");
  assert.doesNotMatch(mutated, NEEDS_LIBRARY_GUARD,
    "护栏必须拦住「只删取数守卫」的变异，否则它只是个 grep");
});
