// 面板装配器（g10）：页面上的每个面板由这里统一按注册表顺序装配，模块自己不挂载。
// 规则：页签第一次激活时装配一次 → 打标记；之后不再重建。
// 这样"重复 / 跳动 / 丢失"三种症状从结构上不可能出现（不再有自我重建）。
//
// 装配语义（g10 修复：以前一律清空整页，把「高级设置」原有内容删了，导致点该页报
// "Cannot set properties of null (setting 'value')"）：
//   · 页面没标 data-panel-mount="keep"  → 面板接管整页：先清空，再按注册表顺序放
//   · 页面标了 keep，且面板只是往页尾追加（默认）→ 一个原有子节点都不动
//   · 页内有 [data-panel-host-anchor] → 面板插在锚点之后（锚点之前的原有内容不动）
(function (global) {
  "use strict";

  // 唯一真相：页面 → 面板顺序
  const REGISTRY = {
    "listen-tools": ["OliviaSoulListenNamingPlayer", "OliviaSoulTimeOfDayInspect", "OliviaSoulTwinGroups"],
    "debug": ["OliviaSoulMigrate", "OliviaSoulDiagnostics"],
    "update": ["OliviaSoulUpdateNotes"],
  };

  let assembling = false;   // 装配期间忽略自己造成的 DOM 变动（这里不用观察器，保留仅为防御）

  function assemble(page) {
    const panels = REGISTRY[page] || [];
    // 只装配"注册过面板"的页面：其它页面（例如 曲名与时段）有自己的内容，绝不能清空
    if (!panels.length) return;
    const host = document.querySelector('.tabPage[data-page="' + page + '"]');
    if (!host || host.dataset.panelHostReady === "1") return;
    host.dataset.panelHostReady = "1";
    assembling = true;
    try {
      // 只在页面允许时才清空：标了 keep 的页面（高级设置 / 软件更新）原有 DOM 里有
      // app.js 在加载时就缓存好的元素引用，清空会让它写到 null 上。
      if (host.dataset.panelMount !== "keep") host.replaceChildren();

      // 页内有锚点 → 面板插在锚点之后。只清掉锚点之后的内容（锚点是页面自己的区块时，
      // 后面不会有什么东西；锚点若由本装配器上一轮留下的面板，说明上次没装完，这里顺手清掉）。
      const anchors = [...host.querySelectorAll("[data-panel-host-anchor]")];
      const anchor = anchors.length ? anchors[anchors.length - 1] : null;
      if (anchor) {
        for (const child of [...host.querySelectorAll("[data-panel-mounted-by-host]")]) {
          if (child !== anchor && !anchor.contains(child)) child.remove();
        }
      }
      let cursor = anchor || null;

      for (const key of panels) {
        const mod = global[key];
        if (!mod || typeof mod.render !== "function") continue;
        try {
          const element = mod.render();
          if (!element) continue;
          element.dataset.panelMountedByHost = "1";
          if (cursor) { cursor.after(element); cursor = element; }
          else host.append(element);
        } catch (error) {
          console.error("[面板装配] " + key + " 渲染失败：", error);
        }
      }
    } finally {
      assembling = false;
    }
  }

  function activate(page) {
    assemble(page);
    // 已装配过的页面只通知模块"可以刷新自己的内容"（不重建外壳）
    for (const key of REGISTRY[page] || []) {
      const mod = global[key];
      if (mod && typeof mod.refresh === "function") {
        try { mod.refresh(); } catch (error) { console.error("[面板刷新] " + key, error); }
      }
    }
  }

  function start() {
    document.querySelectorAll(".sideTab").forEach((button) => {
      button.addEventListener("click", () => {
        const page = button.dataset.tab;
        if (page) global.setTimeout(() => activate(page), 0);
      });
    });
    // 初次加载：把当前可见页装配起来
    const visible = [...document.querySelectorAll(".tabPage")].find((page) => !page.hidden);
    if (visible && visible.dataset.page) activate(visible.dataset.page);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // ---------------- 「打开外链」统一入口（g10 修复） ----------------
  // 以前各面板直接 window.open：便携版 WebView2 里会被当弹窗拦掉（点了没反应）。
  // 现在一律先过后端 /admin/api/open-external：后端只放行https+白名单域名，再交系统默认浏览器。
  // 白名单与 server.js 的 EXTERNAL_LINK_HOSTS 保持一致（前端先挡一道，后端再挡一道）。
  const OPEN_HOSTS = ["github.com", "objects.githubusercontent.com", "api.github.com",
    "raw.githubusercontent.com", "developer.microsoft.com", "www.gyan.dev", "gyan.dev"];

  function hostAllowed(raw) {
    try {
      const parsed = new URL(String(raw || "").trim());
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      return OPEN_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed));
    } catch { return false; }
  }

  async function openExternal(url) {
    const target = String(url || "").trim();
    if (!hostAllowed(target)) throw new Error("只允许打开白名单里的 https 地址");
    // 便携版原生宿主：直接走桌面通道，不经过 node 服务
    if (global.oliviaDesktop && typeof global.oliviaDesktop.openExternal === "function") {
      await global.oliviaDesktop.openExternal(target);
      return target;
    }
    const response = await global.fetch("/admin/api/open-external", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    const body = await response.json().catch(() => ({}));
    if (body && typeof body.code === "number" && body.code !== 0) throw new Error(body.message || "打开外链失败");
    return (body && body.data && body.data.url) || target;
  }

  global.OliviaSoulPanelHost = { assemble, activate, REGISTRY, openExternal, hostAllowed, get assembling() { return assembling; } };
})(window);
