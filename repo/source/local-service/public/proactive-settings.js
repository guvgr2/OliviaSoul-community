// 「主动来信」设置页：她也可以先写信给你。
//
// 形态是**由头驱动**，不是按关系档位定时投递：先看她有没有话想说（隔太久了 /
// 她上封信里问过你的事），再看上限（默认每 7 天 2 封、每天 1 封），最后看她方不方便
// （不在睡觉 / 上课 / 练琴时段）。判定与尺度全在 local-service/proactive-letters.js
// （纯函数，有单测与变异护栏钉住）；本文件只负责读设置、画作息表、存回去，
// 以及「现在检查一次」。
//
// 与竞品 bside-olivia-community 的差异：只借「要考虑哪些场景」这一层问题清单，
// 不借它的五档结构与参数值（差异说明见 analysis/1.2.0-待审查清单.md §21）。
(function (global) {
  "use strict";

  const BASE = "/toy/letter/proactive";
  const TAB = "proactive";

  // 「她在忙」的六类，与 proactive-letters.js 的 HER_BUSY 对应。
  // 下拉只写活动本身（「睡觉」），右边那格才是完整说法（「她在睡觉」）—— 两格都写全句会看着像重复。
  const ACTIVITY_OPTIONS = [
    ["sleep", "睡觉"],
    ["class", "上课"],
    ["practice", "练琴"],
    ["bathing", "洗澡"],
    ["errand", "在外面办事"],
    ["housework", "忙家务"],
  ];
  const DAY_OPTIONS = [["all", "每天"], ["weekday", "工作日"], ["weekend", "周末"]];
  // Date#getDay() 的编号：0 = 周日。
  const WEEKDAYS = { all: null, weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };

  let loaded = false;
  let defaults = null;

  function id(name) {
    return document.getElementById(name);
  }

  async function api(path, options) {
    const response = await global.fetch(BASE + path, Object.assign({
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    }, options));
    const body = await response.json().catch(() => ({}));
    // /toy/* 的错误一律是 HTTP 200 + 非零 code，所以要按 code 判。
    if (body && body.code !== 0 && body.code != null) throw new Error(body.message || "请求失败");
    return body && "data" in body ? body.data : body;
  }

  function option(value, text) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text;
    return node;
  }

  function daysKey(weekdays) {
    if (!Array.isArray(weekdays) || !weekdays.length) return "all";
    const sorted = [...weekdays].sort((a, b) => a - b).join(",");
    if (sorted === "1,2,3,4,5") return "weekday";
    if (sorted === "0,6") return "weekend";
    return "all";
  }

  function slotRow(slot) {
    const row = document.createElement("div");
    row.className = "proactiveRow";

    const from = document.createElement("input");
    from.type = "time";
    from.dataset.field = "from";
    from.value = slot?.from || "09:00";

    const sep = document.createElement("span");
    sep.className = "proactiveSep";
    sep.textContent = "–";

    const to = document.createElement("input");
    to.type = "time";
    to.dataset.field = "to";
    to.value = slot?.to || "11:00";

    const activity = document.createElement("select");
    activity.dataset.field = "activity";
    for (const [value, text] of ACTIVITY_OPTIONS) activity.append(option(value, text));
    activity.value = ACTIVITY_OPTIONS.some(([value]) => value === slot?.activity) ? slot.activity : "class";

    const label = document.createElement("input");
    label.type = "text";
    label.dataset.field = "label";
    label.placeholder = "她会这样说：我在上课";
    label.value = slot?.label || "她在忙";

    const days = document.createElement("select");
    days.dataset.field = "days";
    for (const [value, text] of DAY_OPTIONS) days.append(option(value, text));
    days.value = daysKey(slot?.weekdays);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.dataset.field = "remove";
    remove.textContent = "删掉";
    remove.addEventListener("click", () => row.remove());

    row.append(from, sep, to, activity, label, days, remove);
    return row;
  }

  function renderRoutine(slots) {
    id("proactiveRoutine").replaceChildren(...(slots ?? []).map(slotRow));
  }

  function collectRoutine() {
    return [...id("proactiveRoutine").querySelectorAll(".proactiveRow")].map(row => {
      const field = name => row.querySelector(`[data-field="${name}"]`);
      return {
        from: field("from").value,
        to: field("to").value,
        activity: field("activity").value,
        label: field("label").value.trim() || "她在忙",
        weekdays: WEEKDAYS[field("days").value] ?? null,
      };
    });
  }

  function showVerdict(verdict) {
    const node = id("proactiveVerdict");
    if (!verdict) {
      node.textContent = "—";
      return;
    }
    node.textContent = verdict.ok
      ? `现在可以写：她会先写一封（由头：${verdict.trigger?.label ?? "想跟你说件小事"}）`
      : `现在不写：${verdict.label || verdict.reason || ""}`;
  }

  function fill(data) {
    defaults = data.defaults ?? defaults;
    id("proactiveEnabled").checked = data.enabled !== false;
    id("proactiveKeepShape").checked = data.keepCurrentShape === true;
    id("proactiveMaxPerDay").value = data.settings?.maxPerDay ?? 1;
    id("proactiveMaxPerWeek").value = data.settings?.maxPerWeek ?? 2;
    id("proactiveMinSilenceDays").value = data.settings?.minSilenceDays ?? 5;
    const routine = data.settings?.routine?.length ? data.settings.routine : (data.defaults?.routine ?? []);
    renderRoutine(routine);
    showVerdict(data.verdict);
  }

  function mark(text) {
    id("proactiveSaveResult").textContent = text;
  }

  async function load() {
    try {
      fill(await api(""));
    } catch (error) {
      id("proactiveVerdict").textContent = `读不到设置：${error.message}`;
    }
  }

  async function save() {
    mark("保存中…");
    try {
      fill(await api("", {
        method: "POST",
        body: JSON.stringify({
          enabled: id("proactiveEnabled").checked,
            keepCurrentShape: id("proactiveKeepShape").checked,
          maxPerDay: Number(id("proactiveMaxPerDay").value),
          maxPerWeek: Number(id("proactiveMaxPerWeek").value),
          minSilenceDays: Number(id("proactiveMinSilenceDays").value),
          routine: collectRoutine(),
        }),
      }));
      mark("已保存");
    } catch (error) {
      mark(`没保存：${error.message}`);
    }
  }

  function reset() {
    if (!defaults) return;
    id("proactiveEnabled").checked = defaults.enabled !== false;
    id("proactiveKeepShape").checked = false;
    id("proactiveMaxPerDay").value = defaults.maxPerDay;
    id("proactiveMaxPerWeek").value = defaults.maxPerWeek;
    id("proactiveMinSilenceDays").value = defaults.minSilenceDays;
    renderRoutine(defaults.routine ?? []);
    mark("已填回默认值 —— 还要点一下「保存」");
  }

  async function check() {
    mark("正在检查…");
    try {
      const result = await api("/check", { method: "POST", body: "{}" });
      mark(result.ok ? "她写了一封 —— 去游戏里的信箱看看" : `没写：${result.label || result.reason}`);
      showVerdict((await api("")).verdict);
    } catch (error) {
      mark(`检查失败：${error.message}`);
    }
  }

  function wire() {
    id("saveProactiveSettings")?.addEventListener("click", save);
    id("resetProactiveSettings")?.addEventListener("click", reset);
    id("checkProactiveNow")?.addEventListener("click", check);
    id("proactiveAddSlot")?.addEventListener("click", () => id("proactiveRoutine").append(slotRow(null)));
  }

  function once() {
    if (loaded) return;
    loaded = true;
    wire();
    load();
  }

  // 页签切换由 app.js 现成的 .sideTab 监听器完成（它按 data-page 显示/隐藏 .tabPage），
  // 这里只补一个「第一次显示时加载」—— 和 listen-naming.js 同一套做法。
  document.addEventListener("click", event => {
    if (event.target?.closest?.(`.sideTab[data-tab="${TAB}"]`)) once();
  });
  if (id("proactiveRoutine")) once();
})(window);
