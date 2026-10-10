# B7（2026-10-09 复审）：_probe 目录的回收器。
# 背景：harness-4step.ps1 的 Save-Step 会把每一步中间产物写进 $Root/_probe（账本、历史检索结果、
# 草稿全文、最终回信全文、检查报告），memory-lib.ps1 还会写 _probe/mem_<人>_<NN>.md。
# 这些全是明文信件内容，而以前全仓只删 live_input_*.md，h4_* / mem_* 只写不删 ⇒ 写多少封留多少份。
# 这里的策略是「同一个人只保留最近 Keep 封信」（默认 3 封）：留最近几封够排查，
# PreviousStateTag / ReuseSafeTag 一般也落在最近几封里，不会把还要读的文件删掉。
function Remove-OldProbeFiles {
    param(
        [Parameter(Mandatory = $true)][string]$ProbeDir,
        [string]$Person = "",
        [int]$Keep = 3
    )
    if (-not (Test-Path -LiteralPath $ProbeDir)) { return 0 }
    if ($Keep -lt 1) { throw "Keep must be at least 1" }
    $removed = 0
    $prefixes = @("h4_", "mem_")
    $people = @()
    if (-not [string]::IsNullOrWhiteSpace($Person)) {
        $people = @($Person)
    }
    else {
        $people = @(Get-ChildItem -LiteralPath $ProbeDir -File -ErrorAction SilentlyContinue |
            ForEach-Object { if ($_.Name -match '^(?:h4|mem)_(.+)_\d+') { $Matches[1] } } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    }
    $all = @(Get-ChildItem -LiteralPath $ProbeDir -File -ErrorAction SilentlyContinue)
    foreach ($who in $people) {
        foreach ($prefix in $prefixes) {
            $map = @{}
            $pattern = '^' + [regex]::Escape($prefix + $who + '_') + '(\d+)'
            foreach ($f in $all) {
                if ($f.Name -match $pattern) {
                    $n = [int]$Matches[1]
                    if (-not $map.ContainsKey($n)) { $map[$n] = @() }
                    $map[$n] = @($map[$n]) + @($f.FullName)
                }
            }
            $numbers = @($map.Keys | Sort-Object -Descending)
            if ($numbers.Count -le $Keep) { continue }
            foreach ($n in @($numbers | Select-Object -Skip $Keep)) {
                foreach ($path in @($map[$n])) {
                    try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; $removed++ } catch { }
                }
            }
        }
    }
    return $removed
}