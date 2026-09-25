// 数据搬家助手（g05 新增，独立文件）：
// 便携版的数据目录固定在 <安装目录>\UserData，很多用户机器上还留着另一份旧安装的数据，
// 程序默认看不到，用户会以为"曲库是空的"。这里只读探测本机其它安装，找到后可一键复制过来。
(function (global) {
  "use strict";

  const TAB = "debug";
  const BASE = "/toy/listen-naming";
  let ui = null;

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

  function mb(bytes) {
    return (Number(bytes || 0) / 1048576).toFixed(1) + " MB";
  }

  function renderItems(host, data) {
    host.replaceChildren();
    if (!data.items || !data.items.length) {
      host.append(node("p", "没有在本机找到其它 OliviaSoul 数据目录。", "fieldHint"));
      return;
    }
    for (const item of data.items) {
      const card = node("section", null, "settingsBlock ln-migrateCard");
      const title = node("strong", item.isCurrent ? item.path + "（当前正在使用）" : item.path);
      const info = node("p", item.exists
        ? `曲目 ${item.songCount} 首（已命名 ${item.namedCount} 首） · 数据库 ${mb(item.sizeBytes)}`
          + (item.libraryRoot ? ` · 曲库 ${item.libraryRoot}` : "")
        : "这个目录里没有数据库", "fieldHint");
      card.append(title, info);
      if (item.error) card.append(node("p", "读取失败：" + item.error, "fieldHint"));
      if (item.exists && !item.isCurrent) {
        const actions = node("div", null, "actions");
        const button = node("button", "复制到本安装", "secondary");
        button.type = "button";
        const result = node("p", "", "fieldHint");
        button.addEventListener("click", async () => {
          if (!global.confirm("把这份数据复制到当前安装？\n\n会先备份当前数据库，复制完成后需要关闭并重新打开程序。")) return;
          button.disabled = true;
          result.textContent = "正在复制…";
          try {
            const done = await api("/migrate/apply", { method: "POST", body: JSON.stringify({ path: item.path }) });
            result.textContent = `已复制 ${done.copied.join("、")}；原库已备份为 ${done.backup.split("\\").pop()}。请关闭并重新打开程序。`;
          } catch (error) {
            result.textContent = "复制失败：" + error.message;
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
        card.append(actions, result);
      }
      host.append(card);
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-migrate");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "数据搬家"),
      node("small", "如果本机还装过别的 OliviaSoul，可以把那份数据复制到当前安装来（只读探测，复制前会先备份）"),
    );
    const actions = node("div", null, "actions");
    const scan = node("button", "扫描本机其它安装", "secondary");
    scan.type = "button";
    actions.append(scan);
    const status = node("p", "", "fieldHint");
    const out = node("div", null, "ln-migrateOut");
    box.append(head, actions, status, out);

    // g10：事件绑定必须在 return 之前完成（否则按钮点不动）
    scan.addEventListener("click", async () => {
      scan.disabled = true;
      status.textContent = "正在扫描各磁盘（只看盘根下一层，约 1~2 秒）…";
      try {
        const data = await api("/migrate/detect");
        renderItems(out, data);
        status.textContent = `扫描完成（${data.scannedMs} 毫秒）。当前使用：${data.current}`;
      } catch (error) {
        status.textContent = "扫描失败：" + error.message;
      } finally {
        scan.disabled = false;
      }
    });
    // g10：不再自己挂载，由装配器负责 append；面板外壳在事件绑定之后返回
    ui = { box, scan, status, out };
    return box;
  }


  // g10：只导出 render()，挂载交给装配器（不再有 MutationObserver / 自我重建）
  global.OliviaSoulMigrate = { render: buildPanel };
})(window);
