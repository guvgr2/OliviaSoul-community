// 「游戏崩溃规避」面板（g15）：把 Chromium 的稳定性开关写进 Steam 启动项。
//
// 只改启动项里的一个参数 —— 不改游戏任何文件、随时可关、可完全还原；
// 写入前会备份 Steam 配置并留下恢复清单（卸载时自动还原）。
(function (global) {
  "use strict";

  const BASE = "/toy/listen-naming/game-stability";
  let ui = null;
  let state = null;

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
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  function render(data) {
    if (!ui) return;
    state = data;
    const box = ui.out;
    box.replaceChildren();

    if (!data?.supported) {
      box.append(node("p", data?.hint ?? "暂时用不了这个功能。", "fieldHint"));
      if (data?.toolPath) box.append(node("p", `工具位置：${data.toolPath}`, "fieldHint"));
      ui.toggle.disabled = true;
      ui.toggle.checked = false;
      if (data?.crashes) box.append(crashLine(data.crashes));
      return;
    }

    const crashes = data.crashes ?? {};
    box.append(node("p",
      crashes.sameModule
        ? `游戏崩溃记录：共 ${crashes.total} 次，其中 ${crashes.sameModule} 次在同一处（${crashes.signature || "libcef.dll"}）；最近一次 ${crashes.lastAt || "未知"}。`
        : `游戏崩溃记录：共 ${crashes.total ?? 0} 次，没有发现集中在同一处的情况。`,
      "fieldHint"));

    box.append(node("p", `当前 Steam 启动项：${data.launchOptions ? data.launchOptions : "（空）"}`, "fieldHint"));
    box.append(node("p", `要写进去的参数：${data.flag}`, "fieldHint"));

    if (data.suggest) {
      const tip = node("section", null, "settingsBlock ln-diagPending");
      tip.append(node("strong", "⚠ 同一处崩溃已经出现多次，可以试试打开下面的开关"));
      tip.append(node("p", "这是 Chromium 官方为那条缺陷提供的开关（默认关闭），游戏内嵌的浏览器会少走一条已知会崩的路径。", "fieldHint"));
      box.append(tip);
    }

    // 实验性标注：这个开关的效果没有保证，必须让人一眼看到，不能让人以为"打开就修好了"
    const experimental = node("section", null, "settingsBlock ln-diagPending");
    experimental.append(node("strong", "⚠ 实验性功能，请谨慎使用"));
    experimental.append(node("p",
      "这个开关只是把 Chromium 的一个官方开关写进 Steam 启动项，效果没有保证：游戏会给内嵌浏览器"
      + "重建一份自己的命令行，外部传进去的参数不一定能到那里。它不改动游戏任何文件、随时可以关掉，"
      + "但请不要把它当成「已经修好了」。", "fieldHint"));
    box.append(experimental);

    if (data.enabled) {
      box.append(node("p", "✓ 已经启用。下次从 Steam 启动游戏时生效。", "result"));
    }

    // 已经开着、但装开关之后同一处又崩过 —— 直接把结论说出来，别让用户自己猜
    if (data.flagIneffective) {
      const verdict = node("section", null, "settingsBlock ln-diagPending");
      verdict.append(node("strong", "✗ 这个参数没能阻止崩溃"));
      verdict.append(node("p", `开关装上时间：${String(data.flagIneffective.since).slice(0, 19).replace("T", " ")}（本地时间）`, "fieldHint"));
      verdict.append(node("p", `之后同一处又崩过：${data.flagIneffective.lastCrashAt}${data.flagIneffective.signature ? "（" + data.flagIneffective.signature + "）" : ""}`, "fieldHint"));
      verdict.append(node("p", data.flagIneffective.verdict, "fieldHint"));
      box.append(verdict);
    }

    ui.toggle.checked = data.enabled === true;
    ui.toggle.disabled = false;
    box.append(node("p", data.hint ?? "", "fieldHint"));
    box.append(node("p",
      "说明：这个开关不会改动游戏任何文件，随时可以关掉（关掉时会把参数从启动项里移除、其它参数原样保留）。"
      + "开启后游戏会少做一类页面回收，内存占用可能略微上升；如果开启后仍然崩溃，说明不是这条路径，可以关掉。",
      "fieldHint"));
  }

  function crashLine(crashes) {
    return node("p",
      crashes.sameModule
        ? `游戏崩溃记录：共 ${crashes.total} 次，其中 ${crashes.sameModule} 次在同一处（${crashes.signature || "libcef.dll"}）。`
        : `游戏崩溃记录：共 ${crashes.total ?? 0} 次。`,
      "fieldHint");
  }

  async function load() {
    if (!ui) return;
    ui.status.textContent = "正在读取启动项…";
    try {
      const data = await api("/status");
      render(data);
      ui.status.textContent = "";
    } catch (error) {
      ui.status.textContent = `读取失败：${error.message}`;
    }
  }

  async function toggle(enabled) {
    if (!ui) return;
    ui.toggle.disabled = true;
    ui.status.textContent = enabled ? "正在写入启动项（会先备份 Steam 配置）…" : "正在移除参数…";
    try {
      const result = await api("/toggle", { method: "POST", body: JSON.stringify({ enabled }) });
      ui.status.textContent = result.changed
        ? `✓ 已${enabled ? "启用" : "关闭"}：当前启动项 = ${result.launchOptions || "（空）"}`
        : "启动项本来就是想要的样子，没有改动。";
      if (result.backupPath) ui.status.textContent += "（已备份 Steam 配置）";
      await load();
    } catch (error) {
      const message = String(error.message ?? error);
      ui.status.textContent = /Steam/u.test(message)
        ? "改启动项前请先完全退出 Steam（包括右下角托盘图标），然后再试一次。"
        : `操作失败：${message}`;
      ui.toggle.checked = state?.enabled === true;
    } finally {
      ui.toggle.disabled = false;
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-diagSpacer ln-gameStability");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "游戏崩溃规避"),
      node("small", "游戏内嵌 Chromium 在固定一处空指针崩溃（已复现多次）。Chromium 对这个缺陷有官方开关，程序可以把它写进 Steam 启动项 —— 不改游戏任何文件，随时可关"),
    );

    const actions = node("div", null, "actions");
    const label = node("label", null, "ln-diagCheck");
    const toggleInput = node("input");
    toggleInput.type = "checkbox";
    label.append(toggleInput, node("span", "启用崩溃规避参数（实验）"));
    const refresh = node("button", "刷新状态", "secondary compact");
    refresh.type = "button";
    actions.append(label, refresh);

    const status = node("p", "", "fieldHint");
    const out = node("div", null, "ln-diagOut");
    box.append(head, actions, status, out);

    toggleInput.addEventListener("change", () => { void toggle(toggleInput.checked); });
    refresh.addEventListener("click", () => { void load(); });

    ui = { box, toggle: toggleInput, refresh, status, out };
    void load();
    return box;
  }

  global.OliviaSoulGameStability = { render: buildPanel, refresh: () => { void load(); } };
})(window);
