// 时段依据复核（g05 新增，独立文件）：把「画面识别」的判定依据摆出来给人看 ——
// 每段视频的缩略图 + 亮度 + 色温 + 判定，数据来自 /listen-naming/time-of-day/inspect。
(function (global) {
  "use strict";

  const TAB = "listen-tools";
  const BASE = "/toy/listen-naming";
  let ui = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  async function api(path) {
    const response = await global.fetch(BASE + path, { credentials: "include" });
    const body = await response.json().catch(() => ({}));
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  // 当前正在试听的作品显示在「曲名与时段」页，面板本身在别的页，所以全局找
  function currentFolder() {
    const el = document.querySelector(".ln-folder");
    return el ? el.textContent.trim() : "";
  }

  function renderReport(host, data) {
    host.replaceChildren();
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
      const info = node("p", `亮度 ${segment.brightness ?? "?"} · 色温 ${segment.warmth ?? "?"}`, "fieldHint");
      const verdict = node("p", `判定：${segment.verdictLabel}`, "ln-todVerdict");
      card.append(title, info, verdict);
      if (segment.thumbnailUrl) {
        const img = node("img", null, "ln-todThumb");
        img.src = segment.thumbnailUrl;
        img.alt = `第 ${segment.index + 1} 段画面缩略图`;
        img.loading = "lazy";
        img.width = 160;
        card.append(img);
      }
      if (segment.reason) card.append(node("p", segment.reason, "fieldHint"));
      row.append(card);
    }
    host.append(row);

    const t = data.thresholds || {};
    host.append(node("p",
      `判定阈值：亮度 ≥ ${t.brightnessDay} 且偏冷 → 白天；亮度 < ${t.brightnessNight} → 夜晚；偏暖（色温 ≥ ${t.warmthDusk}）→ 傍晚。`,
      "fieldHint"));
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
    input.placeholder = "文件夹编号（留空则用当前试听的作品）";
    input.className = "ln-todInput";
    const button = node("button", "查看依据", "secondary");
    button.type = "button";
    row.append(input, button);

    const status = node("p", "", "fieldHint");
    const out = node("div", null, "ln-todOut");
    box.append(head, row, status, out);

    // g10：事件绑定必须在 return 之前完成（否则按钮点不动）
    button.addEventListener("click", async () => {
      const folder = (input.value || "").trim() || currentFolder();
      if (!folder) {
        status.textContent = "请先填文件夹编号，或先到「曲名与时段」里选中一首。";
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
