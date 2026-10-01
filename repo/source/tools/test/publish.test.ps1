# publish.test.ps1 —— repo\source\tools\publish.ps1（一键发布）的自带测试
#
# 运行（本机执行策略 Restricted，必须走 -File）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File repo\source\tools\test\publish.test.ps1
#
# 设计（为什么这么测）：
#   * 全部在 %TEMP%\olivia-publish-test-<随机> 的**夹具树**里跑，夹具刻意做成与真实仓库同构：
#       kit\repo\source\tools\publish.ps1                        ← 真实脚本的逐字节拷贝
#       kit\repo\source\local-service\packaging\build-release.ps1 ← 版本号单一来源（假）
#       kit\repo\source\local-service\packaging\发布说明.md        ← Release 正文内容源（假）
#       kit\.test-twins\1.0-final-check.ps1                      ← 假门禁（$outDir 指向夹具产物目录）
#       kit\repo\build-1.0.5\                                    ← 假产物（Setup.exe / Portable.zip）
#   * 「不写真实仓库」不靠嘴说：入口测试用 -Execute 跑夹具拷贝，dry-run 测试对整棵夹具树做前后快照对比。
#   * gh 用替身（真子进程，所以 $LASTEXITCODE 语义与真 gh 一致）：
#       kit\.test-twins\fake-gh.cmd → fake-gh.ps1
#         把每次调用的 argv 原样追加到 <root>\gh-state\calls.jsonl
#         并按 OLIVIA_TEST_GH_* 环境变量返回受控输出/退出码
#         （可模拟：未登录 / 直连被重置 / Tag 已存在 / create 失败 / upload 失败 / 附件缺失 / prerelease 勾错）
#   * 内联断言全部用 exit code + 异常 Data['OliviaCode'] 判定（不靠解析中文输出），
#     这样「失败即停」这类契约在中文编码变化时也不会假红。
#   * 失败即停：任何断言抛错 → 打印栈与夹具路径（夹具保留，便于现场排查），退出码 1。
#
# 覆盖范围：纯函数（版本号/门禁目录/发布说明抽节/哈希表/校验文件/网络诊断）、
#           11 步计划、dry-run 零写入、-Execute 全流程、每一步失败即停、入口退出码。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RealPublish = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\publish.ps1')).Path
$RealKit = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..')).Path

# ---------------------------------------------------------------------------
# 断言与工具
# ---------------------------------------------------------------------------
$script:pass = 0
$script:lastCodeMsg = ''
$script:lastCodeHints = @()

function Pass([string]$Message) {
    $script:pass++
    Write-Host ('  ok - ' + $Message)
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw ($Message + '；期望=[' + $Expected + '] 实际=[' + $Actual + ']') }
    Pass $Message
}

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw ($Message + '；条件为假') }
    Pass $Message
}

function Assert-Match([string]$Pattern, [string]$Text, [string]$Message) {
    if ($Text -notmatch $Pattern) { throw ($Message + '；实际=[' + $Text + ']') }
    Pass $Message
}

function Assert-NotMatch([string]$Pattern, [string]$Text, [string]$Message) {
    if ($Text -match $Pattern) { throw ($Message + '；实际=[' + $Text + ']') }
    Pass $Message
}

function Get-ThrownCode($ErrorRecord) {
    if ($ErrorRecord -and $ErrorRecord.Exception.Data -and $ErrorRecord.Exception.Data.Contains('OliviaCode')) {
        return [int]$ErrorRecord.Exception.Data['OliviaCode']
    }
    return $null
}

function Remember-Thrown($ErrorRecord) {
    $script:lastCodeMsg = [string]$ErrorRecord.Exception.Message
    $script:lastCodeHints = @()
    if ($ErrorRecord.Exception.Data -and $ErrorRecord.Exception.Data.Contains('OliviaHints')) {
        $script:lastCodeHints = @($ErrorRecord.Exception.Data['OliviaHints'])
    }
}

function Assert-Code([int]$Expected, [scriptblock]$Body, [string]$Message) {
    $code = $null
    try { & $Body 6>$null | Out-Null } catch { $code = Get-ThrownCode $_; Remember-Thrown $_ }
    if ($null -eq $code) {
        throw ($Message + '；期望抛出带 OliviaCode=' + $Expected + ' 的错误，实际没抛或没带码；消息=[' + $script:lastCodeMsg + ']')
    }
    if ($code -ne $Expected) {
        throw ($Message + '；期望退出码 ' + $Expected + '，实际 ' + $code + '；消息=[' + $script:lastCodeMsg + ']')
    }
    Pass $Message
}

function Assert-Execute([object]$Context, [int]$Expected, [string]$Message) {
    $code = $null
    try { Invoke-OliviaPublishExecute -Context $Context 6>$null | Out-Null } catch { $code = Get-ThrownCode $_; Remember-Thrown $_ }
    if ($null -eq $code) { $code = 0 }
    if ($code -ne $Expected) {
        throw ($Message + '；期望退出码 ' + $Expected + '，实际 ' + $code + '；消息=[' + $script:lastCodeMsg + ']')
    }
    Pass $Message
}

function Write-FixtureFile([string]$Path, [string]$Text, [bool]$Bom = $true) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($Bom)))
}

function Has-Bom([string]$Path) {
    $b = [IO.File]::ReadAllBytes($Path)
    return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------
$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('olivia-publish-test-' + $stamp)
$kit = Join-Path $fixtureRoot 'kit'
$tools = Join-Path $kit 'repo\source\tools'
$pkg = Join-Path $kit 'repo\source\local-service\packaging'
$twins = Join-Path $kit '.test-twins'
$artDir = Join-Path $kit 'repo\build-1.0.5'
$ghState = Join-Path $fixtureRoot 'gh-state'

$fx = [ordered]@{
    Root        = $fixtureRoot
    Kit         = $kit
    Tools       = $tools
    Pkg         = $pkg
    Twins       = $twins
    ArtDir      = $artDir
    GhState     = $ghState
    Publish     = (Join-Path $tools 'publish.ps1')
    BuildScript = (Join-Path $pkg 'build-release.ps1')
    Notes       = (Join-Path $pkg '发布说明.md')
    NotesNoVer  = (Join-Path $pkg '旧发布说明.md')
    NotesEmpty  = (Join-Path $pkg '空节发布说明.md')
    Gate        = (Join-Path $twins '1.0-final-check.ps1')
    GateVar     = (Join-Path $twins 'bad-var-final-check.ps1')
    GateNoOut   = (Join-Path $twins 'no-out-final-check.ps1')
    FakeGh      = (Join-Path $twins 'fake-gh.cmd')
    FakeGhPs1   = (Join-Path $twins 'fake-gh.ps1')
    Setup       = (Join-Path $artDir 'OliviaSoul-2008.2.7-linli9-1.0.5-Setup.exe')
    Zip         = (Join-Path $artDir 'OliviaSoul-2008.2.7-linli9-1.0.5-Portable.zip')
    Sums        = (Join-Path $artDir 'SHA256SUMS.txt')
    TitleFile   = (Join-Path $twins '_release-title-1.0.5.txt')
    NotesFile   = (Join-Path $twins '_release-notes-1.0.5.md')
    GateLog     = (Join-Path $twins 'publish-1.0.5-gate.log')
}
$Version = '2008.2.7-linli9-1.0.5'
$Short = '1.0.5'
$Tag = 'v2008.2.7-linli9-1.0.5'
$Repo = 'guvgr2/OliviaSoul-community'

function New-PublishFixture {
    foreach ($d in @($fx.Tools, $fx.Pkg, $fx.Twins, $fx.ArtDir, $fx.GhState)) {
        $null = New-Item -ItemType Directory -Path $d -Force
    }
    Copy-Item -LiteralPath $RealPublish -Destination $fx.Publish -Force

    Write-FixtureFile $fx.BuildScript @"
# 夹具：版本号单一来源（形状与真实 packaging\build-release.ps1 一致）
`$baseVersion = "2008.2.7"
`$version = "2008.2.7-linli9-1.0.5"
"@

    Write-FixtureFile $fx.Notes @"
# 夹具发布说明

## 2008.2.7-linli9-1.0.4 · 旧版本一节（夹具）
> 这一节不该出现在 1.0.5 的正文里。

## 2008.2.7-linli9-1.0.5 · 双通道更新 + 回退补丁入口（夹具）
**新增**：夹具内容源。

- 条目 A

## 2008.2.7-linli9-1.0.3 · 更旧的一节（夹具）
> 也不该出现在正文里。
"@

    Write-FixtureFile $fx.NotesNoVer @"
# 夹具发布说明（没有 1.0.5 节）

## 2008.2.7-linli9-1.0.4 · 只有旧版本
> 旧内容。
"@

    Write-FixtureFile $fx.NotesEmpty @"
# 夹具发布说明（1.0.5 节是空的）

## 2008.2.7-linli9-1.0.5 · 标题在但正文空

## 2008.2.7-linli9-1.0.4 · 旧一节
> 旧内容。
"@

    # 假门禁：$kit 行用单引号、$outDir 行用双引号 —— 与真实门禁脚本同形状（publish.ps1 就是这么解析的）
    $gateText = @'
# 夹具门禁（打包冒烟替身）：只为了测「门禁目录解析」与「失败即停」
$kit = 'FIXTURE_KIT'
$outDir = "$kit\repo\build-1.0.5"
Write-Host "fake-gate: outDir=$outDir"
if ($env:OLIVIA_TEST_GATE_FAIL -eq '1') { Write-Host 'fake-gate: 模拟门禁失败'; exit 1 }
Write-Host 'fake-gate: 模拟门禁通过'
exit 0
'@
    Write-FixtureFile $fx.Gate ($gateText.Replace('FIXTURE_KIT', $kit))

    Write-FixtureFile $fx.GateVar (@'
# 夹具门禁：$outDir 引用了 publish.ps1 不认识的变量
$kit = 'FIXTURE_KIT'
$outDir = "$unknown\repo\build-1.0.5"
exit 0
'@.Replace('FIXTURE_KIT', $kit))

    Write-FixtureFile $fx.GateNoOut @'
# 夹具门禁：根本没有 $outDir 行
$kit = 'FIXTURE_KIT'
exit 0
'@

    # gh 替身：真子进程（.cmd 外壳 → fake-gh.ps1），记录 argv 并按环境变量给受控结果
    $fakeGhPs1 = @'
# fake-gh.ps1 —— publish.test.ps1 的 gh 替身：只记录 argv + 按 OLIVIA_TEST_GH_* 返回受控输出/退出码
$stateDir = $env:OLIVIA_TEST_GH_STATE
if (-not $stateDir) { Write-Output 'fake-gh: 缺少 OLIVIA_TEST_GH_STATE'; exit 9 }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$logPath = Join-Path $stateDir 'calls.jsonl'
$flagPath = Join-Path $stateDir 'created.flag'

$n = 0
if (Test-Path -LiteralPath $logPath) {
    $n = @(Get-Content -LiteralPath $logPath -Encoding UTF8 | Where-Object { $_ }).Count
}
[IO.File]::AppendAllText($logPath, ([pscustomobject]@{ n = ($n + 1); args = @($args) } | ConvertTo-Json -Compress -Depth 6) + "`n", $utf8)

function Get-TestEnv([string]$Name, [string]$Default = '') {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $v -or $v -eq '') { return $Default }
    return $v
}
function Get-TestEnvInt([string]$Name, [int]$Default = 0) {
    return [int](Get-TestEnv $Name ([string]$Default))
}

$first = ''
$second = ''
if ($args.Count -ge 1) { $first = [string]$args[0] }
if ($args.Count -ge 2) { $second = [string]$args[1] }

if ($first -eq 'auth') {
    Write-Output (Get-TestEnv 'OLIVIA_TEST_GH_AUTH_OUT' 'Logged in to github.com account tester')
    exit (Get-TestEnvInt 'OLIVIA_TEST_GH_AUTH_CODE' 0)
}
if ($first -eq 'api') {
    if (Test-Path -LiteralPath $flagPath) {
        # 建 Release 之后的核对调用：返回 JSON（附件/prerelease 可按环境变量构造）
        $mode = Get-TestEnv 'OLIVIA_TEST_GH_ASSETS_MODE' 'complete'
        $pre = Get-TestEnv 'OLIVIA_TEST_GH_JSON_PRERELEASE' 'false'
        $tag = Get-TestEnv 'OLIVIA_TEST_GH_TAG' ''
        $names = @((Get-TestEnv 'OLIVIA_TEST_GH_SETUP' ''), (Get-TestEnv 'OLIVIA_TEST_GH_ZIP' ''), (Get-TestEnv 'OLIVIA_TEST_GH_SUMS' ''))
        if ($mode -eq 'missing_asset') { $names = @($names[0], $names[1]) }
        $assets = (@($names | Where-Object { $_ } | ForEach-Object { '{"name":"' + $_ + '"}' }) -join ',')
        Write-Output ('{"tag_name":"' + $tag + '","prerelease":' + $pre + ',"assets":[' + $assets + ']}')
        exit 0
    }
    $mode = Get-TestEnv 'OLIVIA_TEST_GH_PROBE_MODE' 'missing'
    if ($mode -eq 'exists') {
        Write-Output ('{"tag_name":"' + (Get-TestEnv 'OLIVIA_TEST_GH_TAG' '') + '","prerelease":false}')
        exit 0
    }
    if ($mode -eq 'network') {
        Write-Output ('Get "https://api.github.com/' + $second + '": dial tcp 140.82.113.4:443: connect: connection reset by peer')
        exit 1
    }
    Write-Output ('HTTP 404: Not Found (https://api.github.com/' + $second + ')')
    exit 1
}
if ($first -eq 'release') {
    if ($second -eq 'create') {
        $code = Get-TestEnvInt 'OLIVIA_TEST_GH_CREATE_CODE' 0
        if ($code -eq 0) { [IO.File]::WriteAllText($flagPath, '1', $utf8) }
        Write-Output (Get-TestEnv 'OLIVIA_TEST_GH_CREATE_OUT' 'Created release')
        exit $code
    }
    if ($second -eq 'upload') {
        Write-Output (Get-TestEnv 'OLIVIA_TEST_GH_UPLOAD_OUT' 'Uploaded 3 assets')
        exit (Get-TestEnvInt 'OLIVIA_TEST_GH_UPLOAD_CODE' 0)
    }
    if ($second -eq 'edit') {
        Write-Output (Get-TestEnv 'OLIVIA_TEST_GH_EDIT_OUT' 'Edited release')
        exit (Get-TestEnvInt 'OLIVIA_TEST_GH_EDIT_CODE' 0)
    }
}
Write-Output ('fake-gh: 未预期的参数：' + ($args -join ' '))
exit 7
'@
    Write-FixtureFile $fx.FakeGhPs1 $fakeGhPs1

    # .cmd 外壳：纯 ASCII 且**不带 BOM**（cmd.exe 不认识 UTF-8 BOM）
    Write-FixtureFile $fx.FakeGh (@'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-gh.ps1" %*
exit /b %ERRORLEVEL%
'@) $false

    $env:OLIVIA_TEST_GH_STATE = $fx.GhState
    Reset-Fixture
    Reset-GhState
    Reset-GhEnv
    Set-GhDefaults
}

function Reset-Fixture {
    # 每个执行场景开始前：重建产物、清掉生成物与门禁日志
    [IO.File]::WriteAllText($fx.Setup, 'FAKE-SETUP-CONTENT-for-publish-test', (New-Object System.Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($fx.Zip, 'FAKE-PORTABLE-CONTENT-for-publish-test', (New-Object System.Text.UTF8Encoding($false)))
    foreach ($p in @($fx.Sums, $fx.TitleFile, $fx.NotesFile, $fx.GateLog)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
}

function Reset-GhState {
    if (Test-Path -LiteralPath $fx.GhState) { Remove-Item -LiteralPath $fx.GhState -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $fx.GhState -Force
}

function Reset-GhEnv {
    foreach ($n in @('AUTH_CODE', 'AUTH_OUT', 'PROBE_MODE', 'CREATE_CODE', 'CREATE_OUT', 'UPLOAD_CODE', 'UPLOAD_OUT',
            'EDIT_CODE', 'EDIT_OUT', 'JSON_PRERELEASE', 'ASSETS_MODE', 'TAG', 'SETUP', 'ZIP', 'SUMS')) {
        Remove-Item -Path ('Env:OLIVIA_TEST_GH_' + $n) -ErrorAction SilentlyContinue
    }
    Remove-Item -Path 'Env:OLIVIA_TEST_GATE_FAIL' -ErrorAction SilentlyContinue
}

function Set-GhEnv([hashtable]$Values) {
    foreach ($k in $Values.Keys) { Set-Item -Path ('Env:OLIVIA_TEST_GH_' + $k) -Value ([string]$Values[$k]) }
}

function Set-GhDefaults {
    Set-GhEnv @{
        TAG            = $Tag
        SETUP          = 'OliviaSoul-2008.2.7-linli9-1.0.5-Setup.exe'
        ZIP            = 'OliviaSoul-2008.2.7-linli9-1.0.5-Portable.zip'
        SUMS           = 'SHA256SUMS.txt'
        PROBE_MODE     = 'missing'
        JSON_PRERELEASE = 'false'
        ASSETS_MODE    = 'complete'
    }
}

function Get-GhCallObjects {
    # 每次调用一个对象（扁平列表：元素是调用记录本身，不是嵌套数组 —— 避免 PowerShell 输出时被拆平）
    $p = Join-Path $fx.GhState 'calls.jsonl'
    if (-not (Test-Path -LiteralPath $p)) { return @() }
    $lines = @(Get-Content -LiteralPath $p -Encoding UTF8 | Where-Object { $_.Trim() })
    $objs = @()
    foreach ($l in $lines) { $objs += ($l.Trim() | ConvertFrom-Json) }
    return $objs
}

function Get-GhLines {
    # 每个元素 = 一次调用的 argv 拼成一行（断言「调了什么、什么顺序」）
    return @(Get-GhCallObjects | ForEach-Object { (@($_.args)) -join ' ' })
}

function Get-GhArgs([int]$Index) {
    # 第 Index 次调用（0 起）的 argv 数组 —— argv 边界靠它证明：
    # 含空格与中文的 Release 标题必须是**一个** argv（JSON 里就是数组的一个元素）
    $objs = @(Get-GhCallObjects)
    if ($Index -ge $objs.Count) {
        throw ('gh 替身只记录了 ' + $objs.Count + ' 次调用，取不到第 ' + ($Index + 1) + ' 次')
    }
    return @($objs[$Index].args)
}

function New-FixtureContext([hashtable]$Extra = @{}) {
    $p = @{
        Execute            = $true
        Lenient            = $false
        ToolsDir           = $fx.Tools
        KitRoot            = $fx.Kit
        GateScript         = $fx.Gate
        GhRunner           = $fx.FakeGh
        ReleaseNotesSource = $fx.Notes
    }
    foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] }
    return (New-OliviaPublishContext @p 6>$null)
}

function Get-TreeSnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName | ForEach-Object {
            '{0}|{1}|{2}' -f $_.FullName.Substring($Root.Length), $_.Length, ([IO.File]::ReadAllBytes($_.FullName).Length)
        })
}

# ---------------------------------------------------------------------------
# A. 真实文件与被测脚本的静态断言
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'A. 真实 publish.ps1 的静态契约' -ForegroundColor Cyan
Assert-True (Has-Bom $RealPublish) 'publish.ps1 带 UTF-8 BOM（否则 PowerShell 5.1 按 CP936 解码 → 一堆假语法错误）'
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($RealPublish, [ref]$null, [ref]$parseErrors)
Assert-Equal 0 @($parseErrors).Count 'publish.ps1 语法解析 0 错误'

New-PublishFixture
Write-Host '  夹具：' $fx.Root -ForegroundColor DarkGray

# dot-source：主流程有 `if ($MyInvocation.InvocationName -ne '.')` 保护，不会真跑。
# 必须把测试自己的 -Version/-Tag/-Repo 原样传进去：publish.ps1 的 param 绑定在**本脚本作用域**，
# 不传就会把测试的 $Version/$Tag 覆盖成 param 默认值（''），后面所有断言都会拿空版本号。
. $RealPublish -Version $Version -Tag $Tag -Repo $Repo

$realBuild = Join-Path $RealKit 'repo\source\local-service\packaging\build-release.ps1'
$realVer = Get-OliviaPublishVersionFromBuildScript -BuildReleaseScript $realBuild
Assert-True ($realVer.Version.StartsWith($realVer.BaseVersion)) '真实 build-release.ps1 能读出 $version/$baseVersion（版本号单一来源）'
$realNotes = Join-Path $RealKit 'repo\source\local-service\packaging\发布说明.md'
$realSec = $null
$realSecErr = $null
try { $realSec = Get-OliviaPublishNotesSection -NotesSourcePath $realNotes -Version $realVer.Version } catch { $realSecErr = $_ }
if ($realSec) {
    Assert-True ($realSec.Body.Length -gt 0) '真实发布说明的当前版本节正文非空（Release 正文内容源可用）'
} else {
    Assert-Equal 2 (Get-ThrownCode $realSecErr) '真实发布说明缺本版一节时按 code 2 报错（升版本后必须补节再发布）'
}

# ---------------------------------------------------------------------------
# B. 纯函数
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'B. 纯函数' -ForegroundColor Cyan

Assert-Equal $Short (Get-OliviaPublishShortVersion -Version $Version) '短版本号 = -linli9- 之后一段'
Assert-Equal '2008.2.7' (Get-OliviaPublishShortVersion -Version '2008.2.7') '没有 -linli9- 时短号 = 原版本号'
$base = '2008.2.7'
foreach ($ok in @('2008.2.7', '2008.2.7-linli9-g28', '2008.2.7-linli9-1.0.5', '2008.2.7-linli9-1.0.5-beta.1')) {
    Assert-True ((Assert-OliviaPublishVersionFormat -Version $ok -BaseVersion $base)) ('版本号格式合法：' + $ok)
}
foreach ($bad in @('1.0.5', '2008.2.8-linli9-1.0.5', '2008.2.7-x', '2008.2.7-linli9-1.0.5.6.7')) {
    Assert-Code 2 { Assert-OliviaPublishVersionFormat -Version $bad -BaseVersion $base } ('版本号格式非法报 exit 2：' + $bad)
}
Assert-Match 'bump-version' $script:lastCodeHints[1] '非法版本号的提示指向 bump-version.ps1（提醒不要各处手改）'

$names = Get-OliviaPublishArtifactNames -Version $Version
Assert-Equal 'OliviaSoul-2008.2.7-linli9-1.0.5-Setup.exe' $names.Setup '产物名：Setup.exe = OliviaSoul-<完整版本>-Setup.exe'
Assert-Equal 'OliviaSoul-2008.2.7-linli9-1.0.5-Portable.zip' $names.Portable '产物名：Portable.zip'
Assert-Equal 'SHA256SUMS.txt' $names.Sums '产物名：SHA256SUMS.txt'

Assert-Equal 'plain' (Format-OliviaPublishArg 'plain') '命令打印：无空格参数不加引号'
Assert-Equal '"has space"' (Format-OliviaPublishArg 'has space') '命令打印：含空格参数加引号'
Assert-Equal '"say \"hi\""' (Format-OliviaPublishArg 'say "hi"') '命令打印：内部双引号转义'
Assert-Equal 'exe -a "b c"' (Format-OliviaPublishCommandLine 'exe' @('-a', 'b c')) '命令打印：整条命令行拼接正确'

$sec = Get-OliviaPublishNotesSection -NotesSourcePath $fx.Notes -Version $Version
Assert-Match '^## 2008\.2\.7-linli9-1\.0\.5 · 双通道更新' $sec.Heading '抽节：找到当前版本标题行'
Assert-Equal '双通道更新 + 回退补丁入口（夹具）' $sec.TitlePart '抽节：标题「·」之后的部分作为 Release 标题主体'
Assert-Match '夹具内容源' $sec.Body '抽节：正文包含本节内容'
Assert-NotMatch '1\.0\.3' $sec.Body '抽节：正文在下一个小节标题处结束（不吞下一节）'
Assert-NotMatch '1\.0\.4' $sec.Body '抽节：正文不包含更早的小节'
Assert-Code 2 { Get-OliviaPublishNotesSection -NotesSourcePath $fx.NotesNoVer -Version $Version } '抽节：发布说明没有当前版本节 → exit 2'
Assert-Match '缺少' $script:lastCodeMsg '抽节：缺节的消息写明「缺少」'
Assert-Code 2 { Get-OliviaPublishNotesSection -NotesSourcePath $fx.NotesEmpty -Version $Version } '抽节：当前版本节是空的 → exit 2（Release 正文不能为空）'

Assert-Equal ('1.0.5 ' + [char]0x00B7 + ' 双通道更新 + 回退补丁入口（夹具）') (Get-OliviaPublishReleaseTitle -NotesSourcePath $fx.Notes -Version $Version -ShortVersion $Short) 'Release 标题 = 短号 + 「·」 + 节标题后半段'
$body = Get-OliviaPublishReleaseBody -Version $Version -SectionBody $sec.Body
Assert-Match ('^## 本次更新 `' + [regex]::Escape($Version) + '`') $body '正文首行 = 「## 本次更新 `<版本>`」（与 1.0.4 既有格式一致）'
Assert-Match '夹具内容源' $body '正文包含发布说明小节内容'

$entries = @(
    [pscustomobject]@{ Name = 'A.exe'; Bytes = 11; Hash = ('AA' * 32) }
    [pscustomobject]@{ Name = 'B.zip'; Bytes = 22; Hash = ('BB' * 32) }
)
$sums = New-OliviaPublishSha256SumsText -Entries $entries
Assert-Equal ('AA' * 32 + '  A.exe' + [Environment]::NewLine + 'BB' * 32 + '  B.zip' + [Environment]::NewLine) $sums 'SHA256SUMS.txt 格式 = <大写哈希>  <文件名>（两个空格，行序 Setup→Portable）'
Assert-Equal $null (Test-OliviaPublishSha256SumsText -Text $sums -Entries $entries) 'SHA256SUMS.txt 核对：一致时返回 null'
Assert-Match '多出产物' (Test-OliviaPublishSha256SumsText -Text ($sums + ('CC' * 32) + '  C.7z' + [Environment]::NewLine) -Entries $entries) 'SHA256SUMS.txt 核对：多出条目会报出来'
Assert-Match '缺少产物' (Test-OliviaPublishSha256SumsText -Text ('AA' * 32 + '  A.exe' + [Environment]::NewLine) -Entries $entries) 'SHA256SUMS.txt 核对：少条目会报出来'
Assert-Match '不一致' (Test-OliviaPublishSha256SumsText -Text ($sums.Replace(('BB' * 32), ('CC' * 32))) -Entries $entries) 'SHA256SUMS.txt 核对：哈希不符会报出来'
Assert-Match '格式不认识' (Test-OliviaPublishSha256SumsText -Text ('not a sums line' + [Environment]::NewLine) -Entries $entries) 'SHA256SUMS.txt 核对：无法识别的行会报出来'

$hashSection = Get-OliviaPublishHashSection -Entries $entries
Assert-Match '### 📦 文件校验（SHA256）' $hashSection '哈希段带固定标题（发布步骤既有格式）'
Assert-Match '\| `A\.exe` \| 11 B \| `AA' $hashSection '哈希段表格含 文件/大小/SHA256'
Assert-Match 'Get-FileHash \.\\A\.exe -Algorithm SHA256' $hashSection '哈希段含让用户自己核对的 Get-FileHash 命令'
Assert-Match 'SHA256SUMS\.txt` 对拍' $hashSection '哈希段提示可下载 SHA256SUMS.txt 对拍'
$bodyWithHash = Set-OliviaPublishHashSection -Body '前言正文' -Section $hashSection
Assert-Match '前言正文' $bodyWithHash '写哈希段：保留原正文'
$twice = Set-OliviaPublishHashSection -Body $bodyWithHash -Section $hashSection
Assert-Equal 1 ([regex]::Matches($twice, [regex]::Escape('### 📦 文件校验（SHA256）')).Count) '写哈希段幂等：重复执行只有一段'
Assert-NotMatch '前言正文\s*前言正文' $twice '写哈希段幂等：不会重复追加原正文'

$tmpFile = Join-Path $fixtureRoot 'encoding-probe.txt'
$written = Write-OliviaPublishUtf8NoBomFile -Path $tmpFile -Text ('中文内容' + 'abc')
Assert-True (-not (Has-Bom $tmpFile)) '写发布文本文件：UTF-8 无 BOM（GitHub 不会显示乱码 BOM）'
Assert-Equal '中文内容abc' ([IO.File]::ReadAllText($tmpFile)) '写发布文本文件：中文往返正确'
Assert-Equal ([IO.File]::ReadAllBytes($tmpFile).Length) $written '写发布文本文件：返回字节数'

Assert-Match '7890' (Get-OliviaPublishNetworkDiagnosis -Text 'Get "https://api.github.com/x": dial tcp 1.2.3.4:443: connect: connection reset by peer' -ProxyUrl 'http://127.0.0.1:7890') '网络诊断：connection reset → 明确提示需要代理'
Assert-Match '7890' (Get-OliviaPublishNetworkDiagnosis -Text 'x509: certificate signed by unknown authority / schannel' -ProxyUrl 'http://127.0.0.1:7890') '网络诊断：schannel/TLS 类也归为网络失败'
Assert-Match '7890' (Get-OliviaPublishNetworkDiagnosis -Text 'dial tcp: i/o timeout' -ProxyUrl 'http://127.0.0.1:7890') '网络诊断：超时也归为网络失败'
Assert-Equal $null (Get-OliviaPublishNetworkDiagnosis -Text 'HTTP 422: Validation Failed' -ProxyUrl 'http://127.0.0.1:7890') '网络诊断：非网络错误不误报（422 不是网络问题）'
Assert-Equal $null (Get-OliviaPublishNetworkDiagnosis -Text '' -ProxyUrl 'http://127.0.0.1:7890') '网络诊断：空输出不报网络问题'

$gateOut = Get-OliviaPublishGateOutDir -GateScriptPath $fx.Gate -KitRoot $fx.Kit -ProjectRoot (Join-Path $fx.Kit 'repo\source\local-service')
Assert-Equal $artDir $gateOut.OutDir '门禁目录解析：$outDir 里的 $kit 被展开成 -KitRoot（保证「门禁写到哪、就从哪收」）'
Assert-Equal $kit $gateOut.KitLine '门禁目录解析：同时取出 $kit 行（供诊断展示）'
Assert-Code 2 { Get-OliviaPublishGateOutDir -GateScriptPath $fx.GateVar -KitRoot $fx.Kit -ProjectRoot (Join-Path $fx.Kit 'repo\source\local-service') } '门禁目录解析：引用未知变量 → exit 2（不猜）'
Assert-Code 2 { Get-OliviaPublishGateOutDir -GateScriptPath $fx.GateNoOut -KitRoot $fx.Kit -ProjectRoot (Join-Path $fx.Kit 'repo\source\local-service') } '门禁目录解析：没有 $outDir 行 → exit 2'
Assert-Code 3 { Get-OliviaPublishGateOutDir -GateScriptPath (Join-Path $fx.Twins '不存在.ps1') -KitRoot $fx.Kit -ProjectRoot (Join-Path $fx.Kit 'repo\source\local-service') } '门禁目录解析：门禁脚本不存在 → exit 3'

# ---------------------------------------------------------------------------
# C. 上下文与 11 步计划
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'C. 上下文与 11 步计划' -ForegroundColor Cyan

$ctx = New-FixtureContext
Assert-Equal $Version $ctx.Version '上下文：版本号取自夹具 build-release.ps1'
Assert-Equal $Short $ctx.Short '上下文：短号'
Assert-Equal $Tag $ctx.Tag '上下文：Tag 默认 = v<完整版本>'
Assert-Equal "https://github.com/$Repo/releases/tag/$Tag" $ctx.ReleaseUrl '上下文：Release 直达链接'
Assert-Equal 'repos/guvgr2/OliviaSoul-community/releases/tags/v2008.2.7-linli9-1.0.5' $ctx.ApiReleaseUrl '上下文：api 路径（核对与探测都用它）'
Assert-Equal $artDir $ctx.ArtifactDir '上下文：产物目录默认取门禁的 $outDir'
Assert-Equal $fx.Setup $ctx.SetupPath '上下文：Setup.exe 全路径'
Assert-Equal $fx.Zip $ctx.ZipPath '上下文：Portable.zip 全路径'
Assert-Equal $fx.Sums $ctx.SumsPath '上下文：SHA256SUMS.txt 全路径'
Assert-Equal $fx.TitleFile $ctx.TitleFile '上下文：标题文件路径（.test-twins\_release-title-<短号>.txt）'
Assert-Equal $fx.NotesFile $ctx.NotesFile '上下文：正文文件路径（.test-twins\_release-notes-<短号>.md）'
Assert-Equal $fx.GateLog $ctx.GateLog '上下文：门禁日志路径（失败时让人有日志可看）'
Assert-Equal 0 @($ctx.Blockers).Count '上下文：夹具状态下没有拦路问题'
Assert-Equal $false $ctx.NotesSectionMissing '上下文：正文内容源存在'
Assert-Equal ('1.0.5 ' + [char]0x00B7 + ' 双通道更新 + 回退补丁入口（夹具）') $ctx.Title '上下文：Release 标题来自发布说明当前节'
Assert-Match '## 本次更新' $ctx.Body '上下文：Release 正文已生成'

Assert-Code 2 { New-FixtureContext @{ Tag = 'v2008.2.7-linli9-1.0.4' } } '上下文：-Tag 与版本不一致 → exit 2（防止把新版本发到旧 Tag）'
Assert-Code 2 { New-FixtureContext @{ Version = '1.0.5' } } '上下文：-Version 格式非法 → exit 2'
Assert-Code 3 { New-OliviaPublishContext -ToolsDir $fx.Tools -KitRoot $fx.Kit -GateScript $fx.Gate -ReleaseNotesSource $fx.Notes -GhPath (Join-Path $fx.Root 'no-such-gh.exe') -Execute $true } '上下文：找不到 gh → exit 3（提示可用浏览器手工发）'
Assert-Match '浏览器' $script:lastCodeHints[1] '上下文：找不到 gh 的提示给出「浏览器手工建 Release」的退路'

Assert-Code 2 { New-OliviaPublishContext -ToolsDir $fx.Tools -KitRoot $fx.Kit -GateScript $fx.Gate -ReleaseNotesSource $fx.Notes -GhRunner $fx.FakeGh -ArtifactDir (Join-Path $fx.Kit 'repo\build-1.0.4') -Execute $true } '上下文：-ArtifactDir 与门禁 $outDir 不一致 → exit 2'

$lenient = New-OliviaPublishContext -ToolsDir $fx.Tools -KitRoot $fx.Kit -GateScript $fx.Gate -ReleaseNotesSource $fx.Notes -GhRunner $fx.FakeGh -Version '2008.2.7-linli9-1.0.6' -Lenient $true -Execute $false 6>$null
Assert-Equal 3 @($lenient.Blockers).Count 'dry-run（Lenient）：同时收集到三个拦路问题（目录不匹配 / 缺产物 / 缺发布说明节），而不是第一个就抛'
$blockMsgs = @($lenient.Blockers | ForEach-Object { $_.Message })
Assert-True (@($blockMsgs | Where-Object { $_ -match '覆盖' }).Count -eq 1) 'dry-run（Lenient）：报出门禁产物目录版本不匹配（会覆盖已发布产物）'
Assert-True (@($blockMsgs | Where-Object { $_ -match '缺少' }).Count -eq 1) 'dry-run（Lenient）：报出发布说明缺本版一节'
Assert-True (@($blockMsgs | Where-Object { $_ -match '缺产物' }).Count -eq 1) 'dry-run（Lenient）：产物不在位时明确报「缺产物」（不是只标 [缺失] 然后静默成功）'
Assert-Equal 2 ([int](@($lenient.Blockers)[0].Code)) 'dry-run（Lenient）：第一个拦路问题的退出码是 2（入口就按它退出）'
Assert-True (@($lenient.Blockers | ForEach-Object { $_.Code }) -notcontains 0) 'dry-run（Lenient）：每个拦路问题都带退出码'
Assert-Equal $true $lenient.NotesSectionMissing 'dry-run（Lenient）：正文源缺失被显式标记（界面要提示补节）'
Assert-Match '还没有本版一节' $lenient.Body 'dry-run（Lenient）：正文用明确的占位说明，而不是空信'
Assert-Code 2 { New-OliviaPublishContext -ToolsDir $fx.Tools -KitRoot $fx.Kit -GateScript $fx.Gate -ReleaseNotesSource $fx.Notes -GhRunner $fx.FakeGh -Version '2008.2.7-linli9-1.0.6' -Lenient $false -Execute $true } '非 dry-run（-Execute）：同样的拦路问题直接失败（不会带着空信去发布）'

$plan = Get-OliviaPublishPlan -Context $ctx
Assert-Equal 11 @($plan).Count '计划：11 个步骤'
Assert-Equal '1 2 3 4 5 6 7 8 9 10 11' (@($plan | ForEach-Object { $_.Id }) -join ' ') '计划：步骤编号 1..11 连续'
Assert-Equal '前置校验（只读）' $plan[0].Title '计划 [1] 是只读前置校验'
Assert-Match '\[1/11\]|前置校验' '前置校验（只读）' '计划 [1] 文案（sanity）'
Assert-Match ([regex]::Escape($fx.Gate)) $plan[1].Command '计划 [2] 用真门禁脚本路径（powershell -File）'
Assert-Match 'Get-FileHash' $plan[2].Command '计划 [3] 收集产物 SHA256'
Assert-Match ([regex]::Escape($fx.Sums)) $plan[3].Command '计划 [4] 核对 SHA256SUMS.txt'
Assert-Match ([regex]::Escape($fx.TitleFile)) $plan[4].Command '计划 [5] 生成标题文件'
Assert-Match ([regex]::Escape($fx.NotesFile)) $plan[5].Command '计划 [6] 生成正文文件'
Assert-Match 'auth status' $plan[6].Command '计划 [7] gh 预检含 auth status'
Assert-Match 'release create' $plan[7].Command '计划 [8] gh release create'
Assert-Match 'release upload' $plan[8].Command '计划 [9] gh release upload'
Assert-Match 'release edit' $plan[9].Command '计划 [10] gh release edit（把哈希表写回正文）'
Assert-Match 'ConvertFrom-Json' $plan[10].Command '计划 [11] 发布后核对用 ConvertFrom-Json（不用 --jq）'
Assert-NotMatch '--jq' ($plan | ForEach-Object { $_.Command }) '计划：所有步骤都不含 --jq（本机 pwsh 会拆参）'

$planPrerelease = Get-OliviaPublishPlan -Context (New-FixtureContext @{ Prerelease = $true })
Assert-Match '--prerelease' $planPrerelease[7].Command '计划：测试版时 create 带 --prerelease（只有 beta 通道用户能看到）'
Assert-Match '测试版' $planPrerelease[7].Title '计划：测试版的标题写明是测试版'
Assert-NotMatch '--prerelease' $plan[7].Command '计划：正式版不带 --prerelease（否则稳定版用户看不到）'
Assert-Match '正式版' $plan[7].Title '计划：默认是正式版'
$planSkip = Get-OliviaPublishPlan -Context (New-FixtureContext @{ SkipGate = $true })
Assert-Match '跳过' $planSkip[1].Title '计划：-SkipGate 时 [2] 明确说明跳过了门禁（不假装跑过）'

# ---------------------------------------------------------------------------
# D. -Execute 全流程（内联执行，用异常 Data['OliviaCode'] 判定）
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'D. -Execute 全流程与「失败即停」' -ForegroundColor Cyan

# D1 门禁失败 → 不打包不发布
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$env:OLIVIA_TEST_GATE_FAIL = '1'
$ctxD = New-FixtureContext
Assert-Execute $ctxD 1 '门禁失败：-Execute 报 exit 1（AGENTS.md 一：不通过就不要打包）'
Assert-Match '门禁' $script:lastCodeMsg '门禁失败：错误消息点明是门禁'
Assert-Equal 0 @(Get-GhCallObjects).Count '门禁失败：一次 gh 都没调（没有建 Release）'
Assert-Equal $false (Test-Path -LiteralPath $ctxD.TitleFile) '门禁失败：没写标题文件'
Assert-Equal $true (Test-Path -LiteralPath $ctxD.GateLog) '门禁失败：门禁输出已落盘成日志（供排查）'
Remove-Item -Path 'Env:OLIVIA_TEST_GATE_FAIL' -ErrorAction SilentlyContinue

# D2 缺产物 → 不发布
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Remove-Item -LiteralPath $fx.Zip -Force
$ctxD = New-FixtureContext
Assert-Execute $ctxD 2 '缺产物：-Execute 报 exit 2（不会发布没有产物的版本）'
Assert-Match '产物不存在' $script:lastCodeMsg '缺产物：错误消息写明哪个产物不存在'
Assert-Equal 0 @(Get-GhCallObjects).Count '缺产物：一次 gh 都没调'

# D3 既有 SHA256SUMS.txt 与实际不符 → 停（不覆盖别人的校验文件）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Write-FixtureFile $fx.Sums (('00' * 32) + '  ' + $ctx.SetupName + [Environment]::NewLine) $false
$ctxD = New-FixtureContext
Assert-Execute $ctxD 2 '既有 SHA256SUMS.txt 与实际产物不符：-Execute 报 exit 2'
Assert-Match '不一致' $script:lastCodeMsg 'SHA256SUMS.txt 不符：错误消息说明不一致'

# D4 gh 未登录
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ AUTH_CODE = '1'; AUTH_OUT = 'gh: To get started with GitHub CLI, please run: gh auth login' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 3 'gh 未登录：-Execute 报 exit 3（环境缺失）'
Assert-Match 'auth status|未登录' $script:lastCodeMsg 'gh 未登录：消息写明 auth status 失败'

# D5 gh auth 网络类失败 → exit 4 + 代理诊断
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ AUTH_CODE = '1'; AUTH_OUT = 'dial tcp 140.82.113.4:443: connect: connection reset by peer' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 4 'gh auth 网络失败：-Execute 报 exit 4（附网络诊断）'
Assert-Match '7890' ($script:lastCodeHints -join ' ') 'gh auth 网络失败：诊断里给出代理 127.0.0.1:7890'

# D6 Tag 已存在 → 停（AGENTS.md 三·1：已发布的号不能重发）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ PROBE_MODE = 'exists' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 2 'Tag 已存在：-Execute 报 exit 2（同号不能重发）'
Assert-Match '已经有 Release' $script:lastCodeMsg 'Tag 已存在：消息点明同号不能重发'
Assert-Equal 0 @(Get-GhLines | Where-Object { $_ -like 'release create*' }).Count 'Tag 已存在：没有调用 release create'
Assert-Match 'bump-version' ($script:lastCodeHints -join ' ') 'Tag 已存在：提示先升版本号（bump-version.ps1）'

# D7 探测 Tag 时网络失败 → exit 4
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ PROBE_MODE = 'network' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 4 '探测 Tag 时网络失败：-Execute 报 exit 4'
Assert-Match '7890' ($script:lastCodeHints -join ' ') '探测网络失败：诊断里给出代理建议'

# D8 create 失败 → 停在上传之前
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ CREATE_CODE = '1'; CREATE_OUT = 'HTTP 422: Validation Failed' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 1 'release create 失败：-Execute 报 exit 1'
Assert-Equal 0 @(Get-GhLines | Where-Object { $_ -like 'release upload*' }).Count 'create 失败：没有继续上传附件'
Assert-Equal 0 @(Get-GhLines | Where-Object { $_ -like 'release edit*' }).Count 'create 失败：没有继续改正文'

# D9 upload 失败 → 停在改正文之前
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ UPLOAD_CODE = '1'; UPLOAD_OUT = 'HTTP 502: Bad Gateway' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 1 'release upload 失败：-Execute 报 exit 1'
Assert-Equal 0 @(Get-GhLines | Where-Object { $_ -like 'release edit*' }).Count 'upload 失败：没有继续改正文'

# D10 --jq 守卫（本机 pwsh 会把带空格的 --jq 表达式拆参）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$ctxJq = New-FixtureContext
Assert-Code 2 { Invoke-OliviaPublishGhRaw -Context $ctxJq -Arguments @('api', 'repos/x/y/releases/tags/v1', '--jq', '.tag_name') } '内部守卫：命令里出现 --jq 直接 exit 2'
Assert-Equal 0 @(Get-GhCallObjects).Count '--jq 守卫：一次 gh 都没调（拦在调用之前）'

# D11 正式版全流程 happy path
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$ctxD = New-FixtureContext
$ret = $null
$err = ''
try { $ret = Invoke-OliviaPublishExecute -Context $ctxD 6>$null } catch { $err = $_.Exception.Message + ' (code=' + (Get-ThrownCode $_) + ')' }
Assert-Equal '' $err '全流程（正式版）：没有失败'
Assert-Equal 0 $ret '全流程（正式版）：返回 0'
$lines = Get-GhLines
Assert-Equal 6 @($lines).Count '全流程：gh 被调用 6 次（auth → 探测 → create → upload → edit → 核对）'
Assert-Equal 'auth status' $lines[0] '全流程：第 1 次 auth status（先确认登录）'
Assert-Equal ('api repos/guvgr2/OliviaSoul-community/releases/tags/' + $Tag) $lines[1] '全流程：第 2 次探测该 Tag（404 才继续）'
$create = (Get-GhArgs 2)
Assert-Equal 'release' $create[0] '全流程：第 3 次是 gh release …'
Assert-Equal 'create' $create[1] '全流程：… create'
Assert-Equal $Tag $create[2] '全流程：Tag 作为 create 的第 3 个 argv'
$titleIdx = [array]::IndexOf($create, '--title')
Assert-True ($titleIdx -ge 0) '全流程：create 带 --title'
Assert-Equal $ctxD.Title $create[$titleIdx + 1] '全流程：中文标题作为一个 argv 原样传递（不经控制台代码页）'
Assert-True ($create -contains '--notes-file') '全流程：正文走 --notes-file（不从管道灌中文）'
Assert-True (-not ($create -contains '--prerelease')) '全流程：正式版不带 --prerelease'
$upload = @(Get-GhArgs 3)
Assert-Equal 'upload' $upload[1] '全流程：第 4 次是 release upload'
Assert-True ($upload -contains $fx.Setup) '全流程：上传 Setup.exe（全路径）'
Assert-True ($upload -contains $fx.Zip) '全流程：上传 Portable.zip（全路径）'
Assert-True ($upload -contains $fx.Sums) '全流程：上传 SHA256SUMS.txt（全路径）'
Assert-Equal 'edit' (@(Get-GhArgs 4))[1] '全流程：第 5 次是 release edit（哈希表写回正文）'
Assert-Equal 'api' (@(Get-GhArgs 5))[0] '全流程：第 6 次是发布后核对'

Assert-Equal $false (Has-Bom $ctxD.TitleFile) '全流程：标题文件 UTF-8 无 BOM'
Assert-Equal ($ctxD.Title + [Environment]::NewLine) ([IO.File]::ReadAllText($ctxD.TitleFile)) '全流程：标题文件内容 = 标题 + 换行'
$titleBytes = [IO.File]::ReadAllBytes($ctxD.TitleFile)
Assert-Equal ([BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($ctxD.Title + [Environment]::NewLine))) ([BitConverter]::ToString($titleBytes)) '全流程：标题文件逐字节 = UTF-8(中文标题+换行)（若走 CP936 转写就不会相等）'
Assert-Equal $false (Has-Bom $ctxD.NotesFile) '全流程：正文文件 UTF-8 无 BOM'
$notesText = [IO.File]::ReadAllText($ctxD.NotesFile)
Assert-Match ('## 本次更新 `' + [regex]::Escape($Version) + '`') $notesText '全流程：正文首行是「## 本次更新 `<版本>`」'
Assert-Match '夹具内容源' $notesText '全流程：正文含发布说明本节内容'
Assert-Equal 1 ([regex]::Matches($notesText, [regex]::Escape('### 📦 文件校验（SHA256）')).Count) '全流程：正文里哈希段只有一段（幂等）'
foreach ($e in (Get-OliviaPublishArtifactHashes -Context $ctxD)) {
    Assert-Match ([regex]::Escape($e.Hash)) $notesText ('全流程：正文哈希表含 ' + $e.Name + ' 的实际 SHA256')
}
$sumsText = [IO.File]::ReadAllText($ctxD.SumsPath)
Assert-Equal $false (Has-Bom $ctxD.SumsPath) '全流程：生成的 SHA256SUMS.txt 不带 BOM'
Assert-Match ('^[0-9A-F]{64}  ' + [regex]::Escape($ctxD.SetupName)) $sumsText '全流程：SHA256SUMS.txt 第 1 行 = Setup 的大写哈希 + 两个空格 + 文件名'
Assert-Equal $null (Test-OliviaPublishSha256SumsText -Text $sumsText -Entries (Get-OliviaPublishArtifactHashes -Context $ctxD)) '全流程：SHA256SUMS.txt 与实际产物完全一致'
$sumsReal = (& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -Command "(Get-FileHash -LiteralPath '$($fx.Setup)' -Algorithm SHA256).Hash" | Out-String).Trim()
Assert-Equal $sumsReal.ToUpperInvariant() ((Get-OliviaPublishArtifactHashes -Context $ctxD)[0].Hash) '全流程：脚本算的 SHA256 与 Get-FileHash 结果一致（独立复核）'

# D12 测试版（-Prerelease）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ JSON_PRERELEASE = 'true' }
$ctxPre = New-FixtureContext @{ Prerelease = $true }
$err = ''
try { Invoke-OliviaPublishExecute -Context $ctxPre 6>$null | Out-Null } catch { $err = $_.Exception.Message + ' (code=' + (Get-ThrownCode $_) + ')' }
Assert-Equal '' $err '全流程（测试版）：没有失败'
$createPre = (Get-GhArgs 2)
Assert-True ($createPre -contains '--prerelease') '全流程（测试版）：create 带 --prerelease（不稳定功能只发测试版）'

# D13 核对发现 prerelease 勾错
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ JSON_PRERELEASE = 'true' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 1 '核对：正式版却被发成 prerelease → exit 1（否则稳定版用户看不到）'
Assert-Match 'prerelease' $script:lastCodeMsg '核对：消息点明 prerelease 不符'

# D14 核对发现附件缺失
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Set-GhEnv @{ ASSETS_MODE = 'missing_asset' }
$ctxD = New-FixtureContext
Assert-Execute $ctxD 1 '核对：Release 附件缺 SHA256SUMS.txt → exit 1'
Assert-Match '附件里缺' $script:lastCodeMsg '核对：消息点明缺哪个附件'

# ---------------------------------------------------------------------------
# E. 入口（真子进程跑脚本副本：退出码 + dry-run 零写入）
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'E. 入口（子进程）' -ForegroundColor Cyan

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Invoke-PublishChild([string[]]$ExtraArgs, [switch]$NoFakeGh) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fx.Publish,
        '-KitRoot', $fx.Kit, '-GateScript', $fx.Gate, '-ReleaseNotesSource', $fx.Notes)
    if (-not $NoFakeGh) { $a += @('-GhRunner', $fx.FakeGh) }
    $a += $ExtraArgs
    $text = & $psExe @a 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = [int]$LASTEXITCODE; Output = [string]$text }
}

# E1 dry-run：零写入（整棵夹具树前后快照对比）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$before = Get-TreeSnapshot $fx.Root
$r = Invoke-PublishChild @()
$after = Get-TreeSnapshot $fx.Root
Assert-Equal 0 $r.ExitCode '入口 dry-run（默认）：退出码 0'
Assert-Match '11/11' $r.Output '入口 dry-run：打印出完整 11 步计划'
Assert-Match 'DRY-RUN' $r.Output '入口 dry-run：明确标出 DRY-RUN（不会真的执行）'
Assert-Match '1\.0\.5' $r.Output '入口 dry-run：版本号来自 build-release.ps1'
Assert-Match '本模式只读' $r.Output '入口 dry-run：中文提示经子进程输出未乱码（不依赖控制台代码页）'
Assert-Equal $before.Count $after.Count '入口 dry-run：夹具文件数量不变（零写入）'
Assert-Equal ($before -join "`n") ($after -join "`n") '入口 dry-run：夹具每个文件逐字节不变（零副作用自证）'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口 dry-run：一次 gh 都没调'

# E2 dry-run 带拦路问题 → 退出码取第一个问题
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$r = Invoke-PublishChild @('-Version', '2008.2.7-linli9-1.0.6')
Assert-Equal 2 $r.ExitCode '入口 dry-run（版本与门禁目录不匹配）：退出码 2'
Assert-Match '1\.0\.6' $r.Output '入口 dry-run：报出本次版本号'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口 dry-run（有拦路问题）：仍然一次 gh 都没调'

# E2b dry-run 缺产物 → 必须明确报「缺产物」，而不是静默 exit 0（旧版只把产物标 [缺失] 却成功退出）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
Remove-Item -LiteralPath $fx.Zip -Force
$r = Invoke-PublishChild @()
Assert-Equal 2 $r.ExitCode '入口 dry-run（缺产物）：退出码 2 —— 缺产物不是成功'
Assert-Match '缺产物' $r.Output '入口 dry-run（缺产物）：输出里明确写出「缺产物」'
Assert-Match 'Portable\.zip' $r.Output '入口 dry-run（缺产物）：指出缺的是 Portable.zip（可操作：知道该补哪个产物）'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口 dry-run（缺产物）：仍然一次 gh 都没调'

# E2c -Execute 却没有产物可发（-SkipGate + 不存在的产物目录）→ 明确报错退出，不建空 Release
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$noDir = Join-Path $fx.Kit 'repo\build-1.0.5-missing'
$r = Invoke-PublishChild @('-Execute', '-SkipGate', '-ArtifactDir', $noDir)
Assert-Equal 2 $r.ExitCode '入口 -Execute（产物目录不存在）：退出码 2（缺必要产物就停）'
Assert-Match '产物不存在' $r.Output '入口 -Execute（产物目录不存在）：消息写明产物不存在'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口 -Execute（产物目录不存在）：一次 gh 都没调（不会建空 Release）'

# E2d gh 不存在 → 可操作提示（浏览器手工发），不是静默通过
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$r = Invoke-PublishChild @('-GhPath', (Join-Path $fx.Root 'no-such-gh.exe')) -NoFakeGh
Assert-Equal 3 $r.ExitCode '入口（gh 不存在）：退出码 3（环境缺失）'
Assert-Match '找不到 gh' $r.Output '入口（gh 不存在）：消息写明找不到 gh'
Assert-Match '浏览器' $r.Output '入口（gh 不存在）：给出「浏览器手工建 Release」的可操作退路'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口（gh 不存在）：一次 gh 都没调'

# E3 -Execute 与 -DryRun 互斥
$r = Invoke-PublishChild @('-Execute', '-DryRun')
Assert-Equal 2 $r.ExitCode '入口：-Execute 与 -DryRun 同时给 → 退出码 2（不猜用户意图）'

# E4 -SkipGate 全流程（门禁已单独跑过）
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$r = Invoke-PublishChild @('-Execute', '-SkipGate')
Assert-Equal 0 $r.ExitCode '入口 -Execute -SkipGate：退出码 0'
Assert-Equal 6 @(Get-GhLines).Count '入口 -Execute -SkipGate：走完 6 次 gh 调用'
Assert-Equal $false (Has-Bom $fx.TitleFile) '入口 -Execute：标题文件仍是无 BOM'

# E5 门禁失败 → 退出码 1，且没有发 Release
Reset-Fixture; Reset-GhState; Reset-GhEnv; Set-GhDefaults
$env:OLIVIA_TEST_GATE_FAIL = '1'
$r = Invoke-PublishChild @('-Execute')
Assert-Equal 1 $r.ExitCode '入口 -Execute（门禁失败）：退出码 1'
Assert-Equal 0 @(Get-GhCallObjects).Count '入口 -Execute（门禁失败）：一次 gh 都没调'
Assert-Equal $true (Test-Path -LiteralPath $fx.GateLog) '入口 -Execute（门禁失败）：门禁日志已落盘'
Remove-Item -Path 'Env:OLIVIA_TEST_GATE_FAIL' -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 收尾
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ('publish.test.ps1: ' + $script:pass + ' assertions passed') -ForegroundColor Green
Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
exit 0
