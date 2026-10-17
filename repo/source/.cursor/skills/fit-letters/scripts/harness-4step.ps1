# Harness: safe -> draft -> check -> rewrite
# Prompts live in harness/. PowerShell 5.x.
#   powershell -NoProfile -File .cursor/skills/fit-letters/scripts/harness-4step.ps1 -Person X -N 33 -Root "..."

param(
    [Parameter(Mandatory = $true)][string]$Person,
    [Parameter(Mandatory = $true)][int]$N,
    [string]$Root = "",
    [string]$RulesFile = "",
    [string]$HarnessDir = "",
    [string]$Tag = "",
    [string]$Model = "",
    [string]$ReuseSafeTag = "",
    [string]$ArchivePath = "",
    [string]$OutFile = "",
    [string]$DraftFile = "",
    [string]$PrecheckFile = "",
    [string]$HistoryFile = "",
    [string]$PreviousStateTag = "",
    [string]$PreviousReplyOverrideFile = "",
    [switch]$NoThink,
    [switch]$InitializeState,
    [switch]$AllowStateBootstrap,
    [switch]$StopAfterSafe,
    # 主动写信（由头驱动）：归档末段是「由头」而不是「要回的来信」，
    # prompt 里注入 {{proactiveNote}}。不传时全链路与回信完全一致。
    [switch]$Proactive,
    # S9（2026-10-16 两端同步 · 近况层）：档位由调用方按信件数算好后传进来，
    # 本脚本只负责按档取文案（harness\近况.md）并注入 {{drift}}。
    # 默认 -1 = 调用方未提供 ⇒ 不注入，行为与接入前逐字一致。
    [int]$DriftTier = -1,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Get-Location).Path }
. (Join-Path $PSScriptRoot "memory-lib.ps1")
. (Join-Path $PSScriptRoot "history-retrieval.ps1")
Initialize-Ds -Root $Root
if (-not [string]::IsNullOrWhiteSpace($Model)) { Set-DsModel -Model $Model }
if ($NoThink) { Set-DsThinking -On $false }
$sw = [Diagnostics.Stopwatch]::StartNew()
function Say([string]$m) {
    if ($Quiet) { Write-Output $m }
    else { Write-Output $m }
}
function Lap([string]$step) {
    if (-not $Quiet) { Write-Output ("{0} {1}s" -f $step, [int]$sw.Elapsed.TotalSeconds) }
}

$nn = "{0:D2}" -f $N
$probe = Join-Path $Root "_probe"
if (-not (Test-Path -LiteralPath $probe)) { New-Item -ItemType Directory -Path $probe | Out-Null }
$suffix = ""
if (-not [string]::IsNullOrWhiteSpace($Tag)) { $suffix = "_" + $Tag }
. (Join-Path $PSScriptRoot "probe-prune.ps1")

function Save-Step([string]$step, [string]$text) {
    $p = Join-Path $probe ("h4_{0}_{1}{2}_{3}.txt" -f $Person, $nn, $suffix, $step)
    Write-Utf8 $p $text
    if ($step -eq "5final" -and -not [string]::IsNullOrWhiteSpace($OutFile)) { Write-Utf8 $OutFile $text }
    if (-not $Quiet) { Write-Output ("wrote " + $p) }
    # B7：每写完一份就回收同一人更早那几封的中间产物（默认只留最近 3 封，见 probe-prune.ps1）。
    [void](Remove-OldProbeFiles -ProbeDir $probe -Person $Person -Keep 3)
}

if ([string]::IsNullOrWhiteSpace($HarnessDir)) { $HarnessDir = Join-Path $Root "harness" }
if (-not [IO.Path]::IsPathRooted($HarnessDir)) { $HarnessDir = Join-Path $Root $HarnessDir }

# S1（2026-10-16）：渲染严格化 —— 把「静默污染 prompt」改成当场抛错。
# 背景：旧的 Expand-Harness 只做 .Replace：模板里写错一个变量名、或某一步忘了传值，
# 占位符会**原样** `{{xxx}}` 送进模型 prompt（模型读到的是一段垃圾指令），而外层毫无异常、
# 日志也干净。两端同步方案 §7 验收 2 要求四种情形各有一条会失败的测试 ——
# 缺文件 / 缺标记由 Get-HarnessPrompt 覆盖（:76、:82），这里补上「未登记变量」与「必填缺值」。
# 允许为空的变量（缺值按空串渲染，不抛错）：这份名单必须与 harness-manifest.json 的
# optionalVariables 集合一致，由 test/letter-harness-strict-render.test.js 断言（防两边漂移）。
$harnessOptionalVars = @(
    "proactiveNote", "evidence", "previousState", "relationshipMemory", "facts",
    "navigation", "historyResults", "budget", "draft", "check",
    # S3（2026-10-16）：主动来信.md 的 {{memory}} / {{anchors}} 可缺省（无记忆 / 无语料锚时按空串渲染）。
    "memory", "anchors",
    # S9（2026-10-16）：近况层 {{drift}} 可缺省 —— 第 0 档（0–3 封）与「调用方没传档位」都渲染成空串。
    # ⚠️ 必须与 harness-manifest.json 的 optionalVariables 集合一致（strict-render 套件断言两侧逐项相同）。
    "drift"
)
# 宽松匹配：容忍 `{{ x }}` 这种带空格的写法（旧代码只认紧凑写法，带空格就静默漏替换）
$harnessVarPattern = "\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}"
# 替换必须用字面 .Replace，且**不能用 -f 去拼占位符**：格式化器会把 `{{`/`}}` 折叠成 `{`/`}`，
# `"{{%s}}" -f "ctx"` 得到的是 `{ctx}` 而不是 `{{ctx}}` —— 于是静默不替换（2026-10-16 实测踩过）。

function Expand-Harness([string]$text, [hashtable]$map) {
    $preview = ($text -replace "\s+", " ").Trim()
    if ($preview.Length -gt 60) { $preview = $preview.Substring(0, 60) + "..." }
    $names = @([regex]::Matches($text, $harnessVarPattern) |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    foreach ($k in $names) {
        if (-not $map.ContainsKey($k)) {
            throw ("harness template uses an unregistered variable {{" + $k + "}} (template starts with: " + $preview + ")")
        }
        $v = $map[$k]
        $s = if ($null -eq $v) { "" } else { [string]$v }
        if ([string]::IsNullOrWhiteSpace($s) -and -not ($harnessOptionalVars -contains $k)) {
            throw ("harness required variable is empty: {{" + $k + "}} (template starts with: " + $preview + ")")
        }
    }
    $out = $text
    foreach ($k in $names) {
        $v = $map[$k]
        $s = if ($null -eq $v) { "" } else { [string]$v }
        # S4（2026-10-17 发版前必修清单）：旧写法只补「紧凑」与「恰好一个空格」两种形态，
        # 而 $harnessVarPattern 用 \s* 任意空白 ⇒ 模板写成 `{{  drift  }}`（两个空格）时
        # 校验阶段能匹配、替换阶段一个都不命中，最后**被上面那段「残留检查」抛错炸掉整封信生成**。
        # 与其让它在几行之后才炸（错误信息指向「未替换占位符」，看不出真正原因是形态不支持），
        # 不如在这里按正则统一替换：\s* 能匹配到的形态，Replace 就一定处理掉。
        $out = [regex]::Replace($out, "\{\{\s*" + [regex]::Escape($k) + "\s*\}\}", { param($m) $s })
    }
    foreach ($k in $names) {
        if ([regex]::IsMatch($out, "\{\{\s*" + [regex]::Escape($k) + "\s*\}\}")) {
            throw ("harness prompt still has an unreplaced placeholder {{" + $k + "}} (template starts with: " + $preview + ")")
        }
    }
    return $out
}

function Get-HarnessPrompt([string]$fileName) {
    $path = Join-Path $HarnessDir $fileName
    if (-not (Test-Path -LiteralPath $path)) { throw ("missing harness prompt: " + $path) }
    $raw = Read-Utf8 $path
    $sysMarker = "## System"
    $userMarker = "## User"
    $iSys = $raw.IndexOf($sysMarker)
    $iUser = $raw.IndexOf($userMarker)
    if ($iSys -lt 0 -or $iUser -lt 0 -or $iUser -le $iSys) {
        throw ("harness prompt need ## System and ## User: " + $path)
    }
    $sys = $raw.Substring($iSys + $sysMarker.Length, $iUser - $iSys - $sysMarker.Length).Trim()
    $user = $raw.Substring($iUser + $userMarker.Length).Trim()
    return @{ System = $sys; User = $user }
}

if ([string]::IsNullOrWhiteSpace($RulesFile)) { $RulesFile = Join-Path $Root ".cursor\rules\linli-letters.mdc" }
if (-not [IO.Path]::IsPathRooted($RulesFile)) { $RulesFile = Join-Path $Root $RulesFile }
$personaPath = Join-Path $Root ((-join @([char]0x6797, [char]0x79BB, [char]0x4EBA, [char]0x8BBE)) + ".md")
$archDir = -join @([char]0x4FE1, [char]0x4EF6, [char]0x5F80, [char]0x6765)
# S6 两端同步：规则与人设一律「整份读」，不再靠标题嗅探。
#   旧实现 Take-FromHeading 有两种静默行为：标题缺失 ⇒ 整份返回（fail-open）；标题之前有内容 ⇒ 静默丢掉那部分。
#   写法.md（首行 # 写法）与 林离人设.md（首行 # 林离 / Olivia Lin 人设，## 基础 在第三行）都必须整份进 prompt。
#   Strip-Yaml 保留，职责只剩「去 front matter」，与切片无关。
$rules = Strip-Yaml (Read-Utf8 $RulesFile)
$persona = Strip-Yaml (Read-Utf8 $personaPath)
$fields = (Read-Utf8 (Join-Path $HarnessDir ("00-" + (-join @([char]0x680F, [char]0x76EE)) + ".md"))).Trim()

# S9（2026-10-16 两端同步 · 近况层）：按档取「她怎么写」的增量文案，拼成 {{drift}}。
# 载体 harness\近况.md 的格式约定（由 test/harness-behavior-params.test.js 看守）：
#   `## 第 N 档` 开一段，段内每个 `- ` 开头的行为一条；第 2 档起**累积**（注入第 3 档 = 第 1+2+3 档）。
# 档位 ≤ 0（含调用方没传的 -1）⇒ 返回空串，不注入任何东西。
# ⚠️ 本函数只做「取文案 + 拼接」，不读数据库、不算档位：信件数只有调用方（server.js）知道，
#    档位由它算好通过 -DriftTier 传进来 —— 这样脚本不碰库，两端也容易对齐同一档。
function Get-DriftText([int]$Tier, [string]$Dir) {
    if ($Tier -le 0) { return "" }
    $path = Join-Path $Dir ((-join @([char]0x8FD1, [char]0x51B5)) + ".md")
    if (-not (Test-Path -LiteralPath $path)) { throw ("missing near-term carrier: " + $path) }
    $raw = Read-Utf8 $path
    $parts = @()
    for ($n = 1; $n -le $Tier; $n++) {
        $m = [regex]::Match($raw, "(?ms)^##\s*第\s*" + $n + "\s*档.*?(?=^##\s|\z)")
        if (-not $m.Success) { throw ("near-term carrier has no tier " + $n + ": " + $path) }
        $body = @($m.Value -split '\r?\n' | Where-Object { $_ -match '^\s*-\s' })
        if ($body.Count -eq 0) { throw ("near-term tier " + $n + " has no bullet: " + $path) }
        $parts += $body
    }
    # 标题由引擎层带上：档位 > 0 才有这一段；档位 ≤ 0 时返回空串，模板里那一行自然消失。
    return ("# 近况（她最近怎么写 —— 只影响表达倾向，不新增任何事实）`n`n" + ($parts -join "`n"))
}
$driftText = Get-DriftText -Tier $DriftTier -Dir $HarnessDir

# 主动信专属规则已抽成独立规范文件（harness\主动来信.md，两端同步 S3）：
# -Proactive 时把它的 ## System 段并进 {rules}，多步链路仍拿得到主动信口径（单步渲染见该文件的 TODO S3b）。
if ($Proactive) {
    $proactiveRulesName = (-join @([char]0x4E3B, [char]0x52A8, [char]0x6765, [char]0x4FE1)) + ".md"
    $proactiveRules = (Get-HarnessPrompt $proactiveRulesName).System
    $rules = $rules + "`n`n" + $proactiveRules
    # S4（2026-10-16 两端同步）：调性锚（harness\主动信语料.md）随主动信规则一起进 {rules}。
    # 它整份就是五封锚文（没有 ## System / ## User 分段），所以整份读，不走 Get-HarnessPrompt。
    # 文件头的两条引用块也一并进 prompt —— 那是写给模型的「只学长度、口气、落点，不得套用」声明，
    # 不是给维护者看的注释，删掉它就等于把「不得改写扩写」这条唯一的约束拿掉。
    $anchorsName = (-join @([char]0x4E3B, [char]0x52A8, [char]0x4FE1, [char]0x8BED, [char]0x6599)) + ".md"
    $anchorsPath = Join-Path $HarnessDir $anchorsName
    if (-not (Test-Path -LiteralPath $anchorsPath)) { throw ("missing proactive anchors: " + $anchorsPath) }
    $anchors = (Read-Utf8 $anchorsPath).Trim()
    if ([string]::IsNullOrWhiteSpace($anchors)) { throw ("empty proactive anchors: " + $anchorsPath) }
    $rules = $rules + "`n`n# 调性锚（只学它们的长度、口气和落点，不得改写、扩写、拼接或套用其中的句子）`n`n" + $anchors
}

Write-Output ("STEP0 memory " + $Person + " " + $nn)
$arch = Join-Path $Root ("{0}\{1}.md" -f $archDir, $Person)
if (-not [string]::IsNullOrWhiteSpace($ArchivePath)) { $arch = $ArchivePath }
$openingPath = Join-Path $HarnessDir ((-join @([char]0x5F00, [char]0x4FE1)) + ".md")
if (-not (Test-Path -LiteralPath $openingPath)) { $openingPath = Join-Path $Root ("harness\" + (-join @([char]0x5F00, [char]0x4FE1)) + ".md") }
$ctx = Build-Memory -Root $Root -Person $Person -N $N -ArchivePath $arch -OpeningPath $openingPath -Proactive:$Proactive
$factCtx = Build-FactMemory -Root $Root -Person $Person -N $N -ArchivePath $arch -OpeningPath $openingPath -Proactive:$Proactive
if ([string]::IsNullOrWhiteSpace($HistoryFile)) {
    $historySnapshot = New-HistorySnapshotFromArchive -ArchivePath $arch -Person $Person -BeforeN $N
}
else {
    if (-not [IO.Path]::IsPathRooted($HistoryFile)) { $HistoryFile = Join-Path $Root $HistoryFile }
    $historySnapshot = Read-HistorySnapshot -Path $HistoryFile
    if ([string]$historySnapshot.person -ne $Person) { throw "history snapshot person mismatch" }
}
# 主动写信：给 prompt 的补充说明。回信路径下是空串，{{proactiveNote}} 展开后不留痕。
$proactiveNote = ""
if ($Proactive) {
    $proactiveNote = "【本次是她主动写信】没有他的新来信。文末的「由头」是这次想写信的原因，不是他说的话；他此前说过什么，只看上面的往来原文。"
}
if (-not [string]::IsNullOrWhiteSpace($PreviousReplyOverrideFile)) {
    if ($N -lt 2) { throw "previous reply override requires N >= 2" }
    if (-not [IO.Path]::IsPathRooted($PreviousReplyOverrideFile)) { $PreviousReplyOverrideFile = Join-Path $Root $PreviousReplyOverrideFile }
    if (-not (Test-Path -LiteralPath $PreviousReplyOverrideFile)) { throw ("previous reply override not found: " + $PreviousReplyOverrideFile) }
    $overrideReply = (Read-Utf8 $PreviousReplyOverrideFile).Trim()
    $linliHeading = "#### " + (-join @([char]0x6797, [char]0x79BB))
    $targetHeading = "## " + (-join @([char]0x8981, [char]0x56DE, [char]0x7684, [char]0x6765, [char]0x4FE1))
    if ($Proactive) { $targetHeading = "## " + (-join @([char]0x8FD9, [char]0x6B21, [char]0x7531, [char]0x4F60, [char]0x5148, [char]0x5199)) }
    $replyHeadingStart = $ctx.LastIndexOf($linliHeading)
    $targetHeadingStart = $ctx.IndexOf($targetHeading, $replyHeadingStart)
    if ($replyHeadingStart -lt 0 -or $targetHeadingStart -lt 0) { throw "cannot locate previous reply in memory context" }
    $replyHeadingEnd = $ctx.IndexOf("`n", $replyHeadingStart)
    if ($replyHeadingEnd -lt 0 -or $replyHeadingEnd -ge $targetHeadingStart) { throw "cannot locate previous reply heading end" }
    $ctx = $ctx.Substring(0, $replyHeadingEnd + 1) + "`n" + $overrideReply + "`n`n" + $ctx.Substring($targetHeadingStart)
    $replyHeadingStart = $factCtx.LastIndexOf($linliHeading)
    $targetHeadingStart = $factCtx.IndexOf($targetHeading, $replyHeadingStart)
    if ($replyHeadingStart -lt 0 -or $targetHeadingStart -lt 0) { throw "cannot locate previous reply in fact context" }
    $replyHeadingEnd = $factCtx.IndexOf("`n", $replyHeadingStart)
    if ($replyHeadingEnd -lt 0 -or $replyHeadingEnd -ge $targetHeadingStart) { throw "cannot locate previous reply heading end in fact context" }
    $factCtx = $factCtx.Substring(0, $replyHeadingEnd + 1) + "`n" + $overrideReply + "`n`n" + $factCtx.Substring($targetHeadingStart)
}

$relationshipLabel = -join @([char]0x4F60, [char]0x4EEC, [char]0x7684, [char]0x5173, [char]0x7CFB)
$progressLabel = -join @([char]0x4F60, [char]0x4EEC, [char]0x5173, [char]0x7CFB, [char]0x8FDB, [char]0x5C55, [char]0x7684, [char]0x5173, [char]0x952E, [char]0x70B9)
$relationshipMemoryLines = @(
    ($ctx -split "`r?`n") |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.StartsWith($relationshipLabel) -or $_.StartsWith($progressLabel) }
)
$relationshipMemory = "无"
if ($relationshipMemoryLines.Count -gt 0) { $relationshipMemory = [string]::Join("`n", $relationshipMemoryLines) }

$stateBootstrapRequired = $InitializeState
$previousState = "无（未启用上一轮状态传递）"
if (-not [string]::IsNullOrWhiteSpace($PreviousStateTag)) {
    if ($N -eq 1) {
        $previousState = "无（首封，无上一轮状态）"
        $stateBootstrapRequired = $true
    }
    else {
        $previousNn = "{0:D2}" -f ($N - 1)
        $previousStatePath = Join-Path $probe ("h4_{0}_{1}_{2}_1safe.txt" -f $Person, $previousNn, $PreviousStateTag)
        if (-not (Test-Path -LiteralPath $previousStatePath)) {
            if (-not $AllowStateBootstrap) { throw ("missing previous state: " + $previousStatePath) }
            $previousState = "无（缺少前置账本；依据全部可见历史初始化）"
            $stateBootstrapRequired = $true
        }
        else {
            $previousSafeLines = @(
                ((Read-Utf8 $previousStatePath) -split "`r?`n") |
                    ForEach-Object { $_.Trim() } |
                    Where-Object { $_.Length -gt 0 }
            )
            # 跨封继承的持久字段。未决与说话者必须继承（上一封未决的项，本封没有原文确认前仍是未决）；
            # 摘要待核实按封重算，故意不在此列。
            $statePrefixes = @("关系　", "关系依据　", "已承认情感　", "已承认称呼　", "既有亲密　", "既有边界　", "亲密上限　", "说话者　", "未决　")
            $stateLines = @(
                $previousSafeLines |
                    Where-Object {
                        $line = $_
                        @($statePrefixes | Where-Object { $line.StartsWith($_) }).Count -gt 0
                    }
            )
            if ($stateLines.Count -lt 4) { throw ("invalid previous state: " + $previousStatePath) }
            $previousState = [string]::Join("`n", $stateLines)
        }
    }
}

# STEP1: safety gate (was writing card)
$precheckPrompt = "01-" + (-join @([char]0x9884, [char]0x68C0)) + ".md"
if ($stateBootstrapRequired) {
    $precheckPrompt = "01-" + (-join @([char]0x521D, [char]0x59CB, [char]0x5316, [char]0x8D26, [char]0x672C)) + ".md"
}
if (-not [string]::IsNullOrWhiteSpace($PrecheckFile)) { $precheckPrompt = $PrecheckFile }
$precheckPath = Join-Path $HarnessDir $precheckPrompt
$p1 = Get-HarnessPrompt $precheckPrompt
if ([string]::IsNullOrWhiteSpace($ReuseSafeTag)) {
    $map1 = @{ ctx = $ctx; rules = $rules; previousState = $previousState; relationshipMemory = $relationshipMemory; proactiveNote = $proactiveNote }
    $sysSafe = Expand-Harness $p1.System $map1
    $userSafe = Expand-Harness $p1.User $map1
    Write-Output ("STEP1 safe " + $Person + " " + $nn)
    $safe = Invoke-Ds -System $sysSafe -User $userSafe
}
else {
    $reuseSafePath = Join-Path $probe ("h4_{0}_{1}_{2}_1safe.txt" -f $Person, $nn, $ReuseSafeTag)
    if (-not (Test-Path -LiteralPath $reuseSafePath)) { throw ("missing reused precheck: " + $reuseSafePath) }
    Write-Output ("STEP1 reuse-safe " + $Person + " " + $nn + " from=" + $ReuseSafeTag)
    $safe = Read-Utf8 $reuseSafePath
}
Save-Step "1safe" $safe
Lap "T1safe"

$expectedSafeLines = 8
$ledgerLineWords = @{ "八" = 8; "九" = 9; "十" = 10; "十一" = 11; "十二" = 12; "十三" = 13; "十四" = 14; "十五" = 15; "十六" = 16; "十七" = 17; "十八" = 18; "十九" = 19; "二十" = 20 }
$ledgerContractMatch = [regex]::Match($p1.System, "只输出以下([一二三四五六七八九十]+)行")
# S4（2026-10-17 发版前必修清单）：解析不到时**静默退回默认 8**是 fail-open ——
# 预检模板若改成「只输出下列若干行」这类说法，expectedSafeLines 永远是 8，而实际要求 17 行，
# Test-SafeLedgerFormat 会拿「行数 ≠ 8」把每一封合规的信全判违规（或反过来放过不合规的）。
# 行数校验本身拿不到契约就**不该继续猜**，直接抛错让人改模板措辞。
if (-not $ledgerContractMatch.Success) {
    throw ("precheck prompt does not declare its ledger line count (expected wording like 只输出以下十七行): " + $precheckPath)
}
$ledgerLineWord = $ledgerContractMatch.Groups[1].Value
if (-not $ledgerLineWords.ContainsKey($ledgerLineWord)) {
    throw ("precheck prompt declares an unparsable ledger line count: " + $ledgerLineWord + "行")
}
$expectedSafeLines = $ledgerLineWords[$ledgerLineWord]
$safeLines = @(($safe -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
$fullWidthSpace = [string][char]0x3000
$conclusionWord = -join @([char]0x7ED3, [char]0x8BBA)
$allowedRelationships = @()
if ($expectedSafeLines -ge 13) {
    $relationshipWord = -join @([char]0x5173, [char]0x7CFB)
    $relationshipDefinition = @(
        ($p1.System -split "`r?`n") |
            Where-Object { $_.StartsWith($relationshipWord + $fullWidthSpace) }
    )[0]
    $allowedRelationships = @(
        $relationshipDefinition.Substring($relationshipDefinition.IndexOf($fullWidthSpace) + 1) -split ([string][char]0xFF0F)
    )
}
function Test-SafeLedgerFormat([string]$Text, [int]$ExpectedLines, $Relationships) {
    $lines = @(($Text -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    if ($lines.Count -ne $ExpectedLines) { return $false }
    if (@($lines | Where-Object { $_.IndexOf($fullWidthSpace) -lt 1 }).Count -gt 0) { return $false }
    if (-not $lines[$ExpectedLines - 1].StartsWith($conclusionWord)) { return $false }
    if ($Text -match "(?m)^\s*(#|---)") { return $false }
    if ($ExpectedLines -ge 13) {
        $relationshipValue = $lines[4].Substring($lines[4].IndexOf($fullWidthSpace) + 1).Trim()
        if (-not ($Relationships -contains $relationshipValue)) { return $false }
    }
    return $true
}
# ---- 禁补史机械护栏（2026-10-16）-----------------------------------------------
# 为什么需要它：harness/04-尾端检查.md 的「历史证据」一栏要求「草稿引用的旧话、
# 旧称呼、旧约定、旧动作或共同事实，必须能在近期原文或带 ID 与哈希的检索原文中
# 找到」，但那一栏的「过 / 违规」也是**模型自己**写的 —— 模型写「过」就真的过了，
# 全链没有第二层独立去看草稿。这一层不看模型结论，只做一件机械的事：
#   本轮一篇原文证据都没取到（$historyEvidence.Count -eq 0），草稿却对过去做了
#   具体断言（命中下面的措辞表）⇒ 判违规，与模型自报的违规同等处理（走 STEP5 重写）。
# 为什么不会误伤：只在「零证据」时触发（与上面 :299 / :322 的强制检索同源）；
# 有证据时完全交给 STEP4 的逐句核对。词表刻意只收「指代更早」的措辞 ——
# 用户本封信里刚说的话一般不会用「上次 / 上回 / 以前 / 还记得」这些词。
# 中文用码点拼：与本文件既有的 $blockWord / $badWord 保持一致，避免编码差异吃掉判定词。
$historyClaimWords = @(
    (-join @([char]0x4E0A, [char]0x6B21)),                                                     # 上次
    (-join @([char]0x4E0A, [char]0x56DE)),                                                     # 上回
    (-join @([char]0x4E0A, [char]0x5C01)),                                                     # 上封
    (-join @([char]0x524D, [char]0x4E9B, [char]0x5929)),                                       # 前些天
    (-join @([char]0x8FD8, [char]0x8BB0, [char]0x5F97)),                                       # 还记得
    (-join @([char]0x4F60, [char]0x8DDF, [char]0x6211, [char]0x8BF4, [char]0x8FC7)),           # 你跟我说过
    (-join @([char]0x4F60, [char]0x8BB2, [char]0x8FC7)),                                       # 你讲过
    (-join @([char]0x4F60, [char]0x7B54, [char]0x5E94, [char]0x8FC7)),                         # 你答应过
    (-join @([char]0x6BCF, [char]0x6B21, [char]0x4F60, [char]0x90FD)),                         # 每次你都
    (-join @([char]0x4F60, [char]0x4EE5, [char]0x524D, [char]0x603B, [char]0x662F))            # 你以前总是
)
function Get-DraftHistoryClaims([string]$Draft, [int]$EvidenceCount) {
    if ($EvidenceCount -gt 0) { return @() }
    if ([string]::IsNullOrWhiteSpace($Draft)) { return @() }
    $pattern = ($historyClaimWords | ForEach-Object { [regex]::Escape($_) }) -join '|'
    return @(
        ($Draft -split "`r?`n") |
            Where-Object { $_.Trim().Length -gt 0 -and $_ -match $pattern } |
            ForEach-Object { $_.Trim() }
    )
}
$invalidSafe = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
if ($invalidSafe -and [string]::IsNullOrWhiteSpace($ReuseSafeTag)) {
    Write-Output ("STEP1 repair-format " + $Person + " " + $nn)
    $repairSystem = $p1.System + "`n`n上一版输出格式不合格。重新执行原任务，字段不可省略；只输出规定行数与规定字段，不要解释。"
    $repairUser = $userSafe + "`n`n格式不合格的上一版输出：`n" + $safe
    $safe = Invoke-Ds -System $repairSystem -User $repairUser
    Save-Step "1safe" $safe
    $safeLines = @(($safe -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    $invalidSafe = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
}
if ($invalidSafe) { throw "STEP1 precheck format invalid" }

if ($StopAfterSafe) {
    Write-Output ("HARNESS1 DONE {0} {1}{2} total={3}s" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
    return
}

$blockWord = -join @([char]0x62E6, [char]0x622A)
if ($safe -match $blockWord) {
    Save-Step "5final" ("[BLOCKED]`n" + $safe)
    Write-Output ("STEP1 blocked " + $Person + " " + $nn)
    Write-Output ("HARNESS5 DONE {0} {1}{2} total={3}s blocked=1" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
    return
}

$historyBudget = New-HistoryBudget
$historyResults = @()
$historyEvidence = @()
$historyAudit = @()
$historyTermination = "planner-finished"
$historyPrompt = Get-HarnessPrompt ("02-" + (-join @([char]0x5386, [char]0x53F2, [char]0x68C0, [char]0x7D22)) + ".md")
$historyPlannerThinking = $script:DsThinking
Set-DsThinking -On $false
$historicalProofRequired = $safe -match "(?m)^事实伪造　有　.*(往来|旧信|上封|以前|之前|曾经|叫过|写过|说过|记得)"
for ($historyRound = 1; $historyRound -le 2; $historyRound++) {
    $remainingSeconds = [Math]::Max(0, 45 - [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalSeconds))
    $budgetText = "轮次 $historyRound/2；查询 $($historyBudget.queryCount)/4；完整往来 $($historyBudget.fullReads)/3；字符 $($historyBudget.characters)/12000；时间剩余 ${remainingSeconds}s"
    $resultText = "无（尚未检索）"
    if ($historyResults.Count -gt 0) { $resultText = $historyResults | ConvertTo-Json -Depth 8 }
    $historyMap = @{
        safe = $safe
        navigation = $ctx
        proactiveNote = $proactiveNote
        facts = $factCtx
        historyResults = $resultText
        budget = $budgetText
    }
    Write-Output ("STEP2 history-plan round=" + $historyRound + " " + $Person + " " + $nn)
    $intent = Invoke-DsJson `
        -System (Expand-Harness $historyPrompt.System $historyMap) `
        -User (Expand-Harness $historyPrompt.User $historyMap)
    $historyAudit += [pscustomobject]([ordered]@{
        round = $historyRound
        intent = $intent
        finishReason = $script:DsLastFinishReason
        usage = $script:DsLastUsage
    })
    Save-Step ("2history_{0}_intent" -f $historyRound) ($intent | ConvertTo-Json -Depth 8)
    $hasCandidates = @($historyResults | Where-Object { $_.kind -eq "candidate" }).Count -gt 0
    if ([string]$intent.action -eq "finish" -and $historyEvidence.Count -eq 0 -and ($hasCandidates -or $historicalProofRequired)) {
        $repairContext = if ($hasCandidates) { $resultText } else { "无候选；请先 search，或按暂定账本指出的往来顺序直接 read。" }
        $finishRepairMap = @{
            safe = $safe
            navigation = $ctx
        proactiveNote = $proactiveNote
            facts = $factCtx
            historyResults = "暂定账本正在判断一项历史真伪，当前来信自己的引文不是证据，你尚未取得完整历史原文，不能 finish。必须 read 或 neighbors；没有候选时先 search，或按账本指出的往来顺序直接 read。`n" + $repairContext
            budget = $budgetText
        }
        $intent = Invoke-DsJson `
            -System (Expand-Harness $historyPrompt.System $finishRepairMap) `
            -User (Expand-Harness $historyPrompt.User $finishRepairMap)
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            contractRepair = "historical claim requires original evidence"
            repairedIntent = $intent
            finishReason = $script:DsLastFinishReason
            usage = $script:DsLastUsage
        })
        Save-Step ("2history_{0}_intent_repaired" -f $historyRound) ($intent | ConvertTo-Json -Depth 8)
    }
    if ([string]$intent.action -eq "finish") {
        if ($historyEvidence.Count -eq 0 -and $historicalProofRequired) {
            throw "history evidence required but planner did not retrieve original text"
        }
        $historyTermination = "planner-finished: " + [string]$intent.reason
        break
    }
    if ([string]$intent.action -in @("search", "read", "neighbors") -and @($intent.lookups).Count -gt 0) {
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            formatRepair = "normalized top-level action to lookup"
        })
        $intent.action = "lookup"
    }
    if ([string]$intent.action -ne "lookup") {
        $historyTermination = "invalid-action"
        break
    }
    try {
        $retrieved = Invoke-HistoryRetrieval -Snapshot $historySnapshot -Intent $intent -Budget $historyBudget
    }
    catch {
        $rejection = $_.Exception.Message
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            rejection = $rejection
        })
        if ($rejection -match "time budget exceeded") {
            $historyTermination = "retrieval-frozen: " + $rejection
            break
        }
        $repairMap = @{
            safe = $safe
            navigation = $ctx
        proactiveNote = $proactiveNote
            facts = $factCtx
            historyResults = "档案室拒绝上一请求：$rejection。只修复一次；若不能合法检索请 finish。"
            budget = $budgetText
        }
        try {
            $intent = Invoke-DsJson `
                -System (Expand-Harness $historyPrompt.System $repairMap) `
                -User (Expand-Harness $historyPrompt.User $repairMap)
            if ([string]$intent.action -eq "finish") {
                $historyTermination = "planner-finished-after-repair: " + [string]$intent.reason
                break
            }
            if ([string]$intent.action -ne "lookup") { throw "history repaired action invalid" }
            $retrieved = Invoke-HistoryRetrieval -Snapshot $historySnapshot -Intent $intent -Budget $historyBudget
        }
        catch {
            $historyTermination = "retrieval-frozen: " + $_.Exception.Message
            break
        }
    }
    $historyResults += @($retrieved.candidates)
    $historyResults += @($retrieved.evidence)
    $knownEvidence = @{}
    foreach ($item in $historyEvidence) { $knownEvidence[[string]$item.letterId] = $true }
    foreach ($item in @($retrieved.evidence)) {
        if (-not $knownEvidence.ContainsKey([string]$item.letterId)) {
            $historyEvidence += $item
            $knownEvidence[[string]$item.letterId] = $true
        }
    }
    Save-Step ("2history_{0}_result" -f $historyRound) ($retrieved | ConvertTo-Json -Depth 8)
    if ($historyRound -eq 2) { $historyTermination = "round-budget-exhausted" }
}
Set-DsThinking -On $historyPlannerThinking
$historyRetrievalElapsedMs = [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalMilliseconds)

$evidenceText = "无（本轮不需要检索历史原文）"
$reconcileAudit = $null
if ($historyEvidence.Count -gt 0) {
    $reconcileStartedAt = [DateTime]::UtcNow
    $evidenceText = $historyEvidence | ConvertTo-Json -Depth 8
    $provisionalSafe = $safe
    Save-Step "1safe_provisional" $provisionalSafe
    $reconcilePrompt = Get-HarnessPrompt ("02-" + (-join @([char]0x8D26, [char]0x672C, [char]0x6821, [char]0x6B63)) + ".md")
    $reconcileMap = @{ safe = $provisionalSafe; facts = $factCtx; evidence = $evidenceText; proactiveNote = $proactiveNote }
    Write-Output ("STEP2 reconcile " + $Person + " " + $nn)
    Set-DsThinking -On $false
    $safe = Invoke-Ds `
        -System (Expand-Harness $reconcilePrompt.System $reconcileMap) `
        -User (Expand-Harness $reconcilePrompt.User $reconcileMap)
    Save-Step "1safe_reconcile_attempt1" $safe
    $reconcileCalls = 1
    $reconcileUsage = @($script:DsLastUsage)
    $reconcileInvalid = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
    if ($safe -match "(?m)^(关系依据|已承认称呼|既有亲密|既有边界)　.*(五段式|摘要|回忆)") { $reconcileInvalid = $true }
    if ($reconcileInvalid) {
        $reconcileSystem = $reconcilePrompt.System + "`n`n上一版格式或证据来源不合格。只输出规定" + $expectedSafeLines + "行，字段不可省略；最终账本不得把五段式、摘要或回忆写成事实依据，改引近期原文或检索原文的往来顺序/letterId。"
        $safe = Invoke-Ds -System (Expand-Harness $reconcileSystem $reconcileMap) -User (Expand-Harness $reconcilePrompt.User $reconcileMap)
        Save-Step "1safe_reconcile_attempt2" $safe
        $reconcileCalls += 1
        $reconcileUsage += $script:DsLastUsage
    }
    $reconcileInvalid = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
    if ($safe -match "(?m)^(关系依据|已承认称呼|既有亲密|既有边界)　.*(五段式|摘要|回忆)") { $reconcileInvalid = $true }
    if ($reconcileInvalid) {
        throw "STEP2 reconciled ledger format invalid"
    }
    Set-DsThinking -On $historyPlannerThinking
    $reconcileAudit = [ordered]@{
        calls = $reconcileCalls
        finishReason = $script:DsLastFinishReason
        usage = $reconcileUsage
        elapsedMs = [int](([DateTime]::UtcNow - $reconcileStartedAt).TotalMilliseconds)
    }
    Save-Step "1safe" $safe
}

$historyAuditPackage = [ordered]@{
    schema = "olivia-history.audit"
    version = 1
    snapshot = [ordered]@{
        snapshotId = [string]$historySnapshot.snapshotId
        person = [string]$historySnapshot.person
        maxOrder = [int]$historySnapshot.maxOrder
    }
    planner = $historyAudit
    reconcile = $reconcileAudit
    retrievalResults = $historyResults
    evidence = $historyEvidence
    budget = [ordered]@{
        queries = [int]$historyBudget.queryCount
        fullReads = [int]$historyBudget.fullReads
        characters = [int]$historyBudget.characters
        elapsedMs = $historyRetrievalElapsedMs
    }
    totalElapsedMs = [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalMilliseconds)
    terminationReason = $historyTermination
}
Save-Step "2history_audit" ($historyAuditPackage | ConvertTo-Json -Depth 10)
Lap "T2history"

if ([string]::IsNullOrWhiteSpace($DraftFile)) {
    $p3 = Get-HarnessPrompt ("03-" + (-join @([char]0x4E2D, [char]0x6BB5, [char]0x751F, [char]0x6210)) + ".md")
    $map3 = @{ fields = $fields; safe = $safe; rules = $rules; persona = $persona; ctx = $factCtx; evidence = $evidenceText; proactiveNote = $proactiveNote; drift = $driftText }
    $sysDraft = Expand-Harness $p3.System $map3
    $userDraft = Expand-Harness $p3.User $map3
    Write-Output ("STEP3 draft " + $Person + " " + $nn)
    $draft = Invoke-Ds -System $sysDraft -User $userDraft
}
else {
    if (-not [IO.Path]::IsPathRooted($DraftFile)) { $DraftFile = Join-Path $Root $DraftFile }
    if (-not (Test-Path -LiteralPath $DraftFile)) { throw ("draft file not found: " + $DraftFile) }
    Write-Output ("STEP3 reuse-draft " + $Person + " " + $nn)
    $draft = Read-Utf8 $DraftFile
}
Save-Step "3draft" $draft
Lap "T3draft"

$p4 = Get-HarnessPrompt ("04-" + (-join @([char]0x5C3E, [char]0x7AEF, [char]0x68C0, [char]0x67E5)) + ".md")
$map4 = @{ fields = $fields; safe = $safe; persona = $persona; draft = $draft; ctx = $factCtx; evidence = $evidenceText; proactiveNote = $proactiveNote }
$sysCheck = Expand-Harness $p4.System $map4
$userCheck = Expand-Harness $p4.User $map4
Write-Output ("STEP4 check " + $Person + " " + $nn)
$check = Invoke-Ds -System $sysCheck -User $userCheck
Save-Step "4check" $check
Lap "T4check"

$badWord = -join @([char]0x8FDD, [char]0x89C4)
$fullWidthSpace = [string][char]0x3000
$bad = @(
    foreach ($line in ($check -split "`n")) {
        $parts = @($line.Trim() -split [regex]::Escape($fullWidthSpace))
        if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $badWord) { $line }
    }
)
# 禁补史机械护栏：零原文证据 + 草稿引用过去 ⇒ 与模型自报的违规同等处理
$claimLabel = -join @([char]0x5386, [char]0x53F2, [char]0x5F15, [char]0x7528)   # 历史引用
$draftClaims = @(Get-DraftHistoryClaims -Draft $draft -EvidenceCount $historyEvidence.Count)
if ($draftClaims.Count -gt 0) {
    Write-Output ("STEP4 antifabrication " + $Person + " " + $nn + " claims=" + $draftClaims.Count)
    $bad += @($draftClaims | ForEach-Object { $claimLabel + $fullWidthSpace + $badWord + $fullWidthSpace + "本轮没有取到原文证据；" + $_ })
}
if ($bad.Count -eq 0) {
    Save-Step "5final" $draft
    Write-Output ("STEP5 clean " + $Person + " " + $nn)
}
else {
    $check = [string]::Join("`n", $bad)
    $p5 = Get-HarnessPrompt ("05-" + (-join @([char]0x53CD, [char]0x9988, [char]0x91CD, [char]0x5199)) + ".md")
    $map5 = @{ fields = $fields; safe = $safe; check = $check; rules = $rules; persona = $persona; draft = $draft; ctx = $factCtx; evidence = $evidenceText; proactiveNote = $proactiveNote }
    $sysFix = Expand-Harness $p5.System $map5
    $userFix = Expand-Harness $p5.User $map5
    Write-Output ("STEP5 rewrite " + $Person + " " + $nn)
    $final = Invoke-Ds -System $sysFix -User $userFix
    Save-Step "5rewrite" $final
    $recheckMap = @{ fields = $fields; safe = $safe; persona = $persona; draft = $final; ctx = $factCtx; evidence = $evidenceText; proactiveNote = $proactiveNote }
    Write-Output ("STEP5 recheck " + $Person + " " + $nn)
    $recheck = Invoke-Ds `
        -System (Expand-Harness $p4.System $recheckMap) `
        -User (Expand-Harness $p4.User $recheckMap)
    Save-Step "5recheck" $recheck
    $recheckBad = @(
        foreach ($line in ($recheck -split "`n")) {
            $parts = @($line.Trim() -split [regex]::Escape($fullWidthSpace))
            if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $badWord) { $line }
        }
    )
    $recheckClaims = @(Get-DraftHistoryClaims -Draft $final -EvidenceCount $historyEvidence.Count)
    if ($recheckClaims.Count -gt 0) {
        throw ("STEP5 rewritten reply still fabricates history without evidence: " + ($recheckClaims -join " / "))
    }
    if ($recheckBad.Count -gt 0) { throw "STEP5 rewritten reply still violates hard checks" }
    Save-Step "5final" $final
}

Write-Output ("HARNESS5 DONE {0} {1}{2} total={3}s" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
