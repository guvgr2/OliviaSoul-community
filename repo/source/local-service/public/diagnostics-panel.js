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

  /**
   * C2：二次确认走全局通知层（index.html 的 #noticeLayer，与「曲名分享」同一套），
   * 不再用裸 confirm —— 删除备份不可撤销，确认框里必须能看清删的是哪一份。
   * #64：优先用 app.js 暴露的 window.OliviaSoulNotice。层只有一份 DOM，自己摸 DOM + 自挂 click 时，
   * Esc / Enter 会被 app.js 的全局 keydown 直接关层，这里注册的 Promise 就没人兑现（流程静默挂起）。
   * 下面的自建路径只在 app.js 没跑起来（拿不到 OliviaSoulNotice）时兜底 —— 那时也没有那个 keydown，不会互相抢。
   */
  function askNotice({ title, message, confirmText = "确定", cancelText = "取消" }) {
    const shared = global.OliviaSoulNotice;
    if (shared && typeof shared.openNotice === "function")
      return shared.openNotice({ title, message, confirmText, cancelText });
    const layer = global.document.getElementById("noticeLayer");
    const titleNode = global.document.getElementById("noticeTitle");
    const messageNode = global.document.getElementById("noticeMessage");
    const confirmNode = global.document.getElementById("noticeConfirm");
    const cancelNode = global.document.getElementById("noticeCancel");
    if (!layer || !titleNode || !messageNode || !confirmNode || !cancelNode)
      return Promise.resolve(global.confirm(`${title}\n\n${message}`));
    return new Promise(resolvePromise => {
      titleNode.textContent = title;
      messageNode.textContent = message;
      confirmNode.textContent = confirmText;
      cancelNode.textContent = cancelText;
      cancelNode.hidden = false;
      layer.hidden = false;
      const finish = value => {
        layer.hidden = true;
        confirmNode.removeEventListener("click", onYes);
        cancelNode.removeEventListener("click", onNo);
        resolvePromise(value);
      };
      const onYes = () => finish(true);
      const onNo = () => finish(false);
      confirmNode.addEventListener("click", onYes);
      cancelNode.addEventListener("click", onNo);
    });
  }

  /** C2：进度条（既有 .taskProgress + .taskProgressTrack）—— 删除/清理这类会动文件的操作显示进度与结果。 */
  function showProgress(text, percent, state = "running") {
    if (!ui) return;
    const box = ui.dataProgressBox;
    const progress = ui.dataProgress;
    if (!box || !progress) return;
    box.hidden = false;
    progress.dataset.state = state;
    const label = progress.querySelector("strong");
    if (label) label.textContent = text;
    const bar = progress.querySelector(".taskProgressTrack > span");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  }

  /** C2：备份汇总（份数 + 总占用 + 按类型拆开）。数量与字节来自后端，不受列表条数上限影响。 */
  function backupSummaryText(data) {
    const summary = data?.summary ?? null;
    const count = Number(summary?.count ?? data?.total ?? 0);
    if (!count) return "备份目录里还没有备份文件。";
    const kinds = Array.isArray(summary?.kinds) ? summary.kinds : [];
    const parts = kinds.map(kind => `${kind.label} ${kind.count} 份 ${bytes(kind.bytes)}`);
    const size = bytes(Number(summary?.bytes ?? 0));
    return parts.length
      ? `共 ${count} 份 · ${size}（${parts.join(" / ")}）`
      : `共 ${count} 份 · ${size}`;
  }

  /** C2：删一份备份 —— 先二次确认，再显示「删除中」并在进度条上给出结果。 */
  async function deleteBackupFlow(item, button) {
    if (!ui) return;
    const ok = await askNotice({
      title: "删除备份",
      message: `${item.file}\n大小：${bytes(item.bytes)}\n\n此操作不可撤销。`,
      confirmText: "删除",
    });
    if (!ok) return;
    button.disabled = true;
    button.textContent = "删除中…";
    showProgress(`正在删除 ${item.file}…`, 30);
    ui.dataStatus.textContent = `正在删除 ${item.file}…`;
    try {
      const result = await api("/data/backup/delete", {
        method: "POST",
        body: JSON.stringify({ file: item.file, confirm: true }),
      });
      showProgress(`已删除，释放 ${bytes(result.freedBytes)}`, 100, "done");
      await loadDataSafety();
      ui.dataStatus.textContent = `✓ 已删除 ${result.removed}，释放 ${bytes(result.freedBytes)}；还剩 ${Number(result.total) || 0} 份备份`;
    } catch (error) {
      showProgress(`删除失败：${error.message}`, 100, "failed");
      ui.dataStatus.textContent = `删除失败：${error.message}`;
      button.disabled = false;
      button.textContent = "删除";
    }
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

    // C2：先给汇总（份数 + 占用，按类型拆开），再逐份列出 —— 一眼知道备份占了多大、都留了什么
    box.append(node("p", backupSummaryText(data), "fieldHint"));

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      box.append(node("p", "还没有任何备份。点上面「立即备份」存一份，以后改错了可以回到这里。", "fieldHint"));
      return;
    }
    const pendingFile = String(data?.pending?.file ?? "");
    const table = node("table", null, "ln-diagTable");
    const head = node("tr");
    for (const label of ["文件名", "时间", "大小", "类型", "操作"]) head.append(node("th", label));
    table.append(head);
    for (const item of items) {
      const tr = node("tr");
      tr.append(node("td", item.file));
      tr.append(node("td", timeText(item.at)));
      tr.append(node("td", bytes(item.bytes)));
      tr.append(node("td", item.label));
      const actions = node("td");
      const look = node("button", "看内容", "secondary compact");
      look.type = "button";
      look.addEventListener("click", () => { void inspectBackupRow(item.file, tr); });
      if (pendingFile && item.file === pendingFile) {
        // real-shell-notes §4 第 5 条：同一份"待恢复"在页面上只保留一处语义 ——
        // 上面的区块负责「取消这次恢复」，这一行只表达「不能删」，不重复放取消按钮。
        tr.className = "ln-diagPending";
        actions.append(look, node("span", "等待重启恢复，不能删", "fieldHint"));
      } else {
        const restore = node("button", "恢复这一个", "secondary compact");
        restore.type = "button";
        restore.addEventListener("click", () => { void restoreBackup(item); });
        const remove = node("button", "删除", "compact danger");
        remove.type = "button";
        remove.addEventListener("click", () => { void deleteBackupFlow(item, remove); });
        actions.append(look, restore, remove);
      }
      tr.append(actions);
      table.append(tr);
    }
    box.append(table);
    if (Number(data?.total) > items.length)
      box.append(node("p", `另有 ${Number(data.total) - items.length} 份更早的备份，「打开备份目录」能看到全部`, "fieldHint"));
  }

  // 1.0.5：周期自动备份（默认每天一份，最多留 7 份周期备份）
  // 它复用同一个备份目录与同一套设置存储，所以只在这一页加一个设置行，不另开页面。
  const PERIODIC_BACKUP_CHOICES = [
    ["off", "关闭（不建议）"],
    ["1", "每天（默认）"],
    ["7", "每 7 天"],
  ];

  function periodicBackupChoice(data) {
    if (data?.enabled !== true) return "off";
    return Number(data?.intervalDays) === 7 ? "7" : "1";
  }

  function renderPeriodicBackup(data) {
    if (!ui) return;
    const select = ui.periodicSelect;
    select.value = periodicBackupChoice(data);
    const label = select.options[select.selectedIndex]?.textContent ?? "";
    const items = Array.isArray(data?.backups) ? data.backups : [];
    const state = data?.status ?? null;
    const keep = Number(data?.keep) || 7;
    const parts = [`当前：${label}`];
    if (items.length)
      parts.push(`已有 ${items.length} 份周期备份，最新一份 ${timeText(items[0].at)}（${bytes(items[0].bytes)}，${items[0].file}）`);
    else
      parts.push("还没有周期备份 —— 程序启动时检查一次，到了间隔就会自动留第一份");
    parts.push(`只保留最近 ${keep} 份周期备份（手动备份与升级前备份不会被清理）`);
    if (state?.lastError) parts.push(`上次没能备份：${timeText(state.lastErrorAt)} · ${state.lastError}`);
    ui.periodicHint.textContent = parts.join(" · ");

    // C2：保留份数可配置。输入框上下限由后端下发（keepRange），别在前端另写一份范围
    if (ui.keepInput) {
      const range = data?.keepRange ?? null;
      if (range) {
        ui.keepInput.min = String(Number(range.min) || 1);
        ui.keepInput.max = String(Number(range.max) || 60);
      }
      if (global.document.activeElement !== ui.keepInput) ui.keepInput.value = String(keep);
    }
    // C2：改小保留份数**不立刻删** —— 这里显示"将清理几份"，把「确认清理」亮出来（调大即可撤销）
    const removable = Number(data?.cleanup?.removable) || 0;
    if (ui.keepCleanup) {
      ui.keepCleanup.hidden = removable <= 0;
      ui.keepCleanup.dataset.pending = String(removable);
      ui.keepCleanup.textContent = removable > 0 ? `确认清理 ${removable} 份` : "确认清理";
    }
    if (ui.keepStatus) {
      if (removable > 0)
        ui.keepStatus.textContent = `保留份数改成 ${keep} 后，将清理 ${removable} 份旧周期备份（调大即可撤销）。`;
      else if (ui.keepStatus.textContent.startsWith("保留份数改成"))
        ui.keepStatus.textContent = "";
    }
  }

  async function loadPeriodicBackup() {
    if (!ui) return;
    try {
      renderPeriodicBackup(await api("/data/periodic-backup"));
    } catch (error) {
      ui.periodicStatus.textContent = `读取周期备份设置失败：${error.message}`;
    }
  }

  async function savePeriodicBackup(value) {
    if (!ui) return;
    const body = value === "off" ? { enabled: false } : { enabled: true, intervalDays: Number(value) };
    ui.periodicStatus.textContent = "正在保存…";
    try {
      renderPeriodicBackup(await api("/data/periodic-backup", {
        method: "POST",
        body: JSON.stringify(body),
      }));
      ui.periodicStatus.textContent = "✓ 已保存（立刻生效，不用重启）";
    } catch (error) {
      ui.periodicStatus.textContent = `保存失败：${error.message}`;
      // 保存失败就拉回服务器上的真实值，别让下拉框停在没生效的选择上
      await loadPeriodicBackup();
    }
  }

  /** C2：保存保留份数。后端只记设置、不删文件 —— 要真清理得再点「确认清理」。 */
  async function saveBackupKeep() {
    if (!ui) return;
    const keep = Number.parseInt(String(ui.keepInput.value ?? "").trim(), 10);
    ui.keepStatus.textContent = "正在保存…";
    try {
      renderPeriodicBackup(await api("/data/periodic-backup", {
        method: "POST",
        body: JSON.stringify({ keep }),
      }));
      // 必须无条件写回显：renderPeriodicBackup 只更新既有节点，「正在保存…」还留在
      // keepStatus 里，写成 if (!textContent) 就会永远停在「正在保存…」（真实浏览器实测踩到过）。
      ui.keepStatus.textContent = `✓ 已保存：周期备份最多留 ${keep} 份`;
    } catch (error) {
      ui.keepStatus.textContent = `保存失败：${error.message}`;
      await loadPeriodicBackup();
    }
  }

  /** C2：真的动手清理（只有用户点了「确认清理」才会走到这里）。 */
  async function cleanupPeriodicBackups() {
    if (!ui) return;
    const count = Number(ui.keepCleanup?.dataset.pending) || 0;
    const ok = await askNotice({
      title: "清理旧周期备份",
      message: `将删除 ${count || "若干"} 份最早的周期备份。\n手动备份、升级前备份、以及正在使用的数据库都不会被删。\n\n此操作不可撤销。`,
      confirmText: "清理",
    });
    if (!ok) return;
    ui.keepCleanup.disabled = true;
    ui.keepStatus.textContent = "正在清理旧周期备份…";
    showProgress("正在清理旧周期备份…", 40);
    try {
      const result = await api("/data/periodic-backup/cleanup", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      const removed = Array.isArray(result.removed) ? result.removed.length : 0;
      showProgress(`已清理 ${removed} 份，保留 ${Number(result.keep) || 0} 份`, 100, "done");
      ui.keepStatus.textContent = `✓ 已清理 ${removed} 份旧周期备份`;
      await loadPeriodicBackup();
      await loadDataSafety();
    } catch (error) {
      showProgress(`清理失败：${error.message}`, 100, "failed");
      ui.keepStatus.textContent = `清理失败：${error.message}`;
    } finally {
      ui.keepCleanup.disabled = false;
    }
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

  async function cancelRestoreNow() {    if (!ui) return;
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

  // g21 ①：本机体检结果的展示（内存 / 内核池 / 页面文件 / 常驻进程 / 崩溃概览）。
  // 结论是参考信息：面板上标了「实验性」，数据只在本机显示、不上传。
  function renderSystemCheck(data) {
    const wrap = node("div");
    const system = data && data.system ? data.system : {};
    const crashes = data && data.crashes ? data.crashes : {};
    const memory = system.memory || {};
    const pool = system.kernelPool || {};
    if (system.error) wrap.append(node("p", `没取到系统状态：${system.error}`, "fieldHint"));
    if (memory.availableMB != null) wrap.append(node("p", `可用物理内存：${memory.availableMB} MB（本机共 ${memory.totalMB != null ? memory.totalMB : "?"} MB）`));
    if (memory.commitPercent != null) wrap.append(node("p", `提交内存：${memory.commitPercent}%（已用 ${memory.committedMB} MB，上限 ${memory.commitLimitMB} MB）`));
    if (pool.nonpagedMB != null) {
      wrap.append(node("p", `内核非分页池：${pool.nonpagedMB} MB`));
      if (pool.note) wrap.append(node("p", pool.note, "fieldHint"));
    }
    if (system.pageFile && system.pageFile.totalGB != null) wrap.append(node("p", `页面文件：${system.pageFile.totalGB} GB`));
    if (system.uptimeHours != null) wrap.append(node("p", `已开机：${system.uptimeHours} 小时`));
    const known = system.processes && Array.isArray(system.processes.known) ? system.processes.known : [];
    if (known.length) {
      wrap.append(node("p", "常驻进程（只列与本程序、游戏相关的）："));
      for (const item of known.slice(0, 8)) wrap.append(node("p", `　${item.name} × ${item.count}，提交 ${item.commitMB} MB`, "fieldHint"));
    }
    if (crashes.total != null) wrap.append(node("p", `游戏崩溃记录：${crashes.total} 次${crashes.lastAt ? `，最近一次 ${crashes.lastAt}` : ""}`));
    const warnings = system.warnings && Array.isArray(system.warnings) ? system.warnings : [];
    for (const text of warnings) wrap.append(node("p", `⚠ ${text}`, "fieldHint"));
    if (!wrap.childNodes.length) wrap.append(node("p", "没有取到可显示的信息（可能是系统权限限制）", "fieldHint"));
    return wrap;
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-diagnostics");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "诊断"),
      node("small", "启动慢在哪 · 曲库有没有脏数据 · 游戏崩在哪；要给作者报障，用下面的「一键诊断包」"),
    );

    // g21 ①：本机体检放在诊断页最上面 —— 它直接回答「游戏为什么崩、是不是本程序的问题」。
    const checkBox = node("section", null, "settingsBlock ln-diagSystem");
    checkBox.append(
      node("strong", "本机体检（实验性）"),
      node("small", "内存 / 内核内存池 / 页面文件 / 常驻进程 + 崩溃概览。结论只是参考，数据只在本机显示、不会上传", "fieldHint"),
    );
    const checkActions = node("div", null, "actions");
    const checkButton = node("button", "一键体检", "secondary");
    checkButton.type = "button";
    checkActions.append(checkButton);
    const checkOut = node("div", null, "ln-diagOut");
    checkBox.append(checkActions, checkOut);
    checkButton.addEventListener("click", async () => {
      checkButton.disabled = true;
      checkOut.replaceChildren(node("p", "正在读取本机状态（约 1~2 秒）…", "fieldHint"));
      try {
        const data = await api("/diagnostics/system");
        checkOut.replaceChildren(renderSystemCheck(data));
      } catch (error) {
        checkOut.replaceChildren(node("p", `体检失败：${error && error.message ? error.message : error}`, "fieldHint"));
      } finally { checkButton.disabled = false; }
    });

    // g13：这一页很长，先给一条"本页目录 + 直达按钮"，新用户才不会以为诊断只有上面几块
    const navBox = node("section", null, "settingsBlock ln-diagNav");
    navBox.append(node("p",
      "诊断这一块往下依次是：读取启动耗时 → 曲库健康检查 → 游戏崩溃记录 → 完整诊断包 → 数据备份与恢复（含导出迁移）→ 游戏崩溃规避 → 游戏日志（在最底部）。找不到就点这几个按钮直接跳。",
      "fieldHint"));
    const navActions = node("div", null, "actions");
    const navCrash = node("button", "去游戏崩溃记录", "secondary compact");
    const navPack = node("button", "去一键诊断包", "secondary compact");
    const navLog = node("button", "去游戏日志", "secondary compact");
    const navData = node("button", "去数据备份与恢复", "secondary compact");
    const navStability = node("button", "去游戏崩溃规避", "secondary compact");
    for (const button of [navCrash, navPack, navLog, navData, navStability]) button.type = "button";
    navActions.append(navCrash, navPack, navLog, navData, navStability);
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
      node("small", "点下面「解读崩溃报告」→ 读游戏的 crash.txt / crash.dmp，告诉你崩在哪个模块、是不是本程序改过的文件，并生成一段可以发给官方的文本；如果反复崩在同一处，也可以试试下面的「游戏崩溃规避」—— 但它是实验性功能、实测对本游戏无效（参数到不了游戏的内嵌浏览器），程序会在开启后又崩时直接把结论写在那个面板里"),
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
      node("small", "你的整理成果（曲名 / 时段 / 歌词关联 / 信件）全在数据库里。平时改时段、写曲名都会自动留一份备份，现在还会按天自动留（见下面「周期自动备份」，可关）—— 这里可以手动再存一份、随时看某份备份里有什么、出错时回滚，或者把全部数据打包换电脑"),
    );
    const dataActions = node("div", null, "actions");
    const backupNowButton = node("button", "立即备份", "secondary");
    const revealBackupsButton = node("button", "打开备份目录", "secondary");
    const refreshBackupsButton = node("button", "刷新列表", "secondary compact");
    for (const button of [backupNowButton, revealBackupsButton, refreshBackupsButton]) button.type = "button";
    dataActions.append(backupNowButton, revealBackupsButton, refreshBackupsButton);
    const dataStatus = node("p", "", "fieldHint");
    const dataOut = node("div", null, "ln-diagOut ln-diagDataOut");
    // C2：删除/清理的进度（复用既有 .taskProgress 结构）。放在 dataOut **外面**：刷新列表会
    // replaceChildren，进度条不能被一起清掉，否则"删除完成/失败"的结果一闪就没了。
    // 外层盒子是裸 div（没有 display 规则），所以 hidden 生效 —— .taskProgress 本身是 grid，hidden 会被它盖掉。
    const dataProgressBox = node("div");
    dataProgressBox.hidden = true;
    const dataProgress = node("div", null, "taskProgress");
    const progressLine = node("div");
    progressLine.append(node("span", "备份清理"), node("strong", "准备中…"));
    const progressTrack = node("span", null, "taskProgressTrack");
    progressTrack.append(node("span"));
    dataProgress.append(progressLine, progressTrack);
    dataProgressBox.append(dataProgress);

    // 1.0.5：周期自动备份设置行（默认开启、每 1 天、最多留 7 份）
    const periodicRow = node("div", null, "ln-diagPeriodic");
    const periodicText = node("div");
    periodicText.append(
      node("strong", "周期自动备份"),
      node("small", "程序启动时会检查距上次备份的时间：超过间隔就自动留一份 —— 就算你从不点「立即备份」，也不会一直没有退路。备份失败只记日志，不影响使用。"),
    );
    const periodicSelect = node("select");
    for (const [value, label] of PERIODIC_BACKUP_CHOICES) {
      const option = node("option", label);
      option.value = value;
      periodicSelect.append(option);
    }
    periodicSelect.setAttribute("aria-label", "周期自动备份间隔");
    // C2：保留份数可配置（默认 7 份）。控件与下拉框同一行；输入框的上下限由后端 keepRange 下发。
    const keepBox = node("div");
    keepBox.append(
      node("strong", "保留份数"),
      node("small", "周期自动备份最多留几份。改小不会立刻删：先告诉你将清理几份，确认后才真删（调大即可撤销）。"),
    );
    const keepInput = node("input");
    keepInput.type = "number";
    keepInput.min = "1";
    keepInput.max = "60";
    keepInput.step = "1";
    keepInput.value = "7";
    keepInput.setAttribute("aria-label", "周期备份保留份数");
    const keepSave = node("button", "保存份数", "secondary compact");
    keepSave.type = "button";
    const keepCleanup = node("button", "确认清理", "compact danger");
    keepCleanup.type = "button";
    keepCleanup.hidden = true;
    const keepStatus = node("p", "", "fieldHint");
    keepBox.append(keepInput, keepSave, keepCleanup, keepStatus);
    periodicRow.append(periodicText, periodicSelect, keepBox);
    const periodicHint = node("p", "", "fieldHint");
    const periodicStatus = node("p", "", "fieldHint");

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
      dataHead, dataActions, dataStatus, dataProgressBox, dataOut,
      periodicRow, periodicHint, periodicStatus,
      transferHead, transferActions, transferStatus,
      status);

    // g12：事件绑定必须在 return 之前完成
    ui = {
      box, startupButton, copyButton, healthButton, startupOut, healthOut, crashButton, crashOut,
      packButton, packOut, status,
      dataOut, dataStatus, dataProgressBox, dataProgress, transferStatus,
      periodicSelect, periodicHint, periodicStatus,
      keepInput, keepSave, keepCleanup, keepStatus,
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
    periodicSelect.addEventListener("change", () => { void savePeriodicBackup(periodicSelect.value); });
    keepSave.addEventListener("click", () => { void saveBackupKeep(); });
    keepCleanup.addEventListener("click", () => { void cleanupPeriodicBackups(); });
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
    navStability.addEventListener("click", () => jumpTo(".ln-gameStability"));
    // g14：进页就把备份列表读出来（只读本地目录，很快）
    void loadDataSafety();
    // 1.0.5：周期备份的设置与现状（只读设置 + 本地目录，很快）
    void loadPeriodicBackup();
    // 进页签就把启动记录读出来（只读本地日志，很快）
    void loadStartup();
    return box;
  }

  global.OliviaSoulDiagnostics = { render: buildPanel };
})(window);
