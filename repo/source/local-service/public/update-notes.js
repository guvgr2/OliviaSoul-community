// 更新日志展示（g05 新增，独立文件，不改 app.js）：
// 「软件更新」页检测到新版本时，把 Release 说明、发布页链接、安装包直链摆出来。
// 安全约定：GitHub 返回的说明文字一律用 textContent 渲染，绝不 innerHTML。
(function (global) {
  "use strict";

  const TAB = "update";
  let panel = null;
  let lastTag = "";

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  // g10：外链统一交后端（域名白名单 + 系统默认浏览器），面板里不再自己 window.open
  async function openUrl(url) {
    const host = global.OliviaSoulPanelHost;
    if (!url || !host || typeof host.openExternal !== "function") return;
    try {
      await host.openExternal(url);
      if (panel) panel.status.textContent = "已用系统浏览器打开：" + url;
    } catch (error) {
      if (panel) panel.status.textContent = "打不开链接：" + (error && error.message ? error.message : error);
    }
  }

  function ensurePanel() {
    if (panel) return panel;
    const box = node("section", null, "settingsBlock ln-updateNotes");
    const head = node("div", null, "settingsBlockHead");
    const title = node("strong", "更新说明");
    // 版本行沿用页面原有的 #updateVersion（app.js 会写它），避免"当前版本"出现两遍
    const versionLine = document.getElementById("updateVersion") || node("small", "正在读取版本信息……");
    if (!versionLine.id) versionLine.id = "updateVersion";
    if (!versionLine.textContent.trim()) versionLine.textContent = "正在读取版本信息……";
    head.append(title, versionLine);

    const notesBox = node("pre", "", "ln-updateNotesBody");
    const actions = node("div", null, "actions");
    const openRelease = node("button", "打开发布页", "secondary");
    const openAsset = node("button", "下载安装包", "secondary");
    openRelease.type = "button";
    openAsset.type = "button";
    actions.append(openRelease, openAsset);

    const status = node("p", "", "fieldHint");
    box.append(head, notesBox, actions, status);

    // g10：事件绑定 + 内部引用必须在 return 之前完成
    panel = { box, versionLine, notesBox, actions, status, openRelease, openAsset, releaseUrl: "", assetUrl: "" };
    openRelease.addEventListener("click", () => openUrl(panel.releaseUrl));
    openAsset.addEventListener("click", () => openUrl(panel.assetUrl));
    // 进入页签即取一次正文（面板骨架此时已建好，只改自己的文字，不重建 DOM）
    void refresh(true);
    // g10：不再自己挂载，由装配器负责 append；面板外壳在事件绑定之后返回
    return box;
  }

  async function refresh(force) {
    const ui = panel || ensurePanel();
    if (!ui) return;
    if (!document.body.contains(ui.box)) return;   // 面板还没被装配器挂上就先不动
    if (ui.status.textContent === "正在读取…" && !force) return;
    ui.status.textContent = "正在读取…";
    try {
      const response = await global.fetch("/admin/api/update", { credentials: "include" });
      const body = await response.json();
      if (!body || body.code !== 0) throw new Error(body && body.message ? body.message : "接口返回异常");
      const data = body.data || {};
      lastTag = String(data.latestTag || "");
      ui.releaseUrl = String(data.releaseUrl || "");
      ui.assetUrl = String(data.assetUrl || "");
      const sizeMb = data.assetSize ? (Number(data.assetSize) / 1048576).toFixed(1) + " MB" : "";
      ui.versionLine.textContent = `当前 ${data.currentTag || "?"} · GitHub 最新 ${lastTag || "?"}`
        + (data.publishedAt ? ` · 发布于 ${String(data.publishedAt).slice(0, 10)}` : "");
      ui.notesBox.textContent = String(data.notes || "").trim() || "（这个版本没有写更新说明）";
      ui.openRelease.hidden = !ui.releaseUrl;
      ui.openAsset.hidden = !ui.assetUrl;
      ui.openAsset.textContent = sizeMb ? `下载安装包（${sizeMb}）` : "下载安装包";
      ui.status.textContent = data.updateAvailable
        ? `有新版本 ${lastTag} 可以更新`
        : "当前已经是最新版本";
    } catch (error) {
      ui.notesBox.textContent = "";
      ui.openRelease.hidden = true;
      ui.openAsset.hidden = true;
      ui.status.textContent = "读取更新信息失败：" + error.message;
    }
  }


  // g10：只导出 render()，挂载交给装配器（不再有 MutationObserver / 自我重建）
  // refresh 由装配器在每次进入「软件更新」页签时调用，只刷新文字，不重建面板
  global.OliviaSoulUpdateNotes = { render: ensurePanel, refresh };
})(window);
