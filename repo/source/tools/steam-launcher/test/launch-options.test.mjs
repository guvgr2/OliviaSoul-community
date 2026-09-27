import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readLaunchOptions, editLaunchOptions, buildLaunchOptions, configureLaunchOptions, buildFlagOptions, configureGameFlag } from '../steam-launch-options.mjs';

const appId = '12345';
const helperPath = String.raw`I:\Example App\UserData\tools\steam-launcher\OliviaSteamWaiter.exe`;
const fixture = (options = '') => '\uFEFF' + `// Keep every unrelated byte\r\n"UserLocalConfigStore"\r\n{\r\n\t"Software" { "Valve" { "Steam" { "apps" {\r\n\t\t"999" { "LaunchOptions" "keep-other-game" }\r\n\t\t"${appId}"\r\n\t\t{\r\n\t\t\t"Playtime" "42"\r\n${options}\t\t}\r\n\t} } } }\r\n\t"Tickets" { "${appId}" "example-decoy" }\r\n}\r\n`;
const optionLine = '\t\t\t"LaunchOptions"\t\t"-windowed"\r\n';

test('missing option remains distinct from empty and zero unrelated state changes', () => {
  assert.equal(readLaunchOptions(fixture(), appId), null);
  assert.equal(editLaunchOptions(fixture(), appId, null), fixture());
});
test('inserts one exact leaf while retaining BOM, CRLF, comments, other app and decoy', () => {
  assert.equal(editLaunchOptions(fixture(), appId, '-windowed'), fixture(optionLine));
});
test('updates only the value span and removes an option line losslessly', () => {
  assert.equal(editLaunchOptions(fixture(optionLine), appId, '-novid'), fixture(optionLine.replace('-windowed', '-novid')));
  assert.equal(editLaunchOptions(fixture(optionLine), appId, null), fixture());
});
test('escaped arguments round-trip and nested path is case insensitive', () => {
  const value = String.raw`-path "I:\Music Collection\"`;
  const changed = editLaunchOptions(fixture().replace('"Steam"', '"sTeAm"'), appId, value);
  assert.equal(readLaunchOptions(changed, appId), value);
});
test('malformed input and duplicate target keys fail without reflecting config contents', () => {
  for (const source of [fixture().slice(0, -4), fixture(optionLine + optionLine), fixture().replace('"Playtime" "42"', '"secret-content" [bad]')]) {
    assert.throws(() => readLaunchOptions(source, appId), (error) => !error.message.includes('secret-content'));
  }
  assert.throws(() => readLaunchOptions(fixture().replace('"Software"', '"Other"'), appId));
});
test('helper options preserve simple user arguments once and repeated install is idempotent', () => {
  assert.equal(buildLaunchOptions(helperPath, '-windowed -title "Chinese song"'), `"${helperPath}" %command% -windowed -title "Chinese song"`);
  const installed = buildLaunchOptions(helperPath, null);
  assert.equal(buildLaunchOptions(helperPath, installed), installed);
});
test('conflicting wrappers, shell syntax, malformed quotes and unsafe helper paths are refused', () => {
  for (const old of ['other.exe %command%', '-x & shutdown', '"unterminated', 'custom.exe', '-x | other', '-x\n-other']) {
    assert.throws(() => buildLaunchOptions(helperPath, old));
  }
  for (const helper of ['relative.exe', 'I:\\bad"name.exe', 'I:\\helper&other.exe']) {
    assert.throws(() => buildLaunchOptions(helper, null));
  }
});

const testRoot = path.resolve(process.env.OLIVIA_LAUNCH_TEST_ROOT || path.join(import.meta.dirname, '.test-output'));
async function temp(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'localconfig.vdf');
  const realHelper = path.join(dir, 'OliviaSteamWaiter.exe');
  await fs.writeFile(configPath, fixture(optionLine));
  await fs.writeFile(realHelper, 'test-helper');
  return { configPath, helperPath: realHelper, backupDirectory: path.join(dir, 'Backups'), appId };
}
const stopped = async () => {};
test('command-line preview prints only the allowed public result fields', async (t) => {
  const args = await temp(t);
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.resolve(import.meta.dirname, '../steam-launch-options.mjs'), '--mode', 'preview',
    '--configPath', args.configPath, '--helperPath', args.helperPath,
    '--backupDirectory', args.backupDirectory, '--appId', appId,
  ], { windowsHide: true });
  assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(), ['changed', 'success']);
});
test('install backs up, returns no config data, idempotent install and scoped restore preserve later unrelated edits', async (t) => {
  const args = await temp(t);
  const result = await configureLaunchOptions({ ...args, mode: 'install' }, stopped);
  assert.equal(result.changed, true);
  assert.equal(JSON.stringify(result).includes('example-decoy'), false);
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), fixture(optionLine));
  const installed = await fs.readFile(args.configPath, 'utf8');
  assert.equal(readLaunchOptions(installed, appId), `"${args.helperPath}" %command% -windowed`);
  assert.equal((await configureLaunchOptions({ ...args, mode: 'install' }, stopped)).changed, false);
  await fs.writeFile(args.configPath, installed.replace('"42"', '"43"'));
  await configureLaunchOptions({ ...args, mode: 'restore', manifestPath: result.manifestPath }, stopped);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture(optionLine).replace('"42"', '"43"'));
});
test('later user option edits prevent restore and retain config', async (t) => {
  const args = await temp(t);
  const result = await configureLaunchOptions({ ...args, mode: 'install' }, stopped);
  const changed = editLaunchOptions(await fs.readFile(args.configPath, 'utf8'), appId, '-user-new-option');
  await fs.writeFile(args.configPath, changed);
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'restore', manifestPath: result.manifestPath }, stopped), /OPTIONS_CHANGED/);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), changed);
});
test('running Steam refuses install before backups or write', async (t) => {
  const args = await temp(t);
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'install' }, async () => { throw new Error('STEAM_RUNNING'); }), /STEAM_RUNNING/);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture(optionLine));
  await assert.rejects(fs.stat(args.backupDirectory), /ENOENT/);
});
test('Steam guard runs again immediately before replace and keeps original on refusal', async (t) => {
  const args = await temp(t);
  let checks = 0;
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'install' }, async () => {
    checks++;
    if (checks === 2) throw new Error('STEAM_RUNNING');
  }), /STEAM_RUNNING/);
  assert.equal(checks, 2);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture(optionLine));
});
test('optimistic hash check refuses changed file and preview never writes', async (t) => {
  const args = await temp(t);
  const original = await fs.readFile(args.configPath);
  const preview = await configureLaunchOptions({ ...args, mode: 'preview' }, stopped);
  assert.equal(preview.expectedHash, createHash('sha256').update(original).digest('hex'));
  await fs.writeFile(args.configPath, fixture(optionLine).replace('"42"', '"99"'));
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'install', expectedHash: preview.expectedHash }, stopped), /CONFIG_CHANGED/);
  assert.equal((await fs.readFile(args.configPath, 'utf8')).includes('"99"'), true);
});

test('file changed during final guard is not overwritten', async (t) => {
  const args = await temp(t);
  let checks = 0;
  const concurrent = fixture(optionLine).replace('"42"', '"100"');
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'install' }, async () => {
    if (++checks === 2) await fs.writeFile(args.configPath, concurrent);
  }), /CONFIG_CHANGED/);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), concurrent);
});
test('restore of an originally missing option removes just the added line', async (t) => {
  const args = await temp(t);
  await fs.writeFile(args.configPath, fixture());
  const result = await configureLaunchOptions({ ...args, mode: 'install' }, stopped);
  await configureLaunchOptions({ ...args, mode: 'restore', manifestPath: result.manifestPath }, stopped);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture());
});
test('wrong account restore manifest is refused', async (t) => {
  const args = await temp(t);
  const result = await configureLaunchOptions({ ...args, mode: 'install' }, stopped);
  const before = await fs.readFile(args.configPath, 'utf8');
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  manifest.configPath = path.join(path.dirname(args.configPath), 'other-user.vdf');
  await fs.writeFile(result.manifestPath, JSON.stringify(manifest));
  await assert.rejects(configureLaunchOptions({ ...args, mode: 'restore', manifestPath: result.manifestPath }, stopped), /INVALID_RESTORE_MANIFEST/);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), before);
});

// ---------------------------------------------------------------- g15：纯参数开关
// 用途：把 Chromium 的稳定性开关（--enable-features=...）写进游戏启动项，
// 不改游戏文件、只动这一个参数、随时可关。
const FLAG = '--enable-features=SkipDiscardDrivenByStaleSignal';

test('buildFlagOptions adds the flag, keeps other arguments, is idempotent and removes only the target', () => {
  assert.equal(buildFlagOptions('-windowed', FLAG, true), `-windowed ${FLAG}`);
  assert.equal(buildFlagOptions(`-windowed ${FLAG}`, FLAG, true), `-windowed ${FLAG}`);
  assert.equal(buildFlagOptions(`-windowed ${FLAG}`, FLAG, false), '-windowed');
  assert.equal(buildFlagOptions(FLAG, FLAG, false), '');
  assert.equal(buildFlagOptions(null, FLAG, true), FLAG);
  assert.equal(buildFlagOptions(`-a ${FLAG} -b`, FLAG, false), '-a -b');
});

test('buildFlagOptions refuses wrapped commands and malformed flags', () => {
  for (const old of ['"C:\\Example App\\launcher.exe" %command%', '-x & shutdown', '-x | other', '"unterminated']) {
    assert.throws(() => buildFlagOptions(old, FLAG, true), /EXISTING_OPTIONS_REQUIRE_REVIEW/);
  }
  for (const bad of ['not-a-flag', '--enable-features=a b', '--', 'enable-features=x']) {
    assert.throws(() => buildFlagOptions('-windowed', bad, true), /INVALID_FLAG/);
  }
});

test('configureGameFlag writes the flag, backs up the file, keeps other arguments and is idempotent', async (t) => {
  const args = await temp(t);
  const applied = await configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: true }, stopped);
  assert.equal(applied.changed, true);
  assert.equal(readLaunchOptions(await fs.readFile(args.configPath, 'utf8'), appId), `-windowed ${FLAG}`);
  assert.equal(await fs.readFile(applied.backupPath, 'utf8'), fixture(optionLine));
  const manifest = JSON.parse(await fs.readFile(applied.manifestPath, 'utf8'));
  assert.equal(manifest.mode, 'install');
  assert.equal(manifest.originalOptions, '-windowed');
  assert.equal(manifest.installedOptions, `-windowed ${FLAG}`);
  assert.equal((await configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: true }, stopped)).changed, false);
  assert.equal((await fs.readdir(args.backupDirectory)).filter(n => n.endsWith('.vdf')).length, 1);
});

test('disabling restores exactly and deletes both backups — no Steam account data left behind', async (t) => {
  const args = await temp(t);
  const applied = await configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: true }, stopped);
  const off = await configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: false, manifestPath: applied.manifestPath }, stopped);
  assert.equal(off.changed, true);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture(optionLine));
  assert.equal(await fs.stat(applied.manifestPath).then(() => true, () => false), false);
  assert.equal(await fs.stat(applied.backupPath).then(() => true, () => false), false);
  assert.deepEqual((await fs.readdir(args.backupDirectory)).filter(n => n.endsWith('.vdf')), []);
});

test('configureGameFlag runs the Steam guard before writing and leaves the config alone', async (t) => {
  const args = await temp(t);
  await assert.rejects(
    configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: true }, async () => { throw new Error('STEAM_RUNNING'); }),
    /STEAM_RUNNING/);
  assert.equal(await fs.readFile(args.configPath, 'utf8'), fixture(optionLine));
});

test('configureGameFlag preview never writes and optimistic hash check refuses a changed file', async (t) => {
  const args = await temp(t);
  const preview = await configureGameFlag({ ...args, mode: 'preview', flag: FLAG, enabled: true }, stopped);
  assert.equal(preview.changed, true);
  assert.equal(readLaunchOptions(await fs.readFile(args.configPath, 'utf8'), appId), '-windowed');
  await assert.rejects(
    configureGameFlag({ ...args, mode: 'apply', flag: FLAG, enabled: true, expectedHash: '0'.repeat(64) }, stopped),
    /CONFIG_CHANGED/);
  assert.equal(readLaunchOptions(await fs.readFile(args.configPath, 'utf8'), appId), '-windowed');
});
