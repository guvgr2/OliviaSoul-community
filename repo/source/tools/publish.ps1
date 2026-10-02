# publish.ps1 —— 一键发布（默认 dry-run，零副作用）
#
# 目的：把 1.0.4 发布时**人工一步一步敲过的那套流程**固化成一条命令，避免每次发版
#       漏步骤（漏传产物、忘记勾 prerelease、同号重发、哈希与 Release 正文不一致）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File repo\source\tools\publish.ps1
#       → dry-run（默认）：打印将要执行的每一步命令与参数，**不写任何文件、不调 gh**
#   powershell -NoProfile -ExecutionPolicy Bypass -File repo\source\tools\publish.ps1 -Execute
#       → 真做：门禁 → 收集产物与 SHA256 → 生成标题/正文文件 → gh release create
#              → 上传 Setup.exe / Portable.zip / SHA256SUMS.txt → 把哈希表追加进正文
#              → 用 gh api 核对发布结果
#
# 每一步的来源（都有出处，不是凭空写的）：
#   [1] 前置校验 ......... 版本号唯一定义在 packaging\build-release.ps1 的 $version（单一来源）；
#                         产物目录取自门禁脚本自己的 $outDir（见 [1] 的说明）；
#                         「同一个号不能重发」= AGENTS.md 三·1。
#   [2] 门禁 ............ AGENTS.md 一（六阶段全面检查）+ 二（新增功能必须登记套件）；
#                         实际调用 .test-twins\1.0-final-check.ps1 —— 它内含「关键套件门禁 +
#                         打包 + 解压冒烟 + 产物哈希」，就是 1.0.4 发布时人工执行的那一条。
#   [3][4] 产物与哈希 .... 命名 OliviaSoul-<完整版本>-Setup.exe / -Portable.zip、
#                         SHA256SUMS.txt 两行「<大写SHA256>  <文件名>」= repo\build-1.0.4\ 里
#                         1.0.4 实际产物的格式。
#   [5][6] 标题/正文 ..... 结构照 .test-twins\_release-title-1.0.4.txt 与
#                         _release-notes-1.0.4.md（`## 本次更新 `<version>`` + 分类小节 +
#                         「### 📦 文件校验（SHA256）」表格 + Get-FileHash 核对示例）；
#                         内容源是 packaging\发布说明.md 的当前版本节（每版一节）。
#   [7]-[11] GitHub ..... tag 规则 `v<完整版本>` 照 .test-twins\1.0.4发布步骤.md；
#                         中文一律走文件（--notes-file / 标题文件，见下面「中文」一节）；
#                         不用 --jq（本机 pwsh 会把带空格的 --jq 表达式拆参报错），
#                         统一 (& gh api <url>) | ConvertFrom-Json = 任务书第 5 节要求。
#
# 中文为什么不走控制台管道：
#   本机是 Windows PowerShell 5.1，控制台代码页 CP936。中文只要经过「命令行管道/控制台」
#   就可能被按 CP936 解码而损坏。本脚本因此：正文写进文件后用 gh 的 --notes-file 读取；
#   标题也是先从文件读成字符串再作为 argv 传给 gh（argv 由 CreateProcess 以 UTF-16 传递，
#   不经代码页，唯一可行做法 —— gh 没有 --title-file 这种参数）；生成的发布文本文件一律
#   UTF-8 **无 BOM**（GitHub 与 1.0.4 的既有文件都是无 BOM）。
#
# 退出码：0 成功（含 dry-run）；1 某一步失败；2 前置校验失败；3 环境缺失；4 网络失败（附诊断）
#
# 环境注意（本仓库实测）：本机执行策略为 Restricted，必须用
#   powershell -NoProfile -ExecutionPolicy Bypass -File 调用；本文件必须带 UTF-8 BOM。

[CmdletBinding()]
param(
    # 默认不传 = dry-run（只打印）；要真做必须显式 -Execute
    [switch]$Execute,

    # 显式声明 dry-run（与 -Execute 互斥，默认就是它；写出来是为了自文档）
    [switch]$DryRun,

    # 目标版本（默认读 packaging\build-release.ps1 的 $version —— 版本号单一来源）
    [string]$Version = '',

    # Release 标签（默认 "v<版本>"；显式传入时必须与默认值一致）
    [string]$Tag = '',

    # GitHub 仓库
    [string]$Repo = 'guvgr2/OliviaSoul-community',

    # 仓库套件根目录（默认由本脚本位置推出：repo\source\tools → 上三级）
    [string]$KitRoot = '',

    # 产物目录（默认取门禁脚本自己的 $outDir，保证「门禁写到哪、我们就从哪收」）
    [string]$ArtifactDir = '',

    # 门禁（打包冒烟）脚本
    [string]$GateScript = '',

    # 跳过门禁：直接用产物目录里已有的产物（用于门禁已单独跑过、只重跑发布步骤）
    [switch]$SkipGate,

    # 发布说明（Release 正文的内容源，按版本节抽取）
    [string]$ReleaseNotesSource = '',

    # Release 标题文本文件（生成物，UTF-8 无 BOM）
    [string]$TitleFile = '',

    # Release 正文文件（生成物，UTF-8 无 BOM）
    [string]$NotesFile = '',

    # 测试版：加 gh 的 --prerelease。默认关 = 正式版（稳定版用户可见）。
    # 注意（packaging\发布说明.md:37）：stable 通道靠 prerelease 标记挡住测试版，
    # 所以「不稳定功能发测试版」必须带这个开关；正式版**绝不能**带。
    [switch]$Prerelease,

    # gh 可执行文件：留空则自动找（先 PATH、再环境变量 OLIVIA_GH_PATH），也可用 -GhPath 指定。
    # 这里**不能**写死作者本机的 gh 全路径：公开仓库的隐私门禁
    # （repo\source\local-service\test\repo-privacy.test.js）会拦下本机工具目录指纹，
    # 写死了连发布门禁都过不去（1.0.6 发布时踩过）。
    [string]$GhPath = '',

    # 仅供测试/调试：用一个替身程序接收与 gh 完全相同的参数序列（替代 $GhPath）
    [string]$GhRunner = '',

    # 网络失败时建议的代理
    [string]$ProxyUrl = 'http://127.0.0.1:7890'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 失败：把退出码与提示挂在异常的 Data 上（不用字符串前缀解析；dot-source 时不 exit）
# ---------------------------------------------------------------------------
function Stop-OliviaPublish {
    param(
        [Parameter(Mandatory)][int]$Code,
        [Parameter(Mandatory)][string]$Message,
        [string[]]$Hints = @()
    )
    $ex = New-Object System.Exception($Message)
    $ex.Data['OliviaCode'] = $Code
    $ex.Data['OliviaHints'] = $Hints
    throw $ex
}

# ---------------------------------------------------------------------------
# 纯函数（只读、无副作用；测试直接调这些）
# ---------------------------------------------------------------------------
function Get-OliviaPublishVersionFromBuildScript {
    param([Parameter(Mandatory)][string]$BuildReleaseScript)
    if (-not (Test-Path -LiteralPath $BuildReleaseScript)) {
        Stop-OliviaPublish -Code 3 -Message "找不到打包脚本（版本号单一来源）：$BuildReleaseScript"
    }
    # 用 [IO.File]::ReadAllText 读（UTf-8，可带 BOM）；不要经控制台管道，否则 CP936 会毁掉中文注释
    $text = [IO.File]::ReadAllText($BuildReleaseScript)
    $versionMatch = [regex]::Match($text, '(?m)^\s*\$version\s*=\s*"([^"]+)"')
    if (-not $versionMatch.Success) {
        Stop-OliviaPublish -Code 2 -Message "打包脚本里找不到 `$version = ""..."" 行：$BuildReleaseScript"
    }
    $baseMatch = [regex]::Match($text, '(?m)^\s*\$baseVersion\s*=\s*"([^"]+)"')
    if (-not $baseMatch.Success) {
        Stop-OliviaPublish -Code 2 -Message "打包脚本里找不到 `$baseVersion = ""..."" 行：$BuildReleaseScript"
    }
    [pscustomobject]@{
        Version     = $versionMatch.Groups[1].Value
        BaseVersion = $baseMatch.Groups[1].Value
        Path        = $BuildReleaseScript
    }
}

function Assert-OliviaPublishVersionFormat {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$BaseVersion
    )
    # 与 packaging\build-release.ps1:33 同一个形状：基版本 + 可选的 -linli9-(gNN | x[.y[.z]][-beta.N])
    $pattern = '^' + [regex]::Escape($BaseVersion) + '(?:-linli9-(?:g\d{2}|\d+(?:\.\d+){0,2}(?:-beta\.\d+)?))?$'
    if ($Version -notmatch $pattern) {
        Stop-OliviaPublish -Code 2 -Message "版本号格式不合法：$Version" -Hints @(
            "允许的三种：$BaseVersion、$BaseVersion-linli9-gNN、$BaseVersion-linli9-x.y（测试版可加 -beta.N）",
            '与 packaging\build-release.ps1:33 的正则一致；改版本号请用 repo\source\tools\bump-version.ps1。'
        )
    }
    $true
}

function Get-OliviaPublishShortVersion {
    param([Parameter(Mandatory)][string]$Version)
    $m = [regex]::Match($Version, '-linli9-(.+)$')
    if ($m.Success) { return $m.Groups[1].Value }
    return $Version
}

function Get-OliviaPublishArtifactNames {
    param([Parameter(Mandatory)][string]$Version)
    [pscustomobject]@{
        Setup   = "OliviaSoul-$Version-Setup.exe"
        Portable = "OliviaSoul-$Version-Portable.zip"
        Sums    = 'SHA256SUMS.txt'
    }
}

function Format-OliviaPublishArg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

function Format-OliviaPublishCommandLine {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )
    $parts = @((Format-OliviaPublishArg $Exe))
    foreach ($a in @($Arguments)) { $parts += (Format-OliviaPublishArg $a) }
    return ($parts -join ' ')
}

function Get-OliviaPublishNotesSection {
    param(
        [Parameter(Mandatory)][string]$NotesSourcePath,
        [Parameter(Mandatory)][string]$Version
    )
    if (-not (Test-Path -LiteralPath $NotesSourcePath)) {
        Stop-OliviaPublish -Code 3 -Message "找不到发布说明（Release 正文的内容源）：$NotesSourcePath"
    }
    $text = [IO.File]::ReadAllText($NotesSourcePath)
    $lines = $text -split "\r?\n"
    $headingPattern = '^##\s+' + [regex]::Escape($Version) + '(?=\s|$)'
    $headingIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $headingPattern) { $headingIdx = $i; break }
    }
    if ($headingIdx -lt 0) {
        Stop-OliviaPublish -Code 2 -Message "发布说明里找不到当前版本节：$NotesSourcePath 缺少「## $Version …」节" -Hints @(
            '先在 packaging\发布说明.md 里补上本版一节（标题形如「## 2008.2.7-linli9-1.0.5 · 本版重点」），再发布。'
        )
    }
    $endIdx = $lines.Count
    for ($j = $headingIdx + 1; $j -lt $lines.Count; $j++) {
        if ($lines[$j] -match '^##\s') { $endIdx = $j; break }
    }
    $heading = $lines[$headingIdx]
    $titlePart = ''
    $sep = [string][char]0x00B7                              # 「·」分隔符
    $sepIdx = $heading.IndexOf($sep)
    if ($sepIdx -ge 0) {
        $titlePart = $heading.Substring($sepIdx + $sep.Length).Trim()
    }
    $body = ''
    if ($endIdx - 1 -ge $headingIdx + 1) {
        $body = (($lines[($headingIdx + 1)..($endIdx - 1)]) -join [Environment]::NewLine).Trim()
    }
    if (-not $body) {
        Stop-OliviaPublish -Code 2 -Message "发布说明里当前版本节是空的：$Version（Release 正文会没有内容）"
    }
    [pscustomobject]@{
        Heading   = $heading
        TitlePart = $titlePart
        Body      = $body
    }
}

function Get-OliviaPublishReleaseTitle {
    param(
        [Parameter(Mandatory)][string]$NotesSourcePath,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ShortVersion
    )
    $section = Get-OliviaPublishNotesSection -NotesSourcePath $NotesSourcePath -Version $Version
    if ($section.TitlePart) { return "$ShortVersion $([char]0x00B7) $($section.TitlePart)" }
    return $ShortVersion
}

function Get-OliviaPublishReleaseBody {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$SectionBody
    )
    $lines = @(
        ('## 本次更新 `{0}`' -f $Version)
        ''
        $SectionBody
    )
    return ($lines -join [Environment]::NewLine)
}

function Get-OliviaPublishHashSection {
    param([Parameter(Mandatory)][object[]]$Entries)
    $s = @(
        '### 📦 文件校验（SHA256）'
        ''
        '| 文件 | 大小 | SHA256 |'
        '|---|---|---|'
    )
    foreach ($e in $Entries) {
        $s += ('| `{0}` | {1} B | `{2}` |' -f $e.Name, $e.Bytes, $e.Hash)
    }
    $s += ''
    $s += '自己核对（PowerShell）：'
    $s += ''
    $s += '```powershell'
    foreach ($e in $Entries) {
        $s += ('Get-FileHash .\{0} -Algorithm SHA256 | Format-List' -f $e.Name)
    }
    $s += '```'
    $s += ''
    $s += '也可以直接下载本页附件里的 `SHA256SUMS.txt` 对拍。'
    return ($s -join [Environment]::NewLine)
}

function Set-OliviaPublishHashSection {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Body,
        [Parameter(Mandatory)][string]$Section
    )
    # 幂等：正文里已有哈希表就整段替换，重复运行不会出现两段
    $marker = '### 📦 文件校验（SHA256）'
    $idx = $Body.IndexOf($marker)
    if ($idx -ge 0) { $trimmed = $Body.Substring(0, $idx).TrimEnd() } else { $trimmed = $Body.TrimEnd() }
    $nl = [Environment]::NewLine
    return ($trimmed + $nl + $nl + '---' + $nl + $nl + $Section + $nl)
}

function New-OliviaPublishSha256SumsText {
    param([Parameter(Mandatory)][object[]]$Entries)
    # 与 repo\build-1.0.4\SHA256SUMS.txt 同格式：<大写SHA256>  <文件名>（两个空格）
    $lines = @()
    foreach ($e in $Entries) { $lines += ('{0}  {1}' -f $e.Hash, $e.Name) }
    return (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

function Test-OliviaPublishSha256SumsText {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [Parameter(Mandatory)][object[]]$Entries
    )
    # 返回差异说明；一致则返回 $null
    $expected = @{}
    foreach ($e in $Entries) { $expected[$e.Name] = $e.Hash }
    $seen = @{}
    foreach ($line in ($Text -split "\r?\n")) {
        if (-not $line.Trim()) { continue }
        $m = [regex]::Match($line, '^\s*([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$')
        if (-not $m.Success) { return "SHA256SUMS.txt 有一行格式不认识：$line" }
        $hash = $m.Groups[1].Value.ToUpperInvariant()
        $name = $m.Groups[2].Value
        if (-not $expected.ContainsKey($name)) { return "SHA256SUMS.txt 里多出产物：$name" }
        if ($expected[$name] -ne $hash) { return "SHA256SUMS.txt 里的哈希与文件实际值不一致：$name（文件里 $hash，实际 $($expected[$name])）" }
        $seen[$name] = $true
    }
    foreach ($name in $expected.Keys) {
        if (-not $seen.ContainsKey($name)) { return "SHA256SUMS.txt 里缺少产物：$name" }
    }
    return $null
}

function Write-OliviaPublishUtf8NoBomFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # UTF8Encoding($false) = 不写 BOM（GitHub 与 1.0.4 既有发布文本文件都是无 BOM）
    [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        Stop-OliviaPublish -Code 1 -Message "写入的发布文本文件意外带上了 BOM（GitHub 会把它显示出来）：$Path"
    }
    return $bytes.Length
}

function Get-OliviaPublishNetworkDiagnosis {
    param(
        [string]$Text,
        [string]$ProxyUrl = 'http://127.0.0.1:7890'
    )
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $needles = @(
        'connection reset', 'econnreset', 'econnrefused', 'etimedout', 'i/o timeout',
        'connection timed out', 'context deadline exceeded', 'dial tcp', 'tls handshake',
        'schannel', 'unexpected eof', 'could not resolve host', 'network is unreachable',
        'failed to connect', 'sni'
    )
    foreach ($n in $needles) {
        if ($Text.ToLowerInvariant().Contains($n)) {
            return ('网络类失败：疑似直连 github.com 被阻断（SNI / TLS 重置 / 超时）。先设代理再重跑：' +
                    '$env:HTTPS_PROXY=''' + $ProxyUrl + '''; $env:HTTP_PROXY=''' + $ProxyUrl + '''' +
                    '（gh 也读这两个变量）；若仍失败，用浏览器手工建 Release（1.0.4 就是这么发的）。')
        }
    }
    return $null
}

function Get-OliviaPublishGateOutDir {
    param(
        [Parameter(Mandatory)][string]$GateScriptPath,
        [Parameter(Mandatory)][string]$KitRoot,
        [Parameter(Mandatory)][string]$ProjectRoot
    )
    if (-not (Test-Path -LiteralPath $GateScriptPath)) {
        Stop-OliviaPublish -Code 3 -Message "找不到门禁（打包冒烟）脚本：$GateScriptPath"
    }
    $text = [IO.File]::ReadAllText($GateScriptPath)
    $kitMatch = [regex]::Match($text, '(?m)^\s*\$kit\s*=\s*''([^'']+)''')
    $outMatch = [regex]::Match($text, '(?m)^\s*\$outDir\s*=\s*"([^"]+)"')
    if (-not $outMatch.Success) {
        Stop-OliviaPublish -Code 2 -Message "门禁脚本里找不到 `$outDir = ""…"" 行：$GateScriptPath" -Hints @(
            '请给门禁脚本一个 $outDir 行（或显式传 -ArtifactDir）。'
        )
    }
    $variables = @{
        'kit'     = $KitRoot
        'project' = $ProjectRoot
    }
    $raw = $outMatch.Groups[1].Value
    if ($raw -match '\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?') {
        foreach ($ref in ([regex]::Matches($raw, '\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?'))) {
            $name = $ref.Groups[1].Value
            if (-not $variables.ContainsKey($name)) {
                Stop-OliviaPublish -Code 2 -Message "门禁脚本的 `$outDir 里引用了本脚本不认识的变量 `$$name：$raw" -Hints @(
                    '请显式传 -ArtifactDir 指定产物目录。'
                )
            }
            $raw = $raw.Replace($ref.Value, $variables[$name])
        }
    }
    if ($raw -match '\$') {
        Stop-OliviaPublish -Code 2 -Message "门禁脚本的 `$outDir 展开后仍有变量：$raw" -Hints @('请显式传 -ArtifactDir 指定产物目录。')
    }
    [pscustomobject]@{
        OutDir  = $raw
        KitLine = if ($kitMatch.Success) { $kitMatch.Groups[1].Value } else { '' }
    }
}

# ---------------------------------------------------------------------------
# 上下文：把「版本 / 路径 / 产物名 / 命令」一次算清，供 dry-run 打印与 -Execute 共用
# ---------------------------------------------------------------------------
function Add-OliviaPublishBlocker {
    # dry-run（Lenient）时不抛异常，把「会拦住发布的问题」收集起来最后一起报；
    # -Execute 时立刻抛（退出码取自异常 Data）。
    param(
        $Blockers = @(),
        [bool]$Lenient = $false,
        [Parameter(Mandatory)][int]$Code,
        [Parameter(Mandatory)][string]$Message,
        [string[]]$Hints = @()
    )
    if (-not $Lenient) {
        Stop-OliviaPublish -Code $Code -Message $Message -Hints $Hints
    }
    return @($Blockers) + @([pscustomobject]@{ Code = $Code; Message = $Message; Hints = $Hints })
}

function New-OliviaPublishContext {
    param(
        [bool]$Execute = $false,
        # dry-run 模式：前置校验的问题只记录不抛异常（先让用户看完整计划，再看拦住的原因）
        [bool]$Lenient = $false,
        [string]$Version = '',
        [string]$Tag = '',
        [string]$Repo = 'guvgr2/OliviaSoul-community',
        [string]$KitRoot = '',
        [string]$ArtifactDir = '',
        [string]$GateScript = '',
        [bool]$SkipGate = $false,
        [string]$ReleaseNotesSource = '',
        [string]$TitleFile = '',
        [string]$NotesFile = '',
        [bool]$Prerelease = $false,
        [string]$GhPath = '',
        [string]$GhRunner = '',
        [string]$ProxyUrl = 'http://127.0.0.1:7890',
        [string]$ToolsDir = ''
    )

    if (-not $ToolsDir) { $ToolsDir = $PSScriptRoot }
    $sourceRoot = (Resolve-Path -LiteralPath (Join-Path $ToolsDir '..')).Path          # repo\source
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $sourceRoot 'local-service')).Path
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $sourceRoot '..')).Path          # repo
    if (-not $KitRoot) { $KitRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot '..')).Path }
    if (-not (Test-Path -LiteralPath $KitRoot)) {
        Stop-OliviaPublish -Code 3 -Message "找不到仓库套件根目录（-KitRoot）：$KitRoot"
    }

    $buildReleaseScript = Join-Path $projectRoot 'packaging\build-release.ps1'
    if (-not $Version) {
        $Version = (Get-OliviaPublishVersionFromBuildScript -BuildReleaseScript $buildReleaseScript).Version
        $versionFromBuildScript = $true
    } else {
        $versionFromBuildScript = $false
    }
    $baseVersion = (Get-OliviaPublishVersionFromBuildScript -BuildReleaseScript $buildReleaseScript).BaseVersion
    Assert-OliviaPublishVersionFormat -Version $Version -BaseVersion $baseVersion | Out-Null
    if ($versionFromBuildScript) {
        # 版本号只有一处定义，这里只提示、不静默改写
        Write-Host "[信息] 版本号取自 packaging\build-release.ps1：$Version（短号 $(Get-OliviaPublishShortVersion -Version $Version)）"
    }
    $short = Get-OliviaPublishShortVersion -Version $Version

    if (-not $Tag) { $Tag = "v$Version" }
    if ($Tag -ne "v$Version") {
        Stop-OliviaPublish -Code 2 -Message "Tag 与版本号不一致：-Tag $Tag 但版本是 $Version" -Hints @(
            "既有约定是 `v<完整版本号>`（1.0.4 用的是 v2008.2.7-linli9-1.0.4），Tag 默认就按这个算。"
        )
    }

    if (-not $GateScript) { $GateScript = Join-Path $KitRoot '.test-twins\1.0-final-check.ps1' }
    $gate = Get-OliviaPublishGateOutDir -GateScriptPath $GateScript -KitRoot $KitRoot -ProjectRoot $projectRoot

    $artifactDirExplicit = [bool]$ArtifactDir
    if (-not $ArtifactDir) { $ArtifactDir = $gate.OutDir }
    $gateDirMatchesVersion = $true
    $gateDirShort = ''
    if ($gate.OutDir -match 'build-(.+)$') { $gateDirShort = $Matches[1] }
    if ($gateDirShort -ne $short) { $gateDirMatchesVersion = $false }

    $blockers = @()
    if (-not $SkipGate) {
        # 门禁会把产物写进它自己的 $outDir，并先 Remove-Item 整个目录。
        # 它写的那一份必须就是我们准备发布的这一个版本，否则会覆盖已发布版本的产物。
        $trimChars = [char[]]@('\', '/')
        if ($artifactDirExplicit -and ($ArtifactDir.TrimEnd($trimChars) -ne $gate.OutDir.TrimEnd($trimChars))) {
            $blockers = Add-OliviaPublishBlocker -Blockers $blockers -Lenient $Lenient -Code 2 `
                -Message "产物目录与门禁脚本的 `$outDir 不一致，门禁会写到别处" -Hints @(
                "门禁 `$outDir = $($gate.OutDir)（$GateScript）",
                "-ArtifactDir = $ArtifactDir",
                '要么把门禁脚本的 $outDir 改成目标版本目录，要么加 -SkipGate（表示门禁已单独跑过、发布只用既有产物）。'
            )
        }
        if (-not $gateDirMatchesVersion) {
            $blockers = Add-OliviaPublishBlocker -Blockers $blockers -Lenient $Lenient -Code 2 `
                -Message '门禁脚本的产物目录不是本次要发的版本，跑下去会覆盖别人已发布的产物' -Hints @(
                "门禁 `$outDir = $($gate.OutDir)（目录里的版本 $gateDirShort），本次版本是 $short（$GateScript）",
                ('把门禁脚本的 $outDir 改成 "$kit\repo\build-' + $short + '"（或改成从 build-release.ps1 现读 $version）后重跑；'),
                '若门禁已单独跑过、只想跑发布步骤，加 -SkipGate -ArtifactDir <产物目录>。'
            )
        }
    }

    $names = Get-OliviaPublishArtifactNames -Version $Version
    $setupPath = Join-Path $ArtifactDir $names.Setup
    $zipPath = Join-Path $ArtifactDir $names.Portable
    $sumsPath = Join-Path $ArtifactDir $names.Sums

    # 产物必须在位：这是一次只读检查，dry-run（Lenient）也必须明确报「缺产物」。
    # 只把产物标成 [缺失] 印在计划里、却不影响退出码，等于静默报成功（用户会以为能发）。
    # -Execute 时同样的问题由第 [3] 步 Get-OliviaPublishArtifactHashes 以 code 2 报出。
    if ($Lenient) {
        $missingArtifacts = @(@($setupPath, $zipPath) | Where-Object { -not (Test-Path -LiteralPath $_) })
        if (@($missingArtifacts).Count -gt 0) {
            $blockers = Add-OliviaPublishBlocker -Blockers $blockers -Lenient $true -Code 2 `
                -Message ('产物不存在（缺产物）：' + (@($missingArtifacts) -join '、')) -Hints @(
                "缺的是 Release 必须上传的产物，不是可选项：Setup.exe 与 Portable.zip 都要能下载。",
                "门禁脚本（$GateScript）跑完应当把它们写进 $ArtifactDir；",
                '先跑门禁生成产物，或加 -ArtifactDir <已有产物目录>（配合 -SkipGate 表示门禁已单独跑过）。'
            )
        }
    }

    if (-not $ReleaseNotesSource) { $ReleaseNotesSource = Join-Path $projectRoot 'packaging\发布说明.md' }
    if (-not $TitleFile) { $TitleFile = Join-Path $KitRoot ".test-twins\_release-title-$short.txt" }
    if (-not $NotesFile) { $NotesFile = Join-Path $KitRoot ".test-twins\_release-notes-$short.md" }

    # gh 定位顺序：-GhPath > PATH 上的 gh > 环境变量 OLIVIA_GH_PATH。
    # 刻意不把任何具体机器的路径写进脚本（见上面 $GhPath 参数处的说明）。
    if (-not $GhRunner -and -not $GhPath) {
        $foundGh = Get-Command gh -ErrorAction SilentlyContinue
        if ($foundGh) { $GhPath = [string]$foundGh.Source }
        elseif ($env:OLIVIA_GH_PATH) { $GhPath = [string]$env:OLIVIA_GH_PATH }
    }
    $ghExe = if ($GhRunner) { $GhRunner } else { $GhPath }
    if (-not $GhRunner -and -not $GhPath) {
        Stop-OliviaPublish -Code 3 -Message '找不到 gh：没有传 -GhPath，PATH 上也没有 gh' -Hints @(
            '用 -GhPath 指定 gh 全路径，或把 gh 放进 PATH，或设环境变量 OLIVIA_GH_PATH；',
            '真的没有 gh 时，用浏览器手工建 Release（1.0.4 就是这么发的，见 .test-twins\1.0.4发布步骤.md）。'
        )
    }
    if (-not $GhRunner -and -not (Test-Path -LiteralPath $GhPath)) {
        Stop-OliviaPublish -Code 3 -Message "找不到 gh：$GhPath" -Hints @(
            '该路径不存在，请用 -GhPath 指定正确的 gh 全路径；',
            '真的没有 gh 时，用浏览器手工建 Release（1.0.4 就是这么发的，见 .test-twins\1.0.4发布步骤.md）。'
        )
    }

    $psExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) {
        $cmd = Get-Command powershell -ErrorAction SilentlyContinue
        if (-not $cmd) { Stop-OliviaPublish -Code 3 -Message '找不到 powershell.exe（无法调用门禁脚本）' }
        $psExe = [string]$cmd.Path
    }

    # 正文/标题内容源：发布说明的当前版本节。dry-run 下缺节只当「拦路问题」报出来（让人先看完整计划），
    # -Execute 下必须直接失败 —— 没有内容源的 Release 就是一封空信。
    $notesSectionMissing = $false
    try {
        $section = Get-OliviaPublishNotesSection -NotesSourcePath $ReleaseNotesSource -Version $Version
        $title = Get-OliviaPublishReleaseTitle -NotesSourcePath $ReleaseNotesSource -Version $Version -ShortVersion $short
        $body = Get-OliviaPublishReleaseBody -Version $Version -SectionBody $section.Body
    } catch {
        $errCode = 1
        $errHints = @()
        if ($_.Exception.Data -and $_.Exception.Data.Contains('OliviaCode')) { $errCode = [int]$_.Exception.Data['OliviaCode'] }
        if ($_.Exception.Data -and $_.Exception.Data.Contains('OliviaHints')) { $errHints = @($_.Exception.Data['OliviaHints']) }
        if (-not $Lenient -or $errCode -ne 2) { throw }
        $notesSectionMissing = $true
        $blockers = Add-OliviaPublishBlocker -Blockers $blockers -Lenient $true -Code $errCode -Message $_.Exception.Message -Hints $errHints
        $title = "$short $([char]0x00B7) （发布说明里还没有本版一节）"
        $body = "（发布说明里还没有本版一节：$ReleaseNotesSource 缺少「## $Version …」—— 发布前必须先补上。）"
    }

    [ordered]@{
        Execute          = $Execute
        Lenient          = $Lenient
        Blockers         = @($blockers)
        NotesSectionMissing = $notesSectionMissing
        Version          = $Version
        BaseVersion      = $baseVersion
        Short            = $short
        Tag              = $Tag
        Repo             = $Repo
        KitRoot          = $KitRoot
        RepoRoot         = $repoRoot
        ProjectRoot      = $projectRoot
        ToolsDir         = $ToolsDir
        BuildReleaseScript = $buildReleaseScript
        GateScript       = $GateScript
        GateOutDir       = $gate.OutDir
        GateDirShort     = $gateDirShort
        GateLog          = Join-Path $KitRoot ".test-twins\publish-$short-gate.log"
        ArtifactDir      = $ArtifactDir
        ArtifactDirExplicit = $artifactDirExplicit
        SetupName        = $names.Setup
        ZipName          = $names.Portable
        SumsName         = $names.Sums
        SetupPath        = $setupPath
        ZipPath          = $zipPath
        SumsPath         = $sumsPath
        ReleaseNotesSource = $ReleaseNotesSource
        TitleFile        = $TitleFile
        NotesFile        = $NotesFile
        Title            = $title
        Body             = $body
        SkipGate         = $SkipGate
        Prerelease       = $Prerelease
        ProxyUrl         = $ProxyUrl
        GhPath           = $GhPath
        GhExe            = $ghExe
        GhRunner         = $GhRunner
        PowerShellExe    = $psExe
        ReleaseUrl       = "https://github.com/$Repo/releases/tag/$Tag"
        ApiReleaseUrl    = "repos/$Repo/releases/tags/$Tag"
    }
}

function Get-OliviaPublishPlan {
    param([Parameter(Mandatory)]$Context)
    $c = $Context
    $kind = if ($c.Prerelease) { '测试版（带 --prerelease：**只有切到 beta 通道的用户能看到**）' } else { '正式版（不带 --prerelease：稳定版用户可见）' }
    $createArgs = @('release', 'create', $c.Tag, '--repo', $c.Repo, '--title', $c.Title, '--notes-file', $c.NotesFile)
    if ($c.Prerelease) { $createArgs += '--prerelease' }
    $uploadArgs = @('release', 'upload', $c.Tag, $c.SetupPath, $c.ZipPath, $c.SumsPath, '--repo', $c.Repo)
    $editArgs = @('release', 'edit', $c.Tag, '--repo', $c.Repo, '--notes-file', $c.NotesFile)

    $steps = @()
    $steps += [pscustomobject]@{
        Id = 1; Title = '前置校验（只读）'
        Command = 'Test-Path / 版本号格式 / Tag 规则 / 门禁 $outDir 与本次版本是否一致'
        Note = "产物目录 $($c.ArtifactDir)"
    }
    if ($c.SkipGate) {
        $steps += [pscustomobject]@{
            Id = 2; Title = '门禁（-SkipGate 已跳过）'
            Command = '（跳过；直接用产物目录里已有的产物）'
            Note = "要求 $($c.SetupName) / $($c.ZipName) 已存在"
        }
    } else {
        $steps += [pscustomobject]@{
            Id = 2; Title = '门禁：关键套件 + 打包 + 解压冒烟（失败即停）'
            Command = (Format-OliviaPublishCommandLine $c.PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $c.GateScript))
            Note = "输出同时写一份到 $($c.GateLog)"
        }
    }
    $steps += [pscustomobject]@{
        Id = 3; Title = '收集产物与 SHA256'
        Command = 'Get-FileHash -Algorithm SHA256 ' + (Format-OliviaPublishArg $c.SetupPath) + ' ' + (Format-OliviaPublishArg $c.ZipPath)
        Note = '缺失即停（不会发布没有产物的版本）'
    }
    $steps += [pscustomobject]@{
        Id = 4; Title = 'SHA256SUMS.txt 核对（缺失则生成）'
        Command = '核对 ' + (Format-OliviaPublishArg $c.SumsPath)
        Note = '既有文件与实算哈希不一致即停（不覆盖既有校验文件的内容分歧）'
    }
    $steps += [pscustomobject]@{
        Id = 5; Title = '生成 Release 标题文件（UTF-8 无 BOM）'
        Command = '写入 ' + (Format-OliviaPublishArg $c.TitleFile)
        Note = '内容 = 发布说明当前版本节标题的「·」后半段（前面补短号）'
    }
    $steps += [pscustomobject]@{
        Id = 6; Title = '生成 Release 正文文件（UTF-8 无 BOM）'
        Command = '写入 ' + (Format-OliviaPublishArg $c.NotesFile)
        Note = '内容 = 「## 本次更新 `<版本>`」+ 发布说明当前版本节正文'
    }
    $steps += [pscustomobject]@{
        Id = 7; Title = 'gh 预检：登录状态 + 该 Tag 是否已有 Release'
        Command = (Format-OliviaPublishCommandLine $c.GhExe @('auth', 'status')) + '  ;  ' +
                  (Format-OliviaPublishCommandLine $c.GhExe @('api', $c.ApiReleaseUrl))
        Note = '已存在同名 Release 即停（AGENTS.md 三·1：已发布的号不能重发）'
    }
    $steps += [pscustomobject]@{
        Id = 8; Title = "建 Release（$kind）"
        Command = (Format-OliviaPublishCommandLine $c.GhExe $createArgs)
        Note = '中文标题作为 argv 传入（不经控制台代码页），正文走 --notes-file'
    }
    $steps += [pscustomobject]@{
        Id = 9; Title = '上传三个附件'
        Command = (Format-OliviaPublishCommandLine $c.GhExe $uploadArgs)
        Note = 'Setup.exe + Portable.zip + SHA256SUMS.txt'
    }
    $steps += [pscustomobject]@{
        Id = 10; Title = '把哈希表追加进正文并更新 Release'
        Command = '写入 ' + (Format-OliviaPublishArg $c.NotesFile) + '（追加「### 📦 文件校验（SHA256）」）  ;  ' +
                  (Format-OliviaPublishCommandLine $c.GhExe $editArgs)
        Note = '幂等：正文里已有哈希表就整段替换，重跑不会出现两段'
    }
    $steps += [pscustomobject]@{
        Id = 11; Title = '发布后核对（不用 --jq，改走 ConvertFrom-Json）'
        Command = '(' + (Format-OliviaPublishCommandLine $c.GhExe @('api', $c.ApiReleaseUrl)) + ') | ConvertFrom-Json'
        Note = "核对 prerelease=$($c.Prerelease) 与 3 个附件是否都在；不一致即报错（勾错 prerelease 会误发给稳定版用户）"
    }
    return $steps
}

# ---------------------------------------------------------------------------
# 执行：gh 调用与各步骤
# ---------------------------------------------------------------------------
function Invoke-OliviaPublishGhRaw {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    if ($Arguments -contains '--jq') {
        Stop-OliviaPublish -Code 2 -Message '内部错误：命令里出现 --jq（本机 pwsh 会把带空格的 --jq 表达式拆参）' -Hints @(
            '统一改用 (& gh api <url>) | ConvertFrom-Json。'
        )
    }
    Write-Host ('    $ ' + (Format-OliviaPublishCommandLine $Context.GhExe $Arguments)) -ForegroundColor DarkGray
    # gh 把失败信息写到 stderr（例如「该 Tag 还没有 Release」这种**预期内**的 404）。
    # 本脚本开头设了 $ErrorActionPreference = 'Stop'，而 Windows PowerShell 5.1 在 Stop 下
    # 会把原生命令的 stderr 变成**终止性**异常 —— 于是 `gh api <不存在的 tag>` 会直接打断
    # 整个发布（1.0.6 发布时踩到：[7/11] 预检 404 直接 exit 1，根本没走到「可以建」）。
    # 这里只关心退出码，stderr 一律并入 $out 交给调用方判断，所以局部放开 Stop。
    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Context.GhExe @Arguments 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevErrorAction
    }
    if ($null -eq $code) { $code = 0 }
    [pscustomobject]@{
        ExitCode = [int]$code
        Output   = ([string]$out).Trim()
    }
}

function Stop-OliviaPublishGhFailure {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Purpose,
        [Parameter(Mandatory)]$Result,
        [int]$Code = 1
    )
    $diag = Get-OliviaPublishNetworkDiagnosis -Text $Result.Output -ProxyUrl $Context.ProxyUrl
    if ($diag) {
        Stop-OliviaPublish -Code 4 -Message "gh 失败（网络类）：$Purpose（gh 退出码 $($Result.ExitCode)）" -Hints @($diag, "gh 原始输出：$($Result.Output)")
    }
    Stop-OliviaPublish -Code $Code -Message "gh 失败：$Purpose（gh 退出码 $($Result.ExitCode)）" -Hints @("gh 原始输出：$($Result.Output)")
}

function Invoke-OliviaPublishGhStep {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Purpose,
        [int]$Code = 1
    )
    $r = Invoke-OliviaPublishGhRaw -Context $Context -Arguments $Arguments
    if ($r.Output) { Write-Host $r.Output }
    if ($r.ExitCode -ne 0) { Stop-OliviaPublishGhFailure -Context $Context -Purpose $Purpose -Result $r -Code $Code }
    return $r.Output
}

function Get-OliviaPublishArtifactHashes {
    param([Parameter(Mandatory)]$Context)
    $entries = @()
    foreach ($p in @($Context.SetupPath, $Context.ZipPath)) {
        if (-not (Test-Path -LiteralPath $p)) {
            Stop-OliviaPublish -Code 2 -Message "产物不存在：$p" -Hints @(
                '先跑门禁（不加 -SkipGate）；若门禁的 $outDir 与本次版本不一致，发布脚本会提前拦住（见 [1] 的提示）。'
            )
        }
        $f = Get-Item -LiteralPath $p
        $entries += [pscustomobject]@{
            Name  = $f.Name
            Bytes = [int64]$f.Length
            Hash  = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToUpperInvariant()
        }
    }
    return $entries
}

function Invoke-OliviaPublishExecute {
    param([Parameter(Mandatory)]$Context)
    $c = $Context
    $nl = [Environment]::NewLine

    # [2] 门禁
    if (-not $c.SkipGate) {
        Write-Host "[2/11] 门禁（关键套件 + 打包 + 解压冒烟）：$($c.GateScript)" -ForegroundColor Cyan
        $gateArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $c.GateScript)
        $gateOut = & $c.PowerShellExe @gateArgs 2>&1 | Out-String
        $gateCode = $LASTEXITCODE
        if ($null -eq $gateCode) { $gateCode = 0 }
        Write-Host $gateOut
        # 存日志：自己按 UTF-8 无 BOM 写（不靠 Tee-Object 的默认编码）
        [void](Write-OliviaPublishUtf8NoBomFile -Path $c.GateLog -Text ([string]$gateOut))
        Write-Host "    门禁输出已存：$($c.GateLog)"
        if ($gateCode -ne 0) {
            Stop-OliviaPublish -Code 1 -Message "门禁未通过（退出码 $gateCode），不打包发布" -Hints @(
                "看日志：$($c.GateLog)",
                'AGENTS.md 一：不通过就不要打包。'
            )
        }
    } else {
        Write-Host '[2/11] 门禁：已按 -SkipGate 跳过（使用既有产物）' -ForegroundColor Yellow
    }

    # [3] 产物与哈希
    Write-Host '[3/11] 收集产物与 SHA256' -ForegroundColor Cyan
    $entries = Get-OliviaPublishArtifactHashes -Context $c
    foreach ($e in $entries) { Write-Host ("    {0}  {1} B  {2}" -f $e.Name, $e.Bytes, $e.Hash) }

    # [4] SHA256SUMS.txt：核对或生成
    Write-Host '[4/11] SHA256SUMS.txt' -ForegroundColor Cyan
    $sumsText = New-OliviaPublishSha256SumsText -Entries $entries
    if (Test-Path -LiteralPath $c.SumsPath) {
        $existing = [IO.File]::ReadAllText($c.SumsPath)
        $diff = Test-OliviaPublishSha256SumsText -Text $existing -Entries $entries
        if ($diff) {
            Stop-OliviaPublish -Code 2 -Message "既有 SHA256SUMS.txt 与实际产物不一致：$diff" -Hints @(
                "文件：$($c.SumsPath)",
                '要么产物被改过（重新打包），要么校验文件是旧版本的（删掉它重跑，本脚本会按实际哈希重建）。'
            )
        }
        Write-Host "    既有 SHA256SUMS.txt 与实际产物一致：$($c.SumsPath)"
    } else {
        [void](Write-OliviaPublishUtf8NoBomFile -Path $c.SumsPath -Text $sumsText)
        Write-Host "    已生成：$($c.SumsPath)"
    }

    # [5] 标题文件
    Write-Host '[5/11] 生成 Release 标题文件（UTF-8 无 BOM）' -ForegroundColor Cyan
    $titleText = $c.Title + $nl
    [void](Write-OliviaPublishUtf8NoBomFile -Path $c.TitleFile -Text $titleText)
    Write-Host "    $($c.TitleFile)"
    Write-Host "    标题：$($c.Title)"

    # [6] 正文文件
    Write-Host '[6/11] 生成 Release 正文文件（UTF-8 无 BOM）' -ForegroundColor Cyan
    [void](Write-OliviaPublishUtf8NoBomFile -Path $c.NotesFile -Text ($c.Body + $nl))
    Write-Host "    $($c.NotesFile)（$(([IO.File]::ReadAllBytes($c.NotesFile)).Length) 字节）"

    # [7] gh 预检
    Write-Host '[7/11] gh 预检：登录状态 + 该 Tag 是否已有 Release' -ForegroundColor Cyan
    $auth = Invoke-OliviaPublishGhRaw -Context $c -Arguments @('auth', 'status')
    if ($auth.ExitCode -ne 0) {
        $diag = Get-OliviaPublishNetworkDiagnosis -Text $auth.Output -ProxyUrl $c.ProxyUrl
        if ($diag) { Stop-OliviaPublish -Code 4 -Message 'gh auth status 失败（网络类）' -Hints @($diag, "gh 原始输出：$($auth.Output)") }
        Stop-OliviaPublish -Code 3 -Message 'gh 未登录（gh auth status 非 0）' -Hints @(
            "gh 原始输出：$($auth.Output)",
            '先 gh auth login（或设 GH_TOKEN 环境变量）。'
        )
    }
    $probe = Invoke-OliviaPublishGhRaw -Context $c -Arguments @('api', $c.ApiReleaseUrl)
    if ($probe.ExitCode -eq 0) {
        Stop-OliviaPublish -Code 2 -Message "该 Tag 已经有 Release 了：$($c.Tag)" -Hints @(
            'AGENTS.md 三·1：已发布的版本不能同号重发 —— 先升版本号（repo\source\tools\bump-version.ps1），再发布。',
            "想改文案：(& $($c.GhExe) api $($c.ApiReleaseUrl)) 先看现状，再手工 edit。"
        )
    }
    if ($probe.Output -notmatch '(?i)404|not found') {
        Stop-OliviaPublishGhFailure -Context $c -Purpose '检查 Tag 是否存在' -Result $probe -Code 1
    }
    Write-Host "    Tag $($c.Tag) 尚不存在（404）→ 可以建"

    # [8] 建 Release（正式版默认不带 --prerelease）
    $kind = if ($c.Prerelease) { '测试版（--prerelease）' } else { '正式版' }
    Write-Host "[8/11] 建 Release：$kind" -ForegroundColor Cyan
    $createArgs = @('release', 'create', $c.Tag, '--repo', $c.Repo, '--title', $c.Title, '--notes-file', $c.NotesFile)
    if ($c.Prerelease) { $createArgs += '--prerelease' }
    [void](Invoke-OliviaPublishGhStep -Context $c -Arguments $createArgs -Purpose "建 Release $($c.Tag)")

    # [9] 上传三个附件
    Write-Host '[9/11] 上传 Setup.exe / Portable.zip / SHA256SUMS.txt' -ForegroundColor Cyan
    $uploadArgs = @('release', 'upload', $c.Tag, $c.SetupPath, $c.ZipPath, $c.SumsPath, '--repo', $c.Repo)
    [void](Invoke-OliviaPublishGhStep -Context $c -Arguments $uploadArgs -Purpose '上传产物')

    # [10] 把哈希表追加进正文
    Write-Host '[10/11] 把哈希表追加进正文并更新 Release' -ForegroundColor Cyan
    $section = Get-OliviaPublishHashSection -Entries $entries
    $withHashes = Set-OliviaPublishHashSection -Body $c.Body -Section $section
    [void](Write-OliviaPublishUtf8NoBomFile -Path $c.NotesFile -Text $withHashes)
    $editArgs = @('release', 'edit', $c.Tag, '--repo', $c.Repo, '--notes-file', $c.NotesFile)
    [void](Invoke-OliviaPublishGhStep -Context $c -Arguments $editArgs -Purpose '更新 Release 正文（含哈希表）')

    # [11] 发布后核对
    Write-Host '[11/11] 发布后核对' -ForegroundColor Cyan
    $json = Invoke-OliviaPublishGhStep -Context $c -Arguments @('api', $c.ApiReleaseUrl) -Purpose '核对 Release'
    $rel = $json | ConvertFrom-Json
    if ([string]$rel.tag_name -ne $c.Tag) {
        Stop-OliviaPublish -Code 1 -Message "核对失败：Release 的 tag 是 $($rel.tag_name)，期望 $($c.Tag)"
    }
    if ([bool]$rel.prerelease -ne [bool]$c.Prerelease) {
        Stop-OliviaPublish -Code 1 -Message "核对失败：prerelease 与本次发布性质不符（GitHub=$($rel.prerelease)，本次=$($c.Prerelease)）" -Hints @(
            '勾错 prerelease 会误发：正式版被勾成 prerelease 则稳定版用户看不到；测试版没勾则所有稳定版用户都会收到。',
            "手工修正：$($c.ReleaseUrl)"
        )
    }
    $assetNames = @($rel.assets | ForEach-Object { $_.name })
    foreach ($want in @($c.SetupName, $c.ZipName, $c.SumsName)) {
        if ($assetNames -notcontains $want) {
            Stop-OliviaPublish -Code 1 -Message "核对失败：附件里缺 $want（现有：$($assetNames -join ', ')）"
        }
    }
    Write-Host "    ✓ $($c.ReleaseUrl)" -ForegroundColor Green
    Write-Host "    ✓ prerelease=$($rel.prerelease)，附件 $($assetNames.Count) 个：$($assetNames -join ', ')" -ForegroundColor Green
    return 0
}

function Show-OliviaPublishPlan {
    param([Parameter(Mandatory)]$Context)
    $c = $Context
    $kindText = if ($c.Prerelease) { '测试版（--prerelease；只有 beta 通道用户能看到）' } else { '正式版（不带 --prerelease；稳定版用户可见）' }
    Write-Host ''
    Write-Host '============ DRY-RUN（默认）—— 下面的命令都不会被执行 ============' -ForegroundColor Yellow
    Write-Host ("版本        : {0}（短号 {1}）" -f $c.Version, $c.Short)
    Write-Host ("Tag         : {0}" -f $c.Tag)
    Write-Host ("仓库        : {0}" -f $c.Repo)
    Write-Host ("产物目录    : {0}" -f $c.ArtifactDir)
    Write-Host ("发布性质    : {0}" -f $kindText)
    Write-Host ("门禁脚本    : {0}{1}" -f $c.GateScript, $(if ($c.SkipGate) { '（本次 -SkipGate，跳过）' } else { '' }))
    Write-Host ("标题文件    : {0}" -f $c.TitleFile)
    Write-Host ("正文文件    : {0}" -f $c.NotesFile)
    Write-Host ("发布说明源  : {0}" -f $c.ReleaseNotesSource)
    Write-Host ("gh          : {0}{1}" -f $c.GhExe, $(if ($c.GhRunner) { '（-GhRunner 测试替身）' } else { '' }))
    Write-Host ("网络失败时  : 建议代理 {0}" -f $c.ProxyUrl)
    Write-Host ''
    Write-Host '产物现状（只读检查，不创建）：'
    foreach ($p in @($c.SetupPath, $c.ZipPath, $c.SumsPath)) {
        $state = if (Test-Path -LiteralPath $p) { '存在' } else { '缺失' }
        Write-Host ("    [{0}] {1}" -f $state, $p)
    }
    if ($c.NotesSectionMissing) {
        Write-Host '    [!] 发布说明里还没有本版一节 —— 正文内容源缺失（见下面「会拦住发布的问题」）' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host ("Release 标题：{0}" -f $c.Title)
    Write-Host 'Release 正文预览（前 12 行）：'
    ($c.Body -split "\r?\n" | Select-Object -First 12) | ForEach-Object { Write-Host ("    | {0}" -f $_) }
    Write-Host ''
    foreach ($s in (Get-OliviaPublishPlan -Context $c)) {
        Write-Host ("[{0}/{1}] {2}" -f $s.Id, 11, $s.Title) -ForegroundColor Cyan
        Write-Host ("    $ {0}" -f $s.Command)
        if ($s.Note) { Write-Host ("    · {0}" -f $s.Note) -ForegroundColor DarkGray }
    }
    Write-Host ''
    if (@($c.Blockers).Count -gt 0) {
        Write-Host '❌ 这些前置问题会拦住发布（dry-run 只报告，不改动任何东西）：' -ForegroundColor Red
        foreach ($b in @($c.Blockers)) {
            Write-Host ('  [退出码 ' + $b.Code + '] ' + $b.Message) -ForegroundColor Red
            foreach ($h in @($b.Hints)) { if ($h) { Write-Host ('    → ' + $h) -ForegroundColor Yellow } }
        }
        Write-Host ''
    }
    Write-Host '本模式只读：不写文件、不建 Release、不调 gh。' -ForegroundColor Yellow
    Write-Host '要真的执行：加 -Execute（正式版默认；测试版另加 -Prerelease）。' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 入口（dot-source 时（测试里 . 脚本）不执行主流程）
# ---------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Execute -and $DryRun) {
            Stop-OliviaPublish -Code 2 -Message '-Execute 与 -DryRun 互斥（默认就是 dry-run，不传 -Execute 即可）'
        }
        $context = New-OliviaPublishContext `
            -Execute ([bool]$Execute) `
            -Lenient ([bool](-not $Execute)) `
            -Version $Version `
            -Tag $Tag `
            -Repo $Repo `
            -KitRoot $KitRoot `
            -ArtifactDir $ArtifactDir `
            -GateScript $GateScript `
            -SkipGate ([bool]$SkipGate) `
            -ReleaseNotesSource $ReleaseNotesSource `
            -TitleFile $TitleFile `
            -NotesFile $NotesFile `
            -Prerelease ([bool]$Prerelease) `
            -GhPath $GhPath `
            -GhRunner $GhRunner `
            -ProxyUrl $ProxyUrl

        if (-not $Execute) {
            Show-OliviaPublishPlan -Context $context
            if (@($context.Blockers).Count -gt 0) {
                exit ([int]$context.Blockers[0].Code)
            }
            exit 0
        }
        [void](Invoke-OliviaPublishExecute -Context $context)
        exit 0
    } catch {
        $code = 1
        $hints = @()
        try {
            if ($_.Exception.Data -and $_.Exception.Data.Contains('OliviaCode')) {
                $code = [int]$_.Exception.Data['OliviaCode']
                $hints = @($_.Exception.Data['OliviaHints'])
            }
        } catch { }
        Write-Host ''
        Write-Host ('[错误] ' + $_.Exception.Message) -ForegroundColor Red
        foreach ($h in $hints) { if ($h) { Write-Host ('  → ' + $h) -ForegroundColor Yellow } }
        exit $code
    }
}
