// 「曲名与时段」附加工具面板：画面识别（时段）+ 社区曲目名单
//
// 为什么单独一个文件：原 listen-naming.js 只负责试听起名，这里往同一个页签里
// **追加**两块工具区，互不干扰；样式沿用 styles.css 的既有类（settingsBlock / panelHead / actions），
// 新增的少量样式（ln-contribution*）追加在 public/listen-naming.css 末尾。
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
    // 失败信封是 { code: "COMMUNITY_XXX", message, data: null }：code 是字符串，不能只判数字
    const code = body && "code" in body ? body.code : 0;
    if (code !== 0 && code != null) throw new Error((body && body.message) || `请求失败（${code}）`);
    if (!response.ok) throw new Error((body && body.message) || `请求失败（HTTP ${response.status}）`);
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

  // ------------------------------------------------------------ 一键投稿（编号 + 曲名 + 3 段指纹）

  // 只写本机 <UserData>\community-outbox\，绝不自动上传；提交动作由用户自己点开 GitHub 模板链接完成。
  function buildContributionSection() {
    const block = node("div", null, "ln-contribution");
    const head = node("div", null, "panelHead");
    head.append(
      node("h3", "一键投稿"),
      node("p", "把本机已经起好名的作品汇总成一个投稿文件：已命名 + 能算出 3 段指纹的才会被收进去。"),
    );
    const counts = node("p", "", "ln-contributionCounts");
    const actions = node("div", null, "ln-contributionActions");
    const build = node("button", "生成投稿文件", "secondary");
    const copy = node("button", "复制文件内容", "secondary");
    const open = node("button", "打开提交页面", "secondary");
    copy.disabled = true;
    open.disabled = true;
    actions.append(build, copy, open);
    const result = node("p", "", "result");
    const file = node("code", "", "ln-contributionFile");
    // g11 可核验闭环：把"这次会公开什么"摆出来，并且可以直接复制
    const disclosure = node("div", null, "ln-contributionDisclosure");
    const disclosureHead = node("p", "", "ln-contributionHint");
    const disclosureList = node("ul", null, "ln-contributionList");
    const contentBox = node("pre", "", "ln-contributionContent");
    contentBox.hidden = true;
    disclosure.append(disclosureHead, disclosureList, contentBox);
    disclosure.hidden = true;
    const hint = node("p", "只上传「编号 + 曲名 + 3 段指纹」，不含任何个人信息（没有路径、用户名、设备信息）。", "ln-contributionHint");
    block.append(head, counts, actions, result, file, disclosure, hint);

    let openUrl = "";
    let totals = { total: 0, ready: 0, submitted: 0 };
    let lastContent = "";

    function renderCounts() {
      counts.textContent = `已命名 ${totals.total ?? 0} 首，可投稿 ${totals.ready ?? 0} 首，已投稿 ${totals.submitted ?? 0} 首`;
    }

    /** g11：把"这次会公开的字段"渲染出来（曲名 + 3 段指纹 + 校验哈希）。 */
    function renderDisclosure(data) {
      const items = Array.isArray(data?.contentPreview) ? data.contentPreview : [];
      disclosure.hidden = !items.length;
      disclosureList.replaceChildren();
      if (!items.length) return;
      disclosureHead.textContent = `这次会公开 ${data.count ?? items.length} 首：编号 + 曲名 + ${data.fingerprint?.segments ?? 3} 段指纹 + 校验哈希`
        + "（没有文件路径、没有用户名、没有设备信息）。下面只是清单，递交的是 JSON 全文：";
      for (const item of items) {
        const line = node("li");
        line.append(
          node("span", item.folder, "ln-sameNumberFolder"),
          node("strong", item.name || "(无曲名)"),
          node("small", ` · ${item.segments} 段指纹 · ${String(item.hash || "").slice(0, 12)}…`),
        );
        disclosureList.append(line);
      }
      if ((Number(data.count) || 0) > items.length) {
        const more = node("li", `… 另有 ${Number(data.count) - items.length} 首（复制文件内容可看全）`, "empty");
        disclosureList.append(more);
      }
    }

    async function copyContent() {
      if (!lastContent) return;
      try {
        if (global.navigator?.clipboard?.writeText) await global.navigator.clipboard.writeText(lastContent);
        else {
          const helper = document.createElement("textarea");
          helper.value = lastContent;
          document.body.append(helper);
          helper.select();
          document.execCommand("copy");
          helper.remove();
        }
        result.textContent = `✓ 已复制 ${lastContent.length} 个字符，直接到 GitHub 页面粘贴即可。`;
      } catch (error) {
        contentBox.hidden = false;
        result.textContent = `复制失败（${error.message}）；已把内容展开，请手动全选复制。`;
      }
    }

    copy.addEventListener("click", () => { void copyContent(); });

    /** 反复调 preview 直到本机指纹都校验完：一次只补算一小批，免得一个请求卡好几分钟。 */
    async function previewAll(onProgress) {
      let data = null;
      for (let round = 0; round < 40; round += 1) {
        data = await api("/community/contribution/preview?limit=20");
        totals = (data && data.totals) || totals;
        renderCounts();
        if (typeof onProgress === "function") onProgress(data);
        if (!(Number(data && data.remaining) > 0)) break;
      }
      return data;
    }

    /** 只看缓存（cacheOnly）：不惊动 ffmpeg，用来显示统计数字。 */
    async function loadCounts() {
      try {
        const data = await api("/community/contribution/preview?cacheOnly=1");
        totals = (data && data.totals) || totals;
        renderCounts();
      } catch (error) {
        counts.textContent = `读取投稿状态失败：${error.message}`;
      }
    }

    build.addEventListener("click", async () => {
      build.disabled = true;
      open.disabled = true;
      file.textContent = "";
      result.textContent = "正在校验指纹…（首次要逐首解码音频，比较慢；指纹会缓存，下次就快了）";
      try {
        const previewData = await previewAll(info => {
          if (info && Number(info.remaining) > 0) {
            result.textContent = `正在校验指纹…已确认可投稿 ${(info.totals && info.totals.ready) ?? 0} 首，还剩 ${info.remaining} 首待校验`;
          }
        });
        const ready = (previewData && previewData.totals && previewData.totals.ready) || 0;
        if (!ready) {
          const named = (previewData && previewData.totals && previewData.totals.total) || 0;
          result.textContent = `没有可投稿的曲目：已命名 ${named} 首，其中能算出 3 段指纹的 0 首。`;
          return;
        }
        const data = await api("/community/contribution/build", { method: "POST", body: JSON.stringify({}) });
        openUrl = (data && data.openUrl) || openUrl;
        open.disabled = !openUrl;
        file.textContent = (data && data.file) || "";
        lastContent = String((data && data.content) || "");
        copy.disabled = !lastContent;
        contentBox.textContent = lastContent;
        contentBox.hidden = true;
        renderDisclosure(data);
        result.textContent = `已生成投稿文件：${(data && data.count) ?? 0} 首，${Math.round(((data && data.bytes) || 0) / 1024)} KB。`
          + (lastContent
            ? "先点「复制文件内容」，再点「打开提交页面」，粘贴到输入框后提交即可。"
            : "文件较大未内嵌显示；请在下方路径找到文件后复制其内容。");
        await loadCounts();
      } catch (error) {
        result.textContent = `生成失败：${error.message}`;
      } finally {
        build.disabled = false;
      }
    });

    open.addEventListener("click", async () => {
      // 必须先生成过投稿文件才允许打开提交页面（预览返回的 openUrl 不算）
      if (!openUrl || !file.textContent) return;
      // g10：外链走后端白名单通道（便携版 WebView2 里 window.open 会被当弹窗拦掉）
      const host = global.OliviaSoulPanelHost;
      try {
        if (host && typeof host.openExternal === "function") await host.openExternal(openUrl);
        else global.open(openUrl, "_blank", "noopener");
      } catch (error) {
        result.textContent = "打不开提交页面：" + (error && error.message ? error.message : error) + "\n可手动访问：" + openUrl;
      }
    });

    void loadCounts();
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
    const contribute = node("button", "生成投稿文件（填 GitHub 用户名）", "secondary");
    actions.append(refresh, autoName, contribute);
    const result = node("p", "", "result");
    block.append(head, status, actions, result, buildContributionSection());

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
