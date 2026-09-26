// 「试听起名」前端模块（OliviaSoul 管理页内嵌页签）
//
// 约定（照抄 app.js / song-editor.js 的既有写法）：
//   * 普通 <script>，IIFE + "use strict"，挂到 window.OliviaSoulListenNaming。
//   * 页签切换由 app.js 现成的 .sideTab 监听器完成（它按 data-page 显示/隐藏
//     .tabPage），本模块只补一个"第一次显示时加载"的监听，不改 app.js。
//   * 所有请求都走 /admin/api/... 或 /toy/...，返回 { code, message, data } 信封，
//     code !== 0 就抛错误（和 app.js 的 api() 一致）。
//   * 样式沿用 styles.css 的既有类：panel / tabPage / panelHead / settingsBlock /
//     taskCard / actions / result / empty / sideTab；本功能专属类统一加 ln- 前缀，
//     只在 listen-naming.css 里定义，颜色沿用同一套深色值。
//
// 本文件是"加法式"新增，不修改任何既有函数。

(function (global) {
  "use strict";

  // ---------------------------------------------------------- 分享意愿询问
  // 必须在试听台开始之前问一次。只上传「曲名 + 3 段音乐指纹」，不上传任何个人数据。
  const CONSENT_KEY = "oliviaSoul.listenNaming.consent.v1";
  const GUIDE_KEY = "oliviaSoul.listenNaming.guideDismissed";
  const CONSENT_HTML =
    "<p><strong>会上传的只有两样东西：</strong></p>" +
    "<p>· 你起的<strong>曲名</strong>（例如：千本樱）<br>" +
    "· <strong>3 段音乐指纹</strong>——用来让别人的程序认出这是同一首歌，从而自动填名</p>" +
    "<p><strong>不会上传任何个人数据：</strong></p>" +
    "<p>用户名 / 昵称 / UID / 账号 · 文件路径 · 设备与显卡信息 · 音频视频文件 · " +
    "聊天记录与信件 · 数据库文件，一概不上传。</p>" +
    "<p>指纹是单向派生数据，<strong>还原不出音频</strong>；曲名和指纹会以你的 GitHub 账号提交到开源仓库，" +
    "成为所有人共享的曲目名单。选「暂不分享」则一切照常使用，只是不参与共享。</p>";

  function consentDialog() {
    const layer = document.getElementById("noticeLayer");
    const title = document.getElementById("noticeTitle");
    const message = document.getElementById("noticeMessage");
    const confirm = document.getElementById("noticeConfirm");
    const cancel = document.getElementById("noticeCancel");
    if (!layer || !title || !message || !confirm || !cancel) return null;
    return { layer, title, message, confirm, cancel };
  }

  function readConsent() {
    try {
      const value = global.localStorage.getItem(CONSENT_KEY) || "";
      return value === "yes" || value === "no" ? value : "";
    } catch {
      return "";
    }
  }

  function writeConsent(value) {
    try {
      global.localStorage.setItem(CONSENT_KEY, value);
    } catch {
      // 无痕模式下写不了，本次会话仍然生效
    }
  }

  function ensureConsent() {
    const saved = readConsent();
    if (saved) return Promise.resolve(saved === "yes");
    const ui = consentDialog();
    if (!ui) {
      const ok = global.confirm(
        "是否愿意把你起的曲名分享给社区？\n\n" +
        "只上传：曲名 + 3 段音乐指纹（让别人能自动认出同一首歌）。\n" +
        "不会上传任何个人数据：用户名、账号、路径、设备信息、音频视频、聊天记录。\n\n" +
        "确定 = 愿意分享；取消 = 暂不分享（功能照常使用）。");
      writeConsent(ok ? "yes" : "no");
      return Promise.resolve(ok);
    }
    return new Promise(resolvePromise => {
      ui.title.textContent = "是否愿意分享你起的曲名？";
      ui.message.innerHTML = CONSENT_HTML;
      ui.cancel.hidden = false;
      ui.cancel.textContent = "暂不分享";
      ui.confirm.textContent = "愿意分享";
      ui.layer.hidden = false;
      const finish = value => {
        ui.layer.hidden = true;
        ui.confirm.removeEventListener("click", onYes);
        ui.cancel.removeEventListener("click", onNo);
        writeConsent(value ? "yes" : "no");
        resolvePromise(value);
      };
      const onYes = () => finish(true);
      const onNo = () => finish(false);
      ui.confirm.addEventListener("click", onYes);
      ui.cancel.addEventListener("click", onNo);
    });
  }


  const TAB = "listen-naming";
  const document = global.document;
  const MAX_SEGMENTS = 6;

  let elements = null;
  let state = createState();
  let requestEpoch = 0;

  function createState() {
    return {
      songs: [],
      // g11：完整的未命名列表（两遍法过滤后 songs 只是它的一份视图）
      allSongs: [],
      clueOnly: false,
      index: 0,
      segment: 0,
      named: 0,
      total: 0,
      // g11 进度
      totalAll: 0,
      namedTotal: 0,
      today: 0,
      undoable: 0,
      lastFolder: "",
      segmentSeconds: 15,
      segmentStart: 20,
      maxSegments: MAX_SEGMENTS,
      clipsDir: "",
      libraryRoot: "",
      backupFile: "",
      hasFeatureCsv: false,
      hasGroupCsv: false,
      loaded: false,
      loading: false,
      // 上一张卡片时光标是否在输入框里（决定换歌后要不要抢焦点；Esc 移出后就不再抢）
      focusInput: true,
    };
  }

  // ------------------------------------------------------------ 基础工具

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  async function request(path, options) {
    const response = await global.fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error("本地服务返回了无法解析的内容");
    }
    if (envelope.code !== 0) throw new Error(envelope.message || "本地服务返回错误");
    return envelope.data;
  }

  function current() {
    return state.songs[state.index] ?? null;
  }

  function setStatus(message, kind) {
    if (!elements) return;
    elements.status.textContent = message || "";
    if (kind) elements.status.dataset.kind = kind;
    else delete elements.status.dataset.kind;
  }

  function formatFeature(feature, folder) {
    if (!feature) return folder;
    const parts = [];
    if (feature.bpm != null) parts.push(`${Math.round(feature.bpm * 10) / 10} BPM`);
    if (feature.key) parts.push(feature.key);
    if (feature.seconds != null) parts.push(`${Math.round(feature.seconds)} 秒`);
    return parts.length ? parts.join(" · ") : folder;
  }

  // ------------------------------------------------------------ 构建界面

  function buildInterface() {
    const host = document.querySelector('.tabPage[data-page="' + TAB + '"]');
    if (!host) return null;
    // 允许重复调用：已经建好就直接复用
    if (host.dataset.listenNamingReady === "1") return collect(host);

    const panelHead = node("div", null, "panelHead");
    const headText = node("div");
    headText.append(
      node("h2", "试听起名"),
      node("p", "一首一首听还没曲名的作品，听出来就打曲名回车写库；写库前会自动备份数据库"),
    );
    const headTools = node("div", null, "ln-statusChips");
    const namedChip = node("span", "", "ln-chip");
    const remainChip = node("span", "", "ln-chip");
    headTools.append(namedChip, remainChip);
    panelHead.append(headText, headTools);

    // g12：上手引导（第一次进来时显示；点「知道了」后记住，可从「命名进度」里再打开）
    const guide = node("section", null, "settingsBlock ln-guide");
    const guideHead = node("div", null, "settingsBlockHead");
    guideHead.append(
      node("strong", "三步上手（听 → 提速 → 保险）"),
      node("small", "第一次用看这里；点「知道了」收起，之后可从下面的「命名进度」里再打开"),
    );
    const guideSteps = node("ol", null, "ln-guideSteps");
    guideSteps.append(
      node("li", "听一段 15 秒，听出来就把曲名打进输入框按回车；听不出点「跳过」——同一首的多个版本按 Ctrl+→ 可以整组跳过。"),
      node("li", "想更快：「导出命名表」把待命名清单存成 CSV，在表格里一次填几十首再导入；也可以点「社区名单比对」让程序猜一首。"),
      node("li", "填错不怕：按 Ctrl+Z 撤回（连带命名的一起回退）。更多工具在「试听工具」页（同款群核对、时段依据）和「高级设置」页（诊断）。"),
    );
    const guideActions = node("div", null, "actions ln-guideActions");
    const guideExport = node("button", "导出命名表", "secondary");
    const guideTools = node("button", "去试听工具页", "secondary");
    const guideDiagnostics = node("button", "去诊断（高级设置）", "secondary");
    const guideClose = node("button", "知道了，收起", "secondary");
    for (const button of [guideExport, guideTools, guideDiagnostics, guideClose]) button.type = "button";
    guideActions.append(guideExport, guideTools, guideDiagnostics, guideClose);
    guide.append(guideHead, guideSteps, guideActions);

    // g11「命名进度」：进度 / 今天命名了多少 / 撤回 / 接着上次 / 两遍法
    const progressBox = node("section", null, "settingsBlock ln-progress");
    const progressHead = node("div", null, "settingsBlockHead");
    progressHead.append(
      node("strong", "命名进度"),
      node("small", "退错了按 Ctrl+Z 撤回；关掉程序下次回来可以接着上次听"),
    );
    const progressLine = node("p", "", "fieldHint ln-progressLine");
    const progressActions = node("div", null, "actions ln-progressActions");
    const undoButton = node("button", "撤回上一条（Ctrl+Z）", "secondary");
    const resumeButton = node("button", "接着上次继续", "secondary");
    const clueButton = node("button", "两遍法：只看有线索的", "secondary");
    const guideButton = node("button", "使用引导", "secondary");
    for (const button of [undoButton, resumeButton, clueButton, guideButton]) button.type = "button";
    progressActions.append(undoButton, resumeButton, clueButton, guideButton);

    // g12：批量命名表（导出 → 表格里填 → 导入）
    const tableActions = node("div", null, "actions ln-tableActions");
    const exportButton = node("button", "导出命名表（CSV）", "secondary");
    const importButton = node("button", "导入命名表", "secondary");
    const importInput = node("input");
    importInput.type = "file";
    importInput.accept = ".csv,text/csv";
    importInput.className = "ln-importFile";
    importInput.hidden = true;
    for (const button of [exportButton, importButton]) button.type = "button";
    tableActions.append(exportButton, importButton, importInput);

    progressBox.append(progressHead, progressLine, progressActions, tableActions);

    const card = node("section", null, "taskCard ln-card");

    const folder = node("div", "", "ln-folder");
    folder.setAttribute("title", "当前作品文件夹");
    const meta = node("p", "", "fieldHint ln-meta");

    const audio = node("audio", null, "ln-audio");
    audio.controls = true;
    audio.preload = "auto";

    const segmentProgress = node("div", null, "taskProgress ln-segment");
    segmentProgress.dataset.state = "running";
    const segmentHead = node("div");
    const segmentStage = node("span", "第 1 段");
    const segmentPercent = node("strong", "1 / 6");
    segmentHead.append(segmentStage, segmentPercent);
    const segmentTrack = node("span", null, "taskProgressTrack");
    segmentTrack.append(node("span"));
    segmentProgress.append(segmentHead, segmentTrack);

    const nameRow = node("div", null, "ln-nameRow");
    const nameInput = node("input");
    nameInput.type = "text";
    nameInput.id = "lnNameInput";
    nameInput.maxLength = 200;
    nameInput.autocomplete = "off";
    nameInput.placeholder = "听出来了吗？打曲名，回车写库（听不出就点「跳过」）";
    nameInput.setAttribute("aria-label", "曲名");
    const submit = node("button", "写库（回车）");
    submit.type = "button";
    const submitHint = node("small", "写库前自动备份数据库；同款群会一起命名（只补空位）", "ln-submitHint");
    const nameBlock = node("div", null, "ln-nameBlock");
    nameBlock.append(nameInput, submitHint);
    nameRow.append(nameBlock, submit);

    // g12：命名质量守卫 —— 输入时提示同名冲突 / 同编号已有写法
    const nameGuard = node("p", "", "fieldHint ln-nameGuard");
    nameGuard.hidden = true;

    // g12：就地看时段依据（不切页签）
    const clueActions = node("div", null, "actions ln-clueActions");
    const inspectButton = node("button", "看这首的时段依据", "secondary");
    inspectButton.type = "button";
    const skipGroupButton = node("button", "跳过同编号/同款群（Ctrl+→）", "secondary");
    skipGroupButton.type = "button";
    const suggestButton = node("button", "社区名单比对", "secondary");
    suggestButton.type = "button";
    clueActions.append(inspectButton, skipGroupButton, suggestButton);
    const clueOut = node("div", null, "ln-clueOut");
    clueOut.hidden = true;

    const actions = node("div", null, "actions ln-actions");
    const replay = node("button", "重播（空格）", "secondary");
    const nextSegment = node("button", "换一段（N）", "secondary");
    const skip = node("button", "跳过（S）", "secondary");
    const previous = node("button", "上一首（←）", "secondary");
    for (const button of [replay, nextSegment, skip, previous]) button.type = "button";
    replay.title = "重播这一段（先把光标移出输入框后按空格）";
    nextSegment.title = "换这个作品的另一段（Esc 后按 N）";
    skip.title = "这首没听出来，跳过（Esc 后按 S；直接点这个按钮也行）";
    previous.title = "回上一首（Esc 后按 ←）";
    actions.append(replay, nextSegment, skip, previous);

    const status = node("p", "", "result ln-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const info = node("section", null, "settingsBlock ln-info");
    const infoHead = node("div", null, "settingsBlockHead");
    infoHead.append(
      node("strong", "这首歌的线索"),
      node("small", "同一编号下已有曲名，可照着起名；同款群为音频实锤的同一录音"),
    );
    const sameNumberList = node("ul", null, "ln-sameNumber");
    const twinLine = node("p", "", "fieldHint ln-twins");
    const pathLine = node("small", "", "ln-path");
    info.append(infoHead, sameNumberList, twinLine, pathLine);

    const help = node("p", "", "fieldHint ln-help");
    help.append(
      "快捷键：空格 重播 · 回车 写库 · N 换一段 · S / → 跳过 · ← 上一首 · Ctrl+→ 整组跳过 · Ctrl+Z 撤回。" +
      "（输入框默认带光标：裸键会当成打字，按 Esc 移出光标后裸键才生效；Ctrl 组合随时可用。）" +
      "每段 15 秒，从第 20 秒起最多 6 段；切片缓存在 UserData\\listen-clips。",
    );

    card.append(folder, meta, audio, segmentProgress, nameRow, nameGuard, clueActions, clueOut, actions, status, info, help);
    host.append(panelHead, guide, progressBox, card);
    host.dataset.listenNamingReady = "1";

    const collected = collect(host);
    bind(collected);
    maybeShowGuide();
    return collected;
  }

  function collect(host) {
    return {
      host,
      namedChip: host.querySelector(".ln-chip"),
      remainChip: host.querySelectorAll(".ln-chip")[1],
      card: host.querySelector(".ln-card"),
      folder: host.querySelector(".ln-folder"),
      meta: host.querySelector(".ln-meta"),
      audio: host.querySelector(".ln-audio"),
      segmentStage: host.querySelector(".ln-segment span"),
      segmentPercent: host.querySelector(".ln-segment strong"),
      segmentTrack: host.querySelector(".ln-segment .taskProgressTrack span"),
      nameInput: host.querySelector("#lnNameInput"),
      submit: host.querySelector(".ln-nameRow > button"),
      status: host.querySelector(".ln-status"),
      sameNumberList: host.querySelector(".ln-sameNumber"),
      twinLine: host.querySelector(".ln-twins"),
      pathLine: host.querySelector(".ln-path"),
      replay: host.querySelectorAll(".ln-actions button")[0],
      nextSegment: host.querySelectorAll(".ln-actions button")[1],
      skip: host.querySelectorAll(".ln-actions button")[2],
      previous: host.querySelectorAll(".ln-actions button")[3],
      // g11 进度面板
      progressLine: host.querySelector(".ln-progressLine"),
      undoButton: host.querySelectorAll(".ln-progressActions button")[0],
      resumeButton: host.querySelectorAll(".ln-progressActions button")[1],
      clueButton: host.querySelectorAll(".ln-progressActions button")[2],
      guideButton: host.querySelectorAll(".ln-progressActions button")[3],
      // g12 质量守卫 + 就地线索
      nameGuard: host.querySelector(".ln-nameGuard"),
      clueActions: host.querySelector(".ln-clueActions"),
      inspectButton: host.querySelectorAll(".ln-clueActions button")[0],
      skipGroupButton: host.querySelectorAll(".ln-clueActions button")[1],
      suggestButton: host.querySelectorAll(".ln-clueActions button")[2],
      clueOut: host.querySelector(".ln-clueOut"),
      // g12 批量命名表
      exportButton: host.querySelectorAll(".ln-tableActions button")[0],
      importButton: host.querySelectorAll(".ln-tableActions button")[1],
      importInput: host.querySelector(".ln-importFile"),
      // g12 上手引导
      guide: host.querySelector(".ln-guide"),
      guideExport: host.querySelectorAll(".ln-guideActions button")[0],
      guideTools: host.querySelectorAll(".ln-guideActions button")[1],
      guideDiagnostics: host.querySelectorAll(".ln-guideActions button")[2],
      guideClose: host.querySelectorAll(".ln-guideActions button")[3],
    };
  }

  function bind(ui) {
    ui.submit.addEventListener("click", () => { void submitName(); });
    // g11：撤回 / 接着上次 / 两遍法
    ui.undoButton?.addEventListener("click", () => { void undoLast(); });
    ui.resumeButton?.addEventListener("click", () => resumeLast());
    ui.clueButton?.addEventListener("click", () => toggleClueOnly());
    // g12：就地看时段依据 / 整组跳过 / 输入时质量守卫
    ui.inspectButton?.addEventListener("click", () => { void inspectCurrent(); });
    ui.skipGroupButton?.addEventListener("click", () => skipWholeGroup());
    ui.suggestButton?.addEventListener("click", () => { void suggestFromCommunity(); });
    ui.nameInput.addEventListener("input", () => scheduleNameCheck());
    // 记住光标在不在输入框里：决定下一张卡片要不要自动抢焦点
    ui.nameInput.addEventListener("focus", () => { state.focusInput = true; });
    ui.nameInput.addEventListener("blur", () => { state.focusInput = false; });
    // g12：批量命名表导出 / 导入
    ui.exportButton?.addEventListener("click", () => { void exportNameTable(); });
    ui.importButton?.addEventListener("click", () => ui.importInput?.click());
    ui.importInput?.addEventListener("change", () => { void importNameTable(); });
    // g12：引导卡片
    ui.guideExport?.addEventListener("click", () => { void exportNameTable(); });
    ui.guideTools?.addEventListener("click", () => switchTab("listen-tools"));
    ui.guideDiagnostics?.addEventListener("click", () => switchTab("debug"));
    ui.guideClose?.addEventListener("click", () => hideGuide(true));
    // 进度面板里的「使用引导」：把收起的引导重新打开
    ui.guideButton?.addEventListener("click", () => showGuide());
    ui.replay.addEventListener("click", () => { void replay(); });
    ui.nextSegment.addEventListener("click", () => { void shiftSegment(); });
    ui.skip.addEventListener("click", moveNext);
    ui.previous.addEventListener("click", movePrevious);
    ui.nameInput.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void submitName();
    });
    // 音频加载失败时把原因显示出来，别静默卡住
    ui.audio.addEventListener("error", () => {
      if (ui.audio.getAttribute("src")) setStatus("这一段取不到音频，可以按 N 换一段，或检查曲库文件和 ffmpeg。", "fault");
    });
    ui.audio.addEventListener("loadeddata", () => { void autoplay(ui); });
  }

  // ------------------------------------------------------------ 渲染

  function renderChips() {
    if (!elements) return;
    // 用服务端返回的总数（不是本次收到的条数），否则会被分页上限截断
    const remain = Math.max(0, (state.total || state.songs.length) - state.index);
    elements.remainChip.textContent = `还剩 ${remain} 首没名字`;
    elements.namedChip.textContent = `本次已命名 ${state.named} 首`;
    if (state.backupFile) elements.namedChip.title = `数据库备份：${state.backupFile}`;
    renderProgress();
  }

  /** g11：进度面板文字与按钮可用性。 */
  function renderProgress() {
    if (!elements || !elements.progressLine) return;
    const done = Number(state.namedTotal) || 0;
    const all = Number(state.totalAll) || (done + (Number(state.total) || state.songs.length));
    const position = Math.min(state.index + 1, state.songs.length);
    const parts = [
      `总进度 ${done} / ${all} 首已命名`,
      `今天 +${Number(state.today) || 0}`,
      state.songs.length ? `本次进度 ${position} / ${state.songs.length}` : "本次已到底",
    ];
    if (state.clueOnly) parts.push("两遍法：只看有线索的");
    elements.progressLine.textContent = parts.join(" · ");
    const last = state.lastFolder || "";
    elements.undoButton.disabled = !(Number(state.undoable) > 0);
    elements.undoButton.textContent = Number(state.undoable) > 0
      ? `撤回上一条（Ctrl+Z · 还可撤 ${state.undoable} 条）`
      : "撤回上一条（暂无可撤）";
    const resumable = last && state.songs.some(song => song.folder === last);
    elements.resumeButton.disabled = !resumable;
    elements.resumeButton.title = resumable ? `回到 ${last}` : "（上次听到的那首已经没有未命名项了）";
    elements.clueButton.disabled = !state.songs.length;
    elements.clueButton.textContent = state.clueOnly ? "两遍法：看全部" : "两遍法：只看有线索的";
  }

  /** g11：两遍法 —— 第一遍过后只挑"有线索的"（同编号已有曲名 / 有同款群）继续听。 */
  function hasClue(song) {
    return (Array.isArray(song.sameNumber) && song.sameNumber.length > 0)
      || (Array.isArray(song.twins) && song.twins.length > 0);
  }

  function applyClueFilter() {
    state.songs = state.clueOnly ? state.allSongs.filter(hasClue) : state.allSongs.slice();
    state.index = 0;
    state.segment = 0;
  }

  function toggleClueOnly() {
    if (!state.allSongs.length) return;
    state.clueOnly = !state.clueOnly;
    applyClueFilter();
    renderCard();
    setStatus(state.clueOnly
      ? `两遍法：只看有线索的，共 ${state.songs.length} 首（同编号已有曲名或同款群）`
      : `已切回全部未命名，共 ${state.songs.length} 首`, "warn");
  }

  function resumeLast() {
    const last = state.lastFolder || "";
    const index = state.songs.findIndex(song => song.folder === last);
    if (index < 0) {
      setStatus("上次听到的那首已经没有未命名项了（可能刚命名过）。", "warn");
      renderProgress();
      return;
    }
    state.index = index;
    state.segment = 0;
    renderCard();
    setStatus(`已回到上次的位置：${last}`, "done");
  }

  /** g11：撤回上一条命名。 */
  async function undoLast() {
    if (!elements) return;
    elements.undoButton.disabled = true;
    try {
      const result = await request("/toy/listen-naming/undo", { method: "POST", body: "{}" });
      if (result?.progress) {
        state.today = Number(result.progress.today) || 0;
        state.named = Math.max(0, state.named - (Number(result.reverted) || 0));
      }
      state.undoable = Number(result?.remaining) || 0;
      if (result?.undone) {
        setStatus(`↩ 已撤回「${result.name}」的命名（${result.reverted} 行）`
          + (result.folders?.length ? `：${result.folders.join("、")}` : "")
          + "；该作品已放回列表，刷新页面即可继续听。", "done");
      } else {
        setStatus(`没能撤回：${result?.reason || "没有可撤回的命名"}`, "warn");
      }
      renderProgress();
    } catch (error) {
      setStatus(`撤回失败：${error.message}`, "fault");
      renderProgress();
    }
  }

  /** g11：把"听 到哪了"记到服务端（不 await，失败不影响命名）。 */
  function rememberPosition(folder) {
    if (!folder) return;
    state.lastFolder = folder;
    void request("/toy/listen-naming/position", {
      method: "POST",
      body: JSON.stringify({ folder }),
    }).catch(() => {});
  }

  // ------------------------------------------------------------ g12：质量守卫 / 整组跳过 / 就地线索

  let nameCheckTimer = 0;
  /** 输入停顿 400ms 后查一次"这个名字有没有用在别处"。 */
  function scheduleNameCheck() {
    if (!elements) return;
    clearTimeout(nameCheckTimer);
    nameCheckTimer = setTimeout(() => { void runNameCheck(); }, 400);
  }

  async function runNameCheck() {
    if (!elements) return;
    const song = current();
    const value = elements.nameInput.value.trim();
    // 没输入内容：退回到"同编号已有写法"提示，而不是把整行藏起来
    if (!value || !song) { paintClueHint(song ?? { sameNumber: [], tags: [] }); return; }
    try {
      const data = await request(`/toy/listen-naming/name-check?name=${encodeURIComponent(value)}`
        + `&folder=${encodeURIComponent(song.folder)}`);
      const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
      const siblings = Array.isArray(data?.siblings) ? data.siblings : [];
      elements.nameGuard.replaceChildren();
      let warn = false;
      if (conflicts.length) {
        warn = true;
        elements.nameGuard.append(node("span",
          `⚠ 「${value}」已经用在 ${conflicts.length} 个别的编号上：`
          + `${conflicts.slice(0, 3).map(x => x.folder).join("、")}${conflicts.length > 3 ? " …" : ""}`, "ln-guardLine"));
      }
      if (siblings.length) {
        elements.nameGuard.append(node("span", `同编号已有写法：${siblings.join(" / ")}`, "ln-guardLine"));
      }
      if (!conflicts.length && !siblings.length) { paintClueHint(song); return; }
      elements.nameGuard.hidden = false;
      elements.nameGuard.dataset.kind = warn ? "warn" : "hint";
    } catch { /* 检查失败就不打扰用户 */ }
  }

  /** g12：整组跳过 —— 把同编号 + 同款群的未命名作品一起挪出本次队列。 */
  function skipWholeGroup() {
    const song = current();
    if (!song || !elements) return;
    const number = String(song.number ?? "");
    const targets = new Set([song.folder, ...(song.twins ?? [])]);
    for (const item of state.allSongs) {
      if (number && String(item.number ?? "") === number) targets.add(item.folder);
    }
    const before = state.songs.length;
    state.allSongs = state.allSongs.filter(item => !targets.has(item.folder));
    if (state.clueOnly) applyClueFilter();
    else state.songs = state.songs.filter(item => !targets.has(item.folder));
    state.total = state.allSongs.length;
    if (state.index >= state.songs.length) state.index = Math.max(0, state.songs.length - 1);
    state.segment = 0;
    renderCard();
    setStatus(`已跳过同编号/同款群 ${before - state.songs.length} 首（编号 ${number || "?"}），本次队列还剩 ${state.songs.length} 首`, "warn");
  }

  // ------------------------------------------------------------ g12：社区比对 / 批量命名表

  /** 切到另一个页签（引导按钮用）：直接点左侧页签，跟用户手动点一样。 */
  function switchTab(tab) {
    const button = document.querySelector('.sideTab[data-tab="' + tab + '"]');
    if (button) button.click();
  }

  /** 收起/展开上手引导；收起后记在 localStorage，下次不再自动弹。 */
  function hideGuide(remember) {
    if (!elements?.guide) return;
    elements.guide.hidden = true;
    if (remember) {
      try { global.localStorage?.setItem(GUIDE_KEY, "1"); } catch { /* 忽略 */ }
      setStatus("引导已收起。需要时点上面「命名进度」里的「使用引导」再打开。", "done");
    }
  }

  function showGuide() {
    if (!elements?.guide) return;
    elements.guide.hidden = false;
    try { global.localStorage?.setItem(GUIDE_KEY, "0"); } catch { /* 忽略 */ }
    elements.guide.scrollIntoView?.({ block: "nearest" });
  }

  /** 首次进入自动展示引导（已收起过就不再弹）。 */
  function maybeShowGuide() {
    if (!elements?.guide) return;
    let seen = "";
    try { seen = global.localStorage?.getItem(GUIDE_KEY) || ""; } catch { seen = ""; }
    elements.guide.hidden = seen === "1";
  }

  /** g12：社区名单比对 —— 命中就把曲名填进输入框（只预填，不写库）。 */
  async function suggestFromCommunity() {
    const song = current();
    if (!song || !elements) return;
    elements.suggestButton.disabled = true;
    setStatus("正在和社区名单比对（首次要算这首的指纹，约几秒）…");
    try {
      const data = await request("/toy/listen-naming/community/suggest?folder=" + encodeURIComponent(song.folder));
      if (data?.matched) {
        elements.nameInput.value = data.name;
        elements.nameInput.focus();
        setStatus(`社区名单命中：建议曲名「${data.name}」（最差一段相似度 ${Math.round((data.worst ?? 0) * 1000) / 1000}）——`
          + "确认没问题就按回车写库。", "done");
        void runNameCheck();
      } else {
        setStatus(`社区名单没认出这首：${data?.reason || "没有命中"}（名单里共 ${data?.catalogCount ?? 0} 条，可到「试听工具」页刷新名单）`, "warn");
      }
    } catch (error) {
      setStatus(`比对失败：${error.message}`, "fault");
    } finally {
      elements.suggestButton.disabled = false;
    }
  }

  /** 导出：把待命名清单存成 CSV（Excel 可直接打开填「曲名」列）。 */
  async function exportNameTable() {
    if (!elements) return;
    elements.exportButton.disabled = true;
    setStatus("正在生成命名表…");
    try {
      const data = await request("/toy/listen-naming/name-table");
      const blob = new global.Blob([data.csv], { type: "text/csv;charset=utf-8" });
      const url = global.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = data.fileName || "olivia-命名表.csv";
      document.body.append(link);
      link.click();
      link.remove();
      global.setTimeout(() => global.URL.revokeObjectURL(url), 4000);
      setStatus(`✓ 已导出 ${data.count} 行到「${link.download}」；填好第 3 列「曲名」后点「导入命名表」。${data.hint || ""}`, "done");
    } catch (error) {
      setStatus(`导出失败：${error.message}`, "fault");
    } finally {
      elements.exportButton.disabled = false;
    }
  }

  /** 导入：读 CSV → 先 dryRun 校验 → 再真写库；整批可用 Ctrl+Z 撤回。 */
  async function importNameTable() {
    if (!elements?.importInput) return;
    const file = elements.importInput.files?.[0];
    elements.importInput.value = "";
    if (!file) return;
    elements.importButton.disabled = true;
    setStatus(`正在读取「${file.name}」…`);
    try {
      const csv = await file.text();
      const check = await request("/toy/listen-naming/name-import", {
        method: "POST",
        body: JSON.stringify({ csv, dryRun: true }),
      });
      if (!check.planned) {
        setStatus(`表里没有可导入的曲名（跳过 ${check.skipped?.length ?? 0} 行）。`, "warn");
        return;
      }
      const sample = (check.sample ?? []).slice(0, 3)
        .map(item => `${item.folder} → ${item.name}${item.twins ? `（连带 ${item.twins}）` : ""}`).join("；");
      if (!global.confirm(`准备导入 ${check.planned} 首：\n\n${sample}${check.planned > 3 ? " …" : ""}\n\n`
        + "写入前会自动备份数据库，整批可以用 Ctrl+Z 一次性撤回。现在写入吗？")) return;
      const done = await request("/toy/listen-naming/name-import", {
        method: "POST",
        body: JSON.stringify({ csv }),
      });
      state.named = Number(done.progress?.session ?? state.named) || state.named;
      state.today = Number(done.progress?.today ?? state.today) || state.today;
      state.undoable = Number(done.undoable ?? state.undoable) || state.undoable;
      setStatus(`✓ 已导入：${done.applied} 首（写入 ${done.written} 行），跳过 ${done.skipped?.length ?? 0} 行；`
        + `备份：${done.backupFile}。列表里的曲目已更新，可继续听下一首。`, "done");
      await load();
    } catch (error) {
      setStatus(`导入失败：${error.message}`, "fault");
    } finally {
      elements.importButton.disabled = false;
    }
  }

  /** g12：就地看时段依据（缩略图 + 亮度/色温 + 判定）。 */  async function inspectCurrent() {
    const song = current();
    if (!song || !elements?.clueOut) return;
    const out = elements.clueOut;
    elements.inspectButton.disabled = true;
    out.hidden = false;
    out.replaceChildren(node("p", "正在抽帧分析（每段调用一次 ffmpeg，首次约 1~3 秒）…", "fieldHint"));
    try {
      const data = await request("/toy/listen-naming/time-of-day/inspect?folder=" + encodeURIComponent(song.folder));
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const row = node("div", null, "ln-todRow");
      for (const segment of segments) {
        const card = node("section", null, "settingsBlock ln-todCard");
        card.append(
          node("strong", `第 ${segment.index + 1} 段`),
          node("p", `亮度 ${segment.brightness ?? "?"} · 色温 ${segment.warmth ?? "?"}`, "fieldHint"),
          node("p", `判定：${segment.verdictLabel ?? "?"}`, "ln-todVerdict"),
        );
        if (segment.thumbnailUrl) {
          const img = node("img", null, "ln-todThumb");
          img.src = segment.thumbnailUrl;
          img.alt = `第 ${segment.index + 1} 段画面缩略图`;
          img.loading = "lazy";
          img.width = 160;
          card.append(img);
        }
        row.append(card);
      }
      out.replaceChildren(row);
      if (!segments.length) out.replaceChildren(node("p", "这首没有可用的视频画面。", "fieldHint"));
    } catch (error) {
      out.replaceChildren(node("p", "查看失败：" + error.message, "fieldHint"));
    } finally {
      elements.inspectButton.disabled = false;
    }
  }

  function renderCard() {
    if (!elements) return;
    const song = current();
    renderChips();
    if (!song) {
      elements.folder.textContent = "🎉 全部听完了";
      elements.meta.textContent = "";
      elements.sameNumberList.replaceChildren();
      elements.twinLine.textContent = "";
      elements.pathLine.textContent = "";
      elements.audio.removeAttribute("src");
      elements.audio.load();
      elements.nameInput.value = "";
      elements.nameInput.disabled = true;
      elements.submit.disabled = true;
      elements.segmentStage.textContent = "已全部听完";
      elements.segmentPercent.textContent = "";
      elements.segmentTrack.style.width = "100%";
      setStatus(`本次一共命名了 ${state.named} 首。`, "done");
      return;
    }

    const twins = Array.isArray(song.twins) ? song.twins : [];
    elements.folder.textContent = song.folder;
    elements.meta.textContent = formatFeature(song.feature, song.folder);
    elements.nameInput.disabled = false;
    elements.submit.disabled = false;
    elements.nameInput.value = "";
    elements.segmentStage.textContent = `第 ${state.segment + 1} 段`
      + `（第 ${state.segmentStart + state.segment * state.segmentSeconds} 秒起）`;
    elements.segmentPercent.textContent = `${state.segment + 1} / ${state.maxSegments}`;
    elements.segmentTrack.style.width = `${Math.round((state.segment + 1) / state.maxSegments * 100)}%`;

    const sameNumber = Array.isArray(song.sameNumber) ? song.sameNumber : [];
    elements.sameNumberList.replaceChildren();
    if (sameNumber.length) {
      for (const item of sameNumber.slice(0, 5)) {
        const line = node("li");
        line.append(node("span", item.folder, "ln-sameNumberFolder"), node("strong", item.name));
        elements.sameNumberList.append(line);
      }
    } else {
      const line = node("li", "同一编号下还没有已命名的作品", "empty");
      elements.sameNumberList.append(line);
    }

    elements.twinLine.textContent = twins.length
      ? `★ 同款群 ${twins.length} 首会一起命名（音频实锤同一录音）：${twins.slice(0, 6).join("、")}${twins.length > 6 ? " …" : ""}`
      : (state.hasGroupCsv ? "这首歌不在同款群里，只给本首命名。" : "没有同款群记录，只给本首命名。");
    elements.pathLine.textContent = `${state.libraryRoot}\\${song.folder}`;

    paintClueHint(song);   // g12：选中就先把"同编号已有写法"摆出来
    loadClip();
    // 只在"上一张卡片时光标就在输入框里"时才自动抢焦点。
    // 否则（用户按 Esc 移出后用 S 跳过等）抢焦点会把裸键又变成打字，S/N/空格/← 就废了。
    if (state.focusInput) elements.nameInput.focus();
    rememberPosition(song.folder);   // g11：记住听到哪了（失败不影响操作）
  }

  /** g12：不用打字也先把线索摆出来 —— 同编号已有的曲名 + 这首已有的标签。 */
  function paintClueHint(song) {
    if (!elements?.nameGuard) return;
    const sameNumber = Array.isArray(song.sameNumber) ? song.sameNumber : [];
    const names = [...new Set(sameNumber.map(item => item.name).filter(Boolean))];
    const tags = Array.isArray(song.tags) ? song.tags : [];
    const tagText = tags.map(name => ({ later: "待定", doubt: "存疑", like: "喜欢" }[name] ?? name)).join(" · ");
    if (!names.length && !tagText) {
      elements.nameGuard.hidden = true;
      delete elements.nameGuard.dataset.kind;
      return;
    }
    elements.nameGuard.replaceChildren();
    if (names.length) {
      elements.nameGuard.append(node("span", `同编号已有写法：${names.slice(0, 5).join(" / ")}`, "ln-guardLine"));
    }
    if (tagText) {
      elements.nameGuard.append(node("span", `这首的标记：${tagText}`, "ln-guardLine"));
    }
    elements.nameGuard.hidden = false;
    elements.nameGuard.dataset.kind = "hint";
  }

  // ------------------------------------------------------------ 播放

  function clipUrl(song, segment) {
    return `/toy/listen-naming/clip?folder=${encodeURIComponent(song.folder)}&seg=${segment}`;
  }

  async function autoplay(ui) {
    try {
      await ui.audio.play();
    } catch {
      setStatus("浏览器拦截了自动播放，按一下播放按钮或空格即可。", "warn");
    }
  }

  function loadClip() {
    const song = current();
    if (!song || !elements) return;
    const url = clipUrl(song, state.segment);
    if (elements.audio.getAttribute("src") === url) elements.audio.currentTime = 0;
    else elements.audio.src = url;
    setStatus(`正在播放「${song.folder}」第 ${state.segment + 1} 段…`);
    elements.audio.load();
    void autoplay(elements);
  }

  async function replay() {
    if (!elements || !current()) return;
    if (!elements.audio.getAttribute("src")) { loadClip(); return; }
    elements.audio.currentTime = 0;
    await autoplay(elements);
  }

  async function shiftSegment() {
    if (!current()) return;
    state.segment = (state.segment + 1) % state.maxSegments;
    loadClip();
  }

  function moveNext() {
    if (!state.songs.length) return;
    if (state.index >= state.songs.length - 1) {
      state.index = state.songs.length;
      state.segment = 0;
      renderCard();
      return;
    }
    state.index += 1;
    state.segment = 0;
    renderCard();
  }

  function movePrevious() {
    if (!state.songs.length) return;
    state.index = Math.max(0, state.index - 1);
    state.segment = 0;
    renderCard();
  }

  // ------------------------------------------------------------ 写库

  async function submitName() {
    const song = current();
    if (!song || !elements || elements.submit.disabled) return;
    const name = elements.nameInput.value.trim();
    if (!name) {
      setStatus("先打上曲名再回车。", "warn");
      elements.nameInput.focus();
      return;
    }
    const token = ++requestEpoch;
    elements.submit.disabled = true;
    elements.nameInput.disabled = true;
    setStatus(`正在写库：${name} …`);
    try {
      const result = await request("/toy/listen-naming/name", {
        method: "POST",
        body: JSON.stringify({ folder: song.folder, name }),
      });
      if (token !== requestEpoch) return;
      state.named = Number.isFinite(Number(result.named)) ? Number(result.named) : state.named + 1;
      state.backupFile = result.backupFile || state.backupFile;
      // g11：进度与撤回条数由服务端权威返回
      if (result.progress) state.today = Number(result.progress.today) || state.today;
      state.undoable = Number(result.undoable) || state.undoable + 1;
      const twins = Array.isArray(result.twins) ? result.twins : [];
      // 连带命名的同款群也要从"未命名"里去掉，否则两遍法过滤视图会残留
      const gone = new Set([song.folder, ...twins]);
      state.allSongs = state.allSongs.filter(item => !gone.has(item.folder));
      state.namedTotal = Number(state.namedTotal || 0) + (Number(result.written) || 1);
      state.total = state.allSongs.length;
      if (state.clueOnly) applyClueFilter();
      else state.songs.splice(state.index, 1);
      setStatus(
        `✓ 已写库：${name}（本次第 ${state.named} 首 · 今天 +${state.today}）`
        + (twins.length ? `，同款群连带 ${twins.length} 首：${twins.join("、")}` : "")
        + `；备份：${state.backupFile}`,
        "done",
      );
      if (state.index >= state.songs.length) state.index = state.songs.length;
      state.segment = 0;
      elements.submit.disabled = false;
      elements.nameInput.disabled = false;
      renderCard();
    } catch (error) {
      if (token !== requestEpoch) return;
      elements.submit.disabled = false;
      elements.nameInput.disabled = false;
      setStatus(`写库失败：${error.message}`, "fault");
      elements.nameInput.focus();
    }
  }

  // ------------------------------------------------------------ 数据加载

  async function load() {
    // 先问一次分享意愿（试听台开始之前）
    if (!(await ensureConsent())) {
      // 用户暂不分享：照常进入试听台，只是不参与社区共享
    }
    if (!elements || state.loading) return;
    state.loading = true;
    setStatus("正在读取曲库…");
    try {
      const data = await request("/toy/listen-naming/list?pageSize=3000");
      state.allSongs = Array.isArray(data.songs) ? data.songs : [];
      state.songs = state.allSongs.slice();
      state.clueOnly = false;
      state.total = Number(data.total) || state.songs.length;
      state.totalAll = Number(data.totalAll) || state.total;
      state.namedTotal = Number(data.namedTotal) || 0;
      state.named = Number(data.named) || 0;
      state.undoable = Number(data.undoable) || 0;
      state.today = Number(data.progress?.today) || 0;
      state.lastFolder = String(data.progress?.lastFolder || "");
      state.segmentSeconds = Number(data.segmentSeconds) || 15;
      state.segmentStart = Number(data.segmentStart) || 20;
      state.maxSegments = Number(data.maxSegments) || MAX_SEGMENTS;
      state.clipsDir = data.clipsDir || "";
      state.libraryRoot = data.libraryRoot || "";
      state.backupFile = data.backupFile || "";
      state.hasFeatureCsv = data.hasFeatureCsv === true;
      state.hasGroupCsv = data.hasGroupCsv === true;
      state.index = 0;
      state.segment = 0;
      state.loaded = true;
      renderCard();
    } catch (error) {
      setStatus(`读取失败：${error.message}`, "fault");
    } finally {
      state.loading = false;
    }
  }

  // ------------------------------------------------------------ 快捷键

  function keydown(event) {
    if (!elements || elements.host.hidden) return;
    // g11：撤回（Ctrl+Z / Cmd+Z）—— 必须在下面那道"带修饰键直接 return"之前处理
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      void undoLast();
      return;
    }
    // g12：Ctrl+→ / Ctrl+S = 整组跳过（同编号 + 同款群一起跳过，兜底用）。
    // 输入框默认是带焦点的，所以这里**不能**按"是否可编辑"挡掉：
    // Ctrl 组合是明确意图，挡掉的话界面上写的 Ctrl+→ 就成了摆设。
    if ((event.ctrlKey || event.metaKey) && !event.altKey
      && (event.key === "ArrowRight" || event.key === "s" || event.key === "S")) {
      event.preventDefault();
      skipWholeGroup();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const editable = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable;
    const inNameInput = target === elements.nameInput;

    // 输入框默认带焦点，裸键（S / N / 空格 / → / ←）会被当成打字。
    // 想用裸快捷键：按 Esc 把光标移出输入框（下面这段），或直接点按钮。
    if (event.key === "Escape" && (inNameInput || editable)) {
      event.preventDefault();
      target.blur();
      setStatus("已离开输入框：现在 S 跳过、N 换一段、空格 重播、← 上一首都能用了（点输入框可以继续打字）。");
      return;
    }
    if (event.key === " " && !inNameInput) {
      event.preventDefault();
      void replay();
      return;
    }
    if (event.key === "Enter") {
      // 输入框里的回车由输入框自己的监听器处理
      if (inNameInput) return;
      if (editable) return;
      event.preventDefault();
      void submitName();
      return;
    }
    if (event.key === "ArrowRight") {
      if (editable) return;
      event.preventDefault();
      moveNext();
      return;
    }
    if (event.key === "ArrowLeft") {
      if (editable) return;
      event.preventDefault();
      movePrevious();
      return;
    }
    if (inNameInput || editable) return;
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      void shiftSegment();
    } else if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      moveNext();
    }
  }

  // ------------------------------------------------------------ 页签联动

  function installTabHook() {
    const button = document.querySelector('.sideTab[data-tab="' + TAB + '"]');
    if (!button) return;
    const boot = () => {
      if (!elements) elements = buildInterface();
      if (elements && !state.loaded) void load();
      else if (elements) elements.nameInput.focus();
    };
    if (button.classList.contains("active")) boot();
    button.addEventListener("click", boot);
    // 页签也可能被程序切换（例如点通知），补一层观察
    const host = document.querySelector('.tabPage[data-page="' + TAB + '"]');
    if (host && typeof global.MutationObserver === "function") {
      new global.MutationObserver(() => { if (!host.hidden) boot(); })
        .observe(host, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  function start() {
    installTabHook();
    document.addEventListener("keydown", keydown);
  }

  global.OliviaSoulListenNaming = {
    start,
    load,
    state,
    get listLength() { return state.songs.length; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(window);
