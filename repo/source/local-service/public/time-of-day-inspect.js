// 时段依据复核（g05 新增，独立文件）：把「画面识别」的判定依据摆出来给人看 ——
// 每段视频的缩略图 + 亮度 + 色温 + 判定，数据来自 /listen-naming/time-of-day/inspect。
(function (global) {
  "use strict";

  const TAB = "listen-tools";
  const BASE = "/toy/listen-naming";
  // g13：三个时段与它们在界面上的叫法（数组顺序就是界面上从左到右的顺序）
  const SLOTS = [["TOD12", "白天"], ["TOD1730", "傍晚"], ["TOD20", "夜晚"]];
  let ui = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  /**
   * 亮度 / 色温是后端算出来的原始浮点，展示时取整；拿不到就显示问号，不猜。
   * 注意必须先判 null / 空串再转 Number：Number(null) 是 0、Number("") 也是 0，
   * 直接转会把「没有值」显示成 0，反而比原来的 `?? "?"` 更糟。
   */
  function formatMetric(value) {
    if (value == null || value === "") return "?";
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number)) : "?";
  }

  /**
   * 这一段画面当前被哪些时段占着（返回 [slot, 中文名] 数组）。
   * 一首歌里同一段画面只能占一个时段，所以「改完到底改成了什么」只能这样反查 ——
   * 界面上原来只有「数据库现值：白天=DEFAULT · …」，看不出这一段归谁。
   */
  function slotsOfVariant(mapping, variant) {
    const key = String(variant ?? "");
    if (!key || !mapping) return [];
    return SLOTS.filter(([slot]) => String(mapping[slot] ?? "") === key);
  }

  /** 变体键 → 「第 N 段」，给确认框和写入回执写人话；认不出来就原样显示键名。 */
  function segmentTextOfVariant(segments, variant) {
    const key = String(variant ?? "");
    if (!key) return "";
    const index = (segments ?? []).findIndex((segment) => String(segment.video ?? "") === key);
    return index >= 0 ? `第 ${index + 1} 段` : key;
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    // g13：后端错误响应的 code 是字符串错误码（如 TIME_OF_DAY_FOLDER_NOT_FOUND），
    // 以前只认数字型 code，字符串码被跳过 → 拿到 data:null → 面板空指针崩、还吞掉真正的提示。
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  // 当前正在试听的作品显示在「曲名与时段」页，面板本身在别的页，所以全局找
  function currentFolder() {
    const el = document.querySelector(".ln-folder");
    return el ? el.textContent.trim() : "";
  }

  /**
   * message：写入成功后要显示的回执。必须在**渲染过程中**就塞进新的结果行 ——
   * 这块报告是整体 replaceChildren 重建的，渲染完再往旧节点写回执等于写进空气。
   */
  function renderReport(host, data, message) {
    host.replaceChildren();
    // g13：拿不到数据时给一句人话，别让整块面板炸在 null 上
    if (!data || typeof data !== "object" || !Array.isArray(data.segments)) {
      host.append(node("p",
        "没有拿到这首歌的时段依据。请重试；反复失败就到「高级设置 → 诊断 → 一键诊断包」导一份发我。",
        "result"));
      return;
    }
    const head = node("p", `文件夹 ${data.folder}：共 ${data.segments.length} 段画面`, "fieldHint");
    host.append(head);

    if (!data.segments.length) {
      host.append(node("p", "这首歌在数据库里没有找到可用的视频。", "result"));
      return;
    }

    const row = node("div", null, "ln-todRow");
    for (const segment of data.segments) {
      const card = node("section", null, "settingsBlock ln-todCard");
      const title = node("strong", `第 ${segment.index + 1} 段`);
      // 后端返回的是原始浮点（亮度如 227.285），而判定阈值都是整数（110 / 62 / 10），
      // 直接上屏既啰嗦，还和色温的小数位数对不齐 —— 展示层统一取整。
      const info = node("p", `亮度 ${formatMetric(segment.brightness)} · 色温 ${formatMetric(segment.warmth)}`, "fieldHint");
      const verdict = node("p", `判定：${segment.verdictLabel}`, "ln-todVerdict");
      // 1.0.9：手动指定以前只回一句「已写入 N 行」，用户点完仍然不知道这一段现在算哪个时段
      // （截图核对时就是这么卡住的）。每张卡直接写出它在数据库里当前的归属。
      const held = slotsOfVariant(data.current, segment.video);
      const current = node("p",
        held.length ? `当前：${held.map(([, label]) => label).join(" · ")}` : "当前：未指定",
        "fieldHint ln-todCurrent");
      card.append(title, info, verdict, current);
      if (segment.thumbnailUrl) {
        const img = node("img", null, "ln-todThumb");
        img.src = segment.thumbnailUrl;
        img.alt = `第 ${segment.index + 1} 段画面缩略图`;
        img.loading = "lazy";
        img.width = 160;
        card.append(img);
      }
      if (segment.reason) card.append(node("p", segment.reason, "fieldHint"));

      // g14：手动指定必须挂在「这一段」自己的卡片上。以前三个按钮是全局一行，
      // 后端永远拿第 1 段的变体键写库 —— 第 2、3 段根本改不动，界面却看着像单选。
      const cardActions = node("div", null, "actions ln-todCardActions");
      if (segment.video) {
        cardActions.append(node("span", "指定这一段为：", "fieldHint"));
        for (const [slot, label] of SLOTS) {
          const button = node("button", label, "secondary compact");
          button.type = "button";
          button.addEventListener("click", async () => {
            // 1.0.9：确认框提前说清代价。同一段只能占一个时段，所以把这一段指到新时段时，
            // 原来占着它的那个时段会被清空；目标时段原本指着别的段，也会被替换掉。
            const lines = [`把 ${data.folder} 的第 ${segment.index + 1} 段画面设为「${label}」？`];
            const willClear = slotsOfVariant(data.current, segment.video).filter(([name]) => name !== slot);
            if (willClear.length) {
              lines.push(`当前「${willClear.map(([, name]) => name).join("、")}」指向这一段，会被清空（同一段只能占一个时段）。`);
            }
            const previousVariant = data.current?.[slot];
            if (previousVariant && String(previousVariant) !== String(segment.video)) {
              lines.push(`「${label}」原本指向${segmentTextOfVariant(data.segments, previousVariant)}，将被替换。`);
            }
            lines.push("只改这一首的时段，写库前会自动备份数据库。");
            if (!global.confirm(lines.join("\n"))) return;
            await runAction(host, cardActions, `/time-of-day/set-slot`, { folder: data.folder, slot, variant: segment.video }, data);
          });
          cardActions.append(button);
        }
      } else {
        cardActions.append(node("span", "这一段没有可用的变体键，无法手动指定。", "fieldHint"));
      }
      card.append(cardActions);
      row.append(card);
    }
    host.append(row);

    const t = data.thresholds || {};
    host.append(node("p",
      `判定阈值：亮度 ≥ ${t.brightnessDay} 且偏冷 → 白天；亮度 < ${t.brightnessNight} → 夜晚；偏暖（色温 ≥ ${t.warmthDusk}）→ 傍晚。`,
      "fieldHint"));

    // g13：判错了也能改 —— 显示数据库现值 + 一键按判定重写 + 每段自己手动指定
    const showMapping = (mapping) => {
      if (!mapping) return "（数据库里现在是空）";
      const parts = SLOTS
        .filter(([slot]) => mapping[slot])
        .map(([slot, label]) => `${label}=${mapping[slot]}`);
      return parts.length ? parts.join(" · ") : "（数据库里现在是空）";
    };
    const currentLine = node("p", `数据库现值：${showMapping(data.current)}`, "fieldHint");
    const verdictLine = node("p", `画面判定值：${showMapping(data.mapping)}`, "fieldHint ln-todVerdictLine");
    host.append(currentLine, verdictLine);

    const actions = node("div", null, "actions ln-todActions");
    const rework = node("button", "按画面判定重写这一首", "secondary");
    rework.type = "button";
    // g14：一首歌正常有 3 段画面（白天 / 傍晚 / 夜晚各一段）。只剩 1 段时「按画面判定重写」
    // 会把另外两个时段的映射清成空，播放时三段都回退到同一段视频 —— 这时宁可禁用并说明原因。
    const segmentCount = data.segments.length;
    const shortOfSegments = segmentCount < SLOTS.length;
    if (segmentCount === 1) {
      rework.disabled = true;
      rework.title = "只识别到 1 段画面：重写会清空另外两个时段的映射，播放时三段都会回退到同一段视频。请先补齐这首歌的其它时段视频。";
    }
    actions.append(rework);
    rework.addEventListener("click", async () => {
      const warning = shortOfSegments
        ? `\n\n注意：只识别到 ${segmentCount}/3 段画面，重写会清空另外 ${SLOTS.length - segmentCount} 个时段的映射（播放时回退到同一段视频）。`
        : "";
      if (!global.confirm(`按画面判定重写 ${data.folder} 的时段？\n会覆盖这一首已有的时段，写库前会自动备份数据库。${warning}`)) return;
      await runAction(host, actions, `/time-of-day/rework`, { folder: data.folder }, data);
    });
    host.append(actions);
    if (shortOfSegments) {
      host.append(node("p",
        `这首歌只识别到 ${segmentCount}/3 段画面：按画面判定重写会清空缺的时段，建议先补齐视频，或用每段卡片上的「白天 / 傍晚 / 夜晚」逐个指定。`,
        "fieldHint"));
    }

    const result = node("p", "", "result ln-todResult");
    if (message) result.textContent = message;
    host.append(result);
    host._todResult = result;
  }

  /** g13：修正动作的统一入口（复用同一套接口与错误提示）。 */
  async function runAction(host, actions, path, body, data) {
    const result = host._todResult;
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    if (result) result.textContent = "正在写库（先备份数据库）…";
    try {
      const updated = await api(path, { method: "POST", body: JSON.stringify(body) });
      // 1.0.9：回执要写清「这次改成了什么、原来那个时段被怎么处理了」。老文案只把三个时段
      // 全列一遍，改前改后看着一样，用户没法确认到底生效没有。
      // before 优先用后端回传的 previous（写前快照）；「按画面判定重写」没有 previous，
      // 就退回本次渲染时拿到的现值 —— 两者都是写库前的状态，够用。
      const before = updated?.previous ?? data?.current ?? null;
      const after = updated?.mapping ?? null;
      const currentText = SLOTS
        .filter(([slot]) => after?.[slot])
        .map(([slot, label]) => `${label}=${after[slot]}`)
        .join(" · ");
      const changes = SLOTS
        .filter(([slot]) => String(before?.[slot] ?? "") !== String(after?.[slot] ?? ""))
        .map(([slot, label]) => (after?.[slot]
          ? `${label} → ${segmentTextOfVariant(data?.segments, after[slot])}（${after[slot]}）`
          : `原「${label}」已清空`));
      const receipt = `✓ 已写入 ${updated?.written ?? 0} 行：${currentText || "（空）"}`
        + (changes.length ? `；${changes.join("；")}` : "")
        + (updated?.backupFile ? `（备份 ${updated.backupFile}）` : "");
      // 重新读一次依据，让"数据库现值"和每张卡的"当前"立刻更新。
      // 回执必须交给重渲染去写（它会把整块报告连同结果行一起换掉），否则用户点完什么都看不到。
      try {
        renderReport(host, await api(`/time-of-day/inspect?folder=${encodeURIComponent(data.folder)}`), receipt);
      } catch {
        // 刷新失败不影响写入结果：退回旧的结果行显示回执
        if (result) result.textContent = receipt;
      }
    } catch (error) {
      if (result) result.textContent = `写入失败：${error.message}`;
    } finally {
      for (const button of actions.querySelectorAll("button")) button.disabled = false;
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-todInspect");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "时段依据复核"),
      node("small", "看看程序是凭什么判断白天 / 傍晚 / 夜晚的：缩略图 + 亮度 + 色温，只读不改库"),
    );

    const row = node("div", null, "actions");
    const input = node("input");
    input.type = "text";
    input.placeholder = "文件夹名或编号（留空则用当前试听的作品）";
    input.className = "ln-todInput";
    const button = node("button", "查看依据", "secondary");
    button.type = "button";
    row.append(input, button);

    const status = node("p", "", "fieldHint");
    const out = node("div", null, "ln-todOut");

    // g13 新手引导：这一块经常是"出问题才来找"的地方，所以就地给一条去排障的路
    const helpRow = node("div", null, "actions ln-todHelp");
    const helpText = node("span",
      "看不明白 / 结果不对 / 想报障？排障工具在「更新与维护 → 高级设置」页的最下面：一键诊断包（导一个 zip 发作者）· 游戏崩溃记录 · 游戏日志。",
      "fieldHint");
    const helpButton = node("button", "去诊断（高级设置）", "secondary compact");
    helpButton.type = "button";
    helpRow.append(helpText, helpButton);
    box.append(head, row, status, out, helpRow);

    // g10：事件绑定必须在 return 之前完成（否则按钮点不动）
    helpButton.addEventListener("click", () => {
      const tab = document.querySelector('.sideTab[data-tab="debug"]');
      if (!tab) return;
      tab.click();
      // 切页后面板才装配出来，等一帧再滚到诊断块
      global.setTimeout(() => {
        const target = document.querySelector(".ln-diagnostics");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    });
    button.addEventListener("click", async () => {
      const folder = (input.value || "").trim() || currentFolder();
      if (!folder) {
        status.textContent = "请先填文件夹名或编号，或先到「曲名与时段」里选中一首。";
        return;
      }
      button.disabled = true;
      status.textContent = "正在抽帧分析（每段会调用一次 ffmpeg，第一次约 1~3 秒）…";
      try {
        const data = await api("/time-of-day/inspect?folder=" + encodeURIComponent(folder));
        renderReport(out, data);
        status.textContent = "分析完成。缩略图已缓存，下次查看会快很多。";
      } catch (error) {
        out.replaceChildren();
        status.textContent = "查看失败：" + error.message;
      } finally {
        button.disabled = false;
      }
    });

    // g10：不再自己挂载，由装配器负责 append；面板外壳在事件绑定之后返回
    ui = { box, input, button, status, out };
    return box;
  }


  // g10：只导出 render()，挂载交给装配器（不再有 MutationObserver / 自我重建）
  global.OliviaSoulTimeOfDayInspect = { render: buildPanel };
})(window);
