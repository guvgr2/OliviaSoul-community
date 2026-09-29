// 不变量测试：用静态扫描 + 交叉比对，抓「同一个常量被抄到多处」这类 bug。
//
// 为什么需要它：补丁版本从 v45 升到 v46 时，同一个版本列表被抄在 6 个位置，
// 结果漏改了三处，直接造成用户「启用本地服务」报 backup feapp archive identity
// mismatch，以及卸载恢复路径判定失效。这类 bug 靠"写代码时更小心"是防不住的，
// 只能靠测试自动发现"同一事实存在多个副本"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { FEAPP_REVISIONS, feappRevisionAtLeast, feappRevisionRank, isKnownFeappRevision } from '../desktop/feapp-revisions.js';

const DESKTOP = new URL('../desktop/', import.meta.url);
const TOOLS = new URL('../../tools/', import.meta.url);
const read = (base, name) => readFile(new URL(name, base), 'utf8');
const versionsIn = text => (text.match(/v\d{1,12}/gu) ?? []).map(v => Number(v.slice(1)));

test('本支版本列表自身一致且递增（v22…，无重复）', () => {
  const ranks = FEAPP_REVISIONS.map(v => feappRevisionRank(v));
  assert.ok(ranks.every(r => r !== null), '列表里每个都必须是合法版本号');
  assert.equal(new Set(ranks).size, ranks.length, '不应有重复版本');
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '应按版本递增排列');
  assert.equal(feappRevisionRank('v999'), null, '未知版本必须返回 null');
  assert.equal(isKnownFeappRevision('v999'), false);
  assert.equal(feappRevisionAtLeast('v999', 'v31'), false, '未知版本不得被当作可升级');
  const last = FEAPP_REVISIONS[FEAPP_REVISIONS.length - 1];
  assert.equal(feappRevisionAtLeast(last, last), true);
});

test('桌面端不再出现散落的连续版本枚举（必须引用 feapp-revisions.js）', async () => {
  const offenders = [];
  for (const name of ['controller.js', 'client-backups.js', 'uninstall-restore.js', 'main.js', 'client-patch-registry.js']) {
    let text;
    try { text = await read(DESKTOP, name); } catch { continue; }
    for (const matched of text.match(/\[[^\]\r\n]{0,600}?\]/gu) ?? []) {
      const count = (matched.match(/"v\d{1,12}"|'v\d{1,12}'/gu) ?? []).length;
      if (count >= 4) offenders.push(`${name}: ${matched.slice(0, 80)}…`);
    }
  }
  assert.deepEqual(offenders, [], `发现散落版本枚举，请改用 desktop/feapp-revisions.js：\n${offenders.join('\n')}`);
});

test('补丁脚本的 marker 版本必须在已知版本列表内', async () => {
  const patch = await read(TOOLS, 'patch-feapp-local.ps1');
  const matched = /\$patchMarker\s*=\s*'\/\*OliviaSoulPatch:mail-music-(v\d{1,12})\*\/'/u.exec(patch);
  assert.ok(matched, '未能从 patch-feapp-local.ps1 解析出 $patchMarker');
  const marker = matched[1];
  assert.ok(FEAPP_REVISIONS.includes(marker), `补丁 marker ${marker} 不在 feapp-revisions.js 的已知列表里 —— 新增补丁版本时要同步该列表`);
});

test('get-feapp-status.ps1 的 currentMarker 与 knownMarkers 必须覆盖已知版本', async () => {
  const status = await read(TOOLS, 'get-feapp-status.ps1');
  const current = /\$currentMarker\s*=\s*'\/\*OliviaSoulPatch:mail-music-(v\d{1,12})\*\/'/u.exec(status);
  assert.ok(current, '未能解析 $currentMarker');
  assert.ok(FEAPP_REVISIONS.includes(current[1]), `$currentMarker=${current[1]} 不在已知版本列表里`);

  const knownBlock = /\$knownMarkers\s*=\s*@\(([\s\S]*?)\)/u.exec(status);
  assert.ok(knownBlock, '未能解析 $knownMarkers');
  const known = new Set(versionsIn(knownBlock[1]).map(v => `v${v}`));
  // 列表里允许用 $currentMarker 变量引用当前版本 —— 解析时必须把它算作 currentMarker 的值，
  // 否则会把「用变量引用」误判成「缺少该版本」。
  if (knownBlock[1].includes('$currentMarker')) known.add(current[1]);
  const missing = FEAPP_REVISIONS.filter(v => !known.has(v));
  assert.deepEqual(missing, [], `get-feapp-status.ps1 的 knownMarkers 缺少这些版本：${missing.join('、')}`);
});

test('client-backups.js 内嵌的 marker 判定必须覆盖「会改 locale」的全部版本（v29+）', async () => {
  const backups = await read(DESKTOP, 'client-backups.js');
  const matched = /knownFeLocalePatch=\([\s\S]{0,2000}?\)\)\);/u.exec(backups);
  assert.ok(matched, '未能解析内嵌 PS 的 knownFeLocalePatch 判定');
  const covered = new Set(versionsIn(matched[0]).map(v => `v${v}`));
  const required = FEAPP_REVISIONS.filter(v => feappRevisionAtLeast(v, 'v29'));
  const missing = required.filter(v => !covered.has(v));
  assert.deepEqual(missing, [], `内嵌 marker 判定缺少：${missing.join('、')}（新增补丁版本时要同步，或改用 feappMarkerStartsWithExpression()）`);
});

test('卸载恢复路径的 locale 放行范围与备份路径一致（同一事实不得有两个副本）', async () => {
  const uninstall = await read(DESKTOP, 'uninstall-restore.js');
  const backups = await read(DESKTOP, 'client-backups.js');
  for (const [name, text] of [['uninstall-restore.js', uninstall], ['client-backups.js', backups]]) {
    assert.match(text, /feappRevisionAtLeast\([^)]*["']v29["']\)|isKnownFeappRevision/u,
      `${name} 的 locale 放行应统一走 feapp-revisions.js（v29+），而不是自带一份列表`);
  }
});

test('打包清单必须覆盖 desktop 下的全部模块（新增文件忘了加清单 = 装出来缺模块）', async () => {
  const build = await readFile(new URL('../packaging/build-release.ps1', import.meta.url), 'utf8');
  const block = /\$desktopModules = @\(([\s\S]*?)\)/u.exec(build);
  assert.ok(block, '未能从 build-release.ps1 解析出 $desktopModules');
  const listed = new Set((block[1].match(/"([^"]+\.js)"/gu) ?? []).map(item => item.replace(/"/gu, '')));
  // main.js 是上游 Electron 风格的旧入口；本支由 C# WebView2 宿主直接启动 server.js，
  // 因此刻意不打包。下面另有一条测试确保它不被任何生产代码 import。
  const intentionallyExcluded = new Set(['main.js']);
  const actual = (await readdir(new URL('../desktop/', import.meta.url))).filter(name => name.endsWith('.js'));
  const missing = actual.filter(name => !listed.has(name) && !intentionallyExcluded.has(name));
  assert.deepEqual(missing, [], `desktop 下这些模块没进打包清单，装出来会缺模块：${missing.join('、')}`);
  for (const name of intentionallyExcluded) {
    assert.ok(!listed.has(name), `${name} 已被列进打包清单，请把它从“刻意排除”名单里移除（否则这份名单会过期）`);
  }
});

test('刻意不打包的 desktop/main.js 不得被任何生产代码 import', async () => {
  // 只扫生产代码：desktop/（除 main.js 自身）、midi/，以及仓库根的生产入口。
  // 刻意不扫 test/ —— 测试目录里出现 "main.js" 字样（读取源码做静态断言）是正常的，
  // 之前的版本因为把 test/ 也扫进来，被自己文件里的字符串误判成「被 import」。
  const offenders = [];
  for (const root of ['../desktop/', '../midi/']) {
    for (const name of await readdir(new URL(root, import.meta.url))) {
      if (!name.endsWith('.js') || name === 'main.js') continue;
      // 注意：base 必须是合法 URL。传 '../desktop/' 这样的字符串会在 readFile 之前就抛错，
      // 而且 .catch() 拦不到（错误发生在参数求值时）—— 这一版修掉这个写法。
      const text = await readFile(new URL(`${root}${name}`, import.meta.url), 'utf8').catch(() => '');
      if (/from\s+["'][^"']*\/?main\.js["']/u.test(text)) offenders.push(`${root}${name}`);
    }
  }
  for (const name of ['server.js']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8').catch(() => '');
    if (/from\s+["'][^"']*\/?main\.js["']/u.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `main.js 不在打包清单里，却在这些生产文件里被 import（装出来会缺模块）：${offenders.join('、')}`);
});

test('打包清单必须覆盖 midi 下的全部本支模块（上游未打包模块除外）', async () => {
  const build = await readFile(new URL('../packaging/build-release.ps1', import.meta.url), 'utf8');
  const block = /\$midiModules = @\(([\s\S]*?)\)/u.exec(build);
  assert.ok(block, '未能从 build-release.ps1 解析出 $midiModules');
  const listed = new Set((block[1].match(/"([^"]+\.js)"/gu) ?? []).map(item => item.replace(/"/gu, '')));
  // 这三个是上游模块，本支刻意不打包（渲染管线相关）
  const upstreamOnly = new Set(['render-pipeline.js', 'render-queue.js', 'timeline.js']);
  const actual = (await readdir(new URL('../midi/', import.meta.url))).filter(name => name.endsWith('.js'));
  const missing = actual.filter(name => !listed.has(name) && !upstreamOnly.has(name));
  assert.deepEqual(missing, [], `midi 下这些模块没进打包清单：${missing.join('、')}`);
});
