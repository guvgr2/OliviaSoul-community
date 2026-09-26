// 试听页增强（g05 新增，独立文件，不改动原有 listen-naming.js）：
//   · 预取：听当前这首时，后台把后面 2 首的第 1 段切片好（配合服务端 warm=1）
//   · 连播：一段放完自动进入下一首（默认关，点按钮或按 C 切换）
//   · 稍后再听：标记听不出来的（按 L），自动跳过；可一键清除
//   · 缓存状态：显示切片缓存占用，可一键清到上限
(function (global) {
  "use strict";

  const TAB = "listen-tools";
  const BASE = "/toy/listen-naming";
  const LATER_KEY = "olivia.listenNaming.later";
  const AUTOPLAY_KEY = "olivia.listenNaming.autoPlay";

  let folders = [];
  let foldersAt = 0;
  let autoPlay = global.localStorage?.getItem(AUTOPLAY_KEY) === "1";
  let laterSet = new Set();
  let lastFolder = "";
  let lastRebuildAt = 0;
  let rebuildFailed = false;
  let skipGuard = 0;
  let ui = null;

  try {
    laterSet = new Set(JSON.parse(global.localStorage?.getItem(LATER_KEY) || "[]"));
  } catch { laterSet = new Set(); }

  function saveLater() {
    try { global.localStorage?.setItem(LATER_KEY, JSON.stringify([...laterSet])); } catch { /* 忽略 */ }
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  async function ensureFolders(force) {
    if (!force && folders.length && Date.now() - foldersAt < 120_000) return folders;
    try {
      const data = await api("/list?pageSize=3000");
      folders = (data.songs || []).map((song) => song.folder).filter(Boolean);
      foldersAt = Date.now();
    } catch { /* 拿不到就预取不了，不影响使用 */ }
    return folders;
  }

  // 当前正在试听的作品显示在「曲名与时段」页，面板本身在别的页，所以全局找
  function currentFolder() {
    const el = document.querySelector(".ln-folder");
    return el ? el.textContent.trim() : "";
  }

  function nextFolders(folder, count) {
    const index = folders.indexOf(folder);
    if (index < 0) return [];
    return folders.slice(index + 1, index + 1 + count);
  }

  function warm(folder, segment) {
    // 不 await：预取失败无所谓，绝不能挡住用户操作
    global.fetch(BASE + "/clip?folder=" + encodeURIComponent(folder) + "&seg=" + segment + "&warm=1",
      { credentials: "include" }).catch(() => {});
  }

  function prefetchAround(folder) {
    if (!folder) return;
    // 当前这首的下一段 + 后面两首的第 1 段
    warm(folder, 1);
    for (const next of nextFolders(folder, 2)) warm(next, 0);
  }

  function clickAction(index) {
    const buttons = document.querySelectorAll('.tabPage[data-page="' + TAB + '"] .ln-actions button');
    const button = buttons[index];
    if (button) button.click();
  }

  function setStatus(message) {
    if (ui?.status) ui.status.textContent = message || "";
  }

  async function refreshCacheLine() {
    if (!ui) return;
    try {
      const stats = await api("/clips/stats");
      const mb = (stats.bytes / 1048576).toFixed(1);
      const limit = (stats.limitBytes / 1048576).toFixed(0);
      ui.cacheLine.textContent = `切片缓存：${stats.files} 个 / ${mb} MB（上限 ${limit} MB）`;
    } catch {
      ui.cacheLine.textContent = "切片缓存：读不到";
    }
  }

  function buildControls() {
    const box = node("section", null, "settingsBlock ln-playerBox");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "试听增强"),
      node("small", "预取下一首 · 连播 · 稍后再听（快捷键 C / L）"),
    );

    const row = node("div", null, "actions");
    const autoButton = node("button", "", "secondary");
    autoButton.type = "button";
    const laterButton = node("button", "稍后再听（L）", "secondary");
    laterButton.type = "button";
    const clearButton = node("button", "清除「稍后再听」标记", "secondary");
    clearButton.type = "button";
    const pruneButton = node("button", "清理切片缓存", "secondary");
    pruneButton.type = "button";
    row.append(autoButton, laterButton, clearButton, pruneButton);

    const status = node("p", "", "fieldHint ln-playerStatus");
    const cacheLine = node("p", "", "fieldHint ln-cacheLine");

    // g12：待定清单 + 标签（存在服务端，命名页与这里共享一份）
    const tagBar = node("div", null, "actions ln-tagBar");
    const doubtButton = node("button", "标记存疑", "secondary");
    const likeButton = node("button", "标记喜欢", "secondary");
    const refreshTags = node("button", "刷新清单", "secondary");
    for (const button of [doubtButton, likeButton, refreshTags]) button.type = "button";
    tagBar.append(doubtButton, likeButton, refreshTags);

    const tagFilter = node("div", null, "actions ln-tagFilter");
    const laterFilter = node("button", "只看待定", "secondary");
    const doubtFilter = node("button", "只看存疑", "secondary");
    const likeFilter = node("button", "只看喜欢", "secondary");
    for (const button of [laterFilter, doubtFilter, likeFilter]) button.type = "button";
    tagFilter.append(laterFilter, doubtFilter, likeFilter);

    const tagLine = node("p", "", "fieldHint ln-tagLine");
    const tagList = node("ul", null, "ln-tagList");
    box.append(head, row, status, cacheLine, tagBar, tagFilter, tagLine, tagList);

    const paintAuto = () => {
      autoButton.textContent = autoPlay ? "连播：开（C）" : "连播：关（C）";
    };
    paintAuto();

    autoButton.addEventListener("click", () => {
      autoPlay = !autoPlay;
      try { global.localStorage?.setItem(AUTOPLAY_KEY, autoPlay ? "1" : "0"); } catch { /* 忽略 */ }
      paintAuto();
      setStatus(autoPlay ? "连播已开：一段放完自动进下一首" : "连播已关");
    });

    laterButton.addEventListener("click", () => {
      const folder = currentFolder();
      if (!folder) return;
      // g12：改用服务端标签（和「待定清单」同一份数据），localStorage 仅作离线兜底
      const nowLater = !laterSet.has(folder);
      if (nowLater) laterSet.add(folder); else laterSet.delete(folder);
      saveLater();
      setStatus(nowLater ? `已标记稍后再听：${folder}（共 ${laterSet.size} 首）` : `已取消标记：${folder}`);
      void api("/tags", {
        method: "POST",
        body: JSON.stringify({ folder, tag: "later", value: nowLater }),
      }).then(() => paintTags()).catch(() => { /* 服务端写不了就只留本地标记 */ });
      if (nowLater) clickAction(2);   // 标记后立刻跳过
    });

    clearButton.addEventListener("click", async () => {
      const folders = [...laterSet];
      laterSet = new Set();
      saveLater();
      setStatus(`已清除「稍后再听」标记（${folders.length} 首）`);
      for (const folder of folders) {
        void api("/tags", { method: "POST", body: JSON.stringify({ folder, tag: "later", value: false }) }).catch(() => {});
      }
      global.setTimeout(() => { void paintTags(); }, 400);
    });

    pruneButton.addEventListener("click", async () => {
      pruneButton.disabled = true;
      try {
        const data = await api("/clips/prune", { method: "POST" });
        setStatus("缓存已清理：删除 " + data.removed + " 个，释放 " + (data.freedBytes / 1048576).toFixed(1) + " MB");
      } catch (error) {
        setStatus("清理失败：" + error.message);
      } finally {
        pruneButton.disabled = false;
        void refreshCacheLine();
      }
    });

    // g12：标签（待定/存疑/喜欢）与待定清单 —— 存服务端，命名页与这里共享
    const paintTags = async (tag = "") => {
      try {
        const data = await api("/tags" + (tag ? "?tag=" + encodeURIComponent(tag) : ""));
        const counts = data?.counts ?? {};
        tagLine.textContent = `待定 ${counts.later ?? 0} 首 · 存疑 ${counts.doubt ?? 0} 首 · 喜欢 ${counts.like ?? 0} 首`
          + (tag ? `　（当前只看「${data?.names?.[tag] ?? tag}」）` : "");
        tagList.replaceChildren();
        const items = Array.isArray(data?.tags) ? data.tags : [];
        if (!items.length) {
          tagList.append(node("li", tag ? "这个标签下还没有作品。" : "还没有任何标记。", "empty"));
          return;
        }
        for (const item of items.slice(0, 50)) {
          const line = node("li");
          const jump = node("button", item.folder, "secondary ln-tagJump");
          jump.type = "button";
          jump.addEventListener("click", () => {
            // 让「曲名与时段」页切到这一首：写入位置记忆后由命名页接管
            void api("/position", { method: "POST", body: JSON.stringify({ folder: item.folder }) })
              .then(() => setStatus(`已记住位置：${item.folder}，去「曲名与时段」页点「接着上次继续」`))
              .catch(() => setStatus("切换失败：写位置失败"));
          });
          line.append(jump, node("small", item.tags.map(name => data.names?.[name] ?? name).join(" · ")));
          tagList.append(line);
        }
      } catch (error) {
        tagLine.textContent = `读取标签失败：${error.message}`;
      }
    };

    const toggleTag = async (tag) => {
      const folder = currentFolder();
      if (!folder) { setStatus("先到「曲名与时段」里选中一首。", "warn"); return; }
      try {
        const data = await api("/tags", { method: "POST", body: JSON.stringify({ folder, tag, value: true }) });
        setStatus(`已把 ${folder} 标记为「${data?.names?.[tag] ?? tag}」`);
        await paintTags();
      } catch (error) {
        setStatus(`标记失败：${error.message}`, "warn");
      }
    };
    doubtButton.addEventListener("click", () => { void toggleTag("doubt"); });
    likeButton.addEventListener("click", () => { void toggleTag("like"); });
    refreshTags.addEventListener("click", () => { void paintTags(); });
    laterFilter.addEventListener("click", () => { void paintTags("later"); });
    doubtFilter.addEventListener("click", () => { void paintTags("doubt"); });
    likeFilter.addEventListener("click", () => { void paintTags("like"); });

    // g10：音频元素属于「曲名与时段」页，用文档级捕获监听，跟它什么时候被创建无关
    if (!global.__lnPlayerAudioBound) {
      global.__lnPlayerAudioBound = true;
      document.addEventListener("play", (event) => {
        const el = event.target;
        if (el && el.classList && el.classList.contains("ln-audio")) prefetchAround(currentFolder());
      }, true);
      document.addEventListener("ended", (event) => {
        const el = event.target;
        if (el && el.classList && el.classList.contains("ln-audio") && autoPlay) {
          global.setTimeout(() => clickAction(2), 300);   // 连播：进下一首
        }
      }, true);
    }

    // g10：面板外壳返回给装配器；内部引用留给模块自己刷新内容用
    ui = { box, autoButton, laterButton, clearButton, pruneButton, status, cacheLine, tagLine, tagList };
    void paintTags();
    return box;
  }

  // 装配器每次进入「试听工具」页签时调用：只刷新缓存占用与清单文字，不重建面板
  function refresh() {
    void refreshCacheLine();
    void ensureFolders();
    if (ui?.tagLine) void loadTagsIntoPanel();
  }

  /** 刷新标签清单（复用面板里的渲染逻辑，避免重复代码）。 */
  async function loadTagsIntoPanel() {
    if (!ui) return;
    try {
      const data = await api("/tags");
      const counts = data?.counts ?? {};
      ui.tagLine.textContent = `待定 ${counts.later ?? 0} 首 · 存疑 ${counts.doubt ?? 0} 首 · 喜欢 ${counts.like ?? 0} 首`;
    } catch { /* 读不到就不刷 */ }
  }

  function onKeydown(event) {
    const input = document.querySelector('.tabPage[data-page="' + TAB + '"] #lnNameInput');
    if (input && document.activeElement === input) return;   // 输入框里打字不抢键
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === "c" || event.key === "C") {
      ui?.autoButton?.click();
      event.preventDefault();
    } else if (event.key === "l" || event.key === "L") {
      ui?.laterButton?.click();
      event.preventDefault();
    }
  }
  document.addEventListener("keydown", onKeydown, true);

  // g10：只导出 render()，挂载交给装配器（不再有 MutationObserver / 自我重建）
  // refresh 由装配器在每次进入页签时调用（内部只改自己的文字，不重建 DOM）
  global.OliviaSoulListenNamingPlayer = { render: buildControls, refresh };
})(window);
