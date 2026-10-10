import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOliviaService } from '../server.js';

// 这组测试守四件事：
// ① 时间线是**只读**接口，筛选与统计全部服务端做（游标分页，不许用 OFFSET 的 page=N）。
// ② 不剧透：没到 available_at 的回信一律算「待回信」，与 letterExportReplied 同一口径。
// ③ /admin/api/letters 不传参时行为与 1.0.9 之前完全一致（最近 100 条、返回数组）。
// ④ 信件 JSON 导入：严格校验 + 已存在跳过 + 写库前备份 + 幂等（同一个 preview 只能确认一次）。

const REPLIED = 4;
const FAILED = 5;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'letter-timeline-'));
  const service = await createOliviaService({
    root,
    dataDir: join(root, 'data'),
    appData: join(root, 'app-data'),
    runtimeDir: join(root, 'runtime'),
    worker: false,
    runMemoryRefresh: false,
    fetch: async () => { throw new Error('No external requests allowed'); },
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

  async function request(path, init = {}) {
    const response = await fetch(base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    return { status: response.status, body: await response.json() };
  }

  function seedLetter(options = {}) {
    const user = service.db.prepare('SELECT id FROM users LIMIT 1').get();
    const at = options.createdAt ?? 1_700_000_000;
    service.db.prepare(`
      INSERT INTO letters(id, user_id, person, content, status, reply_type, reply_text, created_at, available_at, replied_at, is_read, source, memory_order, letter_date, letter_time)
      VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      options.id, user.id, options.person ?? '林离', options.content ?? '正文', options.status ?? REPLIED,
      options.replyText ?? null, at, options.availableAt ?? at, options.repliedAt ?? at,
      options.source ?? 'live', options.memoryOrder ?? null,
      options.letterDate ?? '2026-10-01', options.letterTime ?? '12:00',
    );
    return options.id;
  }

  function letterCount() {
    return Number(service.db.prepare('SELECT COUNT(*) AS count FROM letters').get().count);
  }

  return { root, service, base, request, seedLetter, letterCount };
}

function importFile(letters, overrides = {}) {
  return JSON.stringify({
    schema: 'olivia-soul-letters',
    version: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    person: '林离',
    count: letters.length,
    letters,
    ...overrides,
  });
}

test('时间线游标分页：翻到底不重复也不漏，created_at 相同靠 rowid 定序', async t => {
  const { request, seedLetter } = await fixture(t);
  // 三封 created_at 完全一样，只有 rowid 能定序；另两封时间不同。
  seedLetter({ id: 'a', createdAt: 1_700_000_100 });
  seedLetter({ id: 'b', createdAt: 1_700_000_200 });
  seedLetter({ id: 'c', createdAt: 1_700_000_200 });
  seedLetter({ id: 'd', createdAt: 1_700_000_200 });
  seedLetter({ id: 'e', createdAt: 1_700_000_300 });

  const seen = [];
  let before = '';
  let pages = 0;
  for (;;) {
    const url = `/toy/mail/timeline?limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const { body } = await request(url);
    assert.equal(body.code, 0, body.message);
    seen.push(...body.data.list.map(item => item.letterId));
    pages += 1;
    if (!body.data.hasMore) {
      assert.equal(body.data.nextBefore, '');
      break;
    }
    assert.ok(body.data.nextBefore, '还有下一页时必须给出游标');
    before = body.data.nextBefore;
    assert.ok(pages < 10, '翻页没有收敛，游标可能没生效');
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, '翻页出现重复');
  // 最新在前：e（最新）→ b/c/d（同时间，rowid 倒序）→ a，最终顺序与一次拉全量一致。
  const all = await request('/toy/mail/timeline?limit=50');
  assert.deepEqual(seen, all.body.data.list.map(item => item.letterId));
});

test('不剧透：没到 available_at 的回信算待回信，到点后同一口径立刻变成已回信', async t => {
  const { service, request, seedLetter } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  seedLetter({ id: 'future', status: REPLIED, replyText: '还没解锁的回信', availableAt: now + 3600 });
  seedLetter({ id: 'ready', status: REPLIED, replyText: '已经能看的回信', availableAt: now - 10 });
  seedLetter({ id: 'failed', status: FAILED, availableAt: now - 10 });

  const first = await request('/toy/mail/timeline?limit=10');
  const byId = new Map(first.body.data.list.map(item => [item.letterId, item]));
  assert.equal(byId.get('future').timelineState, 'pending');
  assert.equal(byId.get('future').replyText, null, '没解锁的回信绝不能吐给前端');
  assert.equal(byId.get('ready').timelineState, 'replied');
  assert.equal(byId.get('ready').replyText, '已经能看的回信');
  assert.equal(byId.get('failed').timelineState, 'failed');

  const stats = first.body.data.stats;
  assert.equal(stats.total, 3);
  assert.equal(stats.replied, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.pending, 1);

  const pendingOnly = await request('/toy/mail/timeline?limit=10&status=pending');
  assert.deepEqual(pendingOnly.body.data.list.map(item => item.letterId), ['future']);
  const repliedOnly = await request('/toy/mail/timeline?limit=10&status=replied');
  assert.deepEqual(repliedOnly.body.data.list.map(item => item.letterId), ['ready']);

  // 到点之后：同一个接口、同一口径，立刻变成「已回信」——不是另起一套判断。
  service.db.prepare('UPDATE letters SET available_at = ? WHERE id = ?').run(now - 1, 'future');
  const after = await request('/toy/mail/timeline?limit=10');
  const unlocked = after.body.data.list.find(item => item.letterId === 'future');
  assert.equal(unlocked.timelineState, 'replied');
  assert.equal(unlocked.replyText, '还没解锁的回信');
  assert.equal(after.body.data.stats.replied, 2);
});

test('筛选全在服务端做：状态 / 归档 / 按人 / 搜索，非法参数直接报错', async t => {
  const { request, seedLetter } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  seedLetter({ id: 'l1', person: '林离', content: '今天下雨了', availableAt: now - 5, replyText: '带伞', memoryOrder: 1 });
  seedLetter({ id: 'l2', person: '林离', content: '明天考试', availableAt: now - 5, replyText: '加油' });
  seedLetter({ id: 'l3', person: '小满', content: '生日蛋糕', availableAt: now - 5, replyText: '谢谢' });
  seedLetter({ id: 'l4', person: '小满', content: '下雨天的猫', availableAt: now + 999, replyText: '以后再回' });

  const archived = await request('/toy/mail/timeline?limit=10&archived=archived');
  assert.deepEqual(archived.body.data.list.map(item => item.letterId), ['l1']);
  // total = 当前筛选命中数；stats = 全库概览。带筛选时两者必须区分开，
  // 否则前端会拿「全库 4 封」去配「只列出 1 条」的列表（真机探针实测踩过）。
  assert.equal(archived.body.data.total, 1);
  assert.equal(archived.body.data.stats.total, 4);
  const unarchived = await request('/toy/mail/timeline?limit=10&archived=unarchived');
  assert.equal(unarchived.body.data.list.length, 3);
  assert.equal(unarchived.body.data.total, 3);
  assert.ok(!unarchived.body.data.list.some(item => item.letterId === 'l1'));
  const all = await request('/toy/mail/timeline?limit=10&archived=all');
  assert.equal(all.body.data.list.length, 4);
  assert.equal(all.body.data.total, 4);

  const byPerson = await request('/toy/mail/timeline?limit=10&person=%E5%B0%8F%E6%BB%A1');
  assert.deepEqual(byPerson.body.data.list.map(item => item.letterId).sort(), ['l3', 'l4']);
  assert.equal(byPerson.body.data.total, 2);
  assert.deepEqual(byPerson.body.data.persons.map(item => item.person), ['小满', '林离']);

  const searched = await request(`/toy/mail/timeline?limit=10&q=${encodeURIComponent('下雨')}`);
  assert.deepEqual(searched.body.data.list.map(item => item.letterId).sort(), ['l1', 'l4']);

  // q=下雨 命中 l1/l4，person=小满 又只剩 l4，而 l4 还没到 available_at → 三条一起用就是空的
  const combined = await request(`/toy/mail/timeline?limit=10&q=${encodeURIComponent('下雨')}&status=replied&person=%E5%B0%8F%E6%BB%A1`);
  assert.deepEqual(combined.body.data.list.map(item => item.letterId), []);

  const bad = await request('/toy/mail/timeline?status=whatever');
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message, /status/u);
  const badArchived = await request('/toy/mail/timeline?archived=whatever');
  assert.notEqual(badArchived.body.code, 0);

  // limit 超出上限被夹到 200，不报错；limit=0 回落到默认值而不是空页。
  const giant = await request('/toy/mail/timeline?limit=99999');
  assert.equal(giant.body.code, 0);
  const zero = await request('/toy/mail/timeline?limit=0');
  assert.equal(zero.body.code, 0);
  assert.equal(zero.body.data.list.length, 4);
});

test('统计是整个库的数字，不是「这一页几条」', async t => {
  const { request, seedLetter } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < 7; index += 1) {
    seedLetter({ id: `s${index}`, createdAt: 1_700_000_000 + index, availableAt: now - 5, replyText: `回信 ${index}` });
  }
  seedLetter({ id: 'p0', status: 1, createdAt: 1_700_000_050 });
  const { body } = await request('/toy/mail/timeline?limit=2');
  assert.equal(body.data.list.length, 2);
  assert.equal(body.data.stats.total, 8);
  assert.equal(body.data.stats.replied, 7);
  assert.equal(body.data.stats.pending, 1);
  assert.equal(body.data.stats.failed, 0);
  assert.equal(body.data.stats.firstAt, 1_700_000_000);
  assert.equal(body.data.stats.lastAt, 1_700_000_050);
  assert.equal(body.data.total, 8);
});

test('/admin/api/letters 不传参时仍是最近 100 条数组，带参才是分页对象', async t => {
  const { request, seedLetter } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < 105; index += 1) {
    seedLetter({ id: `a${index}`, createdAt: 1_700_000_000 + index, availableAt: now - 5, replyText: '回信' });
  }
  const legacy = await request('/admin/api/letters');
  assert.equal(legacy.body.code, 0);
  assert.ok(Array.isArray(legacy.body.data), '不传参必须还是数组，老前端不许被破坏');
  assert.equal(legacy.body.data.length, 100);
  assert.ok(legacy.body.data[0].letterId === 'a104', '最新的一封排最前');
  assert.ok('person' in legacy.body.data[0] && 'memoryError' in legacy.body.data[0]);

  const paged = await request('/admin/api/letters?limit=3');
  assert.equal(paged.body.code, 0);
  assert.ok(!Array.isArray(paged.body.data));
  assert.equal(paged.body.data.list.length, 3);
  assert.equal(paged.body.data.stats.total, 105);
  assert.equal(paged.body.data.hasMore, true);
  assert.ok(paged.body.data.nextBefore);
});

test('导入前严格校验：schema / 版本 / 结构不对一律拒绝，不许半截写进去', async t => {
  const { request, letterCount } = await fixture(t);
  const before = letterCount();
  const cases = [
    ['不是 JSON', '{', /JSON/u],
    ['schema 不对', importFile([{ letterId: 'x', incoming: '正文' }], { schema: 'something-else' }), /olivia-soul-letters/u],
    ['版本不支持', importFile([{ letterId: 'x', incoming: '正文' }], { version: 2 }), /版本/u],
    ['letters 不是数组', importFile([], { letters: {} }), /letters/u],
    ['letters 为空', importFile([]), /空的/u],
    ['缺 letterId', importFile([{ incoming: '正文' }]), /letterId/u],
    ['正文为空', importFile([{ letterId: 'x', incoming: '   ' }]), /正文/u],
  ];
  for (const [label, content, pattern] of cases) {
    const { body } = await request('/toy/letter/import/preview', { method: 'POST', body: JSON.stringify({ content }) });
    assert.notEqual(body.code, 0, `${label} 应该被拒绝`);
    assert.match(body.message, pattern, `${label} 的报错要说明原因`);
  }
  assert.equal(letterCount(), before, '校验失败绝不能写库');
  assert.equal((await request('/toy/letter/import/preview', { method: 'POST', body: JSON.stringify({}) })).body.code !== 0, true);
});

test('导入计划分清「新增 / 已存在跳过 / 文件内冲突」，确认后写库并留备份，重复确认不再写', async t => {
  const { root, service, request, seedLetter, letterCount } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  seedLetter({ id: 'exists', createdAt: now - 100, availableAt: now - 100, replyText: '本地已有的回信' });
  const before = letterCount();

  const content = importFile([
    { letterId: 'exists', date: '2026-09-01', time: '09:00', incoming: '导入文件里的旧内容', reply: '导入文件里的旧回信', replyLabel: '回信', contentMd5: '' },
    { letterId: 'fresh', date: '2026-09-02', time: '10:30', incoming: '新的一封', reply: '新的回信', replyLabel: '回信', contentMd5: '' },
    { letterId: 'fresh', date: '2026-09-02', time: '10:30', incoming: '同一份文件里重复的那封', reply: '重复', replyLabel: '回信', contentMd5: '' },
  ]);
  const preview = await request('/toy/letter/import/preview', { method: 'POST', body: JSON.stringify({ content }) });
  assert.equal(preview.body.code, 0, preview.body.message);
  assert.equal(preview.body.data.fileCount, 3);
  assert.equal(preview.body.data.addCount, 1);
  assert.equal(preview.body.data.skipCount, 1);
  assert.equal(preview.body.data.conflictCount, 1);
  assert.deepEqual(preview.body.data.skippedSample, ['exists']);
  assert.deepEqual(preview.body.data.conflictSample, ['fresh']);
  assert.deepEqual(preview.body.data.addSample.map(item => item.letterId), ['fresh']);
  assert.equal(letterCount(), before, 'preview 阶段不许写库');

  const confirm = await request('/toy/letter/import/confirm', { method: 'POST', body: JSON.stringify({ previewId: preview.body.data.previewId }) });
  assert.equal(confirm.body.code, 0, confirm.body.message);
  assert.equal(confirm.body.data.added, 1);
  assert.equal(confirm.body.data.skipped, 1);
  assert.equal(confirm.body.data.failed, 0);
  assert.match(confirm.body.data.backupFile, /^backup-letter-import-\d{8}-\d{6}\.sqlite$/u);
  assert.equal(letterCount(), before + 1);

  // 备份真的落在数据目录里
  const files = await readdir(join(root, 'data'));
  assert.ok(files.includes(confirm.body.data.backupFile), '导入前必须留下一份库副本');

  // 写进去的信：来源 import、未归档、立刻可见（source=import 不受 available_at 限制）
  const row = service.db.prepare('SELECT * FROM letters WHERE id = ?').get('fresh');
  assert.equal(row.source, 'import');
  assert.equal(row.memory_order, null);
  assert.equal(row.status, REPLIED);
  assert.match(row.letter_date, /^2026-09-02$/u);
  assert.match(row.letter_time, /^10:30$/u);

  const timeline = await request('/toy/mail/timeline?limit=10');
  const imported = timeline.body.data.list.find(item => item.letterId === 'fresh');
  assert.equal(imported.timelineState, 'replied');
  assert.equal(imported.replyText, '新的回信');
  assert.equal(imported.archived, 0);
  assert.equal(timeline.body.data.stats.total, before + 1);

  // 本地已有的那封一个字都没被覆盖
  const kept = service.db.prepare('SELECT * FROM letters WHERE id = ?').get('exists');
  assert.equal(kept.reply_text, '本地已有的回信');
  assert.equal(kept.content, '正文');

  // 幂等：同一个 preview 再确认一次只会拿到「已经用过了」，不会再写一封
  const twice = await request('/toy/letter/import/confirm', { method: 'POST', body: JSON.stringify({ previewId: preview.body.data.previewId }) });
  assert.notEqual(twice.body.code, 0);
  assert.match(twice.body.message, /用过|不存在/u);
  assert.equal(letterCount(), before + 1);

  // 同一份文件再走一遍 preview：这次全部都是「已存在跳过」，新增 0
  seedLetter({ id: 'noop', createdAt: now - 10, availableAt: now - 10, replyText: 'x' });
  const again = await request('/toy/letter/import/preview', { method: 'POST', body: JSON.stringify({ content }) });
  assert.equal(again.body.data.addCount, 0);
  assert.equal(again.body.data.skipCount, 2);
  assert.equal(again.body.data.conflictCount, 1);
  const noopConfirm = await request('/toy/letter/import/confirm', { method: 'POST', body: JSON.stringify({ previewId: again.body.data.previewId }) });
  assert.equal(noopConfirm.body.code, 0);
  assert.equal(noopConfirm.body.data.added, 0);
  assert.equal(noopConfirm.body.data.backupFile, '', '没有要写的信就不该白备份一份');
});

test('游戏侧脚本：登记进 serveStatic 白名单，锚点钉着信箱头部按钮组，沿用「克隆原生按钮」的做法', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/admin/game-letter-timeline.js');
  assert.equal(response.status, 200, '脚本没登记进白名单时，游戏里点「时间线」只会拿到 404');
  const source = await response.text();
  assert.match(source, /\/toy\/mail\/timeline/u);
  assert.match(source, /信件时间线/u);

  // 锚点契约：必须是「下载 / 分享信件」那一组（与 game-letter-export.js 同一处），否则按钮会挂到别的页面上
  assert.match(source, /querySelectorAll\('div\.flex\.items-center\.gap-2\.flex-shrink-0'\)/u);
  assert.match(source, /下载\|Download/u);
  assert.ok(!source.includes("querySelectorAll('div')"), '不该对整页 div 做全量扫描');

  // 验收①：样式与图标都跟着「当前这个下载按钮」重新取，而不是自造一套原生按钮外观
  assert.match(source, /button\.className = download\.className;/u);
  assert.match(source, /icon\.cloneNode\(true\)/u);
  assert.match(source, /if \(styledFrom === download\) return;/u);

  // 紧跟「一键导出」后面（那枚也是注入的；还没挂上时退到组尾）
  assert.match(source, /一键导出/u);
  assert.match(source, /exporter\.nextSibling/u);

  // 防重复挂载：按钮还在页面上就别再造一个（真机实测踩到过挂出 3 枚）
  assert.match(source, /button\.isConnected/u);

  // 状态色契约（与设计稿一致）：已回信走 primary-2 米白、待回信灰点、失败用 error 红
  assert.match(source, /STATE_COLOR = \{ replied: 'var\(--tp-primary-2\)', pending: 'var\(--tp-grey-5\)', failed: 'var\(--tp-error\)' \}/u);

  // 导入入口挂在线时间线顶部（派工单 §3.4）：preview → confirm 两步，靠 previewId 串起来
  assert.match(source, /导入信件 JSON/u);
  assert.match(source, /\/toy\/letter\/import\/preview/u);
  assert.match(source, /\/toy\/letter\/import\/confirm/u);
  assert.match(source, /previewId/u);
  assert.match(source, /没有预览结果就不能确认/u);

  // 写请求只有 post() 那一处，且时间线本身仍然只读
  const postCalls = source.match(/method: 'POST'/gu) || [];
  assert.equal(postCalls.length, 1, '写请求只能出现在 post() 里这一处');
  assert.match(source, /method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}/u);
});
