import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOliviaService } from '../server.js';

// 这组测试守的是「接线」，不是「判据」：
// proactive-letters.js 的每条判据都有自己的单测，但纯函数全绿证明不了服务端真的喂了数据、
// 真的落了盘、真的调用过一次生成器、真的没有重发。这里逐条把这条链路钉住。

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'proactive-letter-'));
  const dataDir = join(root, 'data');
  const calls = [];
  const service = await createOliviaService({
    root, dataDir, appData: join(root, 'app-data'), runtimeDir: join(root, 'runtime'),
    worker: false, runMemoryRefresh: false,
    fetch: async () => { throw new Error('No external requests allowed'); },
    proactiveGenerator: async payload => {
      calls.push(payload);
      if (options.failGenerator) throw new Error('模型不可用');
      return options.reply ?? '琴房窗台上落着薄薄的灰，阳光斜进来，忽然想到你。';
    },
  });
  // 默认作息含「23:30–07:00 睡觉」⇒ 凌晨跑这套件时每条判据都先撞 her_busy，
  // 由头 / 额度 / 重发这些用例就验不到真正要验的东西（而且这套件只在白天能绿）。
  // 默认把她的作息清空（任何时刻都不忙），要验作息的用例自己设回去。
  // 传 routine: null 表示「别动默认作息」（要验默认值的用例需要它）。
  if (options.routine !== null) service.saveProactiveLetterSettings({ routine: options.routine ?? [] });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, service, calls, base: `http://127.0.0.1:${port}` };
}

function withDb(dataDir, fn) {
  const db = new DatabaseSync(join(dataDir, 'olivia-local.sqlite'));
  try { return fn(db); } finally { db.close(); }
}

function seedLetters(dataDir, rows) {
  return withDb(dataDir, db => {
    const user = db.prepare('SELECT id, person FROM users ORDER BY id LIMIT 1').get();
    assert.ok(user, '服务应当已经建好本地用户');
    const insert = db.prepare(`INSERT INTO letters(id, user_id, person, content, reply_text, status, source,
      created_at, available_at, replied_at, letter_date, letter_time, reply_label, reply_type)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row, index) => {
      const at = row.at;
      // reply_type 必须跟真实状态一致：回复完成是 1（文字）/ 2（视频），还没回才是 0。
      // 漏了这一列，seed 出来的「她先写来的」会带着列默认值 0 进接口 —— 那正是线上那个
      // 「详情页一直显示『林离回信中…』」的缺陷，用它做断言等于把缺陷当成预期。
      const replyType = row.replyType ?? ((row.status ?? 4) === 4 ? 1 : 0);
      insert.run(`seed-${index + 1}`, user.id, row.person ?? user.person, row.content ?? '', row.reply ?? null,
        row.status ?? 4, row.source ?? 'live', at, row.availableAt ?? at, row.repliedAt ?? at,
        '2026-01-01', '09:00', row.replyLabel ?? '回信', replyType);
    });
    return user;
  });
}

const countLetters = dataDir => withDb(dataDir, db => Number(db.prepare('SELECT COUNT(*) AS n FROM letters').get().n));
const readLetter = (dataDir, id) => withDb(dataDir, db => db.prepare('SELECT * FROM letters WHERE id = ?').get(id));

/** 把「今天」的某个本地时刻换成时间戳（作息判定按本机时区）。 */
function atLocalTime(hour, minute = 0) {
  const date = new Date(NOW * 1000);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

test('没有往来时她不会先写：判成「没有想说的」，一行都不落', async t => {
  const { service, dataDir } = await fixture(t);
  const before = countLetters(dataDir);
  const result = await service.writeProactiveLetter();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_reason');
  assert.equal(result.label, "她眼下没有特别想说的");
  assert.equal(countLetters(dataDir), before, '判定没通过时不该先扣机会');
});

test('隔得够久 + 她上封信问过事：真调生成器，落成「她先写来的」', async t => {
  const { service, dataDir, calls } = await fixture(t);
  seedLetters(dataDir, [
    { at: NOW - 6 * DAY, content: '我最近在练一首曲子', reply: '那首你练得怎么样了？' },
  ]);
  const result = await service.writeProactiveLetter();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1, '应当调用一次生成器');
  assert.match(calls[0].reasonText, /问过他一件事/u, '由头要带上她问过的那件事');
  assert.equal(calls[0].reasonText.includes('那首你练得怎么样了？'), true);
  const row = readLetter(dataDir, result.letterId);
  assert.equal(row.source, 'proactive');
  assert.equal(row.status, 4);
  assert.equal(row.reply_label, '她先写来的');
  assert.match(row.reply_text, /琴房/u);
  assert.equal(row.content, '', '她先写来的信不该伪造一封你的来信');
  // 她先写来的信也必须是「文字回信」（reply_type=1）。游戏端只凭 replyType 判断她回没回，
  // 停在 0 会让详情页永远显示「林离回信中…」—— 这正是 1.2.2 真机抓到的那个缺陷。
  assert.equal(row.reply_type, 1, '生成完成后必须把 reply_type 置为 1');
});

test('生成失败也算用掉这次机会：标记失败、不重发', async t => {
  const { service, dataDir } = await fixture(t, { failGenerator: true });
  seedLetters(dataDir, [{ at: NOW - 6 * DAY, reply: '好。' }]);
  const first = await service.writeProactiveLetter();
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'failed');
  const row = readLetter(dataDir, first.letterId);
  assert.equal(row.status, 5);
  assert.match(row.error, /她主动写信失败/u);
  const after = countLetters(dataDir);
  const second = await service.writeProactiveLetter();
  assert.equal(second.ok, false);
  assert.equal(countLetters(dataDir), after, '同一轮不该再写第二封');
});

test('她先写过一封、你还没回：她就不再写', async t => {
  const { service, dataDir } = await fixture(t);
  seedLetters(dataDir, [
    { at: NOW - 30 * DAY, content: '最近好吗', reply: '都好。' },
    { at: NOW - 6 * DAY, content: '', reply: '我昨天梦见那首曲子。', source: 'proactive', replyLabel: '她先写来的' },
  ]);
  const result = await service.writeProactiveLetter();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wait_reply');
  assert.equal(result.label, '她先写过一封，你还没回');
});

test('她这个时段在睡觉：不写', async t => {
  const { service, dataDir } = await fixture(t);
  seedLetters(dataDir, [{ at: NOW - 6 * DAY, reply: '好。' }]);
  // fixture 默认把作息清空了（见上），这条用例要验的就是作息，自己设回默认那一段。
  service.saveProactiveLetterSettings({ routine: [{ from: '23:30', to: '07:00', activity: 'sleep', label: '她在睡觉' }] });
  const { verdict, label } = service.proactiveLetterVerdict(atLocalTime(3, 0));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'her_busy');
  assert.equal(label, '她这个时段在忙');
  assert.match(verdict.herActivity.label, /睡觉/u);
});

test('设置往返：存下来的值真读得回来；非法值被拒绝而不是静默回退', async t => {
  const { service } = await fixture(t);
  assert.equal(service.readProactiveLetterSettings().maxPerWeek, 2, '默认每周最多 2 封');
  assert.equal(service.readProactiveLetterSettings().minSilenceDays, 5, '默认隔 5 天才先开口');
  const saved = service.saveProactiveLetterSettings({ minSilenceDays: 7 });
  assert.equal(saved.ok, true);
  assert.equal(service.readProactiveLetterSettings().minSilenceDays, 7);
  const bad = service.saveProactiveLetterSettings({ minSilenceDays: -1 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.invalid, ['minSilenceDays']);
  assert.equal(service.readProactiveLetterSettings().minSilenceDays, 7, '被拒绝的写入不能改掉已存的值');
});

test('作息表能改，且非法时刻被拒绝', async t => {
  const { service } = await fixture(t);
  const bad = service.saveProactiveLetterSettings({ routine: [{ from: '25:00', to: '07:00', activity: 'sleep', label: '她在睡觉' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.invalid.join(','), /routine\[0\]\.from/u);
  const good = service.saveProactiveLetterSettings({ routine: [{ from: '22:00', to: '08:00', activity: 'sleep', label: '她在睡觉' }] });
  assert.equal(good.ok, true);
  assert.equal(service.proactiveLetterVerdict(atLocalTime(23, 30)).verdict.reason, 'her_busy');
});

test('设置接口：GET 回设置与判定，POST 存下来，非法值回 400', async t => {
  const { base } = await fixture(t, { routine: null }); // 这条要验默认值，别动她的作息
  const got = await (await fetch(`${base}/toy/letter/proactive`)).json();
  assert.equal(got.code, 0);
  assert.equal(got.data.enabled, true);
  assert.equal(got.data.settings.maxPerWeek, 2);
  assert.equal(got.data.settings.routine.length, 4, '默认作息四条');
  assert.match(got.data.settings.routine[0].from, /^\d{2}:\d{2}$/u);
  assert.ok(got.data.verdict.label.length > 0, '判定必须带一句人话');
  assert.equal(got.data.defaults.enabled, true);

  const posted = await (await fetch(`${base}/toy/letter/proactive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minSilenceDays: 7 }),
  })).json();
  assert.equal(posted.code, 0);
  assert.equal(posted.data.settings.minSilenceDays, 7);

  // /toy/* 的错误一律是 HTTP 200 + 非零 code（这是这个项目对游戏端的既有契约）。
  const rejected = await fetch(`${base}/toy/letter/proactive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minSilenceDays: -1 }),
  });
  assert.equal(rejected.status, 200);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, -10402);
  assert.match(rejectedBody.message, /不合法的值/u);
});

test('手动触发接口：没有由头时如实回一句人话，也不落库', async t => {
  const { base, dataDir } = await fixture(t);
  const before = countLetters(dataDir);
  const result = await (await fetch(`${base}/toy/letter/proactive/check`, { method: 'POST' })).json();
  assert.equal(result.data.ok, false);
  assert.equal(result.data.reason, 'no_reason');
  assert.equal(result.data.label, '她眼下没有特别想说的');
  assert.equal(countLetters(dataDir), before);
});

test('游戏端列表能认出「她先写来的」', async t => {
  const { base, dataDir } = await fixture(t);
  seedLetters(dataDir, [
    { at: NOW - 6 * DAY, content: '', reply: '窗台上的灰。', source: 'proactive', replyLabel: '她先写来的' },
  ]);
  const list = await (await fetch(`${base}/toy/letter/list`)).json();
  const item = list.data.list.find(entry => entry.proactive === true);
  assert.ok(item, '列表里应当能认出她先写来的信');
  assert.match(item.summary, /她先写来的/u);
  assert.equal(item.replyText, '窗台上的灰。');
  // 有正文还不够：游戏端只靠 replyType 判断她回没回（0 = 还没回），必须是 1。
  assert.equal(item.replyType, 1, '她先写来的信在列表里也必须是「文字回信」');
  assert.equal(item.letterStatus, 4);
});

test('她先写来的信不会被回信 worker 当成待回信捡走', async t => {
  const { service, dataDir } = await fixture(t);
  seedLetters(dataDir, [
    { at: NOW - 6 * DAY, content: '', status: 1, reply: null, source: 'proactive', replyLabel: '她先写来的' },
    { at: NOW - 2 * DAY, content: '这是你的来信', status: 1 },
  ]);
  await service.drainWorker();
  const proactiveRow = readLetter(dataDir, 'seed-1');
  assert.equal(proactiveRow.status, 1, '主动信那行不该被回信 worker 捡走（哪怕它落在待处理状态）');
  const userRow = readLetter(dataDir, 'seed-2');
  assert.notEqual(userRow.status, 1, '你自己的来信仍然要被正常处理');
});

test('普通信不带「她先写来的」标记：这个字段必须是条件性的', async t => {
  const { base, dataDir } = await fixture(t);
  seedLetters(dataDir, [
    { at: NOW - 6 * DAY, content: '最近好吗', reply: '都好。' },
    { at: NOW - 2 * DAY, content: '', reply: '窗台上的灰。', source: 'proactive', replyLabel: '她先写来的' },
  ]);
  const list = await (await fetch(`${base}/toy/letter/list`)).json();
  const normal = list.data.list.find(entry => entry.letterId === 'seed-1');
  assert.ok(normal, '应当能找到普通信');
  // 无条件加上 proactive:false 会让既有「整对象 deepEqual」断言变红（api.test.js 就是这么发现的）
  assert.equal(normal.proactive, undefined, '普通信不该出现 proactive 字段');
  assert.equal(list.data.list.find(entry => entry.letterId === 'seed-2').proactive, true);
});

test('历史数据自愈：已生成完但 reply_type=0 的主动信，服务启动时补成 1', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proactive-heal-'));
  const dataDir = join(root, 'data');
  const options = {
    root, dataDir, appData: join(root, 'app-data'), runtimeDir: join(root, 'runtime'),
    worker: false, runMemoryRefresh: false,
    fetch: async () => { throw new Error('No external requests allowed'); },
  };
  // 先起一次，只为建表；关掉之后直接塞一行「漏置 reply_type」的历史数据
  //（列默认值就是 0，正是线上缺陷留下的样子）。
  const first = await createOliviaService(options);
  await first.listen(0, '127.0.0.1');
  await first.close();
  withDb(dataDir, db => {
    const user = db.prepare('SELECT id, person FROM users ORDER BY id LIMIT 1').get();
    assert.ok(user, '服务应当已经建好本地用户');
    db.prepare(`INSERT INTO letters(id, user_id, person, content, status, source, created_at, available_at,
      replied_at, reply_text, reply_type, reply_label)
      VALUES('heal-1', ?, ?, '', 4, 'proactive', 1, 1, 2, '窗台上的灰。', 0, '她先写来的')`)
      .run(user.id, user.person);
  });
  const second = await createOliviaService(options);
  await second.listen(0, '127.0.0.1');
  t.after(async () => { await second.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(readLetter(dataDir, 'heal-1').reply_type, 1, '启动时应当把历史主动信补成文字回信');
});
