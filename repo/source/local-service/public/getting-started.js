// 新手引导（g13）：只做一件事 —— 记住「功能地图」的收起状态。
// 默认展开（第一次用的人要看到）；用户收起后写 localStorage，下次进来不再自动弹开。
// 独立文件、只碰自己的元素，不参与面板装配（避免动到「基础设置」页原有的 DOM 引用）。
(function (global) {
  "use strict";

  const KEY = "olivia-guide-map";

  function read() {
    try { return global.localStorage?.getItem(KEY) ?? ""; } catch { return ""; }
  }
  function write(value) {
    try { global.localStorage?.setItem(KEY, value); } catch { /* 隐私模式等写不进去就算了 */ }
  }

  function init() {
    const map = global.document?.getElementById("guideMap");
    if (map) {
      if (read() === "collapsed") map.open = false;
      map.addEventListener("toggle", () => write(map.open ? "open" : "collapsed"));
    }
    applyTips();
  }

  /**
   * 把 data-tip 里的功能说明落到 title 上。
   * app.js 的提醒逻辑会改写 title（有提醒时是"说明｜提醒"），没提醒时也由它恢复；
   * 这里再兜一次底，保证任何情况下页签/分组都留着说明 —— 新手引导不能再被顺手清掉。
   */
  function applyTips() {
    const doc = global.document;
    if (!doc) return;
    for (const element of doc.querySelectorAll("[data-tip]")) {
      const tip = element.dataset.tip || "";
      if (!tip) continue;
      const current = element.getAttribute("title") || "";
      if (!current) element.setAttribute("title", tip);
      else if (!current.startsWith(tip)) element.setAttribute("title", `${tip}｜${current}`);
    }
  }

  if (global.document?.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  global.OliviaSoulGettingStarted = { reset: () => write("open") };
})(window);
