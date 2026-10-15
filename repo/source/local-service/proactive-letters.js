// 「她主动写信」的决策引擎。
//
// 形态：**由头驱动** —— 先看有没有话想说（隔太久了 + 她上封信问过你的事），
// 再看上限（每周 2 封 / 每天 1 封），最后看她方不方便（不在睡觉 / 上课 / 练琴时段）。
//
// 这是与竞品 bside-olivia-community 的关键差异：只借「要考虑哪些场景」这一层问题清单，
// **不借**它的五档结构（reserved → familiar → trusted → close → committed）、
// 参数值、1.45 系数、命名与文案。差异说明见 analysis/1.2.0-待审查清单.md §21。
//
// 这个模块是纯函数：不碰数据库、不读时钟（时间一律由调用方传进来），
// 于是每条判据都能被单测与变异审查钉住。

/** 主动信的可调参数。默认尺度：每周最多 2 封、每天最多 1 封、隔 5 天她才会先开口。 */
export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 1,
  maxPerWeek: 2,
  minSilenceDays: 5,
  minGapDays: 3,
});

/** 每个「不发」的原因都有名字 —— 设置页直接显示一句人话，而不是沉默。 */
export const PROACTIVE_REASONS = Object.freeze({
  DISABLED: "disabled",
  BAD_SETTINGS: "bad_settings",
  HER_BUSY: "her_busy",
  WAIT_REPLY: "wait_reply",
  LIMIT_DAY: "limit_day",
  LIMIT_WEEK: "limit_week",
  NOT_YET: "not_yet",
  NO_REASON: "no_reason",
  READY: "ready",
});

export const PROACTIVE_REASON_LABELS = Object.freeze({
  [PROACTIVE_REASONS.DISABLED]: "你关掉了「她也可以先写信」",
  [PROACTIVE_REASONS.BAD_SETTINGS]: "设置里有不合法的值",
  [PROACTIVE_REASONS.HER_BUSY]: "她这个时段在忙",
  [PROACTIVE_REASONS.WAIT_REPLY]: "她先写过一封，你还没回",
  [PROACTIVE_REASONS.LIMIT_DAY]: "今天她已经写过一封了",
  [PROACTIVE_REASONS.LIMIT_WEEK]: "这一周她已经写够了",
  [PROACTIVE_REASONS.NOT_YET]: "还没到下一次机会",
  [PROACTIVE_REASONS.NO_REASON]: "她眼下没有特别想说的",
  [PROACTIVE_REASONS.READY]: "她想写一封",
});

export function proactiveReasonLabel(reason) {
  return PROACTIVE_REASON_LABELS[reason] ?? "她这会儿不写";
}

/**
 * 她的作息模板（确定性默认值，用户可在设置页改）。
 * 只登记「她忙、不方便写信」的时段；没命中的时段就是方便。
 * weekdays 用 Date#getDay() 的编号：0 = 周日 … 6 = 周六；不写 = 每天。
 */
export const PROACTIVE_DEFAULT_ROUTINE = Object.freeze([
  { from: "23:30", to: "07:00", activity: "sleep", label: "她在睡觉" },
  { from: "08:00", to: "11:30", activity: "class", label: "她在上课", weekdays: [1, 2, 3, 4, 5] },
  { from: "13:30", to: "17:00", activity: "practice", label: "她在练琴", weekdays: [1, 2, 3, 4, 5] },
  { from: "19:00", to: "21:00", activity: "practice", label: "她在练琴", weekdays: [1, 2, 3, 4, 5] },
]);

const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/u;

/** "HH:MM" → 当天第几分钟；不是合法时刻就返回 null。 */
export function parseClock(text) {
  const m = CLOCK_PATTERN.exec(String(text ?? "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function toMinutes(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 1440) return value;
  return parseClock(value);
}

/**
 * 归一化作息表 → { slots, invalid }。
 * invalid 非空表示有不合法的条目；调用方应当把它当作**拒绝保存**的理由，
 * 而不是静默回退到默认模板（否则用户以为自己改好了，其实没生效）。
 */
export function normalizeRoutine(raw) {
  if (raw === undefined) return { slots: normalizeRoutine(PROACTIVE_DEFAULT_ROUTINE).slots, invalid: [] };
  if (!Array.isArray(raw)) return { slots: [], invalid: ["routine"] };
  const invalid = [];
  const slots = [];
  for (const [index, item] of raw.entries()) {
    const from = toMinutes(item?.from);
    const to = toMinutes(item?.to);
    const activity = String(item?.activity ?? "").trim();
    const label = String(item?.label ?? "").trim();
    if (from === null) { invalid.push(`routine[${index}].from`); continue; }
    if (to === null) { invalid.push(`routine[${index}].to`); continue; }
    if (from === to) { invalid.push(`routine[${index}].range`); continue; }
    if (!activity) { invalid.push(`routine[${index}].activity`); continue; }
    if (!label) { invalid.push(`routine[${index}].label`); continue; }
    const weekdays = Array.isArray(item?.weekdays) && item.weekdays.length
      ? item.weekdays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
      : null;
    slots.push({ from, to, activity, label, weekdays });
  }
  return { slots, invalid };
}

/** 默认模板展开成分钟槽（给内部与测试用）。 */
export function defaultRoutineSlots() {
  return normalizeRoutine(PROACTIVE_DEFAULT_ROUTINE).slots;
}

function resolveRoutineSlots(routine) {
  if (routine === undefined || routine === null || !Array.isArray(routine)) return defaultRoutineSlots();
  return normalizeRoutine(routine).slots;
}

/**
 * 她此刻在忙什么。返回 null = 这个时段方便写信。
 * 跨午夜的时段（from > to，例如 23:30 → 07:00）按「或」判定。
 */
export function herActivityAt(nowMinutes, weekday, slots) {
  const minute = Number(nowMinutes);
  if (!Number.isFinite(minute) || minute < 0 || minute > 1440) return null;
  const day = Number.isInteger(weekday) ? weekday : null;
  for (const slot of slots ?? []) {
    if (slot.weekdays && day !== null && !slot.weekdays.includes(day)) continue;
    const hit = slot.from < slot.to
      ? minute >= slot.from && minute < slot.to
      : minute >= slot.from || minute < slot.to;
    if (hit) return { activity: slot.activity, label: slot.label };
  }
  return null;
}

/**
 * 从她写给你的信里找出最后一句问句 —— 那是她一直记着的事，最适合当由头。
 * 太长的句子（> maxChars）不适合当由头，跳过继续往前找。
 */
export function lastQuestionFrom(text, maxChars = 40) {
  const body = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!body) return null;
  const sentences = body.split(/(?<=[。！？!?])/u);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i].trim();
    if (!/[？?]$/u.test(sentence)) continue;
    if (sentence.length > maxChars) continue;
    if (sentence.length < 4) continue;
    return sentence;
  }
  return null;
}

/**
 * 由头：「有没有话想说」。
 * 前提是你确实有阵子没写信了（minSilenceDays）；在此之上，
 * 如果她上封信里问过什么，由头就更具体。
 */
export function pickReason(settings, ctx = {}) {
  const days = Number(ctx.daysSinceUserLetter);
  if (!Number.isFinite(days) || days < settings.minSilenceDays) return null;
  const question = lastQuestionFrom(ctx.lastHerReply);
  if (question) return { kind: "letter_question", question, days: Math.floor(days) };
  return { kind: "silence", days: Math.floor(days) };
}

/** 由头 → 交给 harness 的一句话。刻意不施压、不催、不质问。 */
export function buildReasonText(trigger) {
  if (!trigger) return "";
  if (trigger.kind === "letter_question")
    return `他有一阵子没来信了（${trigger.days} 天）。她上封信里问过他一件事：「${trigger.question}」她一直记着，想再提一句。`;
  return `他们已经有 ${trigger.days} 天没有通信了。她翻到上次写给他的信，还想接着说一句。`;
}

/** 归一化设置 → { enabled, maxPerDay, maxPerWeek, minSilenceDays, minGapDays, routine, invalid }。 */
export function normalizeProactiveSettings(raw) {
  const source = raw ?? {};
  const invalid = [];
  const pick = (key, min, max) => {
    const value = source[key];
    if (value === undefined || value === null) return PROACTIVE_DEFAULTS[key];
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) { invalid.push(key); return PROACTIVE_DEFAULTS[key]; }
    return n;
  };
  const enabled = source.enabled === undefined ? PROACTIVE_DEFAULTS.enabled : source.enabled === true;
  const maxPerDay = pick("maxPerDay", 0, 10);
  const maxPerWeek = pick("maxPerWeek", 0, 30);
  const minSilenceDays = pick("minSilenceDays", 0, 365);
  const minGapDays = pick("minGapDays", 0, 365);
  const { slots, invalid: routineInvalid } = normalizeRoutine(source.routine);
  invalid.push(...routineInvalid);
  return { enabled, maxPerDay, maxPerWeek, minSilenceDays, minGapDays, routine: slots, invalid };
}

/**
 * 主判定。判定顺序 = 先排除硬约束，再看有没有话想说：
 * 关掉 → 设置非法 → 她在忙 → 她写过你还没回 → 今日上限 → 本周上限 → 间隔 → 由头 → 可以写。
 * 返回 { ok, reason, trigger?, reasonText?, herActivity? }。
 */
export function evaluateProactiveLetter(settings, ctx = {}) {
  const s = settings ?? normalizeProactiveSettings(null);
  if (!s.enabled) return { ok: false, reason: PROACTIVE_REASONS.DISABLED };
  if (Array.isArray(s.invalid) && s.invalid.length)
    return { ok: false, reason: PROACTIVE_REASONS.BAD_SETTINGS, invalid: s.invalid };
  const busy = herActivityAt(ctx.nowMinutes, ctx.weekday, resolveRoutineSlots(s.routine));
  if (busy) return { ok: false, reason: PROACTIVE_REASONS.HER_BUSY, herActivity: busy };
  if (Number(ctx.unansweredProactive ?? 0) >= 1) return { ok: false, reason: PROACTIVE_REASONS.WAIT_REPLY };
  if (Number(ctx.proactive24h ?? 0) >= s.maxPerDay) return { ok: false, reason: PROACTIVE_REASONS.LIMIT_DAY };
  if (Number(ctx.proactive7d ?? 0) >= s.maxPerWeek) return { ok: false, reason: PROACTIVE_REASONS.LIMIT_WEEK };
  const sinceLast = Number(ctx.daysSinceLastProactive);
  if (Number.isFinite(sinceLast) && sinceLast < s.minGapDays)
    return { ok: false, reason: PROACTIVE_REASONS.NOT_YET };
  const trigger = pickReason(s, ctx);
  if (!trigger) return { ok: false, reason: PROACTIVE_REASONS.NO_REASON };
  return { ok: true, reason: PROACTIVE_REASONS.READY, trigger, reasonText: buildReasonText(trigger) };
}
