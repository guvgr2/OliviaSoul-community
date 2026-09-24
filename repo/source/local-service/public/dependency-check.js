// 「依赖检查」独立页：跑起来需要的东西在不在，缺了怎么办、要不要现在装
//
// 样式沿用应用既有类（panelHead / settingsBlock / taskCard / actions / result），
// 与「软件更新」页保持同一套观感。
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "dependency-check";
  const BASE = "/toy/listen-naming";
  const WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/";
  const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/";

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
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || `请求失败（${body.code}）`);
    return body && "data" in body ? body.data : body;
  }

  function isFfmpeg(name) {
    return name === "ffmpeg.exe" || name === "ffprobe.exe";
  }

  function buildCard(item, reload) {
    const card = node("section", null, "taskCard");
    const head = node("div", null, "panelHead");
    const titleRow = node("div");
    titleRow.append(
      node("h2", `${item.ok ? "✓" : "✗"} ${item.name}`),
      node("p", item.detail || ""),
    );
    head.append(titleRow, node("div", null, "ln-statusChips"));
    card.append(head);

    if (!item.ok) {
      const hint = node("p", "", "fieldHint");
      hint.textContent = item.fix || "";
      const actions = node("div", null, "actions");
      const button = node("button", "", "");
      const result = node("p", "", "result");
      if (item.name.includes("WebView2")) {
        button.textContent = "现在安装（询问后执行）";
        button.addEventListener("click", async () => {
          if (!global.confirm("Microsoft Edge WebView2 运行时是本程序的【必要依赖】。\n\n现在运行随程序附带的安装程序吗？（需要联网，约 1 分钟）")) return;
          button.disabled = true;
          result.textContent = "正在启动安装程序…";
          try {
            const data = await api("/dependencies/install-webview2", { method: "POST" });
            result.textContent = `已启动安装程序：${data.path}\n装完后请重新打开本程序。`;
          } catch (error) {
            result.textContent = `启动失败：${error.message}（可点右边按钮去官网手动下载）`;
          } finally {
            button.disabled = false;
          }
        });
        const manual = node("button", "打开官网下载", "secondary");
        manual.addEventListener("click", () => global.open(WEBVIEW2_URL, "_blank", "noopener"));
        actions.append(button, manual);
      } else if (isFfmpeg(item.name)) {
        button.textContent = "打开下载页（手动放置）";
        button.addEventListener("click", () => global.open(FFMPEG_URL, "_blank", "noopener"));
        const where = node("p", "", "fieldHint");
        where.textContent = "下载后把 ffmpeg.exe / ffprobe.exe 放到程序目录的 runtime\\ffmpeg\\bin 下，再点下面的「重新检查」。";
        card.append(where);
        actions.append(button);
      } else {
        button.textContent = "重新检查";
        button.addEventListener("click", reload);
        actions.append(button);
      }
      card.append(hint, actions, result);
    }
    return card;
  }

  function buildPage(report) {
    const wrap = document.createDocumentFragment();
    const head = node("div", null, "panelHead");
    const left = node("div");
    left.append(
      node("h2", "依赖检查"),
      node("p", "本程序运行需要的东西是否就位。只做只读探测，不会修改系统里任何设置。"),
    );
    const right = node("div", null, "ln-statusChips");
    const chip = node("span", report.ok ? "全部就绪" : `缺 ${report.required.length} 项`, "ln-chip");
    right.append(chip);
    head.append(left, right);
    wrap.append(head);

    for (const item of report.items) wrap.append(buildCard(item, () => mount(true)));
    const footer = node("p", "", "fieldHint");
    footer.textContent = `程序目录：${report.installRoot}　数据目录：${report.userData}`;
    wrap.append(footer);

    // 开源软件声明（与仓库 开源软件声明.md 一致）
    const notice = node("section", null, "settingsBlock");
    const noticeHead = node("div", null, "panelHead");
    noticeHead.append(
      node("h3", "开源软件声明"),
      node("p", "本程序使用了以下开源软件，各自的许可证文本随程序一起分发（见程序目录的 runtime、licenses 文件夹）。"),
    );
    const list = node("div", "", "fieldHint");
    list.innerHTML = [
      "· <b>Node.js 22</b>（MIT）—— 运行时　· <b>FFmpeg / FFprobe</b>（LGPL v3 构建）—— 音视频处理",
      "· <b>whisper.cpp v1.9.2</b>（MIT）—— 语音识别　· <b>midi-file 1.2.4</b>（MIT）—— MIDI 解析",
      "· <b>Microsoft Edge WebView2 SDK</b>（微软许可条款）—— 界面渲染",
      "· 打包工具 <b>Inno Setup 6</b>（允许非商业使用）、<b>.NET SDK</b>（MIT），不随程序分发",
      "· 本程序基于上游开源项目 <b>coderscsy/linli</b> 二次开发；上溯至 <b>yilangren/OliviaSoul</b>",
      "· 本分支新增代码采用 <b>MIT</b> 许可证；上游代码的授权状态请见仓库 开源软件声明.md",
    ].join("<br>");
    notice.append(noticeHead, list);
    wrap.append(notice);

    return wrap;
  }

  async function mount(force) {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host) return;
    if (host.dataset.dependencyReady === "1" && !force) return;
    host.dataset.dependencyReady = "1";
    host.replaceChildren(node("p", "正在检查…", "result"));
    try {
      const report = await api("/dependencies");
      host.replaceChildren(buildPage(report));
    } catch (error) {
      host.replaceChildren(node("p", `检查失败：${error.message}`, "result"));
    }
  }

  const button = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (button) button.addEventListener("click", () => global.setTimeout(() => mount(false), 60));
  global.OliviaSoulDependencyCheck = { mount };
})(window);