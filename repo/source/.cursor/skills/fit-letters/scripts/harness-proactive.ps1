param(
    [Parameter(Mandatory = $true)][string]$Person,
    [Parameter(Mandatory = $true)][string]$Reason,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$HistoryFile = "",
    [string]$RulesFile = "",
    [string]$Root = ""
)

# 主动写信：这一次没有他的来信，只有「由头」。
# 与 harness-live.ps1 的分工：live 把新来信拼成归档末段（#### 我（信件））后走回信链路；
# 这里把由头拼成归档末段（#### 由头），再带 -Proactive 走同一条链路。
# 归档末段用 #### 由头 而不是 #### 我（信件），是为了让持久档案里不出现「他写过一句由头」这种伪事实。

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Get-Location).Path }
if ($Person -match '[<>:"/\\|?*\x00-\x1F]' -or $Person -eq "." -or $Person -eq "..") {
    throw "invalid person"
}

. (Join-Path $PSScriptRoot "memory-lib.ps1")
$reasonPath = $Reason
if (-not [IO.Path]::IsPathRooted($reasonPath)) { $reasonPath = Join-Path $Root $reasonPath }
if (-not (Test-Path -LiteralPath $reasonPath)) { throw "reason not found: $reasonPath" }
$reasonText = (Read-Utf8 $reasonPath).Trim()
if ([string]::IsNullOrWhiteSpace($reasonText)) { throw "reason is empty" }

$archiveDir = -join @([char]0x4FE1, [char]0x4EF6, [char]0x5F80, [char]0x6765)
$archive = Join-Path $Root ("{0}\{1}.md" -f $archiveDir, $Person)
$raw = ""
$prior = @()
if (Test-Path -LiteralPath $archive) {
    $raw = Read-Utf8 $archive
    $prior = @(Get-ArchiveExchanges -Path $archive)
}
if ([string]::IsNullOrWhiteSpace($raw)) {
    $memoryHeading = "## " + (-join @([char]0x8BB0, [char]0x5FC6))
    $raw = "# local archive - $Person`n`n$memoryHeading`n`n---"
}

$n = 1
if ($prior.Count -gt 0) { $n = [int](($prior | Measure-Object -Property N -Maximum).Maximum) + 1 }
$date = Get-Date -Format "yyyy-MM-dd"
$exchangeHeading = "### " + (-join @([char]0x5F80, [char]0x6765))
$reasonHeading = "#### " + (-join @([char]0x7531, [char]0x5934))
$pending = $raw.TrimEnd() + "`n`n## $date`n`n$exchangeHeading $('{0:D2}' -f $n)`n`n$reasonHeading`n`n$reasonText"

$probe = Join-Path $Root "_probe"
if (-not (Test-Path -LiteralPath $probe)) { New-Item -ItemType Directory -Path $probe | Out-Null }
$temporaryArchive = Join-Path $probe ("proactive_input_{0}.md" -f [Guid]::NewGuid().ToString("N"))
Write-Utf8 $temporaryArchive $pending
try {
    $harness = Join-Path $PSScriptRoot "harness-4step.ps1"
    if ([string]::IsNullOrWhiteSpace($RulesFile)) {
        $rulesName = (-join @([char]0x5199, [char]0x6CD5)) + ".md"
        $RulesFile = Join-Path (Join-Path $Root "harness") $rulesName
    }
    $invokeArgs = @{
        Person = $Person
        N = $n
        Root = $Root
        ArchivePath = $temporaryArchive
        OutFile = $OutFile
        RulesFile = $RulesFile
        Tag = "proactive"
        PreviousStateTag = "live"
        AllowStateBootstrap = $true
        Proactive = $true
        Quiet = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($HistoryFile)) { $invokeArgs.HistoryFile = $HistoryFile }
    & $harness @invokeArgs
    if (-not (Test-Path -LiteralPath $OutFile)) { throw "harness did not produce a letter" }
    $letter = (Read-Utf8 $OutFile).Trim()
    if ($letter.StartsWith("[BLOCKED]")) { throw "letter was blocked by the safety gate" }
    if ([string]::IsNullOrWhiteSpace($letter)) { throw "harness returned an empty letter" }
}
finally {
    Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
}
Write-Output "HARNESS PROACTIVE DONE"
