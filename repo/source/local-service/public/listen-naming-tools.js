// 「曲名与时段」附加工具面板：画面识别（时段）+ 社区曲目名单
//
// 为什么单独一个文件：原 listen-naming.js 只负责试听起名，这里往同一个页签里
// **追加**两块工具区，互不干扰；样式沿用 styles.css 的既有类（settingsBlock / panelHead / actions）。
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "listen-naming";
  const BASE = "/toy/listen-naming";
  let previewed = [];

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/gu, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || `请求失败（${body.code}）`);
    return body && "data" in body ? body.data : body;
  }

  // ------------------------------------------------------------ 画面识别（时段）

  function buildTimeOfDaySection() {
    const block = node("section", null, "settingsBlock");
    const head = node("div", null, "panelHead");
    head.append(
      node("h2", "画面识别 · 时段"),
      node("p", "读画面判断每首作品的白天 / 傍晚 / 夜晚（亮度 + 冷暖）。先预览，确认无误再写入。"),
    );
    const actions = node("div", null, "actions");
    const preview = node("button", "预览时段", "secondary");
    const apply = node("button", "写入时段", "");
    apply.disabled = true;
    actions.append(preview, apply);
    const result = node("p", "", "result");
    const table = node("div", "", "listenNamingTable");
    block.append(head, actions, result, table);

    preview.addEventListener("click", async () => {
      result.textContent = "正在读画面…（每首抽 7 帧，需要一点时间）";
      table.innerHTML = "";
      preview.disabled = true;
      try {
        const data = await api("/time-of-day/preview?limit=20");
        previewed = Array.isArray(data.items) ? data.items : [];
        if (!previewed.length) {
          result.textContent = "没有需要判定时段的作品（可能都已经设置过了）。";
          return;
        }
        const rows = previewed.map(item => {
          const cells = (item.videos ?? []).map(v => `${escapeHtml(v.variant ?? "")}：${escapeHtml(v.period ?? "?")}（亮 ${Math.round(v.brightness ?? 0)}）`).join("<br>");
          return `<tr><td>${escapeHtml(item.folder)}</td><td>${cells}</td></tr>`;
        }).join("");
        table.innerHTML = `<table><tr><th>作品</th><th>各视频判定</th></tr>${rows}</table>`;
        result.textContent = `预览 ${previewed.length} 首，确认后点「写入时段」。`;
        apply.disabled = false;
      } catch (error) {
        result.textContent = `预览失败：${error.message}`;
      } finally {
        preview.disabled = false;
      }
    });

    apply.addEventListener("click", async () => {
      if (!previewed.length) return;
      if (!global.confirm(`将写入 ${previewed.length} 首作品的时段对应关系。\n只会写入"从未设置过时段"的作品，已有设置不会被改动。\n\n写库前会自动备份数据库。继续？`)) return;
      apply.disabled = true;
      result.textContent = "正在写入…";
      try {
        const data = await api("/time-of-day/apply", {
          method: "POST",
          body: JSON.stringify({ items: previewed.map(item => ({ songId: item.songId, mapping: item.mapping })) }),
        });
        result.textContent = `写入 ${data.applied ?? 0} 首，跳过 ${data.skipped ?? 0} 首（已有设置）。备份：${data.backup ?? "—"}`;
        previewed = [];
      } catch (error) {
        result.textContent = `写入失败：${error.message}`;
      } finally {
        apply.disabled = true;
      }
    });

    return block;
  }

  // ------------------------------------------------------------ 社区曲目名单

  function buildCommunitySection() {
    const block = node("section", null, "settingsBlock");
    const head = node("div", null, "panelHead");
    head.append(
      node("h2", "社区曲目名单"),
      node("p", "从开源仓库拉取「曲名 + 音乐指纹」名单，用指纹比对自动给本地作品命名（多段校验通过才填，填不中不填）。"),
    );
    const status = node("p", "", "fieldHint");
    const actions = node("div", null, "actions");
    const refresh = node("button", "刷新名单", "secondary");
    const autoName = node("button", "自动命名", "");
    const contribute = node("button", "生成投稿文件", "secondary");
    actions.append(refresh, autoName, contribute);
    const result = node("p", "", "result");
    block.append(head, status, actions, result);

    async function loadStatus() {
      try {
        const data = await api("/community/status");
        const catalog = data.catalog ?? {};
        status.textContent = `名单 ${catalog.count ?? 0} 条 · 更新于 ${catalog.updatedAt || "未知"}${catalog.stale ? " · 使用的是本地缓存（网络不可用）" : ""} · 本地未命名 ${data.local?.unnamed ?? "?"} 首`;
      } catch (error) {
        status.textContent = `读取状态失败：${error.message}`;
      }
    }

    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      result.textContent = "正在拉取…";
      try {
        await api("/community/refresh", { method: "POST" });
        result.textContent = "名单已刷新。";
        await loadStatus();
      } catch (error) {
        result.textContent = `刷新失败：${error.message}`;
      } finally {
        refresh.disabled = false;
      }
    });

    autoName.addEventListener("click", async () => {
      autoName.disabled = true;
      result.textContent = "正在算指纹并比对…（首次会慢，指纹会缓存）";
      try {
        const data = await api("/community/auto-name", { method: "POST", body: JSON.stringify({ limit: 50 }) });
        result.textContent = `检查 ${data.checked ?? 0} 首，命中 ${data.matched ?? 0} 首，写入 ${data.applied ?? 0} 首。名单里没有的仍需你亲自听。`;
        await loadStatus();
      } catch (error) {
        result.textContent = `自动命名失败：${error.message}`;
      } finally {
        autoName.disabled = false;
      }
    });

    contribute.addEventListener("click", async () => {
      const contributor = global.prompt("提交到社区时用你的 GitHub 用户名（只写进投稿文件，不含其它身份信息）：", "") || "";
      if (!contributor.trim()) return;
      contribute.disabled = true;
      try {
        const data = await api("/community/build-contribution", { method: "POST", body: JSON.stringify({ contributor: contributor.trim() }) });
        result.textContent = `已生成投稿文件：${data.path ?? ""}（${data.count ?? 0} 条）。把它提交到仓库的 data/community/ 目录即可。`;
      } catch (error) {
        result.textContent = `生成失败：${error.message}`;
      } finally {
        contribute.disabled = false;
      }
    });

    void loadStatus();
    return block;
  }

  // ------------------------------------------------------------ 挂载

  function mount() {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host || host.dataset.listenNamingTools === "1") return;
    host.dataset.listenNamingTools = "1";
    host.append(buildTimeOfDaySection(), buildCommunitySection());
  }

  const button = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (button) button.addEventListener("click", () => global.setTimeout(mount, 60));
  if (global.document.readyState !== "loading") global.setTimeout(mount, 200);

  global.OliviaSoulListenNamingTools = { mount };
})(window);