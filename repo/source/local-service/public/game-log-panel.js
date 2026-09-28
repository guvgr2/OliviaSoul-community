// 「游戏日志」面板（g13，独立文件）：把游戏自己的 Olivia.log 解析成事件时间轴。
// 挂「高级设置」页（该页由装配器 append，不会清空原有内容）。
(function (global) {
  "use strict";

  const BASE = "/toy/listen-naming/diagnostics";
  let ui = null;
  let report = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({ credentials: "include" }, options));
    const body = await response.json().catch(() => ({}));
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  const levelTag = level => ({ error: "错误", critical: "严重", warning: "警告" }[level] ?? "信息");

  function renderSummary(data) {
    const box = ui.summaryOut;
    box.replaceChildren();
    if (!data?.available) {
      box.append(node("p", data?.hint || "没读到游戏日志。", "fieldHint"));
      return;
    }
    const chips = node("div", null, "ln-diagChips");
    const summary = data.summary ?? {};
    for (const [type, count] of Object.entries(summary)) {
      if (type === "其它" || type === "本程序服务" || type === "窗口/界面") continue;
      chips.append(node("span", `${type} ${count}`, "ln-diagChip"));
    }
    box.append(chips);
    const scanned = data.scanned ?? {};
    box.append(node("p",
      `扫了 ${(data.files ?? []).length} 个日志文件、${scanned.lines ?? 0} 行；`
      + `续行 ${scanned.continuations ?? 0}（${scanned.fractional ?? 0}%）；级别 `
      + Object.entries(data.levels ?? {}).map(([k, v]) => `${k} ${v}`).join(" · "), "fieldHint"));

    // 本地服务没在跑：这条要醒目
    const netErrors = Array.isArray(data.netErrors) ? data.netErrors : [];
    const totalNetErrors = netErrors.reduce((sum, item) => sum + item.count, 0);
    if (totalNetErrors > 0) {
      const warn = node("p", null, "ln-diagWarn");
      warn.append(node("strong", `游戏对本地服务的请求失败 ${totalNetErrors} 次（服务当时没在运行）`));
      warn.append(node("br"));
      warn.append(node("small", netErrors.slice(0, 4).map(item => `${item.key} × ${item.count}`).join("　")));
      warn.append(node("small", "　→ 这些是「游戏在跑、OliviaSoul 没起来」时产生的，游戏里看不出来，但功能会失效。"));
      box.append(warn);
    }

    const noisy = Array.isArray(data.noisyTop) ? data.noisyTop : [];
    if (noisy.length) {
      box.append(node("p", "已折叠的噪声（前端控制台/轮询）："
        + noisy.slice(0, 4).map(item => `${item.key} × ${item.count}`).join("　"), "fieldHint"));
    }
  }

  function renderTimeline() {
    const box = ui.timelineOut;
    box.replaceChildren();
    if (!ui.showTimeline.checked) { box.append(node("p", "勾上「显示事件时间轴」再刷新。", "fieldHint")); return; }
    const onlyError = ui.onlyError.checked;
    const rows = (report?.timeline ?? []).filter(item => !onlyError || /错误|崩溃|失败|未响应|警告/.test(item.type));
    if (!rows.length) { box.append(node("p", "没有匹配的事件。", "fieldHint")); return; }
    const list = node("ul", null, "ln-diagList");
    for (const item of rows.slice(0, 200)) {
      // ln-diagRow：只有时间轴的行才走三列布局；崩溃卡片的 li 是纯文本，保持块级
      const line = node("li", null, "ln-diagRow");
      line.append(
        node("span", item.at, "ln-diagStage"),
        node("strong", item.type, "ln-diagType"),
        node("small", `[${levelTag(item.level)}] ${item.text}`),
      );
      list.append(line);
    }
    box.append(list);
  }

  function renderCrashes() {
    const box = ui.crashOut;
    box.replaceChildren();
    const crashes = Array.isArray(report?.crashes) ? report.crashes : [];
    if (!crashes.length) { box.append(node("p", "日志里没有崩溃记录。", "fieldHint")); return; }
    for (const crash of crashes) {
      const card = node("section", null, "settingsBlock ln-diagCard");
      const ctx = crash.context ?? {};
      const head = node("div", null, "settingsBlockHead");
      head.append(
        node("strong", `崩溃现场 ${crash.at}`),
        node("small", `前 40 条内：显示变化 ${ctx.display ?? 0} · 睡眠唤醒 ${ctx.resume ?? 0} · `
          + `播放结束 ${ctx.player ?? 0} · 氛围音频 ${ctx.ambience ?? 0} · 本程序服务调用 ${ctx.ours ?? 0}`),
      );
      const list = node("ul", null, "ln-diagList");
      for (const line of crash.before ?? []) list.append(node("li", line));
      card.append(head, list);
      box.append(card);
    }
  }

  async function load(full) {
    if (!ui) return;
    ui.loadButton.disabled = true;
    ui.status.textContent = full ? "正在全量解析游戏日志（220 MB，可能要十几秒）…" : "正在读取游戏日志尾部…";
    try {
      report = await api(`/game-log${full ? "?full=1" : ""}`);
      renderSummary(report);
      renderTimeline();
      renderCrashes();
      ui.status.textContent = report?.available
        // 说明口径：这里数的是「游戏日志里记到的」，不是崩溃记录目录里的总条数
        // （日志会轮转，更早的崩溃已经不在里面了），否则两个数字对不上会让人以为程序数错了
        ? `读完了：游戏日志里记到崩溃 ${(report.crashes ?? []).length} 次（更早的可能已随日志轮转），热事件 ${(report.timeline ?? []).length} 条`
        : (report?.hint ?? "没读到游戏日志");
    } catch (error) {
      ui.status.textContent = `读取失败：${error.message}`;
    } finally {
      ui.loadButton.disabled = false;
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-gamelog");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "游戏日志"),
      node("small", "游戏自己写的 Olivia.log：崩溃现场 · 已知无害项已折叠 · 本地服务没在跑时会明确提示。想报障请用上面「一键诊断包」导出的 zip（里面已含日志摘要）"),
    );

    const actions = node("div", null, "actions");
    const loadButton = node("button", "读取游戏日志", "secondary");
    const fullButton = node("button", "全量解析（慢，含更早的）", "secondary");
    const onlyError = node("input");
    onlyError.type = "checkbox";
    const showTimeline = node("input");
    showTimeline.type = "checkbox";
    showTimeline.checked = true;
    for (const button of [loadButton, fullButton]) button.type = "button";
    const labelOnlyError = node("label", null, "ln-diagCheck");
    labelOnlyError.append(onlyError, node("span", "只看错误/崩溃"));
    const labelTimeline = node("label", null, "ln-diagCheck");
    labelTimeline.append(showTimeline, node("span", "显示事件时间轴"));
    actions.append(loadButton, fullButton, labelOnlyError, labelTimeline);

    const summaryOut = node("div", null, "ln-diagOut");
    const timelineOut = node("div", null, "ln-diagOut");
    const crashOut = node("div", null, "ln-diagOut");
    const status = node("p", "", "fieldHint");

    box.append(head, actions, summaryOut, crashOut, timelineOut, status);
    ui = { box, loadButton, fullButton, onlyError, showTimeline, summaryOut, timelineOut, crashOut, status };
    loadButton.addEventListener("click", () => { void load(false); });
    fullButton.addEventListener("click", () => { void load(true); });
    onlyError.addEventListener("change", () => renderTimeline());
    showTimeline.addEventListener("change", () => renderTimeline());
    void load(false);
    return box;
  }

  global.OliviaSoulGameLog = { render: buildPanel, refresh: () => { void load(false); } };
})(window);
