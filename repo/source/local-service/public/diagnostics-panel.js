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
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  const ms = value => (value == null ? "—" : `${Math.round(Number(value))} ms`);
  const seconds = value => (value == null ? "—" : `${(Number(value) / 1000).toFixed(2)} s`);
  const bytes = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  };

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
      // g13：区分"真的一次启动"和"宿主一直开着、中途重新拉起本地服务"
      const title = boot.nodeRestartedInPlace
        ? (index === 0 ? "最近一次：本地服务被重新拉起" : `更早一次：本地服务重新拉起（宿主 pid ${boot.host}）`)
        : (index === 0 ? "最近一次启动" : `更早一次（宿主 pid ${boot.host}）`);
      const summary = boot.nodeRestartedInPlace
        ? `这不是一次新启动：宿主当时已经运行了 ${seconds(boot.nodeStartHostUpMs)}，只是本地服务被重新拉起`
        : (boot.totalMs == null
          ? "这次会话没有宿主侧阶段记录（记录不完整）"
          : `总耗时（进程启动 → 界面可见）约 ${seconds(boot.totalMs)}`);
      head.append(node("strong", title), node("small", summary));
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
      // 本地服务就绪是另一把尺子（相对 node 启动），单独一行，别跟宿主总耗时混在一起
      if (boot.nodeReadyMs != null) {
        const line = node("li");
        line.append(
          node("span", "本地服务就绪", "ln-diagStage"),
          node("strong", ms(boot.nodeReadyMs)),
          node("small", "（node 起来 → 服务可用，与宿主总耗时不是同一把尺子）"),
        );
        list.append(line);
      }
      if (boot.slowest) {
        const slow = boot.slowest;
        card.append(node("p",
          `最慢的一段：${slow.stage} 花了约 ${seconds(slow.deltaMs)}`
          + `（到这一步累计 ${seconds(slow.at)}）`, "fieldHint ln-diagSlow"));
      }
      if (Array.isArray(boot.restarts) && boot.restarts.length) {
        card.append(node("p",
          `同一次运行里本地服务重启过 ${boot.restarts.length} 次：`
          + boot.restarts.map(item => `${item.at}（第 ${item.order} 次）`).join("、"), "fieldHint"));
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

  // g13：一键诊断包 —— 先看会打包什么 / 真正导出 / 打开所在目录
  async function previewPackage() {
    if (!ui) return;
    ui.packButton.disabled = true;
    ui.status.textContent = "正在统计要打包的内容…";
    try {
      const data = await api("/diagnostics/package/preview");
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      ui.packOut.replaceChildren();
      const list = node("ul", null, "ln-diagList");
      for (const entry of entries) {
        const line = node("li");
        line.append(
          node("span", entry.name, "ln-diagStage"),
          node("strong", bytes(entry.bytes)),
          node("small", ""),
        );
        list.append(line);
      }
      ui.packOut.append(list);
      ui.packOut.append(node("p", "不会打包：" + (data?.excluded ?? []).join(" · "), "fieldHint"));
      ui.status.textContent = `会打包 ${entries.length} 个文件，日志里的本机路径已替换成占位符`;
    } catch (error) {
      ui.status.textContent = `统计失败：${error.message}`;
    } finally {
      ui.packButton.disabled = false;
    }
  }

  async function exportPackage() {
    if (!ui) return;
    ui.packButton.disabled = true;
    ui.status.textContent = "正在生成诊断包（读日志 + 数据库体检，几秒）…";
    try {
      const data = await api("/diagnostics/package", { method: "POST", body: "{}" });
      ui.packOut.replaceChildren();
      const line = node("p", "", "fieldHint");
      line.append(node("strong", `已生成：${bytes(data?.bytes)}`), node("br"),
        node("span", String(data?.file ?? "")));
      ui.packOut.append(line);
      ui.packOut.append(node("p",
        `含 ${(data?.entries ?? []).length} 个文件；不含：` + (data?.excluded ?? []).join(" · "), "fieldHint"));
      ui.status.textContent = "诊断包已生成，可以直接发给维护者";
    } catch (error) {
      ui.status.textContent = `生成失败：${error.message}`;
    } finally {
      ui.packButton.disabled = false;
    }
  }

  async function revealPackage() {
    if (!ui) return;
    try {
      const data = await api("/diagnostics/package/reveal", { method: "POST", body: "{}" });
      ui.status.textContent = `已打开目录：${data?.opened ?? ""}`;
    } catch (error) {
      ui.status.textContent = `打开目录失败：${error.message}`;
    }
  }

  // g13：游戏崩溃记录解读
  async function loadCrashes() {
    if (!ui) return;
    ui.crashButton.disabled = true;
    ui.status.textContent = "正在解读游戏崩溃报告（读 minidump，几秒）…";
    try {
      const data = await api("/diagnostics/crashes");
      renderCrashes(data);
      ui.status.textContent = data?.available
        ? `找到 ${data.total} 次崩溃记录`
        : "这台机器上没有游戏崩溃记录（没崩过，或者不是 Steam 版游戏）";
    } catch (error) {
      ui.status.textContent = `读取崩溃记录失败：${error.message}`;
    } finally {
      ui.crashButton.disabled = false;
    }
  }

  function renderCrashes(data) {
    if (!ui) return;
    const box = ui.crashOut;
    box.replaceChildren();
    const crashes = Array.isArray(data?.crashes) ? data.crashes : [];
    if (!crashes.length) {
      box.append(node("p", "没有崩溃记录。", "fieldHint"));
      return;
    }
    const list = node("ul", null, "ln-diagList");
    crashes.forEach((item, index) => {
      const exception = item.exception ?? {};
      const line = node("li");
      line.append(
        node("span", item.at, "ln-diagStage"),
        node("strong", exception.codeHex ? `${exception.codeHex} ${exception.codeText ?? ""}` : "（没读到异常码）"),
        node("small", exception.module
          ? `落在 ${exception.module}${exception.moduleOffset ? " + " + exception.moduleOffset : ""}`
          : "（没读到崩溃位置）"),
      );
      const who = node("small", exception.attribution ? `　归因：${exception.attribution}` : "");
      line.append(who);
      const copy = node("button", "复制上报文本", "secondary compact");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          const result = await api(`/diagnostics/crashes/text?index=${index}`);
          await global.navigator.clipboard.writeText(result?.text ?? "");
          ui.status.textContent = `已复制 ${item.at} 的上报文本`;
        } catch (error) {
          ui.status.textContent = `复制失败：${error.message}`;
        }
      });
      line.append(copy);
      list.append(line);
    });
    box.append(list);
    // 把"是不是我们改的模块"讲清楚
    const patched = crashes.filter(item => /本程序打过补丁/u.test(String(item.exception?.attribution ?? "")));
    box.append(node("p", patched.length
      ? `注意：有 ${patched.length} 次崩在**本程序打过补丁的模块**上，需要认真看。`
      : "这些崩溃都落在游戏自己的模块上（不是本程序改过的文件）。", "fieldHint"));
    box.append(node("p",
      "说明：crash.txt 里的符号名只是「离崩溃地址最近的那个导出符号」，看着像 sqlite3_xxx 其实毫无关系；"
      + "真正能定位的是上面这行的「模块 + 偏移」。", "fieldHint"));
  }

  // ---------------------------------------------------------------- g14 数据备份与恢复
  // 以前备份只写不读（改时段/写曲名前都会存一份，出事却没有任何恢复入口）。这里补上闭环：
  // 备份 → 看内容 → 恢复（重启生效，恢复前自动留档）+ 导出/导入（换电脑迁移）。

  function timeText(value) {
    const text = String(value ?? "").replace("T", " ");
    return text ? text.slice(0, 19) : "—";
  }

  function renderDataSafety(data) {
    if (!ui) return;
    const box = ui.dataOut;
    box.replaceChildren();
    const db = data?.database;
    box.append(node("p",
      db ? `当前数据库：${bytes(db.bytes)} · 最后改动 ${timeText(db.at)}`
        : "还没读到数据库信息。",
      "fieldHint"));

    if (data?.pending) {
      const warn = node("section", null, "settingsBlock ln-diagPending");
      warn.append(node("strong", "⚠ 已安排一次恢复：关掉程序再打开就生效"));
      warn.append(node("p", `${data.pending.label || data.pending.source || "恢复"} · ${data.pending.file}`, "fieldHint"));
      const row = node("div", null, "actions");
      const cancel = node("button", "取消这次恢复", "secondary compact");
      cancel.type = "button";
      cancel.addEventListener("click", () => { void cancelRestoreNow(); });
      row.append(cancel);
      warn.append(row);
      box.append(warn);
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      box.append(node("p", "还没有任何备份。点上面「立即备份」存一份，以后改错了可以回到这里。", "fieldHint"));
      return;
    }
    const table = node("table", null, "ln-diagTable");
    const head = node("tr");
    for (const label of ["时间", "来源", "大小", "操作"]) head.append(node("th", label));
    table.append(head);
    for (const item of items.slice(0, 12)) {
      const tr = node("tr");
      tr.append(node("td", timeText(item.at)));
      tr.append(node("td", item.label));
      tr.append(node("td", bytes(item.bytes)));
      const actions = node("td");
      const look = node("button", "看内容", "secondary compact");
      look.type = "button";
      look.addEventListener("click", () => { void inspectBackupRow(item.file, tr); });
      const restore = node("button", "恢复这一个", "secondary compact");
      restore.type = "button";
      restore.addEventListener("click", () => { void restoreBackup(item); });
      actions.append(look, restore);
      tr.append(actions);
      table.append(tr);
    }
    box.append(table);
    if (items.length > 12)
      box.append(node("p", `另有 ${items.length - 12} 份更早的备份，「打开备份目录」能看到全部`, "fieldHint"));
  }

  async function loadDataSafety() {
    if (!ui) return;
    ui.dataStatus.textContent = "正在读取备份列表…";
    try {
      renderDataSafety(await api("/data/status"));
      ui.dataStatus.textContent = "";
    } catch (error) {
      ui.dataStatus.textContent = `读取失败：${error.message}`;
    }
  }

  async function backupNow() {
    if (!ui) return;
    ui.dataStatus.textContent = "正在备份数据库…";
    try {
      const result = await api("/data/backup", { method: "POST", body: "{}" });
      ui.dataStatus.textContent = `✓ 已备份 ${result.file}（${bytes(result.bytes)}）`;
      await loadDataSafety();
    } catch (error) {
      ui.dataStatus.textContent = `备份失败：${error.message}`;
    }
  }

  async function inspectBackupRow(file, row) {
    if (!ui) return;
    try {
      const info = await api(`/data/inspect?file=${encodeURIComponent(file)}`);
      const counts = info.counts ?? {};
      const line = node("p",
        `完整性 ${info.integrity} · 曲库 ${counts.songs ?? "?"} 条（已命名 ${counts.named ?? "?"}，已设时段 ${counts.timeOfDay ?? "?"}）· 信件 ${counts.letters ?? "?"} 封`,
        info.valid ? "fieldHint" : "result");
      line.dataset.diagInspect = "1";
      const next = row.nextElementSibling;
      if (next && next.dataset?.diagInspect === "1") next.remove();
      row.after(line);
    } catch (error) {
      ui.dataStatus.textContent = `读取备份内容失败：${error.message}`;
    }
  }

  async function restoreBackup(item) {
    if (!ui) return;
    if (!global.confirm(`用备份「${item.file}」恢复数据库？\n\n· 现在这份会先留档成 before-restore-*.sqlite（随时能再换回来）\n· 恢复要关掉程序再打开才生效\n· 备份来源：${item.label}`)) return;
    ui.dataStatus.textContent = "正在安排恢复…";
    try {
      const result = await api("/data/restore", { method: "POST", body: JSON.stringify({ file: item.file, confirm: true }) });
      ui.dataStatus.textContent = `✓ 已安排恢复 ${result.file} —— 关掉程序再打开就会生效（现在这份已留档）。`;
      await loadDataSafety();
    } catch (error) {
      ui.dataStatus.textContent = `恢复失败：${error.message}`;
    }
  }

  async function cancelRestoreNow() {
    if (!ui) return;
    try {
      await api("/data/cancel-restore", { method: "POST", body: "{}" });
      ui.dataStatus.textContent = "已取消这次恢复，数据库不会被替换。";
      await loadDataSafety();
    } catch (error) {
      ui.dataStatus.textContent = `取消失败：${error.message}`;
    }
  }

  async function revealBackups() {
    if (!ui) return;
    try {
      const result = await api("/data/reveal", { method: "POST", body: "{}" });
      ui.dataStatus.textContent = `已打开备份目录：${result.opened}`;
    } catch (error) {
      ui.dataStatus.textContent = `打开目录失败：${error.message}`;
    }
  }

  async function exportAllData() {
    if (!ui) return;
    ui.transferStatus.textContent = "正在打包用户数据（数据库 + 歌词），稍等…";
    try {
      const result = await api("/data/export", { method: "POST", body: "{}" });
      const removed = Number(result.credentialsRemoved ?? 0);
      ui.transferStatus.textContent = `✓ 已导出 ${result.name}（${bytes(result.bytes)}）：`
        + `曲库 ${result.counts?.songs ?? "?"} 条、已命名 ${result.counts?.named ?? "?"}、已设时段 ${result.counts?.timeOfDay ?? "?"}、歌词 ${result.lyrics ?? 0} 个；`
        + (removed ? `已清除 ${removed} 处 API Key（新机器要重新填一次）。` : "没有需要清除的密钥。")
        + " 这个包等于你的隐私数据，别随意外发。";
    } catch (error) {
      ui.transferStatus.textContent = `导出失败：${error.message}`;
    }
  }

  async function importDataFile(file) {
    if (!ui || !file) return;
    if (!global.confirm(`从「${file.name}」导入？\n\n· 会用它替换当前数据库\n· 当前这份会先留档成 before-restore-*.sqlite\n· 导入要关掉程序再打开才生效`)) return;
    ui.transferStatus.textContent = "正在上传并校验导出包…";
    try {
      const response = await global.fetch(`${BASE}/data/import?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const body = await response.json().catch(() => ({}));
      if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "导入失败");
      const data = body?.data ?? body;
      ui.transferStatus.textContent = `✓ 已接受导入（${data?.name ?? file.name}）—— 关掉程序再打开就生效。`;
      await loadDataSafety();
    } catch (error) {
      ui.transferStatus.textContent = `导入失败：${error.message}`;
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-diagnostics");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "诊断"),
      node("small", "启动慢在哪 · 曲库有没有脏数据 · 游戏崩在哪；要给作者报障，用下面的「一键诊断包」"),
    );

    // g13：这一页很长，先给一条"本页目录 + 直达按钮"，新用户才不会以为诊断只有上面几块
    const navBox = node("section", null, "settingsBlock ln-diagNav");
    navBox.append(node("p",
      "诊断这一块往下依次是：读取启动耗时 → 曲库健康检查 → 游戏崩溃记录 → 一键诊断包 → 数据备份与恢复（含导出迁移）→ 游戏日志（在最底部）。找不到就点这几个按钮直接跳。",
      "fieldHint"));
    const navActions = node("div", null, "actions");
    const navCrash = node("button", "去游戏崩溃记录", "secondary compact");
    const navPack = node("button", "去一键诊断包", "secondary compact");
    const navLog = node("button", "去游戏日志", "secondary compact");
    const navData = node("button", "去数据备份与恢复", "secondary compact");
    for (const button of [navCrash, navPack, navLog, navData]) button.type = "button";
    navActions.append(navCrash, navPack, navLog, navData);
    navBox.append(navActions);

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

    // g13：一键诊断包
    const packHead = node("div", null, "settingsBlockHead ln-diagSpacer ln-diagPack");
    packHead.append(
      node("strong", "一键诊断包"),
      node("small", "点「导出诊断包」得到一个 zip（已脱敏）—— 把它发给作者就能直接排障；不含数据库、信件、记忆、歌词、音视频"),
    );
    const packActions = node("div", null, "actions");
    const packButton = node("button", "导出诊断包", "secondary");
    const packPreviewButton = node("button", "先看打包内容", "secondary");
    const packRevealButton = node("button", "打开所在目录", "secondary");
    for (const button of [packButton, packPreviewButton, packRevealButton]) button.type = "button";
    packActions.append(packButton, packPreviewButton, packRevealButton);
    const packOut = node("div", null, "ln-diagOut");

    // g13：游戏崩溃记录
    const crashHead = node("div", null, "settingsBlockHead ln-diagSpacer ln-diagCrash");
    crashHead.append(
      node("strong", "游戏崩溃记录"),
      node("small", "点下面「解读崩溃报告」→ 读游戏的 crash.txt / crash.dmp，告诉你崩在哪个模块、是不是本程序改过的文件，并生成一段可以发给官方的文本"),
    );
    const crashActions = node("div", null, "actions");
    const crashButton = node("button", "解读崩溃报告", "secondary");
    crashButton.type = "button";
    crashActions.append(crashButton);
    const crashOut = node("div", null, "ln-diagOut");

    // g14：数据备份与恢复（+ 导出迁移）
    const dataHead = node("div", null, "settingsBlockHead ln-diagSpacer ln-diagData");
    dataHead.append(
      node("strong", "数据备份与恢复"),
      node("small", "你的整理成果（曲名 / 时段 / 歌词关联 / 信件）全在数据库里。平时改时段、写曲名都会自动留一份备份 —— 这里可以手动再存一份、随时看某份备份里有什么、出错时回滚，或者把全部数据打包换电脑"),
    );
    const dataActions = node("div", null, "actions");
    const backupNowButton = node("button", "立即备份", "secondary");
    const revealBackupsButton = node("button", "打开备份目录", "secondary");
    const refreshBackupsButton = node("button", "刷新列表", "secondary compact");
    for (const button of [backupNowButton, revealBackupsButton, refreshBackupsButton]) button.type = "button";
    dataActions.append(backupNowButton, revealBackupsButton, refreshBackupsButton);
    const dataStatus = node("p", "", "fieldHint");
    const dataOut = node("div", null, "ln-diagOut ln-diagDataOut");

    const transferHead = node("div", null, "settingsBlockHead ln-diagSpacer ln-diagTransfer");
    transferHead.append(
      node("strong", "导出 / 导入（换电脑、留底）"),
      node("small", "导出一个 zip：数据库 + 歌词 + 说明。**不含 API Key**（导出时会自动清除，新机器重填一次），也不含音视频；但含你的曲名与信件，别随意外发"),
    );
    const transferActions = node("div", null, "actions");
    const exportDataButton = node("button", "导出全部用户数据（zip）", "secondary");
    const importDataButton = node("button", "从导出包导入", "secondary");
    const importDataInput = node("input");
    importDataInput.type = "file";
    importDataInput.accept = ".zip,application/zip";
    importDataInput.hidden = true;
    for (const button of [exportDataButton, importDataButton]) button.type = "button";
    transferActions.append(exportDataButton, importDataButton, importDataInput);
    const transferStatus = node("p", "", "fieldHint");

    box.append(head, navBox, startupActions, startupOut, healthHead, healthActions, healthOut,
      crashHead, crashActions, crashOut,
      packHead, packActions, packOut,
      dataHead, dataActions, dataStatus, dataOut,
      transferHead, transferActions, transferStatus,
      status);

    // g12：事件绑定必须在 return 之前完成
    ui = {
      box, startupButton, copyButton, healthButton, startupOut, healthOut, crashButton, crashOut,
      packButton, packOut, status,
      dataOut, dataStatus, transferStatus,
    };
    startupButton.addEventListener("click", () => { void loadStartup(); });
    healthButton.addEventListener("click", () => { void loadHealth(); });
    copyButton.addEventListener("click", () => { void copyDiagnostics(); });
    crashButton.addEventListener("click", () => { void loadCrashes(); });
    packButton.addEventListener("click", () => { void exportPackage(); });
    packPreviewButton.addEventListener("click", () => { void previewPackage(); });
    packRevealButton.addEventListener("click", () => { void revealPackage(); });
    backupNowButton.addEventListener("click", () => { void backupNow(); });
    revealBackupsButton.addEventListener("click", () => { void revealBackups(); });
    refreshBackupsButton.addEventListener("click", () => { void loadDataSafety(); });
    exportDataButton.addEventListener("click", () => { void exportAllData(); });
    importDataButton.addEventListener("click", () => importDataInput.click());
    importDataInput.addEventListener("change", () => {
      const file = importDataInput.files?.[0];
      importDataInput.value = "";
      if (file) void importDataFile(file);
    });
    // g13：本页目录的直达按钮 —— 点完滚到对应块（「游戏日志」在下面的另一个面板里，届时已装配好）
    const jumpTo = (selector) => {
      const target = document.querySelector(selector);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else ui.status.textContent = "这一块没找到，可能被别的内容挡住了；往下翻一下就能看到。";
    };
    navCrash.addEventListener("click", () => jumpTo(".ln-diagCrash"));
    navPack.addEventListener("click", () => jumpTo(".ln-diagPack"));
    navLog.addEventListener("click", () => jumpTo(".ln-gamelog"));
    navData.addEventListener("click", () => jumpTo(".ln-diagData"));
    // g14：进页就把备份列表读出来（只读本地目录，很快）
    void loadDataSafety();
    // 进页签就把启动记录读出来（只读本地日志，很快）
    void loadStartup();
    return box;
  }

  global.OliviaSoulDiagnostics = { render: buildPanel };
})(window);
