// 「运行日志」独立页：与本程序其它页面同一套观感
(function (global) {
  "use strict";

  const document = global.document;
  const TAB = "logs";
  const BASE = "/toy/listen-naming";

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

  function buildPage() {
    const wrap = document.createDocumentFragment();
    const head = node("div", null, "panelHead");
    const left = node("div");
    left.append(
      node("h2", "运行日志"),
      node("p", "记录本功能的操作与错误。遇到问题时可复制或导出这些内容，附在 GitHub 反馈里。"),
    );
    const chips = node("div", null, "ln-statusChips");
    const count = node("span", "—", "ln-chip");
    chips.append(count);
    head.append(left, chips);
    wrap.append(head);

    const block = node("section", null, "settingsBlock");
    const actions = node("div", null, "actions");
    const refresh = node("button", "刷新", "secondary");
    const copy = node("button", "复制（已脱敏）", "");
    const open = node("button", "打开日志文件位置", "secondary");
    const clear = node("button", "清空", "secondary");
    actions.append(refresh, copy, open, clear);
    const result = node("p", "", "result");
    const pathLine = node("p", "", "ln-logPath");
    const viewer = node("pre", "", "ln-logViewer");
    block.append(actions, result, pathLine, viewer);
    wrap.append(block);

    let latest = [];

    // 脱敏：与问题反馈模块同一套规则，避免把本机路径带进公开 issue
    function scrub(text) {
      return String(text ?? "")
        .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/gu, "<路径已隐去>")
        .replace(/\\\\[^\s"'<>|]+/gu, "<路径已隐去>")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<邮箱已隐去>")
        .replace(/\d{7,}/gu, "<数字已隐去>");
    }

    function render(entries) {
      latest = entries || [];
      count.textContent = `共 ${latest.length} 条`;
      if (!latest.length) {
        viewer.textContent = "（暂无日志。使用本功能后这里会出现记录。）";
        return;
      }
      viewer.textContent = latest
        .map(item => `[${item.at}] [${item.level.toUpperCase()}] ${item.message}${item.detail ? "\n    " + item.detail : ""}`)
        .join("\n");
    }

    async function load() {
      try {
        const data = await api("/logs");
        render(data.entries);
        pathLine.textContent = `日志文件：${data.file}`;
      } catch (error) {
        result.textContent = `读取失败：${error.message}`;
      }
    }

    refresh.addEventListener("click", load);
    open.addEventListener("click", async () => {
      try {
        await api("/logs/open-folder", { method: "POST" });
        result.textContent = "已打开日志所在文件夹。";
      } catch (error) {
        result.textContent = `打开失败：${error.message}`;
      }
    });
    clear.addEventListener("click", async () => {
      if (!global.confirm("清空日志？清空后无法恢复。")) return;
      try {
        await api("/logs/clear", { method: "POST" });
        await load();
      } catch (error) {
        result.textContent = `清空失败：${error.message}`;
      }
    });
    copy.addEventListener("click", async () => {
      const text = latest
        .map(item => `[${item.at}] [${item.level.toUpperCase()}] ${scrub(item.message)}${item.detail ? "\n    " + scrub(item.detail) : ""}`)
        .join("\n");
      try {
        await global.navigator.clipboard.writeText(`# OliviaSoul 运行日志（已脱敏）\n\n${text}\n`);
        result.textContent = "已复制到剪贴板（路径、邮箱、长数字已隐去）。";
      } catch {
        result.textContent = "复制失败，请手动从下方选择复制。";
      }
    });

    void load();
    return wrap;
  }

  function mount() {
    const host = document.querySelector(`.tabPage[data-page="${TAB}"]`);
    if (!host || host.dataset.logsReady === "1") return;
    host.dataset.logsReady = "1";
    host.replaceChildren(buildPage());
  }

  const button = document.querySelector(`.sideTab[data-tab="${TAB}"]`);
  if (button) button.addEventListener("click", () => global.setTimeout(mount, 60));
  global.OliviaSoulLogsPage = { mount };
})(window);