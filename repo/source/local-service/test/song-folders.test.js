import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOliviaService } from '../server.js';

// 这组测试守四件事：
// ① 歌单/收藏夹是**新表**，`playlist_items` 的结构一个字段都不能动（它是游戏真实歌单的镜像）。
// ② 游戏端与程序端看到的是同一份数据、同一套接口（/toy/folders 与 /admin/api/folders 等价）。
// ③ 显示层的重名后缀只加在显示名上，曲库里的真名一个字都不改；占位名（个人上传 · midi_xxx）不参与。
// ④ 所有写接口都必须过来源闸门：恶意网页（别的 Origin）写不进去，游戏页面（https://olivia.local）
//    与本机脚本（无 Origin）照旧能写。

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'song-folders-'));
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

  return { root, service, base, request };
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

test('歌单是新增的独立表，playlist_items 结构一个字段都没动', async t => {
  const { service } = await fixture(t);
  const columns = table => service.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).sort();
  assert.deepEqual(columns('song_folders'), ['created_at', 'id', 'name', 'sort_order', 'updated_at', 'user_id']);
  assert.deepEqual(columns('song_folder_items'), ['added_at', 'folder_id', 'item_id', 'item_type', 'sort_order', 'user_id']);
  assert.deepEqual(columns('playlist_items'), [
    'created_at', 'duration', 'icon_url', 'id', 'item_id', 'item_type', 'name', 'name_key',
    'performance_id', 'performance_type', 'song_id', 'user_id', 'video_by_tod_view',
    'video_duration', 'video_url',
  ]);
  // 外键必须仍指向 users，主键约束保持 (user_id, folder_id, item_id)
  const itemPk = service.db.prepare('PRAGMA table_info(song_folder_items)')
    .all().filter(row => row.pk > 0).map(row => row.name).sort();
  assert.deepEqual(itemPk, ['folder_id', 'item_id', 'user_id']);
});

test('歌单 CRUD：改名、撞名自动加后缀、删除连带清条目', async t => {
  const { service, request } = await fixture(t);
  const first = await createFolder(request, '我的收藏');
  assert.equal(first.name, '我的收藏');
  assert.equal(first.itemCount, 0);

  const second = await createFolder(request, '我的收藏');
  assert.equal(second.name, '我的收藏 (2)', '撞名必须自动加后缀，不打扰用户');

  const renamed = await request(`/toy/folders/${encodeURIComponent(first.id)}`, {
    method: 'PATCH', body: JSON.stringify({ name: '我的收藏 (2)' }),
  });
  assert.equal(renamed.body.code, 0, renamed.body.message);
  assert.equal(renamed.body.data.name, '我的收藏 (2) (2)', '改到已占用的名字也要再让开');
  const afterRename = await request('/toy/folders');
  assert.deepEqual(afterRename.body.data.list.map(row => row.name).sort(), ['我的收藏 (2)', '我的收藏 (2) (2)'].sort());

  const empty = await request('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '   ' }) });
  assert.equal(empty.body.code, -1);
  assert.match(empty.body.message, /歌单名不能为空/u);

  // #68（第四轮 · 审-5 §7.3）：歌单名与用户名同口径 —— C0 控制符（NUL/BEL/ESC/DEL）也要拒。
  // 原来只挡零宽/bidi，这些会存进 song_folders.name，还会跟着进导出的 .osfolder 文件名。
  for (const bad of ['\u0000', '\u0007', '\u001B', '\u007F', '零宽\u200B名']) {
    const rejected = await request('/toy/folders', { method: 'POST', body: JSON.stringify({ name: `收藏${bad}` }) });
    assert.equal(rejected.body.code, -1, `歌单名里的 ${JSON.stringify(bad)} 必须被拒`);
    assert.match(rejected.body.message, /不可用字符/u);
  }

  seedSong(service, 'midi_a', '曲目甲');
  await request(`/toy/folders/${encodeURIComponent(first.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'midi_a' }),
  });
  const removed = await request(`/toy/folders/${encodeURIComponent(first.id)}`, { method: 'DELETE' });
  assert.equal(removed.body.code, 0, removed.body.message);
  assert.equal(removed.body.data.removedItems, 1);
  assert.equal(service.db.prepare('SELECT COUNT(*) count FROM song_folder_items').get().count, 0);

  const list = await request('/toy/folders');
  assert.deepEqual(list.body.data.list.map(row => row.name), ['我的收藏 (2)'], '删掉的那份不该还在');
  assert.equal(list.body.data.list[0].itemCount, 0);
  assert.equal(list.body.data.total, 1);

  const missing = await request('/toy/folders/does-not-exist');
  assert.equal(missing.body.code, -1);
  assert.match(missing.body.message, /歌单不存在/u);
});

test('加入曲目去重、排序、移除；显示层重名后缀不改曲库真名', async t => {
  const { service, request } = await fixture(t);
  seedSong(service, 'midi_a', '同名曲');
  seedSong(service, 'midi_b', '同名曲');
  seedSong(service, 'midi_c', '个人上传 · midi_c');
  seedSong(service, 'midi_d', '个人上传 · midi_c');
  const folder = await createFolder(request, '循环用');

  const added = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items`, {
    method: 'POST', body: JSON.stringify({ items: [{ itemId: 'midi_a' }, { itemId: 'midi_b' }] }),
  });
  assert.equal(added.body.code, 0, added.body.message);
  assert.deepEqual(added.body.data.added, ['midi_a', 'midi_b']);

  const again = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'midi_a' }),
  });
  assert.deepEqual(again.body.data.added, [], '重复加入不能再写一行');
  assert.deepEqual(again.body.data.skipped, ['midi_a']);

  const items = again.body.data.items;
  assert.equal(items.length, 2);
  assert.equal(items[0].name, '同名曲');
  assert.equal(items[0].renamed, false);
  assert.equal(items[1].name, '同名曲 (2)');
  assert.equal(items[1].originalName, '同名曲');
  assert.equal(items[1].renamed, true);
  // 红线：曲库里的真名一个字都不能改
  assert.equal(service.midiStore.getUserSong('midi_b').name, '同名曲');

  // 占位名（个人上传 · midi_xxx）自带编号，不算重名
  const placeholder = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemIds: ['midi_c', 'midi_d'] }),
  });
  const placeholders = placeholder.body.data.items.filter(item => item.itemId.startsWith('midi_c') || item.itemId === 'midi_d');
  assert.equal(placeholders.length, 2);
  assert.deepEqual(placeholders.map(item => item.renamed), [false, false]);

  const removed = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items`, {
    method: 'DELETE', body: JSON.stringify({ itemIds: ['midi_a'] }),
  });
  assert.deepEqual(removed.body.data.removed, ['midi_a']);
  assert.deepEqual(removed.body.data.items.map(item => item.itemId), ['midi_b', 'midi_c', 'midi_d']);

  // 排序：整串顺序 + 上移一格
  const ordered = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items/order`, {
    method: 'POST', body: JSON.stringify({ itemIds: ['midi_d', 'midi_b', 'midi_c'] }),
  });
  assert.deepEqual(ordered.body.data.order, ['midi_d', 'midi_b', 'midi_c']);
  assert.deepEqual(ordered.body.data.items.map(item => item.itemId), ['midi_d', 'midi_b', 'midi_c']);

  const up = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items/order`, {
    method: 'POST', body: JSON.stringify({ itemId: 'midi_c', direction: 'up' }),
  });
  assert.deepEqual(up.body.data.order, ['midi_d', 'midi_c', 'midi_b']);

  // #69（第四轮 · 审-5 §7.4）：direction 传错字不能静默「按空 order 重排 = 原样不动」，
  // 调用方会以为生效了。现在必须明确报错；「没传 / 传空串」仍是合法的整表重排。
  for (const direction of ['sideways', 'UP', 1, {}]) {
    const rejected = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items/order`, {
      method: 'POST', body: JSON.stringify({ itemId: 'midi_b', direction }),
    });
    assert.equal(rejected.body.code, -1, `direction=${JSON.stringify(direction)} 必须被拒，不能静默重排`);
    assert.match(rejected.body.message, /只能填 up 或 down/u);
  }
  const blank = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items/order`, {
    method: 'POST', body: JSON.stringify({ direction: '', itemIds: ['midi_b', 'midi_c', 'midi_d'] }),
  });
  assert.equal(blank.body.code, 0, blank.body.message);
  assert.deepEqual(blank.body.data.order, ['midi_b', 'midi_c', 'midi_d'], '空 direction 仍要按 itemIds 整表重排');
});

test('一键导入曲库全部：能播的整批进来、不能播的只计数不丢', async t => {
  const { service, request } = await fixture(t);
  seedSong(service, 'midi_a', '甲');
  seedSong(service, 'midi_b', '乙');
  service.midiStore.upsertUserSong({ id: 'midi_no_media', name: '没媒体', sourceKind: 'official-import' });
  service.midiStore.upsertUserSong({ id: 'midi_upload', name: '上传中', sourceKind: 'upload' });
  const folder = await createFolder(request, '全曲库');

  const imported = await request(`/toy/folders/${encodeURIComponent(folder.id)}/import-library`, {
    method: 'POST', body: '{}',
  });
  assert.equal(imported.body.code, 0, imported.body.message);
  assert.equal(imported.body.data.added, 2);
  assert.equal(imported.body.data.noMedia, 1, '不能播的曲目必须被报出来，不能静默丢');
  assert.deepEqual(imported.body.data.items.map(item => item.itemId).sort(), ['midi_a', 'midi_b']);

  const twice = await request(`/toy/folders/${encodeURIComponent(folder.id)}/import-library`, {
    method: 'POST', body: '{}',
  });
  assert.equal(twice.body.data.added, 0);
  assert.equal(twice.body.data.skipped, 2);
});

test('导出/导入闭环：撞名让位、未匹配的曲目必须逐条列出', async t => {
  const { service, request } = await fixture(t);
  seedSong(service, 'midi_a', '甲');
  seedSong(service, 'midi_b', '乙');
  const source = await createFolder(request, '分享单');
  await request(`/toy/folders/${encodeURIComponent(source.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemIds: ['midi_a', 'midi_b'] }),
  });

  const exported = await request(`/toy/folders/${encodeURIComponent(source.id)}/export`);
  assert.equal(exported.body.data.mode, 'qr');
  assert.equal(exported.body.data.count, 2);
  assert.equal(exported.body.data.text, 'OSF1|分享单|midi_a,midi_b');
  // 二维码矩阵：前端自己画，所以要保证尺寸自洽、是方阵、且确实是这份文本编出来的
  const qr = exported.body.data.qr;
  assert.ok(qr, '≤30 首要带二维码矩阵');
  assert.ok(qr.size >= 21 && qr.size % 4 === 1, `QR 尺寸应为 21+4k，实际 ${qr.size}`);
  assert.equal(qr.rows.length, qr.size);
  assert.ok(qr.rows.every(row => row.length === qr.size && /^[01]+$/u.test(row)));

  const imported = await request('/toy/folders/import', {
    method: 'POST', body: JSON.stringify({ text: exported.body.data.text }),
  });
  assert.equal(imported.body.code, 0, imported.body.message);
  assert.equal(imported.body.data.folder.name, '分享单 (2)', '撞名要自动让位');
  assert.equal(imported.body.data.added, 2);
  assert.deepEqual(imported.body.data.missing, []);
  const reExport = await request(`/toy/folders/${encodeURIComponent(imported.body.data.folder.id)}/export`);
  assert.notDeepEqual(reExport.body.data.qr.rows, qr.rows, '不同的曲目单要编出不同的码');

  const partial = await request('/toy/folders/import', {
    method: 'POST', body: JSON.stringify({ text: 'OSF1|别处的单|midi_a,midi_ghost,midi_ghost' }),
  });
  assert.equal(partial.body.data.added, 1);
  assert.deepEqual(partial.body.data.missing, ['midi_ghost']);
  assert.equal(partial.body.data.missingCount, 1);
  assert.equal(partial.body.data.total, 2, '重复 id 要去重后再报总数');

  const bad = await request('/toy/folders/import', { method: 'POST', body: JSON.stringify({ text: '随便一段文字' }) });
  assert.equal(bad.body.code, -1);
  assert.match(bad.body.message, /二维码/u);

  // 超过 30 首就不给二维码，直接给 .osfolder 文件
  const big = await createFolder(request, '大单');
  const ids = Array.from({ length: 31 }, (unused, index) => `midi_big_${index}`);
  await request(`/toy/folders/${encodeURIComponent(big.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemIds: ids }),
  });
  const bigExport = await request(`/toy/folders/${encodeURIComponent(big.id)}/export`);
  assert.equal(bigExport.body.data.count, 31);
  assert.equal(bigExport.body.data.mode, 'file');
  assert.equal(bigExport.body.data.qr, null, '超过 30 首不给二维码');
  assert.equal(bigExport.body.data.fileName, '大单.osfolder');
});

test('游戏端与程序端是同一份数据、同一套接口', async t => {
  const { service, request } = await fixture(t);
  seedSong(service, 'midi_a', '甲');
  const folder = await createFolder(request, '双端');

  const game = await request(`/toy/folders/${encodeURIComponent(folder.id)}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'midi_a' }),
  });
  assert.equal(game.body.code, 0, game.body.message);

  const admin = await request(`/admin/api/folders/${encodeURIComponent(folder.id)}`);
  assert.equal(admin.body.code, 0, admin.body.message);
  assert.equal(admin.body.data.name, '双端');
  assert.deepEqual(admin.body.data.items.map(item => item.itemId), ['midi_a']);

  const adminList = await request('/admin/api/folders');
  assert.deepEqual(adminList.body.data.list.map(row => [row.id, row.itemCount]), [[folder.id, 1]]);

  const renamedByAdmin = await request(`/admin/api/folders/${encodeURIComponent(folder.id)}`, {
    method: 'PATCH', body: JSON.stringify({ name: '双端改名' }),
  });
  assert.equal(renamedByAdmin.body.data.name, '双端改名');
  const gameAgain = await request('/toy/folders');
  assert.equal(gameAgain.body.data.list[0].name, '双端改名');

  assert.equal(service.db.prepare('SELECT COUNT(*) count FROM song_folders').get().count, 1);
});

test('写接口来源闸门：恶意网页写不进去，游戏页面与本机脚本照旧', async t => {
  const { service, request, base } = await fixture(t);
  seedSong(service, 'midi_a', '甲');
  const folder = await createFolder(request, '闸门');

  async function attempt(path, init, origin) {
    return request(path, { ...init, headers: origin === null ? {} : { Origin: origin } });
  }

  // 恶意网页：/toy/* 与 /admin/api/* 都写不进去
  const blocked = await attempt('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '坏人建的' }) }, 'https://evil.example');
  assert.equal(blocked.body.code, -1);
  assert.match(blocked.body.message, /来源/u);
  const stillOne = await request('/toy/folders');
  assert.equal(stillOne.body.data.total, 1, '被拒的写请求不能留下任何痕迹');

  const blockedAdd = await attempt('/toy/addToPlaylist', {
    method: 'POST', body: JSON.stringify({ itemType: 3, itemId: 'midi_a' }),
  }, 'https://evil.example');
  assert.equal(blockedAdd.body.code, -1);
  assert.equal(service.db.prepare('SELECT COUNT(*) count FROM playlist_items').get().count, 0);

  const blockedAdmin = await attempt('/admin/api/folders', { method: 'POST', body: JSON.stringify({ name: '坏人建的' }) }, 'https://evil.example');
  assert.equal(blockedAdmin.status, 403, '管理接口要回真正的 403');

  // file:// 页面（Origin: null）同样拒绝
  const blockedNull = await attempt('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '沙箱页' }) }, 'null');
  assert.equal(blockedNull.body.code, -1);
  const blockedNullReferer = await request('/toy/folders', {
    method: 'POST', body: JSON.stringify({ name: '沙箱页' }), headers: { Referer: 'https://evil.example/page' },
  });
  assert.equal(blockedNullReferer.body.code, -1);

  // 游戏页面：单机模式的虚拟源，必须放行
  const fromGame = await attempt('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '游戏建的' }) }, 'https://olivia.local');
  assert.equal(fromGame.body.code, 0, fromGame.body.message);
  const fromChannel = await attempt('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '渠道服的' }) }, 'https://toy-cnbeta01.olivia.miyoushe.com');
  assert.equal(fromChannel.body.code, 0, fromChannel.body.message);

  // 本机脚本 / node 测试：没有来源，照旧放行
  const fromScript = await request('/toy/folders', { method: 'POST', body: JSON.stringify({ name: '脚本建的' }) });
  assert.equal(fromScript.body.code, 0, fromScript.body.message);

  // 本机管理界面：自身源
  const selfOrigin = new URL(base).origin;
  const fromAdminUi = await attempt('/admin/api/folders', { method: 'POST', body: JSON.stringify({ name: '界面建的' }) }, selfOrigin);
  assert.equal(fromAdminUi.body.code, 0, fromAdminUi.body.message);

  // 游戏页面还是要能正常加歌（回归：闸门不能误伤游戏）
  const gameAdd = await attempt('/toy/addToPlaylist', {
    method: 'POST', body: JSON.stringify({ itemType: 3, itemId: 'midi_a', name: '甲' }),
  }, 'https://olivia.local');
  assert.equal(gameAdd.body.code, 0, gameAdd.body.message);

  // 读接口不受影响（GET 不带来源闸门）
  const readFromEvil = await attempt(`/toy/folders/${encodeURIComponent(folder.id)}`, {}, 'https://evil.example');
  assert.equal(readFromEvil.body.code, 0);
});
