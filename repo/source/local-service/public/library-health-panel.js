// 「曲库体检」面板（C1 新增，独立文件，不改 app.js / 不改 server.js）：
//   * 页签的显示与隐藏由 app.js 现成的 .sideTab 监听器完成（它按 data-page 开关 .tabPage），
//     本模块只补一个「第一次点开时挂载」的监听，挂载约定照抄 folder-manager.js。
//   * 数据来自既有的 GET /toy/listen-naming/health（midi/listen-naming.js 的 getHealth），
//     本文件不新增任何取数逻辑，只把明细展开成卡片，并显式给出
//     「共 N 条，已列出前 M 条」+「加载全部」（?full=1），不再静默截断。
//   * 类名全部沿用既有样式（settingsBlock / settingsBlockHead / ln-diagChips / ln-chip /
//     ln-diagPending / ln-diagTable / panelHead / edition / actions / compact / empty /
//     loadingShine / result），不新增 CSS 文件、不写死颜色、不写死字号。
(function (global) {
  "use strict";

  const document = global.document;
  const ENDPOINT = "/toy/listen-naming/health";
  // 页内上手引导（照 g12 的老规矩）：收起状态记在 localStorage，且另立 key ——
  // 不复用「曲名与时段」那条（用户在那儿收起过，不代表想在这里也收起）。
  const GUIDE_KEY = "oliviaSoul.libraryHealth.guideDismissed";

  function guideDismissed() {
    try { return global.localStorage?.getItem(GUIDE_KEY) === "1"; } catch { return false; }
  }
  function rememberGuide(dismissed) {
    try { global.localStorage?.setItem(GUIDE_KEY, dismissed ? "1" : "0"); } catch { /* 忽略 */ }
  }

  // 「去修」出口：一律复用既有页签（点 .sideTab[data-tab=xxx] 走 app.js 现成的切换逻辑），
  // 映射照 diagnostics-panel.js 末尾那排「去 xxx」的既有去向 + 派工单 §4.1。
  const FIX_NAMING = { label: "去曲名与时段", tab: "listen-naming" };
  const FIX_DURATION = { label: "去时长修复", tab: "listen-naming" };
  const FIX_DESKTOP = { label: "去客户端挂载与存储", tab: "desktop" };
  const FIX_TWIN = { label: "去同款群核对", tab: "listen-tools" };

  // 五类明细卡片。key = 接口里的数组字段，totalKey = totals 里的同名字段。
  // badge 的样式类全部是既有类：警告用 ln-diagPending，错误用 ln-chip + data-kind="fault"，
  // 「可合并」不是错误，用 .result 的绿色文字。
  // 七类明细卡，顺序按严重度：警告（能玩但不完整）→ 错误（要人工核对）→ 可合并提示。
  const CARDS = [
    {
      key: "placeholderNames",
      totalKey: "placeholderNames",
      title: "占位名（还没起名）",
      hint: "这些作品的曲名还是自动生成的占位名。这里只统计数量，不会替你猜曲名。",
      unit: "条",
      badgeClass: "ln-chip ln-diagPending",
      columns: ["作品文件夹", "当前曲名"],
      fix: FIX_NAMING,
      row: item => [item.folder, item.name],
    },
    {
      key: "duplicateNames",
      totalKey: "duplicateNames",
      title: "同名冲突（不同的曲子起了同一个名）",
      hint: "重名的作品在游戏里认不出哪首是哪首；去曲名与时段里改掉其中一个名字。",
      unit: "条",
      badgeClass: "ln-chip ln-diagPending",
      columns: ["曲名", "出现在"],
      fix: FIX_NAMING,
      row: item => [item.name, summarizeFolders(item.folders)],
    },
    {
      key: "missingVideo",
      totalKey: "missingVideo",
      title: "缺失视频（只有音频、没有画面）",
      hint: "文件夹里没有画面文件，进游戏后看不到 MV；去客户端挂载与存储里补上。",
      unit: "个",
      badgeClass: "ln-chip ln-diagPending",
      columns: ["作品文件夹", "说明"],
      fix: FIX_DESKTOP,
      row: item => [item, "缺少画面文件"],
    },
    {
      key: "missingMidi",
      totalKey: "missingMidi",
      title: "缺失 MIDI",
      hint: "文件夹里没有可播放的 MIDI 音频来源，游戏里点了不会有声音。",
      unit: "个",
      badgeClass: "ln-chip ln-diagPending",
      columns: ["作品文件夹", "说明"],
      fix: FIX_DESKTOP,
      row: item => [item, "缺少 MIDI 文件"],
    },
    {
      key: "durationOdd",
      totalKey: "durationOdd",
      title: "时长异常",
      hint: "时长明显偏短或偏长的作品，多半是音频来源本身有问题。",
      unit: "个",
      badgeClass: "ln-chip",
      badgeKind: "fault",
      columns: ["作品文件夹", "时长"],
      fix: FIX_DURATION,
      row: item => [item.folder, formatDuration(item.seconds)],
    },
    {
      key: "twinConflicts",
      totalKey: "twinConflicts",
      title: "同款群命名不一致",
      hint: "同一个同款群里的几个版本名字不一样，需要人工核对是不是同一首。",
      unit: "组",
      badgeClass: "ln-chip",
      badgeKind: "fault",
      columns: ["同款群", "各版本曲名"],
      fix: FIX_TWIN,
      row: item => [summarizeFolders(item.folders), summarizeNames(item.names)],
    },
    {
      key: "duplicateGroups",
      totalKey: "duplicateGroups",
      title: "疑似重复（同款群里名字一样）",
      hint: "同款群里几个版本的名字完全相同，看起来是同一首，可以合并成一个版本。",
      unit: "组",
      badgeClass: "result",
      columns: ["同款群", "版本数"],
      fix: FIX_TWIN,
      row: item => [item.name, `${countOf(item.count)} 个文件夹`],
    },
  ];

  // 概览计数：counts.* 是全量数字（不是本页条数）。fault 为真且非零时标成故障色。
  const OVERVIEW = [
    ["曲库文件夹", "folders", false],
    ["数据库行", "rows", false],
    ["已命名", "named", false],
    ["占位名", "placeholderNames", true],
    ["同名冲突", "duplicateNames", true],
    ["同款群不一致", "twinConflicts", true],
    ["疑似重复（可合并）", "duplicateGroups", false],
    ["视频缺失", "missingVideo", true],
    ["缺失 MIDI", "missingMidi", true],
    ["时长异常", "durationOdd", true],
  ];

  let host = null;
  const view = { data: null, error: null, loading: false, full: false };

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function countOf(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  // 扫光加载态沿用 app.js 的写法：内容同时写进 textContent 与 data-shine（CSS 用 attr(data-shine)）。
  function loadingLine(tag, text, className) {
    const element = node(tag, text, className ? `${className} loadingShine` : "loadingShine");
    element.dataset.shine = text;
    return element;
  }

  // 时长说人话：5 秒 / 1 分 12 秒 / 1 小时 12 分。
  // 先判「有没有值」再转数字 —— Number(null) 与 Number("") 都是 0，直接转会把它显示成 0 秒。
  function formatDuration(seconds) {
    if (seconds == null || seconds === "") return "未知";
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "未知";
    const total = Math.round(value);
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    const restSeconds = total % 60;
    if (minutes < 60) return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  }

  function formatCheckedAt(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "刚刚";
    const minutes = Math.floor((Date.now() - at) / 60000);
    if (!Number.isFinite(minutes) || minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  // 一行几十个文件夹名太吵：只列前几个，其余用「等 N 个」收尾。
  function summarizeFolders(folders) {
    const list = (Array.isArray(folders) ? folders : []).filter(name => typeof name === "string" && name);
    if (!list.length) return "—";
    const shown = list.slice(0, 3);
    return list.length > shown.length ? `${shown.join("、")} 等 ${list.length} 个` : shown.join("、");
  }

  function summarizeNames(names) {
    const list = (Array.isArray(names) ? names : []).filter(name => typeof name === "string" && name);
    return list.length ? list.join(" / ") : "—";
  }

  function goTab(tab) {
    const button = document.querySelector(`.sideTab[data-tab="${tab}"]`);
    if (button) button.click();
  }

  async function api(path) {
    const response = await global.fetch(path, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    // 「还没设置曲库目录」时服务端回的是一张指引卡片 { needsLibrary: true, message }（code 仍是 0）：
    // 它不是数据而是给用户的话，必须当错误抛出去，否则面板会把空数据画成「干净曲库」。
    if (body && body.data && body.data.needsLibrary) {
      const error = new Error(body.data.message || "还没设置曲目存储路径");
      error.needsLibrary = true;
      throw error;
    }
    // 成功一律是 {code:0, data:{...}}；别的一律当失败，优先把后端的 message 当人话说出来，
    // 不要只说「加载失败」，也不要让畸形响应被当成「没有问题」的干净曲库。
    if (body && body.data && (body.code === 0 || body.code == null)) return body.data;
    // 全新安装还没选曲库目录时，服务端整组 /listen-naming/* 路由都不接管请求，回的是统一的
    // 「接口不存在」—— 那是给开发者的字眼，用户看到会一头雾水，这里翻成「去哪儿选目录」。
    const message = (body && body.message) || `请求失败（${response.status}）`;
    if (/接口不存在/.test(message)) {
      // 这条翻译路径同样属于「还没选曲库目录」，必须一起打上标志，
      // 否则状态条会走到「检查失败，请重试」那一支，与正文和 :203-209 的说法自相矛盾。
      const error = new Error("还没选曲库目录（或目录读不到）—— 先去「客户端与歌词 → 客户端挂载与存储」选一次曲库目录，再回来点「重新检查」");
      error.needsLibrary = true;
      throw error;
    }
    throw new Error(message);
  }

  function buildStamp() {
    if (view.loading) return loadingLine("small", "正在检查曲库…");
    // 无库不是「检查失败」：状态条要和正文说同一件事，笼统写「请重试」只会让人反复点按钮。
    if (view.error) {
      return node("small", view.needsLibrary
        ? "还没设置曲目存储路径 · 正文里写了去哪儿设置"
        : "检查失败，请重试");
    }
    if (view.data) return node("small", `上次检查：${formatCheckedAt(view.data.checkedAt)} · 只读扫描，不会改动任何文件`);
    return node("small", "还没检查过");
  }

  function buildOverview(data) {
    const counts = (data && data.counts) || {};
    const section = node("section", null, "settingsBlock");
    const head = node("div", null, "settingsBlockHead ln-diagChips");
    head.append(node("strong", "曲库概览"));
    const chips = node("div", null, "ln-diagChips");
    for (const [label, key, fault] of OVERVIEW) {
      const value = countOf(counts[key]);
      const chip = node("span", `${label} ${value}`, "ln-chip");
      if (fault && value > 0) chip.dataset.kind = "fault";
      chips.append(chip);
    }
    section.append(head, chips);
    return section;
  }

  function buildBadge(spec, total) {
    const badge = node("span", `${total} ${spec.unit}`);
    if (spec.badgeClass === "result") {
      badge.className = "result";
      return badge;
    }
    badge.className = spec.badgeClass;
    if (spec.badgeKind) badge.dataset.kind = spec.badgeKind;
    return badge;
  }

  function buildFixButton(fix) {
    const button = node("button", fix.label, "compact");
    button.type = "button";
    button.addEventListener("click", () => { goTab(fix.tab); });
    return button;
  }

  function buildLimitRow(data, shown, total) {
    const row = node("div", null, "actions compactActions");
    row.append(node("small", `共 ${total} 条，已列出前 ${shown} 条`));
    if (data.full !== true) {
      const more = node("button", "加载全部", "secondary compact");
      more.type = "button";
      more.disabled = view.loading;
      more.addEventListener("click", () => { void load({ full: true }); });
      row.append(more);
    }
    return row;
  }

  function buildTable(spec, rows) {
    const table = node("table", null, "ln-diagTable");
    const headRow = node("tr");
    for (const column of spec.columns) headRow.append(node("th", column));
    headRow.append(node("th", "去修"));
    const thead = node("thead");
    thead.append(headRow);
    const tbody = node("tbody");
    for (const item of rows) {
      const cells = spec.row(item);
      const row = node("tr");
      for (let index = 0; index < spec.columns.length; index += 1) {
        const value = cells[index];
        row.append(node("td", value == null || value === "" ? "—" : String(value)));
      }
      const fixCell = node("td");
      fixCell.append(buildFixButton(spec.fix));
      row.append(fixCell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    return table;
  }

  function buildCard(spec, data) {
    const rows = Array.isArray(data[spec.key]) ? data[spec.key] : [];
    const total = countOf((data.totals || {})[spec.totalKey]);
    const section = node("section", null, "settingsBlock");
    const head = node("div", null, "settingsBlockHead ln-diagChips");
    head.append(node("strong", spec.title), buildBadge(spec, total));
    section.append(head);
    if (spec.hint) section.append(node("small", spec.hint));
    if (!rows.length) {
      section.append(node("p", "没发现问题 —— 曲库挺干净", "empty"));
      return section;
    }
    // 不静默截断：只有「这一类一共有多少条」多于「本页列了多少条」时才提示并给出口。
    if (total > rows.length) section.append(buildLimitRow(data, rows.length, total));
    section.append(buildTable(spec, rows));
    return section;
  }

  function appendReport(body, data) {
    body.append(buildOverview(data));
    const totals = (data && data.totals) || {};
    const allClean = CARDS.every(spec => countOf(totals[spec.totalKey]) === 0);
    if (allClean) {
      body.append(node("p", "没发现问题 —— 曲库挺干净", "empty"));
      body.append(node("small", `上次检查：${formatCheckedAt(data.checkedAt)}`));
      return;
    }
    for (const spec of CARDS) body.append(buildCard(spec, data));
  }

  // 页内就地引导：照 listen-naming.js 的「三步上手」模板（settingsBlock + settingsBlockHead
  // + <ol> + fieldHint + actions），只复用既有样式类，不新增 CSS。
  function buildGuide() {
    const section = node("section", null, "settingsBlock");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "三步上手（先体检 → 看明细 → 去修）"),
      node("small", "第一次用看这里；点「知道了，收起」不再自动展开，之后可点右上角「使用引导」再打开"),
    );
    const steps = node("ol");
    steps.append(
      node("li", "点「重新检查」只读扫描曲库（不改动任何文件）；上面的「曲库概览」给出各类问题的条数。"),
      node("li", "每张卡片是一类问题：占位名 / 同名冲突 / 缺失视频 / 缺失 MIDI / 时长异常 / 同款群命名不一致 / 疑似重复。卡片上写清「共 N 条，已列出前 M 条」，点「加载全部」看剩下的。"),
      node("li", "每行右侧的「去修」直接跳到能改它的页签（去曲名与时段 / 去时长修复 / 去客户端挂载与存储 / 去同款群核对）；改完回来点「重新检查」。"),
    );
    const hint = node("p",
      "旧的「曲库健康检查」（在「高级设置」里）还在，这一页是它的明细版：只统计，不替你猜曲名。",
      "fieldHint");
    const actions = node("div", null, "actions");
    const close = node("button", "知道了，收起", "secondary");
    close.type = "button";
    close.addEventListener("click", () => { rememberGuide(true); render(); });
    actions.append(close);
    section.append(head, steps, hint, actions);
    section.hidden = guideDismissed();
    return section;
  }

  function buildPage() {
    const head = node("div", null, "panelHead");
    const left = node("div");
    const title = node("h2");
    title.append(node("span", "曲库体检"), node("span", "新", "edition"));
    left.append(title, node("p", "占位名 / 缺失 MIDI / 时长异常 / 疑似重复 / 同款群不一致 —— 只读扫描，不会改动任何文件"));
    const actions = node("div", null, "actions compactActions");
    const refresh = node("button", "重新检查", "secondary compact");
    refresh.type = "button";
    refresh.disabled = view.loading;
    refresh.addEventListener("click", () => { void load({ full: view.full }); });
    const guideButton = node("button", "使用引导", "secondary compact");
    guideButton.type = "button";
    guideButton.addEventListener("click", () => { rememberGuide(false); render(); });
    actions.append(refresh, guideButton, buildStamp());
    head.append(left, actions);

    const body = node("div");
    // 「还没设置曲库目录」时 view.error 已经是完整的指路话（服务端单一来源），别再套「检查失败：」。
    if (view.error) body.append(node("p", view.needsLibrary ? view.error : `检查失败：${view.error}`, "empty"));
    else if (!view.data) body.append(loadingLine("p", "正在只读扫描曲库…", "empty"));
    else appendReport(body, view.data);

    const fragment = document.createDocumentFragment();
    fragment.append(head, buildGuide(), body);
    return fragment;
  }

  function render() {
    if (!host) return;
    host.replaceChildren(buildPage());
  }

  async function load(options) {
    const wantFull = !!(options && options.full);
    if (wantFull) view.full = true;
    view.loading = true;
    view.error = null;
    view.needsLibrary = false;
    render();
    try {
      view.data = await api(`${ENDPOINT}${view.full ? "?full=1" : ""}`);
      view.error = null;
      view.needsLibrary = false;
    } catch (error) {
      view.error = error && error.message ? error.message : String(error);
      // 状态条要靠它区分「没设曲库目录（可指路）」和普通检查失败。
      view.needsLibrary = !!(error && error.needsLibrary === true);
      view.data = null;
    } finally {
      view.loading = false;
      render();
    }
  }

  function mount() {
    const page = document.querySelector('.tabPage[data-page="library-health"]');
    if (!page || page.dataset.libraryHealthReady === "1") return;
    page.dataset.libraryHealthReady = "1";
    host = page;
    render();
    void load({ full: false });
  }

  const button = document.querySelector('.sideTab[data-tab="library-health"]');
  if (button) button.addEventListener("click", () => global.setTimeout(mount, 60));

  global.OliviaSoulLibraryHealth = { mount };
})(window);
