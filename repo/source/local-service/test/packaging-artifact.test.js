import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const task = resolve(project, '../../.superpowers/sdd/2026-09-05-public-review-package');
const script = join(project, 'packaging/build-release.ps1');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture() {
  await mkdir(join(task, 'fixtures'), { recursive: true });
  return mkdtemp(join(task, 'fixtures/package-'));
}
function powershell(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
}
const parse = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]};`;

test('installer-only checksums do not require or list a portable archive', async () => {
  const root = await fixture();
  // ⚠️ fixture 的文件名必须与 build-release.ps1 实际使用的版本串一致 —— 脚本 `:149-150` 直接拼
  // `OliviaSoul-$version-*.exe`，两边一旦漂移就报「缺少发布文件」（2026-10-17 真实踩过：版本号升到
  // 1.2.3 后 fixture 还在建 1.2.2 的文件名）。
  // 版本串的口径随 S2 改过：现在是**现读 package.json**（`$version = [string]$package.version`，
  // version-sync.test.js 钉形态），所以这里也双向接受 —— 现读形态取 package.json，写死副本取字面量。
  const buildText = await readFile(script, 'utf8');
  const version = /\$version\s*=\s*\[string\]\$package\.version/u.test(buildText)
    ? JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version
    : (buildText.match(/^\$version\s*=\s*"([^"]+)"/m) ?? [])[1];
  assert.ok(version, 'build-release.ps1 里应能读到版本号（现读 package.json 或写死 $version）');
  await writeFile(join(root, `OliviaSoul-${version}-Setup.exe`), 'fixture');
  const result = powershell(`& ${quote(script)} -OutputDirectory ${quote(root)} -ChecksumOnly -InstallerOnly`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sums = await readFile(join(root, 'SHA256SUMS.txt'), 'utf8');
  assert.match(sums, /Setup\.exe/); assert.doesNotMatch(sums, /Portable/);
});
async function put(root, name, content = '') {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), content);
}

// Exercises the production copy block against disk, never executes the build.
// Removing a required desktop module from the whitelist breaks import closure.
test('desktop payload closes relative JS imports and excludes adjacent personal/developer files', async () => {
  const root = await fixture();
  const source = join(root, 'source');
  const stage = join(root, 'stage');
  await put(source, 'desktop/node-host.js', 'import "./controller.js"; import "./workspace-template.js";');
  await put(source, 'desktop/controller.js', 'import "./client-backups.js"; import "./client-execution.js"; import "./client-patch-registry.js";');
  await put(source, 'desktop/uninstall-restore.js', 'import "./client-backups.js"; import "./client-patch-registry.js";');
  for (const name of ['workspace-template.js', 'client-backups.js', 'client-execution.js', 'client-patch-registry.js', 'startup-task.ps1']) await put(source, `desktop/${name}`);
  // ⚠️ fixture 必须**与 build-release.ps1 的 $desktopModules 清单同源**：测试过去只放了
  // 清单里早期的 7 项，而清单后来又长了 elevation-command.js / feapp-revisions.js ⇒
  // Copy-Item 找不到源文件直接抛 PathNotFound（这也是「测试 fixture 跟不上清单」的活例）。
  // 修法：fixture 只放「清单里 + 测试要断言的那几个哨兵」，清单里其余项**不建源文件**，
  // 改成让脚本块只复制 fixture 里真实存在的那部分 —— 即先把清单过滤成 fixture 子集。
  // 具体做法：fixture 建全清单（与 live 目录同名文件一起建），哨兵文件单独建。
  for (const name of ['elevation-command.js', 'feapp-revisions.js']) await put(source, `desktop/${name}`, `// fixture for ${name}`);
  for (const name of ['.env', 'personal.sqlite', 'private.log', 'UserData/letter.txt', 'main.js']) await put(source, `desktop/${name}`, 'PRIVATE SENTINEL');
  // ⚠️ 与 midi 同一处坑：`$desktopModules` 是脚本级变量（:423 定义、:437 的 foreach 消费），
  // 只 Create foreach 块 ⇒ 变量为空 ⇒ 什么都不复制（stage/app/desktop 目录根本不存在）。
  // 修法：按 AST 行号从源文件切「定义 + 消费」整段，并先 Ensure-Directory 建出目标目录。
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }
    $project=${quote(source)}; $stage=${quote(stage)};
    $srcLines=[IO.File]::ReadAllText(${quote(script)},[Text.Encoding]::UTF8) -split [char]10;
    $dStart=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$desktopModules'},$true);
    if(-not $dStart){Write-Output 'DESKTOP_MODULE_LIST_MISSING'; exit 2};
    $dForeach=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Body.Extent.Text.Contains('app\\desktop')},$true);
    if(-not $dForeach){Write-Output 'DESKTOP_COPY_BLOCK_MISSING'; exit 2};
    if($dForeach.Extent.StartLineNumber -le $dStart.Extent.EndLineNumber){Write-Output 'DESKTOP_BLOCKS_OUT_OF_ORDER'; exit 2};
    Ensure-Directory (Join-Path $stage 'app/desktop');
    $dBlock=($srcLines[($dStart.Extent.StartLineNumber-1)..($dForeach.Extent.EndLineNumber-1)] -join [char]10);
    & ([scriptblock]::Create($dBlock));`);
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(join(stage, 'app/desktop'));
  for (const name of files.filter(name => name.endsWith('.js'))) {
    const text = await readFile(join(stage, 'app/desktop', name), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+\.js)["']/g)) {
      assert.ok(files.includes(match[1].slice(2)), `${name} has unresolved runtime import ${match[1]}`);
    }
  }
  assert.deepEqual(files.sort(), [
    'client-backups.js', 'client-execution.js', 'client-patch-registry.js', 'controller.js',
    'elevation-command.js', 'feapp-revisions.js',
    'node-host.js', 'startup-task.ps1', 'uninstall-restore.js', 'workspace-template.js',
  ].sort());
});

// Removing the guard must fail without sacrificing an existing output sentinel.
test('output guard refuses nonempty, filesystem root and project paths without mutation', async () => {
  const root = await fixture();
  const output = join(root, 'existing');
  await put(output, 'sentinel.txt', 'DO NOT DELETE');
  const helper = join(project, 'packaging/package-safety.ps1');
  const result = powershell(`$ErrorActionPreference='Stop'; if(-not(Test-Path -LiteralPath ${quote(helper)})){Write-Output 'GUARD_MISSING'; exit 2}; . ${quote(helper)};
    foreach($path in @(${quote(output)},${quote(project)},[IO.Path]::GetPathRoot(${quote(root)}))) {
      $rejected=$false; try { Assert-EmptyPackageDirectory -Path $path -ProtectedRoots @(${quote(project)}) } catch { $rejected=$true }
      if(-not $rejected){throw "Unsafe directory accepted: $path"}
    }
    Assert-EmptyPackageDirectory -Path ${quote(join(root, 'fresh'))} -ProtectedRoots @(${quote(project)});`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(output, 'sentinel.txt'), 'utf8'), 'DO NOT DELETE');
  assert.deepEqual(await readdir(root), ['existing']);
});

test('review guides ship verbatim both inside payload and beside archives', async () => {
  const root = await fixture();
  const guides = ['使用说明.txt', '发布说明.md', '反馈指南.md', 'API配置使用说明.md'];
  for (const name of guides) await put(root, `docs/${name}`, `PUBLIC ${name}\n`);
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-ReviewGuides')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'GUIDE_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-ReviewGuides -Source ${quote(join(root, 'docs'))} -Stage ${quote(join(root, 'stage'))} -Output ${quote(join(root, 'output'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of guides) for (const directory of ['stage', 'output']) {
    assert.equal(await readFile(join(root, directory, name), 'utf8'), `PUBLIC ${name}\n`);
  }
});

// Catches missing or wrongly versioned SDK notices in the binary distribution.
test('WebView2 SDK notices follow the declared package version and ship verbatim', async () => {
  const root = await fixture();
  const projectFile = join(root, 'OliviaSoul.csproj');
  await put(root, 'OliviaSoul.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.Web.WebView2" Version="9.8.7" /></ItemGroup></Project>');
  for (const name of ['LICENSE.txt', 'NOTICE.txt']) {
    await put(root, `nuget/microsoft.web.webview2/9.8.7/${name}`, `SDK ${name}\n`);
    await put(root, `nuget/microsoft.web.webview2/1.0.0/${name}`, 'WRONG VERSION');
  }
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-WebViewNotices')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'SDK_NOTICE_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-WebViewNotices -ProjectFile ${quote(projectFile)} -NugetRoot ${quote(join(root, 'nuget'))} -Stage ${quote(join(root, 'stage'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['LICENSE.txt', 'NOTICE.txt']) {
    assert.equal(await readFile(join(root, 'stage/licenses/WebView2', name), 'utf8'), `SDK ${name}\n`);
  }
});

test('Node ZIP staging copies only the selected runtime and license entries', async () => {
  const root = await fixture();
  await put(root, 'input/node-example/node.exe', 'NODE RUNTIME');
  await put(root, 'input/node-example/LICENSE', 'NODE LICENSE');
  await put(root, 'input/node-example/node_modules/npm/private-fixture.txt', 'DO NOT STAGE');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-ZipEntry')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'SELECTIVE_ZIP_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    [IO.Compression.ZipFile]::CreateFromDirectory(${quote(join(root, 'input'))},${quote(join(root, 'node.zip'))});
    Copy-ZipEntry -Archive ${quote(join(root, 'node.zip'))} -EntryName 'node-example/node.exe' -Destination ${quote(join(root, 'stage/node.exe'))};
    Copy-ZipEntry -Archive ${quote(join(root, 'node.zip'))} -EntryName 'node-example/LICENSE' -Destination ${quote(join(root, 'stage/NODE-LICENSE.txt'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['NODE-LICENSE.txt', 'node.exe']);
  assert.equal(await readFile(join(root, 'stage/node.exe'), 'utf8'), 'NODE RUNTIME');
  assert.equal(await readFile(join(root, 'stage/NODE-LICENSE.txt'), 'utf8'), 'NODE LICENSE');
});

test('optional Steam helper payload includes runtime companions but no tests or account settings', async () => {
  const root = await fixture();
  for (const name of ['README.md', 'configure.ps1', 'steam-launch-options.mjs', 'test/private.js', 'localconfig.vdf']) await put(root, `steam/${name}`, name);
  await put(root, 'compiled/OliviaSteamWaiter.exe', 'compiled fixture');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-SteamLauncherPayload')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'STEAM_PAYLOAD_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-SteamLauncherPayload -Source ${quote(join(root, 'steam'))} -Compiled ${quote(join(root, 'compiled'))} -Destination ${quote(join(root, 'stage'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['OliviaSteamWaiter.exe', 'README.md', 'configure.ps1', 'steam-launch-options.mjs'].sort());
});

test('media payload retains runtime import closure and excludes generation-only and personal files', async () => {
  const root = await fixture();
  const source = join(root, 'source');
  const stage = join(root, 'stage');
  for (const name of await readdir(join(project, 'midi'))) await put(source, `midi/${name}`, await readFile(join(project, 'midi', name)));
  await put(source, 'midi/private.sqlite', 'PRIVATE');
  await put(stage, 'app/storage-paths.js');
  // ⚠️ `$midiModules` 是**脚本级变量**（:405 定义、:415 的 foreach 里消费）。测试过去只把
  // foreach 块单独 scriptblock::Create 出来执行 ⇒ `$midiModules` 为空 ⇒ 一个文件都不复制
  // （stage/app/midi 是空目录）⇒ `duration-repair.js` 断言红。
  // 修法：把**定义块 + 消费块**一起执行（它们是同一段连续代码 :405-417），
  // 这样既测了「清单内容」又测了「复制行为」，且不需要在测试里抄一份清单。
  // ⚠️ 模板串里的 `$` 必须转义成 `\$`（这是 JS 模板字符串，不转义会被当 JS 变量插值）。
  // ⚠️ `$midiModules` 是**脚本级变量**（:405 定义、:415 的 foreach 里消费）。测试过去只把
  // foreach 块单独 scriptblock::Create 出来执行 ⇒ `$midiModules` 为空 ⇒ 一个文件都不复制
  // （stage/app/midi 是空目录）⇒ `duration-repair.js` 断言红。
  // 修法：把**定义块 + 消费块**一起执行（它们是同一段连续代码 :405-417），
  // 这样既测了「清单内容」又测了「复制行为」，且不需要在测试里抄一份清单。
  // ⚠️ 不能用 `$midiStart.Parent.Extent.Text` 取整段 —— `$midiModules = @(...)` 的 Parent 是
  // **StatementBlockAst**，Extent 会一路盖到文件末尾（:405 到 :616），里面含 `$guideHash`、
  // `Step-Mark` 等只依赖真实构建上下文的代码 ⇒ 单独 Create 必然语法/运行错。
  // 正解：只取**定义那一句**（含 @(...) 多行字面量）**加消费的 foreach 块**，用 AST 的
  // StartLineNumber/EndLineNumber 从源文件按行切，不做任何字符串推断。
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }
    $project=${quote(source)}; $stage=${quote(stage)};
    $srcLines=[IO.File]::ReadAllText(${quote(script)},[Text.Encoding]::UTF8) -split [char]10;
    $midiStart=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$midiModules'},$true);
    if(-not $midiStart){Write-Output 'MIDI_MODULE_LIST_MISSING'; exit 2};
    $midiForeach=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Body.Extent.Text.Contains('app\\midi')},$true);
    if(-not $midiForeach){Write-Output 'MIDI_COPY_BLOCK_MISSING'; exit 2};
    if($midiForeach.Extent.StartLineNumber -le $midiStart.Extent.EndLineNumber){Write-Output 'MIDI_BLOCKS_OUT_OF_ORDER'; exit 2};
    $midiBlock=($srcLines[($midiStart.Extent.StartLineNumber-1)..($midiForeach.Extent.EndLineNumber-1)] -join [char]10);
    Ensure-Directory (Join-Path $stage 'app/midi');
    & ([scriptblock]::Create($midiBlock));`);
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(join(stage, 'app/midi'));
  assert.ok(!files.some(name => ['render-pipeline.js', 'render-queue.js', 'timeline.js', 'private.sqlite'].includes(name)), 'generation-only or personal payload leaked');
  assert.ok(files.includes('duration-repair.js'));
  const appSource = await readFile(join(project, 'server.js'), 'utf8');
  for (const match of appSource.matchAll(/from\s*["']\.\/midi\/([^"']+)["']/g)) assert.ok(files.includes(match[1]), `missing server dependency ${match[1]}`);
  for (const name of files) {
    for (const match of (await readFile(join(stage, 'app/midi', name), 'utf8')).matchAll(/from\s*["'](\.[^"']+\.js)["']/g)) {
      await readFile(resolve(stage, 'app/midi', match[1]));
    }
  }
});
