import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOliviaService } from '../server.js';

// 这组测试守两件事：
// ① 游戏「我的信箱」页面上那个「一键导出」按钮背后的本地接口，真能落盘、内容完整、且不含隐私
//    （导出物一旦带上本机路径 / 密钥 / 真实模型名，repo-privacy 那套红线就破了）。
// ② 还没到 available_at 的回信一律按「尚未收到回信」处理 —— 导出物不该剧透还没解锁的回信。

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'letter-export-'));
  const dataDir = join(root, 'data');
  const service = await createOliviaService({ root, dataDir, appData: join(root, 'app-data'),
    runtimeDir: join(root, 'runtime'), worker: false, runMemoryRefresh: false,
    fetch: async () => { throw new Error('No external requests allowed'); } });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, base: `http://127.0.0.1:${port}` };
}

function seed(dataDir, rows) {
  const db = new DatabaseSync(join(dataDir, 'olivia-local.sqlite'));
  try {
    const user = db.prepare('SELECT id, person FROM users ORDER BY id LIMIT 1').get();
    assert.ok(user, '服务应当已经建好本地用户');
    const insert = db.prepare(`INSERT INTO letters(id, user_id, person, content, reply_text, status,
      created_at, available_at, replied_at, letter_date, letter_time, reply_label, reply_video)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((row, index) => {
      const at = row.at ?? 1_700_000_000 + index;
      insert.run(`letter-${index + 1}`, user.id, user.person, row.content, row.reply ?? null,
        row.status ?? 4, at, row.availableAt ?? at, at,
        row.date ?? '2026-01-01', row.time ?? '09:00', row.replyLabel ?? '回信', row.video ?? null);
    });
    return user;
  } finally { db.close(); }
}

async function post(base, body) {
  const response = await fetch(base + '/toy/letter/export', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, result: await response.json() };
}

test('一键导出：落盘 Markdown，内容完整且不含本机路径与密钥', async t => {
  const { root, dataDir, base } = await fixture(t);
  await fetch(base + '/toy/letter/unread_count');
  seed(dataDir, [
    { content: '今天想听你唱那首老歌', reply: '好呀，我记着了。', date: '2026-01-02', time: '09:30', video: 'reply-abc.mp4' },
    { content: '第二封：周末的安排', status: 1 },
  ]);
  const { status, result } = await post(base, { format: 'md' });
  assert.equal(status, 200);
  assert.equal(result.code, 0);
  assert.equal(result.data.count, 2);
  assert.equal(result.data.repliedCount, 1);
  assert.equal(result.data.format, 'md');
  assert.ok(result.data.directory.endsWith('exports'), '导出目录应当是数据目录下的 exports');
  assert.match(result.data.file, /^信件导出-\d{8}-\d{6}\.md$/u);
  const text = await readFile(result.data.path, 'utf8');
  assert.match(text, /# 与.+的往来信件/u);
  assert.match(text, /今天想听你唱那首老歌/u);
  assert.match(text, /好呀，我记着了。/u);
  assert.match(text, /第二封：周末的安排/u);
  assert.match(text, /（尚未收到回信）/u);
  assert.match(text, /回信视频：reply-abc\.mp4/u);
  assert.doesNotMatch(text, /[A-Za-z]:\\/u, '导出物不能出现本机磁盘路径');
  assert.ok(!text.includes(root), '导出物不能包含临时根目录');
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]/u, '导出物不能出现密钥');
  assert.doesNotMatch(text, /deepseek|glm-|kimi-/iu, '导出物不能出现真实模型名');
});

test('一键导出：还没到点的回信按「尚未收到」处理，不剧透', async t => {
  const { dataDir, base } = await fixture(t);
  await fetch(base + '/toy/letter/unread_count');
  const future = Math.floor(Date.now() / 1000) + 3600;
  seed(dataDir, [{ content: '先写一封', reply: '这封回信还没到解锁时间', availableAt: future }]);
  const { result } = await post(base, { format: 'md' });
  assert.equal(result.data.repliedCount, 0);
  const text = await readFile(result.data.path, 'utf8');
  assert.doesNotMatch(text, /这封回信还没到解锁时间/u);
  assert.match(text, /（尚未收到回信）/u);
});

test('一键导出：连着点两次不会互相覆盖（旧名字只精确到分钟）', async t => {
  const { dataDir, base } = await fixture(t);
  await fetch(base + '/toy/letter/unread_count');
  seed(dataDir, [{ content: '会写两遍', reply: '回信' }]);
  const first = await post(base, { format: 'md' });
  const second = await post(base, { format: 'md' });
  assert.equal(first.result.code, 0);
  assert.equal(second.result.code, 0);
  assert.notEqual(first.result.data.file, second.result.data.file, '两次导出的文件名撞了，等于覆盖掉了前一份');
  const firstText = await readFile(first.result.data.path, 'utf8');
  const secondText = await readFile(second.result.data.path, 'utf8');
  assert.match(firstText, /会写两遍/u);
  assert.match(secondText, /会写两遍/u);
  // 撞名时加的是 -2 后缀，而不是把时间戳改坏
  assert.match(second.result.data.file, /^信件导出-\d{8}-\d{6}(-\d+)?\.md$/u);
});

test('一键导出：JSON 与 Markdown 同源，字段可再导入', async t => {
  const { dataDir, base } = await fixture(t);
  await fetch(base + '/toy/letter/unread_count');
  seed(dataDir, [{ content: '内容 A', reply: '回信 A' }]);
  const { result } = await post(base, { format: 'json' });
  assert.equal(result.data.format, 'json');
  assert.match(result.data.file, /\.json$/u);
  const parsed = JSON.parse(await readFile(result.data.path, 'utf8'));
  assert.equal(parsed.schema, 'olivia-soul-letters');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.letters[0].incoming, '内容 A');
  assert.equal(parsed.letters[0].reply, '回信 A');
  assert.equal(parsed.letters[0].hasReplyVideo, false);
});

test('一键导出：没有信件时明确报错，而不是产出空文件', async t => {
  const { base } = await fixture(t);
  await fetch(base + '/toy/letter/unread_count');
  const { result } = await post(base, { format: 'md' });
  assert.notEqual(result.code, 0);
  assert.match(result.message, /还没有可以导出的信件/u);
});

test('游戏侧脚本已登记进 serveStatic 白名单，且锚点仍钉着信箱头部按钮组', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/admin/game-letter-export.js');
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /一键导出/u);
  assert.match(source, /\/toy\/letter\/export/u);
  // 锚点契约：必须是「下载 / 分享信件」那一组容器，否则按钮会挂到别的页面上
  assert.match(source, /querySelectorAll\('div\.flex\.items-center\.gap-2\.flex-shrink-0'\)/u);
  assert.match(source, /下载\|Download/u);
  // 别退回「把页面里每个 div 都扫一遍」的写法
  assert.ok(!source.includes("querySelectorAll('div')"), '不该再对整页 div 做全量扫描');
  // 认错容器时要能纠正回来：样式跟着「当前这个下载按钮」走，而不是只准备一次
  assert.match(source, /if \(styledFrom === download\) return;/u);
  // 挂上之后放慢轮询，页面切到后台再放慢一档
  assert.match(source, /document\.hidden \? 10000 : target \? 5000 : 1500/u);
});
