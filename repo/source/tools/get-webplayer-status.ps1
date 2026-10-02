param(
    [Parameter(Mandatory = $true)][string]$WebplayerPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
if (-not (Test-Path -LiteralPath $WebplayerPath -PathType Leaf)) {
    [ordered]@{ clientFound = $false; mounted = $false; port = $null } | ConvertTo-Json -Compress
    exit 0
}

$stream = [IO.File]::OpenRead($WebplayerPath)
$archive = New-Object -TypeName IO.Compression.ZipArchive -ArgumentList @(
    $stream,
    [IO.Compression.ZipArchiveMode]::Read,
    $false
)
try {
    $entries = @($archive.Entries | Where-Object { $_.FullName -match '^assets/main-[^/]+\.js$' })
    if ($entries.Count -ne 1) { throw "expected one main-*.js, got $($entries.Count)" }
    $reader = New-Object IO.StreamReader($entries[0].Open(), (New-Object System.Text.UTF8Encoding $false))
    try { $text = $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}
finally {
    $archive.Dispose()
    $stream.Dispose()
}

$patchMarker = '/*OliviaSoulPatch:webplayer-instant-seamless-v20*/'
$legacyPatchMarkers = @(
    '/*OliviaSoulPatch:webplayer-instant-seamless-v19*/',
    '/*OliviaSoulPatch:webplayer-instant-seamless-v18*/',
    '/*OliviaSoulPatch:webplayer-lyrics-wallpaper-pause-v16*/',
    '/*OliviaSoulPatch:webplayer-instant-seamless-v17*/',
    '/*OliviaSoulPatch:webplayer-lyrics-pause-bounded-progress-v15*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-bounded-progress-v14*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v13*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v12*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v11*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v10*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v9*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v8*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v7*/',
    '/*OliviaSoulPatch:webplayer-no-watermark-direct-http-progress-v6*/'
)
$watermarkShown = 'S(n)?(k(),we(l,{key:0,uid:S(n)},null,8,["uid"])):Re("",!0)'
$activeMarker = @(@($patchMarker) + $legacyPatchMarkers | Where-Object { $text.StartsWith($_) } | Select-Object -First 1)
$managed = $activeMarker.Count -eq 1 -and
    -not $text.Contains($watermarkShown) -and
    $text.Contains('/toy/player-command') -and
    $text.Contains('/toy/player-state') -and
    $text.Contains('__OliviaSoulPlayerPoll')
$mounted = $managed -and $text.StartsWith($patchMarker)
$revision = if ($managed) { [regex]::Match($activeMarker[0], 'v\d+').Value } else { $null }
# 补丁里写死的服务端口，供调用方比较「补丁端口 vs 本机端口」。
# 提取不到就是 $null —— 它绝不参与 managed/mounted 判定：一旦让已打补丁的文件被误判成
# 「干净原版」，它就会被当成原版备份存起来，之后再也恢复不回去（这是不能用错的地方）。
$port = $null
if ($managed) {
    $portMatches = @([regex]::Matches($text, 'http://127\.0\.0\.1:(\d+)/toy/player-command'))
    $uniquePorts = @($portMatches | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Unique)
    if ($uniquePorts.Count -eq 1) { $port = $uniquePorts[0] }
}
[ordered]@{ clientFound = $true; mounted = $mounted; managed = $managed; updateAvailable = ($managed -and -not $mounted); revision = $revision; port = $port } | ConvertTo-Json -Compress
