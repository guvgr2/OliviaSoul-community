// 「同款群核对」面板（g12 新增，独立文件）：
//   把"音频指纹判定为同一录音"的文件夹聚成群，**只给建议**，由人逐群确认后才有作用。
//   安全约定：
//     · 建议不落库：只有点「采纳这一群」才写进 UserData\listen-naming-groups.csv
//     · 连带命名另有总开关，默认关；关掉时命名只影响当前这一首
//     · 超过上限（默认 6 首）的群标成"可疑"，不允许采纳（误判常表现为畸大的群）
//     · 每一群都给出判定依据（几段通过、最差相似度），方便人工判断像不像
(function (global) {
  "use strict";

  const BASE = "/toy/listen-naming";
  let ui = null;
  let scanning = false;

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

  function say(message, kind) {
    if (!ui) return;
    ui.status.textContent = message || "";
    if (kind) ui.status.dataset.kind = kind;
    else delete ui.status.dataset.kind;
  }

  function renderThresholds(thresholds) {
    if (!ui || !thresholds) return;
    ui.thresholdLine.textContent =
      `判定依据：用 ${thresholds.segments} 段指纹比对，至少 ${thresholds.minPassed} 段 ≥ ${thresholds.threshold}`
      + `，且任何一段不得低于 ${thresholds.floor}；一个群最多 ${thresholds.maxSize} 首才算可信。`;
  }

  function renderGroup(group) {
    const card = node("section", null, "settingsBlock ln-twinCard");
    const head = node("div", null, "settingsBlockHead");
    const title = group.suspicious
      ? `⚠ 可疑：${group.size} 首（超过 ${group.size > 0 ? "" : ""}上限，已禁止采纳）`
      : `建议同群：${group.size} 首`;
    head.append(
      node("strong", title),
      node("small", group.accepted ? `已采纳（群号 ${group.groupId}）` : (group.ignored ? "已忽略" : "待确认")),
    );

    const list = node("ul", null, "ln-twinList");
    for (const member of group.members) {
      const line = node("li");
      const evidence = member.scores
        ? `${member.scores.filter(score => score >= 0.9).length}/${member.scores.length} 段 ≥0.90 · 最差 ${member.worst}`
        : "基准";
      line.append(
        node("span", member.folder, "ln-twinFolder"),
        node("small", evidence, "ln-twinEvidence"),
      );
      list.append(line);
    }

    const actions = node("div", null, "actions ln-twinActions");
    const accept = node("button", group.accepted ? "已采纳" : "采纳这一群", "secondary");
    const ignore = node("button", group.ignored ? "已忽略" : "忽略", "secondary");
    accept.type = "button";
    ignore.type = "button";
    accept.disabled = group.accepted || group.suspicious || group.size > (ui?.thresholds?.maxSize ?? 6);
    ignore.disabled = group.ignored;
    accept.addEventListener("click", () => { void act("accept", group); });
    ignore.addEventListener("click", () => { void act("ignore", group); });
    actions.append(accept, ignore);
    card.append(head, list, actions);
    return card;
  }

  async function act(kind, group) {
    const what = kind === "accept" ? "采纳" : "忽略";
    if (kind === "accept" && !global.confirm(
      `采纳这一群（${group.size} 首）？\n\n${group.folders.join("\n")}\n\n`
      + "采纳后这些文件夹会被登记为「同款群」。"
      + (ui?.twinNaming ? "当前连带命名已开启，命名其中一首时其余没曲名的会一起命名（只补空位）。"
        : "当前连带命名未开启，所以暂时只影响提示，不会自动改名。"))) return;
    try {
      const data = await api(`/groups/${kind}`, { method: "POST", body: JSON.stringify({ folders: group.folders }) });
      say(kind === "accept"
        ? `✓ 已采纳群 ${data.groupId}（${data.members.length} 首）`
        : `已忽略这一群（${data.ignored} 首）`, "done");
      await loadStatus();
    } catch (error) {
      say(`${what}失败：${error.message}`, "fault");
    }
  }

  function renderStatus(data) {
    if (!ui) return;
    ui.thresholds = data.thresholds;
    renderThresholds(data.thresholds);
    ui.progressLine.textContent =
      `已核验 ${data.computed} / ${data.total} 首（还剩 ${data.remaining} 首没算指纹）`
      + `　·　待确认建议 ${data.suggestionCount} 群　·　可疑 ${data.suspiciousCount} 群　·　已采纳 ${data.acceptedCount} 群`;
    ui.twinButton.textContent = data.twinNaming ? "连带命名：已开启（点一下关闭）" : "连带命名：未开启（点一下打开）";
    ui.twinButton.dataset.state = data.twinNaming ? "on" : "off";
    ui.twinHint.textContent = data.twinNamingHint || "";
    ui.groupFile.textContent = data.groupFile ? `索引文件：${data.groupFile}` : "";

    ui.groupsOut.replaceChildren();
    if (!data.groups?.length) {
      ui.groupsOut.append(node("p", data.computed < 2
        ? "还没有足够的指纹：点「继续核验（算一批指纹）」开始。每批大概几秒到几十秒，可以随时停下。"
        : "没有发现新的同款群建议（已采纳或已忽略的不会重复出现）。", "fieldHint"));
      return;
    }
    for (const group of data.groups) ui.groupsOut.append(renderGroup(group));
  }

  async function loadStatus() {
    if (!ui) return;
    try {
      renderStatus(await api("/groups/status"));
    } catch (error) {
      say(`读取同款群状态失败：${error.message}`, "fault");
    }
  }

  async function scan() {
    if (!ui || scanning) return;
    scanning = true;
    ui.scanButton.disabled = true;
    say("正在算一批指纹（每首要解码 3 段音频，慢是正常的）…");
    try {
      const data = await api("/groups/scan", { method: "POST", body: JSON.stringify({ limit: 8, budgetMs: 25000 }) });
      const failed = data.failed?.length ? `，${data.failed.length} 首算不出来（${data.failed[0].reason}）` : "";
      say(`这一批算了 ${data.scanned} 首（用时 ${(data.elapsedMs / 1000).toFixed(1)} 秒）${failed}；`
        + `累计 ${data.computed} / ${data.total}，还剩 ${data.remaining} 首。可以再点一次继续。`,
        data.scanned ? "done" : "warn");
      await loadStatus();
    } catch (error) {
      say(`核验失败：${error.message}`, "fault");
    } finally {
      scanning = false;
      ui.scanButton.disabled = false;
    }
  }

  async function toggleTwin() {
    if (!ui) return;
    const next = ui.twinButton.dataset.state !== "on";
    if (next && !global.confirm(
      "打开「同款群连带命名」？\n\n"
      + "打开后：命名一首时，已采纳的同款群里还没曲名的会一起命名（**只补空位，不会覆盖已有曲名**）。\n"
      + "如果发现连带错了，按 Ctrl+Z 可一次性撤回；诊断面板的「曲库健康检查」也能查出同群名字不一致。")) return;
    try {
      const data = await api("/groups/twin-naming", { method: "POST", body: JSON.stringify({ value: next }) });
      say(data.twinNaming ? "连带命名已开启" : "连带命名已关闭（命名只影响当前这一首）", "done");
      await loadStatus();
    } catch (error) {
      say(`切换失败：${error.message}`, "fault");
    }
  }

  function buildPanel() {
    const box = node("section", null, "settingsBlock ln-twins");
    const head = node("div", null, "settingsBlockHead");
    head.append(
      node("strong", "同款群核对"),
      node("small", "找出「同一录音的不同版本」，登记成群后可一起命名；建议由你逐群确认，绝不自动生效"),
    );

    const actions = node("div", null, "actions ln-twinTop");
    const scanButton = node("button", "继续核验（算一批指纹）", "secondary");
    const refreshButton = node("button", "刷新", "secondary");
    const twinButton = node("button", "连带命名：未开启（点一下打开）", "secondary");
    for (const button of [scanButton, refreshButton, twinButton]) button.type = "button";
    actions.append(scanButton, refreshButton, twinButton);

    const thresholdLine = node("p", "", "fieldHint ln-twinThreshold");
    const progressLine = node("p", "", "fieldHint ln-twinProgress");
    const twinHint = node("p", "", "fieldHint ln-twinHint");
    const groupFile = node("p", "", "fieldHint ln-twinFile");
    const groupsOut = node("div", null, "ln-twinOut");
    const status = node("p", "", "fieldHint ln-twinStatus");
    box.append(head, actions, thresholdLine, progressLine, twinHint, groupFile, groupsOut, status);

    // g12：事件绑定必须在 return 之前完成
    ui = { box, scanButton, refreshButton, twinButton, thresholdLine, progressLine, twinHint, groupFile, groupsOut, status, thresholds: null };
    scanButton.addEventListener("click", () => { void scan(); });
    refreshButton.addEventListener("click", () => { void loadStatus(); });
    twinButton.addEventListener("click", () => { void toggleTwin(); });
    void loadStatus();
    return box;
  }

  global.OliviaSoulTwinGroups = { render: buildPanel };
})(window);
