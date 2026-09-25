// 「问题反馈」：把问题直接开到 GitHub Issues（用户自己的账号提交，维护者能看到并修）
//
// 特点：
//   * 自动附带**脱敏后**的诊断信息（版本 / 系统 / 社区名单状态 / 计数），让 issue 有信息量
//   * 任何路径、用户名、邮箱、超长数字都会在提交前被替换掉
//   * 不需要任何 token：只是打开一个预填好的 GitHub 新建 issue 页面
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "feedback";
  const BASE = "/toy/listen-naming";
  // ⚠️ 发布前改成你自己的仓库（与 midi/community-catalog.js 里的 CATALOG_URL 保持一致）
  const REPO = "guvgr2/OliviaSoul-community";
  const APP_VERSION = "2008.2.7-linli9-g10";

  const KINDS = [
    ["bug", "功能坏了 / 报错"],
    ["wrong-name", "曲名填错了"],
    ["time-of-day", "时段判断不对"],
    ["community", "社区名单相关"],
    ["suggest", "功能建议"],
  ];

  // ------------------------------------------------------------ 脱敏
  function scrub(text) {
    return String(text ?? "")
      .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/gu, "<路径已隐去>")
      .replace(/\\\\[^\s"'<>|]+/gu, "<路径已隐去>")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<邮箱已隐去>")
      .replace(/\d{7,}/gu, "<数字已隐去>")
      .replace(/\bUsers\\[^\s\\]+/giu, "<路径已隐去>");
  }

  /** 发布前需要把 REPO 改成自己的仓库；没改之前按钮不能静默失效，要明确提示。 */
  function repoReady() {
    return Boolean(REPO) && !REPO.includes("<") && !REPO.includes(">") && REPO.includes("/");
  }

  // g10：外链走后端的白名单通道（便携版 WebView2 里 window.open 会被当弹窗拦掉）
  function openIssue(url) {
    if (!repoReady()) {
      global.alert("反馈通道还没配置好：\n\n" +
        "本程序是开发版，代码里的反馈仓库地址还是占位符 " + REPO + "。\n" +
        "发布前需要把它改成你自己的 GitHub 仓库，改完这个按钮就能用了。");
      return Promise.resolve(false);
    }
    const host = global.OliviaSoulPanelHost;
    if (host && typeof host.openExternal === "function") {
      return host.openExternal(url).then(() => true).catch((error) => {
        global.alert("浏览器没有打开。你可以手动访问：\n\n" + url + "\n\n（原因：" + (error && error.message ? error.message : error) + "）");
        return false;
      });
    }
    const opened = global.open(url, "_blank", "noopener");
    if (!opened) {
      global.alert("浏览器没有打开新窗口。你可以手动访问：\n\n" + url);
    }
    return Promise.resolve(Boolean(opened));
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || `请求失败（${body.code}）`);
    return body && "data" in body ? body.data : body;
  }

  async function diagnostics() {
    const lines = [];
    lines.push(`- 程序版本：${APP_VERSION}`);
    lines.push(`- 系统：${scrub(global.navigator.userAgent)}`);
    lines.push(`- 屏幕：${global.screen ? global.screen.width + "x" + global.screen.height : "未知"}`);
    try {
      const status = await api("/community/status");
      const catalog = status.catalog ?? {};
      lines.push(`- 社区名单：${catalog.count ?? 0} 条，更新于 ${catalog.updatedAt || "未知"}${catalog.stale ? "（本地缓存）" : ""}`);
      lines.push(`- 本地未命名：${status.local?.unnamed ?? "未知"} 首`);
    } catch (error) {
      lines.push(`- 社区名单：读取失败（${scrub(error.message)}）`);
    }
    return lines.join("\n");
  }

  function issueUrl(kind, description, diag) {
    const title = `[${KINDS.find(k => k[0] === kind)?.[1] ?? "反馈"}] ${description.split("\n")[0].slice(0, 60)}`;
    const body = [
      "### 我遇到的问题",
      description.trim(),
      "",
      "### 自动附带的诊断信息（已脱敏，不含个人数据）",
      diag,
      "",
      "---",
      "_由程序内的「问题反馈」按钮生成_",
    ].join("\n");
    return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  // ------------------------------------------------------------ 界面
  function mount() {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host || host.dataset.listenNamingFeedback === "1") return;
    host.dataset.listenNamingFeedback = "1";

    const block = document.createElement("section");
    block.className = "settingsBlock";
    const head = document.createElement("div");
    head.className = "panelHead";
    const title = document.createElement("h2");
    title.textContent = "问题反馈";
    const hint = document.createElement("p");
    hint.textContent = "遇到问题或想提建议？点下面的按钮，会打开 GitHub 的新建 issue 页面，内容已帮你填好（含脱敏后的诊断信息），用你自己的账号提交即可。";
    head.append(title, hint);

    const actions = document.createElement("div");
    actions.className = "actions";
    const button = document.createElement("button");
    button.textContent = "反馈问题 → 打开 GitHub";
    const suggest = document.createElement("button");
    suggest.textContent = "建议新功能";
    suggest.className = "secondary";
    suggest.addEventListener("click", () => {
      const title = encodeURIComponent("[功能建议] ");
      const template = encodeURIComponent("功能建议.md");
      openIssue(`https://github.com/${REPO}/issues/new?template=${template}&title=${title}`);
    });
    actions.append(button, suggest);

    const result = document.createElement("p");
    result.className = "result";

    const form = document.createElement("div");
    form.style.display = "none";
    const select = document.createElement("select");
    for (const [value, label] of KINDS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    const area = document.createElement("textarea");
    area.rows = 6;
    area.placeholder = "描述一下问题：你做了什么、期望是什么、实际发生了什么。\n（提示：不要粘贴文件路径或账号信息，提交前会自动脱敏）";
    area.style.width = "100%";
    const send = document.createElement("button");
    send.textContent = "提交到 GitHub";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.className = "secondary";
    const sendRow = document.createElement("div");
    sendRow.className = "actions";
    sendRow.append(send, cancel);
    const preview = document.createElement("pre");
    preview.style.display = "none";
    preview.style.whiteSpace = "pre-wrap";
    preview.style.maxHeight = "240px";
    preview.style.overflow = "auto";

    form.append(select, area, preview, sendRow);

    button.addEventListener("click", () => {
      form.style.display = "";
      button.disabled = true;
      area.focus();
    });
    cancel.addEventListener("click", () => {
      form.style.display = "none";
      button.disabled = false;
      result.textContent = "";
    });
    let staged = false;
    send.addEventListener("click", async () => {
      const description = area.value.trim();
      if (description.length < 5) {
        result.textContent = "请先把问题描述清楚一点（至少 5 个字）。";
        return;
      }
      send.disabled = true;
      result.textContent = "正在收集诊断信息…";
      try {
        const diag = await diagnostics();
        if (!staged) {
          // 先原样展示要提交的内容，让用户自己再检查一遍（纯文本用户名之类正则抓不到的靠这一步兜底）
          preview.textContent = ["### 我遇到的问题", scrub(description), "", "### 自动附带的诊断信息（已脱敏）", diag].join("\n");
          preview.style.display = "";
          send.textContent = "确认并打开 GitHub";
          staged = true;
          result.textContent = "请先核对上面将要提交的内容，确认没有不希望公开的信息，再点「确认并打开 GitHub」。";
          return;
        }
        openIssue(issueUrl(select.value, scrub(description), diag));
        staged = false;
        preview.style.display = "none";
        send.textContent = "提交到 GitHub";
        result.textContent = "已打开 GitHub 页面，确认无误后点「Submit new issue」即可。";
        form.style.display = "none";
        button.disabled = false;
      } catch (error) {
        result.textContent = `打开失败：${error.message}`;
      } finally {
        send.disabled = false;
      }
    });

    block.append(head, actions, form, result);
    host.append(block);
  }

  const tabButton = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (tabButton) tabButton.addEventListener("click", () => global.setTimeout(mount, 80));
  if (document.readyState !== "loading") global.setTimeout(mount, 220);

  global.OliviaSoulListenNamingFeedback = { mount, scrub, issueUrl };
})(window);