# bump-version.ps1 —— 版本号一键同步（薄包装）
#
# 核心逻辑全部在 lib/version-bump.mjs（可被直接 import 测试，不在 Node 侧起子进程：
# 受限沙箱下 child_process + stdio pipe 常报 EPERM）。本脚本只做三件事：
#   1. 参数校验与友好提示（缺 node、Root 不对时不静默放过）
#   2. 把参数透传给 lib/version-bump-cli.mjs
#   3. 透传退出码（0 成功；1 出错；2 -Check 发现有需要更新的位置；3 本包装自身的环境错误）
#
# 用法：
#   .\bump-version.ps1 -Version 2008.2.7-linli9-1.0.5   # 同步到新版本（先扫描、逐处打印、再写盘）
#   .\bump-version.ps1 -Check -Version 2008.2.7-linli9-1.0.5   # 只报不改：是否都已是该版本
#   .\bump-version.ps1 -Check                            # 只报不改：各处版本是否彼此一致
#   .\bump-version.ps1 -Check -Root <local-service 目录>  # 指定服务根（默认脚本上一级的 local-service）
#
# 若本机执行策略禁止运行脚本（本机默认 Restricted），用：
#   powershell -NoProfile -ExecutionPolicy Bypass -File repo\source\tools\bump-version.ps1 -Check
# 退出码：0 成功；1 出错；2 -Check 发现有需要更新的位置；3 本包装自身的环境问题（缺 node / Root 不对）

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version = "",

    [switch]$Check,

    [string]$Root = ""
)

$ErrorActionPreference = "Stop"

$toolsDir = $PSScriptRoot
if (-not $Root) {
    # repo/source/tools → repo/source/local-service
    $Root = Join-Path (Split-Path $toolsDir -Parent) "local-service"
}

if (-not $Version -and -not $Check) {
    Write-Host "[错误] 必须给 -Version <新版本> 或 -Check 之一。" -ForegroundColor Red
    Write-Host "  例：.\bump-version.ps1 -Version 2008.2.7-linli9-1.0.5"
    Write-Host "      .\bump-version.ps1 -Check -Version 2008.2.7-linli9-1.0.5"
    Write-Host "  注意：不要手工改版本号 —— 那正是这个脚本要消灭的做法。"
    exit 1
}

$cli = Join-Path $toolsDir "lib\version-bump-cli.mjs"
if (-not (Test-Path -LiteralPath $cli)) {
    Write-Host "[错误] 找不到核心模块：$cli" -ForegroundColor Red
    exit 3
}

if (-not (Test-Path -LiteralPath (Join-Path $Root "package.json"))) {
    Write-Host "[错误] -Root 指向的目录里没有 package.json：$Root" -ForegroundColor Red
    exit 3
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "[错误] 找不到 node。本脚本只是薄包装，规则与替换逻辑都在 lib\version-bump.mjs，必须有 Node.js（本支要求 >= 22.5）。" -ForegroundColor Red
    Write-Host "  请装好 Node.js 后重试；不要手工改版本号，那正是这个脚本要消灭的做法。"
    exit 3
}

$nodePath = if ($node.Path) { $node.Path } else { $node.Source }

$arguments = @($cli, "--root", $Root)
if ($Version) { $arguments += @("--version", $Version) }
if ($Check) { $arguments += "--check" }

# 输出直接透传（不在 PowerShell 里捕获再转印，避免 AGENTS.md 记的「管道截断提前终止上游」）
& $nodePath @arguments
exit $LASTEXITCODE
