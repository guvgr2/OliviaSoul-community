import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOliviaService } from '../server.js';

// 这组测试单独守「歌曲行状态」这一件事：游戏端要在曲库列表上显示
// 「已在 N 个歌单」，并给每首歌显示它为哪些歌单勾选过。
// 接口：GET /toy/folders/membership?ids=a,b,c → { itemIds, members, counts }
//   ① 一批 id 一次问完，不做按行循环；
//   ② 不在任何歌单里的 id 不进 members，但必须在 itemIds 里回声（前端好判断「0 个」）；
//   ③ membership 是保留字，不能被当成歌单 id（否则真实歌单叫 membership 就打不开）；
//   ④ 两端等价：/admin/api/folders/membership 与 /toy/folders/membership 同数据；
//   ⑤ 一次最多 500 个 id（SQLite 变量数上限），多出来的截断而不是报错。

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'song-folder-membership-'));
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

  return { service, base, request };
}

function seedSong(service, id, name) {
  return service.midiStore.upsertUserSong({
    id, name, sourceKind: 'official-import', videoPath: `${id}.mp4`, durationUs: 60_000_000,
  });
}

async function createFolder(request, name) {
  const created = await request('/toy/folders', { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(created.body.code, 0, created.body.message);
  return created.body.data;
}

async function addItems(request, folderId, itemIds) {
  const added = await request(`/toy/folders/${folderId}/items`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
  assert.equal(added.body.code, 0, added.body.message);
  return added.body.data;
}

async function membership(request, ids, prefix = '/toy/folders') {
  const query = ids === null ? '' : `?ids=${ids.map(id => encodeURIComponent(id)).join(',')}`;
  const response = await request(`${prefix}/membership${query}`);
  assert.equal(response.status, 200, `membership 应回 200，实际 ${response.status}`);
  assert.equal(response.body.code, 0, response.body.message);
  return response.body.data;
}

test('membership 一次问出一批 id 分别落在哪些歌单，并回声未命中的 id', async t => {
  const { service, request } = await fixture(t);
  seedSong(service, 'midi_a_1', '甲');
  seedSong(service, 'midi_b_2', '乙');
  seedSong(service, 'midi_c_3', '丙');

  const favourites = await createFolder(request, '我的收藏');
  const practice = await createFolder(request, '练琴');
  await addItems(request, favourites.id, ['midi_a_1', 'midi_b_2']);
  await addItems(request, practice.id, ['midi_a_1']);

  const data = await membership(request, ['midi_a_1', 'midi_b_2', 'midi_c_3']);
  assert.deepEqual(data.itemIds, ['midi_a_1', 'midi_b_2', 'midi_c_3']);
  assert.deepEqual(data.members.midi_a_1.sort(), [favourites.id, practice.id].sort());
  assert.deepEqual(data.members.midi_b_2, [favourites.id]);
  assert.equal(data.members.midi_c_3, undefined, '不在任何歌单里的 id 不该出现在 members 里');
  assert.deepEqual(data.counts, { [favourites.id]: 2, [practice.id]: 1 });
});

test('membership 去重、忽略空白，且移出歌单后立刻不再算在内', async t => {
  const { request } = await fixture(t);
  const folder = await createFolder(request, '我的收藏');
  await addItems(request, folder.id, ['midi_x_9']);

  const once = await membership(request, [' midi_x_9 ', 'midi_x_9']);
  assert.deepEqual(once.itemIds, ['midi_x_9'], '重复与空白要归一');
  assert.deepEqual(once.members.midi_x_9, [folder.id]);

  const removed = await request(`/toy/folders/${folder.id}/items`, {
    method: 'DELETE',
    body: JSON.stringify({ itemIds: ['midi_x_9'] }),
  });
  assert.equal(removed.body.code, 0, removed.body.message);

  const after = await membership(request, ['midi_x_9']);
  assert.equal(after.members.midi_x_9, undefined);
  assert.deepEqual(after.counts, { [folder.id]: 0 });
});

test('不传 ids 时只回计数；membership 是保留字，不会被当成歌单 id', async t => {
  const { request } = await fixture(t);
  const folder = await createFolder(request, '我的收藏');
  await addItems(request, folder.id, ['midi_a_1']);

  const bare = await membership(request, null);
  assert.deepEqual(bare.itemIds, []);
  assert.deepEqual(bare.members, {});
  assert.deepEqual(bare.counts, { [folder.id]: 1 });

  // 真实歌单可以叫这个名字（名字与保留路径不冲突），但 /folders/membership 必须走接口而不是查歌单
  const named = await createFolder(request, 'membership');
  assert.equal(named.name, 'membership');
  const reserved = await request('/toy/folders/membership');
  assert.equal(reserved.body.code, 0);
  assert.ok(Array.isArray(reserved.body.data.itemIds), '保留字路径必须仍走 membership 接口');
  const byId = await request(`/toy/folders/${named.id}`);
  assert.equal(byId.body.code, 0, '同名歌单仍要能按 id 打开');
  assert.equal(byId.body.data.name, 'membership');
});

test('两端等价：/admin/api/folders/membership 与 /toy/folders/membership 同数据', async t => {
  const { request } = await fixture(t);
  const folder = await createFolder(request, '我的收藏');
  await addItems(request, folder.id, ['midi_a_1', 'midi_b_2']);

  const toy = await membership(request, ['midi_a_1', 'midi_b_2'], '/toy/folders');
  const admin = await membership(request, ['midi_a_1', 'midi_b_2'], '/admin/api/folders');
  assert.deepEqual(admin, toy);
});

test('一次最多 500 个 id：多出来的截断而不是报错', async t => {
  const { request } = await fixture(t);
  const ids = Array.from({ length: 620 }, (unused, index) => `midi_cap_${index}`);
  const data = await membership(request, ids);
  assert.equal(data.itemIds.length, 500);
  assert.equal(data.itemIds[0], 'midi_cap_0');
  assert.equal(data.itemIds.at(-1), 'midi_cap_499');
});
