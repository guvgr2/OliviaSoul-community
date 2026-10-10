// 「歌单与收藏」独立页：与游戏里的歌单是同一份数据。
// 程序端只做重活：一次灌入整个曲库、拖拽排序、看大尺寸二维码、批量导入导出。
// 观感全部复用既有类（panelHead / settingsBlock / actions / ln-diagTable / noticeDialog），
// 不引入新色值、新字体、新渐变、新阴影。
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "folders";
  const BASE = "/toy/folders";
  const SVG_NS = "http://www.w3.org/2000/svg";
  // 曲库上千首时「一键灌入整个曲库」会让歌单很长：一次只画这么多行，
  // 否则几千个 <li>（每个都带拖拽监听）会把页面卡住。拖拽只在整单都画出来时开放。
  const RENDER_LIMIT = 200;
  // 页内上手引导（照 g12 的老规矩）：收起状态记在 localStorage，且**另立 key** ——
  // 用户可能在「曲名与时段」那边收起过引导，不代表他想在这一页也收起。
  const GUIDE_KEY = "oliviaSoul.folders.guideDismissed";

  function guideDismissed() {
    try { return global.localStorage?.getItem(GUIDE_KEY) === "1"; } catch { return false; }
  }
  function rememberGuide(dismissed) {
    try { global.localStorage?.setItem(GUIDE_KEY, dismissed ? "1" : "0"); } catch { /* 忽略 */ }
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || `请求失败（${body.code}）`);
    return body && "data" in body ? body.data : body;
  }

  // 危险操作走页内确认框（不用原生 confirm）：与「运行日志」等处同一套 .
  // #64：优先用 app.js 暴露的 window.OliviaSoulNotice —— 层只有一份 DOM，
  // 自己摸 DOM + 自挂 click 时 Esc/Enter 会被 app.js 的全局 keydown 直接关层，
  // 这里注册的 Promise 就没人兑现（删除歌单的确认框会静默挂起）。
  // 下面自建路径只在 app.js 没跑起来时兜底，那时也没有那个 keydown。
  function confirmDialog(title, message, confirmText) {
    const shared = global.OliviaSoulNotice;
    if (shared && typeof shared.openNotice === "function")
      return shared.openNotice({ title, message, confirmText, cancelText: "取消" });
    const layer = document.getElementById("noticeLayer");
    const titleNode = document.getElementById("noticeTitle");
    const messageNode = document.getElementById("noticeMessage");
    const confirm = document.getElementById("noticeConfirm");
    const cancel = document.getElementById("noticeCancel");
    if (!layer || !titleNode || !messageNode || !confirm || !cancel) return Promise.resolve(global.confirm(message));
    return new Promise(resolvePromise => {
      titleNode.textContent = title;
      messageNode.textContent = message;
      cancel.hidden = false;
      cancel.textContent = "取消";
      confirm.textContent = confirmText;
      layer.hidden = false;
      const finish = value => {
        layer.hidden = true;
        confirm.removeEventListener("click", onYes);
        cancel.removeEventListener("click", onNo);
        resolvePromise(value);
      };
      const onYes = () => finish(true);
      const onNo = () => finish(false);
      confirm.addEventListener("click", onYes);
      cancel.addEventListener("click", onNo);
    });
  }

  // 二维码绘制：后端只给黑白模块，这里画成 SVG（≤30 首最大约 105×105，路径一次拼完）。
  function renderQr(qr) {
    const quiet = 2;
    const span = qr.size + quiet * 2;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "fm-qr");
    svg.setAttribute("viewBox", `0 0 ${span} ${span}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "歌单二维码");
    const background = document.createElementNS(SVG_NS, "rect");
    background.setAttribute("width", String(span));
    background.setAttribute("height", String(span));
    background.setAttribute("fill", "#ffffff");
    svg.append(background);
    let path = "";
    qr.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] === "1") path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    });
    const dark = document.createElementNS(SVG_NS, "path");
    dark.setAttribute("d", path);
    dark.setAttribute("fill", "#111114");
    svg.append(dark);
    return svg;
  }

  function formatDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!total) return "";
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  // 页内就地引导：照 listen-naming.js 的「三步上手」模板（settingsBlock + settingsBlockHead
  // + <ol> + fieldHint + actions），只复用既有样式类，不新增 CSS、不写死颜色字号。
  function buildGuide() {
    const section = node("section", null, "settingsBlock");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "三步上手（建歌单 → 灌曲库 → 给别人）"),
      node("small", "第一次用看这里；点「知道了，收起」不再自动展开，之后可点工具条里的「使用引导」再打开"),
    );
    const steps = node("ol");
    steps.append(
      node("li", "先在「新歌单名」里起个名字、点「新建歌单」；名字撞车会自动加后缀，不用自己避让。"),
      node("li", "选中左边的歌单，点「一键灌入整个曲库」把它填满；用每行的 ↑ ↓ 调顺序，「移出」把某首拿掉（曲库文件不受影响）。"),
      node("li", "要给别人：选中歌单点「导出二维码」——不超过 30 首出二维码，可以「复制文本」或「下载」.osfolder 文件；对方用「导入 .osfolder 文件」或「导入粘贴的文本」导进来，匹配不上的曲目会逐条列出来，不会静默丢。"),
    );
    const hint = node("p",
      "这里的歌单与游戏里的歌单是同一份数据：游戏里加了歌，回这一页点「刷新」就能看到。",
      "fieldHint");
    const actions = node("div", null, "actions");
    const close = node("button", "知道了，收起", "secondary");
    close.type = "button";
    close.addEventListener("click", () => { rememberGuide(true); section.hidden = true; });
    actions.append(close);
    section.append(head, steps, hint, actions);
    section.hidden = guideDismissed();
    return section;
  }

  function buildPage() {
    const wrap = document.createDocumentFragment();

    // ---- 抬头 ----
    const head = node("div", null, "panelHead");
    const left = node("div");
    left.append(
      node("h2", "歌单与收藏"),
      node("p", "与游戏里的歌单是同一份数据：游戏端管日常加歌，这里一次灌入整个曲库、拖拽排序、看大尺寸二维码、批量导入导出。"),
    );
    const chips = node("div", null, "ln-statusChips");
    const chipFolders = node("span", "—", "ln-chip");
    const chipItems = node("span", "—", "ln-chip");
    chips.append(chipFolders, chipItems);
    head.append(left, chips);
    wrap.append(head);
    const guideSection = buildGuide();
    wrap.append(guideSection);

    // ---- 工具条 ----
    const tools = node("section", null, "settingsBlock");
    tools.append(node("h3", "歌单"));
    const createRow = node("div", null, "actions");
    const nameInput = node("input", null, "fm-nameInput");
    nameInput.type = "text";
    nameInput.placeholder = "新歌单名（最多 40 个字）";
    nameInput.setAttribute("aria-label", "新歌单名");
    const createButton = node("button", "新建歌单", "");
    createButton.type = "button";
    createRow.append(nameInput, createButton);
    const heavyRow = node("div", null, "actions");
    const libraryButton = node("button", "一键灌入整个曲库", "secondary");
    const importTextButton = node("button", "导入粘贴的文本", "secondary");
    const pickFileButton = node("button", "导入 .osfolder 文件", "secondary");
    const refreshButton = node("button", "刷新", "secondary");
    const guideButton = node("button", "使用引导", "secondary");
    for (const button of [libraryButton, importTextButton, pickFileButton, refreshButton, guideButton]) button.type = "button";
    const fileInput = node("input", null, "fm-fileInput");
    fileInput.type = "file";
    fileInput.accept = ".osfolder,.txt,text/plain";
    fileInput.hidden = true;
    heavyRow.append(libraryButton, importTextButton, pickFileButton, refreshButton, guideButton, fileInput);
    guideButton.addEventListener("click", () => {
      rememberGuide(false);
      guideSection.hidden = false;
      guideSection.scrollIntoView({ block: "nearest" });
    });
    const pasteArea = node("textarea", null, "fm-paste");
    pasteArea.rows = 2;
    pasteArea.placeholder = "把另一台机器导出的歌单文本粘在这里（以 OSF1| 开头）";
    pasteArea.setAttribute("aria-label", "粘贴歌单文本");
    const result = node("p", "", "result");
    result.setAttribute("role", "status");
    tools.append(createRow, heavyRow, pasteArea, result);
    wrap.append(tools);

    // ---- 两栏：左歌单、右曲目 ----
    const layout = node("div", null, "fm-layout");
    const listBlock = node("section", null, "settingsBlock fm-listBlock");
    listBlock.append(node("h3", "全部歌单"));
    const list = node("ul", null, "fm-list");
    listBlock.append(list);
    const detailBlock = node("section", null, "settingsBlock fm-detailBlock");
    const detailHead = node("div", null, "fm-detailHead");
    const detailTitle = node("h3", "选一个歌单");
    const detailActions = node("div", null, "fm-detailActions");
    const renameButton = node("button", "重命名", "secondary");
    const deleteButton = node("button", "删除歌单", "secondary");
    const exportButton = node("button", "导出二维码", "");
    for (const button of [renameButton, deleteButton, exportButton]) {
      button.type = "button";
      button.disabled = true;
    }
    detailActions.append(renameButton, exportButton, deleteButton);
    detailHead.append(detailTitle, detailActions);
    const renameRow = node("div", null, "actions fm-renameRow");
    renameRow.hidden = true;
    const renameInput = node("input", null, "fm-nameInput");
    renameInput.type = "text";
    renameInput.setAttribute("aria-label", "歌单新名字");
    const renameSave = node("button", "保存名称", "");
    const renameCancel = node("button", "取消", "secondary");
    renameSave.type = "button";
    renameCancel.type = "button";
    renameRow.append(renameInput, renameSave, renameCancel);
    const detailHint = node("p", "", "fm-hint");
    const filterInput = node("input", null, "fm-nameInput fm-filter");
    filterInput.type = "search";
    filterInput.placeholder = "在这一单里筛选曲目（按名字或编号）";
    filterInput.setAttribute("aria-label", "筛选曲目");
    const filterRow = node("div", null, "actions fm-filterRow");
    filterRow.append(filterInput);
    const itemList = node("ul", null, "fm-rows");
    const exportBlock = node("section", null, "settingsBlock fm-exportBlock");
    exportBlock.hidden = true;
    detailBlock.append(detailHead, renameRow, detailHint, filterRow, itemList, exportBlock);
    layout.append(listBlock, detailBlock);
    wrap.append(layout);

    // ---- 状态 ----
    let folders = [];
    let selectedId = "";
    let detail = null;
    let dragFrom = -1;

    function setResult(text) {
      result.textContent = text || "";
    }

    function selectedFolder() {
      return folders.find(folder => folder.id === selectedId) ?? null;
    }

    function renderChips() {
      chipFolders.textContent = `${folders.length} 个歌单`;
      chipItems.textContent = detail ? `当前 ${detail.items.length} 首` : "当前 —";
    }

    function renderList() {
      list.replaceChildren();
      if (!folders.length) {
        list.append(node("li", "还没有歌单。上面输入名字点「新建歌单」，或直接「一键灌入整个曲库」。", "empty"));
        return;
      }
      for (const folder of folders) {
        const row = node("li", null, "fm-listRow");
        row.dataset.folderId = folder.id;
        if (folder.id === selectedId) row.classList.add("active");
        const button = node("button", null, "fm-listButton");
        button.type = "button";
        button.append(node("span", folder.name, "fm-listName"), node("span", String(folder.itemCount), "fm-listCount"));
        button.addEventListener("click", () => select(folder.id));
        row.append(button);
        list.append(row);
      }
    }

    function renderDetail() {
      itemList.replaceChildren();
      exportBlock.hidden = true;
      exportBlock.replaceChildren();
      const folder = selectedFolder();
      const has = Boolean(folder && detail);
      renameButton.disabled = !has;
      deleteButton.disabled = !has;
      exportButton.disabled = !has;
      detailTitle.textContent = has ? `${detail.name}` : "选一个歌单";
      detailHint.textContent = has
        ? `${detail.items.length} 首 · 拖动行可以调整顺序（歌单内的顺序就是游戏里「夹内循环」的播放顺序）`
        : "";
      if (!has) return;
      if (!detail.items.length) {
        itemList.append(node("li", "这个歌单还是空的 —— 用上面的「一键灌入整个曲库」，或在游戏里点歌曲行上的「加入歌单」。", "empty"));
        return;
      }
      const keyword = filterInput.value.trim().toLocaleLowerCase();
      const all = detail.items;
      const visible = keyword
        ? all.filter(item => `${item.name} ${item.originalName ?? ""} ${item.itemId}`.toLocaleLowerCase().includes(keyword))
        : all;
      const shown = visible.slice(0, RENDER_LIMIT);
      if (keyword) detailHint.textContent = `筛出 ${visible.length} 首 / 共 ${all.length} 首`;
      else if (visible.length > RENDER_LIMIT) {
        detailHint.textContent = `共 ${all.length} 首，只画出前 ${RENDER_LIMIT} 首 —— 用右边的筛选框缩小范围（顺序调整用行末的 ↑ ↓，拖动在整单都画出来时才有）。`;
      }
      // 只有在「整单都画出来」时才允许拖拽：拖拽靠行号定位，截断或筛选过就会拖错。
      const canDrag = !keyword && all.length <= RENDER_LIMIT;
      if (!shown.length) {
        itemList.append(node("li", "没有匹配的曲目。", "empty"));
        return;
      }
      shown.forEach((item, position) => {
        const index = keyword ? all.indexOf(item) : position;
        const row = node("li", null, "fm-row");
        row.draggable = canDrag;
        row.dataset.itemId = item.itemId;
        row.dataset.index = String(index);
        const handle = node("span", "⋮⋮", "fm-handle");
        handle.setAttribute("aria-hidden", "true");
        const cover = item.coverUrl || item.iconUrl || "";
        if (cover) {
          const image = node("img", null, "fm-cover");
          image.src = cover;
          image.alt = "";
          image.addEventListener("error", () => image.remove());
          row.append(handle, image);
        } else {
          row.append(handle);
        }
        const title = node("div", null, "fm-rowText");
        title.append(node("span", item.name));
        if (item.renamed) title.append(node("small", `原名：${item.originalName}`, "fm-renamed"));
        row.append(title);
        const duration = formatDuration(item.duration);
        if (duration) row.append(node("span", duration, "fm-duration"));
        const up = node("button", "↑", "secondary fm-mini");
        const down = node("button", "↓", "secondary fm-mini");
        const remove = node("button", "移出", "secondary fm-mini");
        up.type = "button";
        down.type = "button";
        remove.type = "button";
        up.title = "上移";
        down.title = "下移";
        up.disabled = index === 0;
        down.disabled = index === all.length - 1;
        up.addEventListener("click", () => move(item.itemId, "up"));
        down.addEventListener("click", () => move(item.itemId, "down"));
        remove.addEventListener("click", () => removeItem(item));
        row.append(up, down, remove);

        row.addEventListener("dragstart", event => {
          dragFrom = index;
          row.classList.add("dragging");
          event.dataTransfer?.setData("text/plain", String(index));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragend", () => {
          dragFrom = -1;
          row.classList.remove("dragging");
          for (const other of itemList.querySelectorAll(".fm-row")) other.classList.remove("dropTarget");
        });
        row.addEventListener("dragover", event => {
          if (dragFrom < 0 || dragFrom === index) return;
          event.preventDefault();
          row.classList.add("dropTarget");
        });
        row.addEventListener("dragleave", () => row.classList.remove("dropTarget"));
        row.addEventListener("drop", event => {
          event.preventDefault();
          row.classList.remove("dropTarget");
          if (dragFrom < 0 || dragFrom === index) return;
          const order = all.map(entry => entry.itemId);
          const [moved] = order.splice(dragFrom, 1);
          order.splice(index, 0, moved);
          dragFrom = -1;
          void applyOrder(order);
        });
        itemList.append(row);
      });
    }

    async function loadFolders(preferId = "") {
      const data = await api("");
      folders = data.list ?? [];
      if (!selectedId || !folders.some(folder => folder.id === selectedId)) {
        selectedId = preferId && folders.some(folder => folder.id === preferId) ? preferId : (folders[0]?.id ?? "");
      }
      if (preferId && folders.some(folder => folder.id === preferId)) selectedId = preferId;
      renderList();
      renderChips();
      if (selectedId) await loadDetail();
      else {
        detail = null;
        renderDetail();
        renderChips();
      }
    }

    async function loadDetail() {
      if (!selectedId) return;
      detail = await api(`/${encodeURIComponent(selectedId)}`);
      renderDetail();
      renderChips();
    }

    async function select(id) {
      selectedId = id;
      renderList();
      try {
        await loadDetail();
      } catch (error) {
        setResult(`读取歌单失败：${error.message}`);
      }
    }

    async function run(task, describe) {
      setResult("");
      try {
        await task();
      } catch (error) {
        setResult(`${describe}失败：${error.message}`);
      }
    }

    async function applyOrder(order) {
      await run(async () => {
        await api(`/${encodeURIComponent(selectedId)}/items/order`, {
          method: "POST", body: JSON.stringify({ itemIds: order }),
        });
        await loadDetail();
        setResult("顺序已保存。");
      }, "保存顺序");
    }

    async function move(itemId, direction) {
      await run(async () => {
        await api(`/${encodeURIComponent(selectedId)}/items/order`, {
          method: "POST", body: JSON.stringify({ itemId, direction }),
        });
        await loadDetail();
      }, "调整顺序");
    }

    async function removeItem(item) {
      await run(async () => {
        await api(`/${encodeURIComponent(selectedId)}/items`, {
          method: "DELETE", body: JSON.stringify({ itemId: item.itemId }),
        });
        await loadDetail();
        await loadFolders(selectedId);
        setResult(`已把《${item.name}》移出歌单（曲库里的文件没动）。`);
      }, "移出曲目");
    }

    // ---- 事件 ----
    createButton.addEventListener("click", () => run(async () => {
      const name = nameInput.value.trim();
      if (!name) {
        setResult("先给歌单起个名字。");
        return;
      }
      const created = await api("", { method: "POST", body: JSON.stringify({ name }) });
      nameInput.value = "";
      await loadFolders(created.id);
      setResult(`已建歌单《${created.name}》。`);
    }, "新建歌单"));

    nameInput.addEventListener("keydown", event => {
      if (event.key === "Enter") createButton.click();
    });

    libraryButton.addEventListener("click", () => run(async () => {
      if (!selectedId) {
        setResult("先选一个歌单（没有就先新建）。");
        return;
      }
      const added = await api(`/${encodeURIComponent(selectedId)}/import-library`, { method: "POST", body: "{}" });
      await loadDetail();
      await loadFolders(selectedId);
      const parts = [`已灌入 ${added.added} 首`];
      if (added.skipped) parts.push(`跳过重复 ${added.skipped} 首`);
      if (added.noMedia) parts.push(`${added.noMedia} 首没有视频、不能播，未加入`);
      setResult(`${parts.join("，")}。`);
    }, "灌入曲库"));

    importTextButton.addEventListener("click", () => run(async () => {
      const text = pasteArea.value.trim();
      if (!text) {
        setResult("先把歌单文本粘到上面的框里。");
        return;
      }
      await importText(text);
    }, "导入文本"));

    pickFileButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => run(async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      fileInput.value = "";
      await importText(text);
    }, "导入文件"));

    async function importText(text) {
      const imported = await api("/import", { method: "POST", body: JSON.stringify({ text }) });
      pasteArea.value = "";
      await loadFolders(imported.folder.id);
      const parts = [`已导入《${imported.folder.name}》：${imported.added} 首`];
      if (imported.skipped) parts.push(`跳过重复 ${imported.skipped} 首`);
      if (imported.missingCount) parts.push(`本机曲库里找不到 ${imported.missingCount} 首：${imported.missing.slice(0, 8).join("、")}${imported.missingCount > 8 ? " …" : ""}`);
      setResult(`${parts.join("，")}。`);
    }

    renameButton.addEventListener("click", () => {
      const folder = selectedFolder();
      if (!folder) return;
      renameRow.hidden = false;
      renameInput.value = detail?.name ?? folder.name;
      renameInput.focus();
      renameInput.select();
    });
    renameCancel.addEventListener("click", () => {
      renameRow.hidden = true;
    });
    renameSave.addEventListener("click", () => run(async () => {
      const name = renameInput.value.trim();
      if (!name) {
        setResult("名字不能为空。");
        return;
      }
      const updated = await api(`/${encodeURIComponent(selectedId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      renameRow.hidden = true;
      await loadFolders(selectedId);
      setResult(updated.name === name ? "已重命名。" : `已有同名歌单，这次存成了《${updated.name}》。`);
    }, "重命名"));

    deleteButton.addEventListener("click", () => run(async () => {
      const folder = selectedFolder();
      if (!folder) return;
      const yes = await confirmDialog(
        "删除歌单",
        `确定删除《${detail?.name ?? folder.name}》？歌单里的曲目只是移出这份清单，曲库文件不会被删。`,
        "删除",
      );
      if (!yes) return;
      await api(`/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
      selectedId = "";
      detail = null;
      await loadFolders();
      setResult("歌单已删除（曲库文件没动）。");
    }, "删除歌单"));

    exportButton.addEventListener("click", () => run(async () => {
      const data = await api(`/${encodeURIComponent(selectedId)}/export`);
      exportBlock.replaceChildren();
      exportBlock.hidden = false;
      exportBlock.append(node("h3", `导出《${data.name}》`));
      if (!data.count) {
        exportBlock.append(node("p", "空歌单没有可导出的内容。", "empty"));
        return;
      }
      if (data.qr) {
        const figure = node("div", null, "fm-qrBox");
        figure.append(renderQr(data.qr), node("p", `${data.count} 首 · 二维码：用手机扫，或另一台机器导出后按文本导入`, "fm-hint"));
        exportBlock.append(figure);
      } else {
        exportBlock.append(node("p", `这个歌单有 ${data.count} 首，超过 30 首就不出二维码了，请用下面的文件分享。`, "fm-hint"));
      }
      const text = node("textarea", data.text, "fm-exportText");
      text.readOnly = true;
      text.rows = 3;
      text.setAttribute("aria-label", "导出的歌单文本");
      const actions = node("div", null, "actions");
      const copy = node("button", "复制文本", "secondary");
      const download = node("button", `下载 ${data.fileName}`, "");
      copy.type = "button";
      download.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await global.navigator.clipboard.writeText(data.text);
          setResult("歌单文本已复制。");
        } catch {
          text.select();
          setResult("复制失败，请手动从下面的框里选择复制。");
        }
      });
      download.addEventListener("click", () => {
        const blob = new global.Blob([data.text], { type: "text/plain;charset=utf-8" });
        const url = global.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = data.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        global.setTimeout(() => global.URL.revokeObjectURL(url), 4000);
        setResult(`已下载 ${data.fileName}。`);
      });
      actions.append(copy, download);
      exportBlock.append(text, actions);
      setResult(`已生成导出内容（${data.count} 首）。`);
    }, "导出"));

    filterInput.addEventListener("input", () => renderDetail());
    refreshButton.addEventListener("click", () => run(async () => {
      await loadFolders(selectedId);
      setResult("已刷新。");
    }, "刷新"));

    renderDetail();
    void run(async () => {
      await loadFolders();
    }, "读取歌单");

    return wrap;
  }

  function mount() {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host || host.dataset.folderManagerReady === "1") return;
    host.dataset.folderManagerReady = "1";
    host.replaceChildren(buildPage());
  }

  const button = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (button) button.addEventListener("click", () => global.setTimeout(mount, 60));
  global.OliviaSoulFolderManager = { mount };
})(window);
