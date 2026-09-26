// 「诊断」面板（g12 新增，独立文件，不改 app.js）：
//   · 启动耗时报表：把宿主与 node 打印的 startup-stage 汇总，一眼看出启动慢在哪一段
//   · 曲库健康检查：同名冲突 / 同款群命名不一致 / 视频缺失 / 时长异常
//   · 复制诊断信息：把上面两块 + 最近运行日志拼成文本，一键复制给维护者
// 挂在「高级设置」页：装配器不会清空该页原有内容（页面标了 data-panel-mount="keep"）。
(function (global) {
  "use strict";

  const TAB = "debug";
  const BASE = "/toy/listen-naming";
  let ui = null;
  let health = null;
  let report = null;

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

  const ms = value => (value == null ? "—" : `${Math.round(Number(value))} ms`);
  const seconds = value => (value == null ? "—" : `${(Number(value) / 1000).toFixed(2)} s`);

  function renderStartup(data) {
    if (!ui) return;
    const box = ui.startupOut;
    box.replaceChildren();
    const boots = Array.isArray(data?.boots) ? data.boots : [];
    if (!boots.length) {
      box.append(node("p", "还没读到启动记录（运行过一次带 g11/g12 计时的版本后就有）。", "fieldHint"));
      return;
    }
    for (const [index, boot] of boots.entries()) {
      const card = node("section", null, "settingsBlock ln-diagCard");
      const head = node("div", null, "settingsBlockHead");
      head.append(
        node("strong", index === 0 ? "最近一次启动" : `更早一次（宿主 pid ${boot.host}）`),
        node("small", `总耗时（进程启动 → 界面可见）约 ${seconds(boot.totalMs)}`),
      );
      const list = node("ul", null, "ln-diagList");
      for (const stage of boot.stages) {
        const line = node("li");
        line.append(
          node("span", stage.stage, "ln-diagStage"),
          node("strong", stage.sinceProcessStartMs != null ? seconds(stage.sinceProcessStartMs) : ms(stage.elapsedMs)),
          node("small", stage.elapsedMs != null ? `（窗体构造后 ${ms(stage.elapsedMs)}）` : ""),
        );
        list.append(line);
      }
      card.append(head, list);
      if (boot.slowest) {
        const slow = boot.slowest;
        card.append(node("p",
          `最慢的一段：${slow.stage} 花了约 ${seconds(slow.deltaMs)}`
          + `（到这一步累计 ${seconds(slow.at)}）`, "fieldHint ln-diagSlow"));
      }
      box.append(card);
    }
    box.append(node("p", data.note || "", "fieldHint"));
  }

  function renderHealth(data) {
    if (!ui) return;
    health = data;
    const box = ui.healthOut;
    box.replaceChildren();
    if (!data) { box.append(node("p", "点「检查曲库」开始体检。", "fieldHint")); return; }
    const counts = data.counts ?? {};
    const chips = [
      ["曲库文件夹", counts.folders],
      ["数据库行", counts.rows],
      ["已命名", counts.named],
      ["同名冲突", counts.duplicateNames],
      ["同款群不一致", counts.twinConflicts],
      ["视频缺失", counts.missingVideo],
      ["时长异常", counts.durationOdd],
    ];
    const row = node("div", null, "ln-diagChips");
    for (const [label, value] of chips) {
      const chip = node("span", null, "ln-chip");
      chip.textContent = `${label} ${value ?? 0}`;
      if (label !== "曲库文件夹" && label !== "数据库行" && label !== "已命名" && Number(value) > 0) chip.dataset.kind = "fault";
      row.append(chip);
    }
    box.append(row);

    const section = (title, items, format) => {
      if (!items?.length) return;
      const card = node("section", null, "settingsBlock ln-diagCard");
      card.append(node("strong", `${title}（${items.length}）`));
      const list = node("ul", null, "ln-diagList");
      for (const item of items.slice(0, 20)) list.append(node("li", format(item)));
      card.append(list);
      box.append(card);
    };
    section("同名冲突（不同编号用了同一个曲名）", data.duplicateNames,
      item => `「${item.name}」→ ${item.count} 个：${item.folders.join("、")}`);
    section("同款群命名不一致（同一录音应该同名）", data.twinConflicts,
      item => `${item.folders.join("、")} → ${item.names.join(" / ")}`);
    section("曲库文件夹缺失", data.missingVideo, folder => folder);
    section("时长异常（<20 秒 或 >1 小时）", data.durationOdd,
      item => `${item.folder} → ${item.seconds} 秒`);
  }

  function diagnosticText() {
    const lines = ["=== OliviaSoul 诊断信息 ===", `时间：${new Date().toLocaleString()}`, ""];
    lines.push("--- 启动耗时 ---");
    for (const boot of report?.boots ?? []) {
      lines.push(`宿主 pid ${boot.host}：总 ${seconds(boot.totalMs)}`);
      for (const stage of boot.stages) {
        lines.push(`  ${stage.stage}: ${stage.sinceProcessStartMs != null ? seconds(stage.sinceProcessStartMs) : ms(stage.elapsedMs)}`);
      }
    }
    lines.push("", "--- 曲库健康 ---");
    const counts = health?.counts ?? {};
    for (const [key, value] of Object.entries(counts)) lines.push(`${key}: ${value}`);
    lines.push("", `库路径：${health?.libraryRoot ?? "(未读取)"}`);
    return lines.join("\n");
  }

  async function copyDiagnostics() {
    if (!ui) return;
    const text = diagnosticText();
    try {
      if (global.navigator?.clipboard?.writeText) await global.navigator.clipboard.writeText(text);
      else {
        const helper = document.createElement("textarea");
        helper.value = text;
        document.body.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      ui.status.textContent = `✓ 已复制 ${text.length} 个字符，直接粘给维护者即可（不含曲库路径以外的隐私信息）`;
    } catch (error) {
      ui.status.textContent = `复制失败：${error.message}`;
    }
  }

  async function loadStartup() {
    if (!ui) return;
    ui.startupButton.disabled = true;
    ui.status.textContent = "正在读取启动记录…";
    try {
      report = await api("/startup-report?limit=3");
      renderStartup(report);
      ui.status.textContent = "启动记录已更新";
    } catch (error) {
      ui.status.textContent = `读取启动记录失败：${error.message}`;
    } finally {
      ui.startupButton.disabled = false;
    }
  }

  async function loadHealth() {
    if (!ui) return;
    ui.healthButton.disabled = true;
    ui.status.textContent = "正在体检曲库（只读扫描，不会改动任何文件）…";
    try {
      renderHealth(await api("/health"));
      ui.status.textContent = "体检完成";
    } catch (error) {
      ui.status.textContent = `体检失败：${error.message}`;
    } finally {
      ui.healthButton.disabled = false;
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-diagnostics");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "诊断"),
      node("small", "启动慢在哪一段 · 曲库有没有脏数据 · 出问题时一键复制诊断信息"),
    );

    const startupActions = node("div", null, "actions");
    const startupButton = node("button", "读取启动耗时", "secondary");
    const copyButton = node("button", "复制诊断信息", "secondary");
    startupButton.type = "button";
    copyButton.type = "button";
    startupActions.append(startupButton, copyButton);

    const startupOut = node("div", null, "ln-diagOut");

    const healthHead = node("div", null, "settingsBlockHead ln-diagSpacer");
    healthHead.append(node("strong", "曲库健康检查"), node("small", "同名冲突 / 同款群不一致 / 视频缺失 / 时长异常"));
    const healthActions = node("div", null, "actions");
    const healthButton = node("button", "检查曲库", "secondary");
    healthButton.type = "button";
    healthActions.append(healthButton);
    const healthOut = node("div", null, "ln-diagOut");

    const status = node("p", "", "fieldHint");
    box.append(head, startupActions, startupOut, healthHead, healthActions, healthOut, status);

    // g12：事件绑定必须在 return 之前完成
    ui = { box, startupButton, copyButton, healthButton, startupOut, healthOut, status };
    startupButton.addEventListener("click", () => { void loadStartup(); });
    healthButton.addEventListener("click", () => { void loadHealth(); });
    copyButton.addEventListener("click", () => { void copyDiagnostics(); });
    // 进页签就把启动记录读出来（只读本地日志，很快）
    void loadStartup();
    return box;
  }

  global.OliviaSoulDiagnostics = { render: buildPanel };
})(window);
