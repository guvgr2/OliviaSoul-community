// 「她主动写信」决策引擎的护栏。
//
// 这一套的重点是**每条「不发」都真的会被判出来**：判据一旦被删掉或被换个顺序，
// 断言必须变红（配套 .test-twins/mut-config-proactive-letters.json）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROACTIVE_DEFAULTS,
  PROACTIVE_REASONS,
  buildReasonText,
  defaultRoutineSlots,
  evaluateProactiveLetter,
  herActivityAt,
  lastQuestionFrom,
  normalizeProactiveSettings,
  normalizeRoutine,
  parseClock,
  pickReason,
  proactiveReasonLabel,
} from "../proactive-letters.js";

const readyCtx = (extra = {}) => ({
  nowMinutes: 18 * 60, // 18:00 落在默认作息的上课 / 练琴之外，属于她方便的时段
  weekday: 3,
  daysSinceUserLetter: 6,
  daysSinceLastProactive: 30,
  proactive24h: 0,
  proactive7d: 0,
  unansweredProactive: 0,
  lastHerReply: "今天琴房很安静。你上次说的那首曲子，练完了吗？",
  ...extra,
});

test("默认尺度：每周最多 2 封、每天最多 1 封、隔 5 天她才会先开口", () => {
  assert.equal(PROACTIVE_DEFAULTS.enabled, true);
  assert.equal(PROACTIVE_DEFAULTS.maxPerDay, 1);
  assert.equal(PROACTIVE_DEFAULTS.maxPerWeek, 2);
  assert.equal(PROACTIVE_DEFAULTS.minSilenceDays, 5);
  assert.equal(PROACTIVE_DEFAULTS.minGapDays, 3);
});

test("parseClock：合法时刻转分钟，非法一律 null", () => {
  assert.equal(parseClock("00:00"), 0);
  assert.equal(parseClock("9:05"), 545);
  assert.equal(parseClock("23:59"), 1439);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("23:60"), null);
  assert.equal(parseClock(""), null);
  assert.equal(parseClock(null), null);
  assert.equal(parseClock("晚上九点"), null);
});

test("herActivityAt：工作日上课时段命中，同一时刻周末不命中", () => {
  const slots = defaultRoutineSlots();
  assert.equal(herActivityAt(9 * 60, 3, slots).activity, "class");
  assert.equal(herActivityAt(9 * 60, 6, slots), null);
  assert.equal(herActivityAt(14 * 60, 3, slots).activity, "practice");
  assert.equal(herActivityAt(12 * 60, 3, slots), null);
  assert.equal(herActivityAt(21 * 60 + 30, 3, slots), null);
});

test("herActivityAt：跨午夜的睡觉时段两天都算（00:30 与 23:45 都命中）", () => {
  const slots = defaultRoutineSlots();
  assert.equal(herActivityAt(30, 3, slots).activity, "sleep");
  assert.equal(herActivityAt(23 * 60 + 45, 3, slots).activity, "sleep");
  assert.equal(herActivityAt(6 * 60 + 59, 3, slots).activity, "sleep");
  assert.equal(herActivityAt(7 * 60, 3, slots), null);
});

test("normalizeRoutine：非法条目进 invalid 而不是被静默丢掉", () => {
  const bad = normalizeRoutine([{ from: "25:00", to: "07:00", activity: "sleep", label: "她在睡觉" }]);
  assert.deepEqual(bad.slots, []);
  assert.deepEqual(bad.invalid, ["routine[0].from"]);
  assert.deepEqual(normalizeRoutine([]).slots, []);
  assert.deepEqual(normalizeRoutine(null).invalid, ["routine"]);
  // 空数组 = 她没有忙的时段（不是「回到默认模板」）
  assert.deepEqual(normalizeProactiveSettings({ routine: [] }).routine, []);
  // 不传 routine = 用默认模板
  assert.equal(normalizeProactiveSettings({}).routine.length, defaultRoutineSlots().length);
});

test("lastQuestionFrom：取最后一句问句；太长或没有问句就返回 null", () => {
  assert.equal(lastQuestionFrom("今天很好。你练完了吗？"), "你练完了吗？");
  assert.equal(lastQuestionFrom("第一句问了吗？第二句也问了？"), "第二句也问了？");
  assert.equal(lastQuestionFrom("今天天气不错。"), null);
  assert.equal(lastQuestionFrom(""), null);
  assert.equal(lastQuestionFrom(null), null);
  const tooLong = `${"很".repeat(60)}吗？`;
  assert.equal(lastQuestionFrom(tooLong), null);
});

test("pickReason：隔得不够久就没有由头；够久之后由「她问过的事」决定由头", () => {
  const settings = normalizeProactiveSettings(null);
  assert.equal(pickReason(settings, { daysSinceUserLetter: 4, lastHerReply: "你练完了吗？" }), null);
  const asked = pickReason(settings, { daysSinceUserLetter: 6, lastHerReply: "你练完了吗？" });
  assert.equal(asked.kind, "letter_question");
  assert.equal(asked.question, "你练完了吗？");
  assert.equal(asked.days, 6);
  const quiet = pickReason(settings, { daysSinceUserLetter: 6, lastHerReply: "今天琴房很安静。" });
  assert.equal(quiet.kind, "silence");
  assert.equal(quiet.days, 6);
});

test("buildReasonText：由头写清「多久没通信 / 她记着什么事」，且不带催促与质问", () => {
  const asked = buildReasonText({ kind: "letter_question", question: "你练完了吗？", days: 6 });
  assert.match(asked, /6 天/u);
  assert.match(asked, /你练完了吗？/u);
  const silence = buildReasonText({ kind: "silence", days: 9 });
  assert.match(silence, /9 天/u);
  assert.equal(buildReasonText(null), "");
  for (const text of [asked, silence]) {
    assert.doesNotMatch(text, /催|为什么还不|怎么不|你应该|必须/u, `由头不该施压：${text}`);
  }
});

test("evaluateProactiveLetter：关掉 / 设置非法 / 她在忙 / 你还没回 —— 各有各的名字", () => {
  const settings = normalizeProactiveSettings(null);
  assert.equal(
    evaluateProactiveLetter({ ...settings, enabled: false }, readyCtx()).reason,
    PROACTIVE_REASONS.DISABLED,
  );
  assert.equal(
    evaluateProactiveLetter({ ...settings, invalid: ["maxPerDay"] }, readyCtx()).reason,
    PROACTIVE_REASONS.BAD_SETTINGS,
  );
  const busy = evaluateProactiveLetter(settings, readyCtx({ nowMinutes: 9 * 60 }));
  assert.equal(busy.reason, PROACTIVE_REASONS.HER_BUSY);
  assert.equal(busy.herActivity.activity, "class");
  assert.equal(
    evaluateProactiveLetter(settings, readyCtx({ unansweredProactive: 1 })).reason,
    PROACTIVE_REASONS.WAIT_REPLY,
  );
});

test("evaluateProactiveLetter：每日与每周上限分别判，且上限优先于「有没有话说」", () => {
  const settings = normalizeProactiveSettings(null);
  assert.equal(
    evaluateProactiveLetter(settings, readyCtx({ proactive24h: 1 })).reason,
    PROACTIVE_REASONS.LIMIT_DAY,
  );
  assert.equal(
    evaluateProactiveLetter(settings, readyCtx({ proactive7d: 2 })).reason,
    PROACTIVE_REASONS.LIMIT_WEEK,
  );
  assert.equal(
    evaluateProactiveLetter(settings, readyCtx({ daysSinceLastProactive: 1 })).reason,
    PROACTIVE_REASONS.NOT_YET,
  );
  assert.equal(
    evaluateProactiveLetter(settings, readyCtx({ daysSinceUserLetter: 1 })).reason,
    PROACTIVE_REASONS.NO_REASON,
  );
});

test("evaluateProactiveLetter：全都通过时给出由头与给 harness 的那句话", () => {
  const settings = normalizeProactiveSettings(null);
  const verdict = evaluateProactiveLetter(settings, readyCtx());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, PROACTIVE_REASONS.READY);
  assert.equal(verdict.trigger.kind, "letter_question");
  assert.match(verdict.reasonText, /她上封信里问过他/u);
});

test("normalizeProactiveSettings：越界值进 invalid 并退回默认（不静默接受）", () => {
  const settings = normalizeProactiveSettings({ maxPerDay: 99, maxPerWeek: -1, minSilenceDays: "abc" });
  assert.deepEqual(settings.invalid, ["maxPerDay", "maxPerWeek", "minSilenceDays"]);
  assert.equal(settings.maxPerDay, PROACTIVE_DEFAULTS.maxPerDay);
  assert.equal(settings.maxPerWeek, PROACTIVE_DEFAULTS.maxPerWeek);
  assert.equal(settings.minSilenceDays, PROACTIVE_DEFAULTS.minSilenceDays);
});

test("每个 reason 都有人话（设置页不显示内部代号）", () => {
  for (const reason of Object.values(PROACTIVE_REASONS)) {
    const label = proactiveReasonLabel(reason);
    assert.ok(label.length >= 4, `${reason} 缺少人话`);
    assert.doesNotMatch(label, /[a-z_]{4,}/u, `${reason} 的人话不该是内部代号：${label}`);
  }
});
