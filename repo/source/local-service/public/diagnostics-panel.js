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

  function buildPanel() {    const box = node("section", null, "settingsBlock ln-diagnostics");
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

    // g13：一键诊断包
    const packHead = node("div", null, "settingsBlockHead ln-diagSpacer");
    packHead.append(
      node("strong", "一键诊断包"),
      node("small", "把排障需要的材料打成一个 zip（已脱敏）。不含数据库、信件、记忆、歌词、音视频"),
    );
    const packActions = node("div", null, "actions");
    const packButton = node("button", "导出诊断包", "secondary");
    const packPreviewButton = node("button", "先看打包内容", "secondary");
    const packRevealButton = node("button", "打开所在目录", "secondary");
    for (const button of [packButton, packPreviewButton, packRevealButton]) button.type = "button";
    packActions.append(packButton, packPreviewButton, packRevealButton);
    const packOut = node("div", null, "ln-diagOut");

    // g13：游戏崩溃记录
    const crashHead = node("div", null, "settingsBlockHead ln-diagSpacer");
    crashHead.append(
      node("strong", "游戏崩溃记录"),
      node("small", "读游戏的 crash.txt / crash.dmp，告诉你崩在哪个模块（以及是不是本程序改过的文件）"),
    );
    const crashActions = node("div", null, "actions");
    const crashButton = node("button", "解读崩溃报告", "secondary");
    crashButton.type = "button";
    crashActions.append(crashButton);
    const crashOut = node("div", null, "ln-diagOut");

    box.append(head, startupActions, startupOut, healthHead, healthActions, healthOut,
      crashHead, crashActions, crashOut,
      packHead, packActions, packOut, status);

    // g12：事件绑定必须在 return 之前完成
    ui = { box, startupButton, copyButton, healthButton, startupOut, healthOut, crashButton, crashOut, packButton, packOut, status };
    startupButton.addEventListener("click", () => { void loadStartup(); });
    healthButton.addEventListener("click", () => { void loadHealth(); });
    copyButton.addEventListener("click", () => { void copyDiagnostics(); });
    crashButton.addEventListener("click", () => { void loadCrashes(); });
    packButton.addEventListener("click", () => { void exportPackage(); });
    packPreviewButton.addEventListener("click", () => { void previewPackage(); });
    packRevealButton.addEventListener("click", () => { void revealPackage(); });
    // 进页签就把启动记录读出来（只读本地日志，很快）
    void loadStartup();
    return box;
  }

  global.OliviaSoulDiagnostics = { render: buildPanel };
})(window);
