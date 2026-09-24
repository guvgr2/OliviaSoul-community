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
      index: 0,
      segment: 0,
      named: 0,
      total: 0,
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
    nameInput.placeholder = "听出来了吗？打曲名，回车写库（听不出就按 S 跳过）";
    nameInput.setAttribute("aria-label", "曲名");
    const submit = node("button", "写库（回车）");
    submit.type = "button";
    const submitHint = node("small", "写库前自动备份数据库；同款群会一起命名（只补空位）", "ln-submitHint");
    const nameBlock = node("div", null, "ln-nameBlock");
    nameBlock.append(nameInput, submitHint);
    nameRow.append(nameBlock, submit);

    const actions = node("div", null, "actions ln-actions");
    const replay = node("button", "重播（空格）", "secondary");
    const nextSegment = node("button", "换一段（N）", "secondary");
    const skip = node("button", "跳过（S）", "secondary");
    const previous = node("button", "上一首（←）", "secondary");
    for (const button of [replay, nextSegment, skip, previous]) button.type = "button";
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
      "快捷键：空格 重播 · 回车 写库 · N 换一段 · S / → 跳过 · ← 上一首。" +
      "每段 15 秒，从第 20 秒起最多 6 段；切片缓存在 UserData\\listen-clips。",
    );

    card.append(folder, meta, audio, segmentProgress, nameRow, actions, status, info, help);
    host.append(panelHead, card);
    host.dataset.listenNamingReady = "1";

    const collected = collect(host);
    bind(collected);
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
    };
  }

  function bind(ui) {
    ui.submit.addEventListener("click", () => { void submitName(); });
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
    const remain = Math.max(0, state.songs.length - state.index);
    elements.remainChip.textContent = `还剩 ${remain} 首没名字`;
    elements.namedChip.textContent = `本次已命名 ${state.named} 首`;
    if (state.backupFile) elements.namedChip.title = `数据库备份：${state.backupFile}`;
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

    loadClip();
    elements.nameInput.focus();
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
      const twins = Array.isArray(result.twins) ? result.twins : [];
      setStatus(
        `✓ 已写库：${name}（第 ${state.named} 首）`
        + (twins.length ? `，同款群连带 ${twins.length} 首：${twins.join("、")}` : "")
        + `；备份：${state.backupFile}`,
        "done",
      );
      // 已经命名的从列表里剔掉，索引位置保持不变 = 自动跳下一首
      state.songs.splice(state.index, 1);
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
      state.songs = Array.isArray(data.songs) ? data.songs : [];
      state.total = Number(data.total) || state.songs.length;
      state.named = Number(data.named) || 0;
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
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const editable = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable;
    const inNameInput = target === elements.nameInput;

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
