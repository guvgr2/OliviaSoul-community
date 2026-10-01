# 一键自证：pre-commit 门禁到底会不会拦住人。
#
# 用法（自己的终端里跑；受限沙箱里只能跑第 1 段）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File .githooks\verify-hook.ps1
#     powershell -NoProfile -ExecutionPolicy Bypass -File .githooks\verify-hook.ps1 -Keep   # 保留副本目录排查
#
# 它做的事：在系统临时目录造一个**副本仓库**（绝不碰主仓库），然后
#   第 1 段（任何环境都能跑）：直接跑门禁用的两个套件，看三种仓库状态下的退出码
#        干净 / 含本机私有路径的文件 / 版本漂移
#   第 2 段（需要能执行 POSIX sh 的环境）：真实跑 git commit，验证
#        A 干净提交通过 · B 含私有路径的提交被拒 · C 版本漂移提交被拒 ·
#        D checkout 之后 hook 仍是 LF（.githooks/.gitattributes 在起作用）
#
# 受限沙箱（DSH 之类）里 msys 的 sh.exe 起不来（"couldn't create signal pipe, Win32 error 5"），
# git 的 hook 机制整体不可用 —— 第 2 段会被自动跳过并说明原因，别误判成门禁坏了。
param([switch]$Keep)

$ErrorActionPreference = "Stop"

$hookDir = $PSScriptRoot
$repo = Split-Path $hookDir -Parent
$svc = Join-Path $repo "repo\source\local-service"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[FAIL] 找不到 node —— 门禁本身也会因此拦住提交，先装 Node.js。"
  exit 3
}

$clone = Join-Path ([System.IO.Path]::GetTempPath()) ("olivia-gate-check-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$dst = Join-Path $clone "repo\source\local-service"
New-Item -ItemType Directory -Force -Path (Join-Path $clone ".githooks"), (Join-Path $dst "test"), (Join-Path $dst "native-host"), (Join-Path $dst "packaging"), (Join-Path $dst "public") | Out-Null
Copy-Item (Join-Path $hookDir "pre-commit") (Join-Path $clone ".githooks\pre-commit")
Copy-Item (Join-Path $hookDir ".gitattributes") (Join-Path $clone ".githooks\.gitattributes")
$versionFiles = @("package.json", "package-lock.json", "native-host\OliviaSoul.csproj", "packaging\build-release.ps1", "public\listen-naming-feedback.js")
foreach ($rel in $versionFiles + @("test\version-sync.test.js", "test\repo-privacy.test.js")) {
  Copy-Item (Join-Path $svc $rel) (Join-Path $dst $rel)
}
Write-Host "副本仓库：$clone"

Push-Location $clone
& git init -q
& git config user.name "gate self-check"
& git config user.email "gate@example.invalid"
& git config core.hooksPath .githooks

$t1 = "repo/source/local-service/test/repo-privacy.test.js"
$t2 = "repo/source/local-service/test/version-sync.test.js"
$log = Join-Path $clone "gate.log"
$fail = 0

function Invoke-GateCheck([string]$label, [int]$expected) {
  & node --test --experimental-test-isolation=none $t1 $t2 > $log 2>&1
  $code = $LASTEXITCODE
  if ($code -eq $expected) {
    Write-Host ("  [PASS] {0}：退出码 {1}" -f $label, $code)
  } else {
    Write-Host ("  [FAIL] {0}：退出码 {1}，期望 {2}" -f $label, $code, $expected)
    Write-Host "        测试输出里的线索（若这里列的是本仓库自己命中的私有路径，说明门禁是红的，先修它）："
    Select-String -Path $log -Pattern "命中|不一致|AssertionError" -Encoding UTF8 | Select-Object -First 4 | ForEach-Object { Write-Host ("         " + $_.Line.Trim()) }
    $script:fail++
  }
  return $code
}

Write-Host ""
Write-Host "=== 第 1 段：门禁判定（两个套件在三种仓库状态下的退出码）==="

Write-Host "  1a) 干净树"
& git add -A | Out-Null
Invoke-GateCheck "干净树应放行" 0 | Out-Null

Write-Host "  1b) 加入一个含本机私有路径的文件"
$needle = "E:" + "\olivia_tool" + "\soul-integration"
[System.IO.File]::WriteAllText((Join-Path $clone "private-note.txt"), "temp script lives in $needle`r`n", (New-Object System.Text.UTF8Encoding($false)))
& git add -A | Out-Null
Invoke-GateCheck "含私有路径应被拦" 1 | Out-Null
Write-Host "       被拦下的命中行："
Select-String -Path $log -Pattern "命中" -Encoding UTF8 | Select-Object -First 3 | ForEach-Object { Write-Host ("         " + $_.Line.Trim()) }

Write-Host "  1c) 版本漂移（只改 package.json 的 version）"
& git rm -q --cached private-note.txt | Out-Null
Remove-Item (Join-Path $clone "private-note.txt") -Force
$pkgPath = Join-Path $dst "package.json"
$pkg = [System.IO.File]::ReadAllText($pkgPath)
$m = [regex]::Match($pkg, '"version"\s*:\s*"([^"]+)"')
if (-not $m.Success) { throw "副本 package.json 里找不到 version 字段" }
$oldVersion = $m.Groups[1].Value
[System.IO.File]::WriteAllText($pkgPath, $pkg.Replace($oldVersion, $oldVersion + "-gatecheck"), (New-Object System.Text.UTF8Encoding($false)))
& git add -A | Out-Null
Invoke-GateCheck "版本漂移应被拦" 1 | Out-Null
Write-Host "       被拦下的原因："
Select-String -Path $log -Pattern "不一致" -Encoding UTF8 | Select-Object -First 2 | ForEach-Object { Write-Host ("         " + $_.Line.Trim()) }

Write-Host ""
Write-Host "=== 第 2 段：真实 git commit（需要能执行 POSIX sh 的环境）==="
$sh = "C:\Program Files\Git\usr\bin\sh.exe"
if (-not (Test-Path $sh)) {
  $found = Get-Command sh.exe -ErrorAction SilentlyContinue
  if ($found) { $sh = $found.Source }
}
$shOk = $false
if ($sh) {
  try { & $sh -c "exit 0" 2>$null | Out-Null; $shOk = ($LASTEXITCODE -eq 0) } catch { $shOk = $false }
}

if (-not $shOk) {
  Write-Host "  [SKIP] 本环境无法执行 POSIX sh，git 的 hook 机制整体不可用，第 2 段无法进行。"
  Write-Host "         这不是门禁的毛病（一个只写 'exit 0' 的空白 hook 在这里同样跑不起来）。"
  Write-Host "         请在普通终端里重跑本脚本，或在能跑 sh 的环境里执行 git commit 验证。"
} else {
  foreach ($rel in $versionFiles) { Copy-Item (Join-Path $svc $rel) (Join-Path $dst $rel) -Force }
  Remove-Item $log -Force -ErrorAction SilentlyContinue
  & git add -A | Out-Null

  Write-Host "  A) 干净提交（期望：通过）"
  & git commit -m "gate check: clean commit"
  $codeA = $LASTEXITCODE
  if ($codeA -ne 0) { Write-Host ("  [FAIL] 干净提交被拒，退出码 " + $codeA); $fail++ } else { Write-Host "  [PASS] 干净提交通过" }

  Write-Host "  D) checkout 之后 hook 的行尾（期望：CR=0，即 .gitattributes 的 eol=lf 生效）"
  & git checkout -q -- .githooks/pre-commit
  $hb = [System.IO.File]::ReadAllBytes((Join-Path $clone ".githooks\pre-commit"))
  $cr = ($hb | Where-Object { $_ -eq 13 }).Count
  if ($cr -eq 0) { Write-Host ("  [PASS] CR=" + $cr + "，still LF") } else { Write-Host ("  [FAIL] CR=" + $cr + "，hook 被转成了 CRLF，shebang 会坏") ; $fail++ }

  Write-Host "  B) 含本机私有路径的提交（期望：被拒）"
  [System.IO.File]::WriteAllText((Join-Path $clone "private-note.txt"), "temp script lives in $needle`r`n", (New-Object System.Text.UTF8Encoding($false)))
  & git add -A | Out-Null
  & git commit -m "gate check: dirty commit"
  $codeB = $LASTEXITCODE
  if ($codeB -eq 0) { Write-Host "  [FAIL] 脏提交竟然通过了"; $fail++ } else { Write-Host ("  [PASS] 脏提交被拒，退出码 " + $codeB) }

  Write-Host "  C) 版本漂移的提交（期望：被拒）"
  & git reset -q
  Remove-Item (Join-Path $clone "private-note.txt") -Force -ErrorAction SilentlyContinue
  $pkg = [System.IO.File]::ReadAllText($pkgPath)
  $m = [regex]::Match($pkg, '"version"\s*:\s*"([^"]+)"')
  $oldVersion = $m.Groups[1].Value
  [System.IO.File]::WriteAllText($pkgPath, $pkg.Replace($oldVersion, $oldVersion + "-gatecheck"), (New-Object System.Text.UTF8Encoding($false)))
  & git add -A | Out-Null
  & git commit -m "gate check: version drift"
  $codeC = $LASTEXITCODE
  if ($codeC -eq 0) { Write-Host "  [FAIL] 版本漂移竟然通过了"; $fail++ } else { Write-Host ("  [PASS] 版本漂移被拒，退出码 " + $codeC) }

  Write-Host "  提交历史（应当只有 A 那一条）："
  & git log --oneline | ForEach-Object { Write-Host ("    " + $_) }
}

Pop-Location
if (-not $Keep) { Remove-Item -Recurse -Force $clone -ErrorAction SilentlyContinue }

Write-Host ""
if ($fail -eq 0) {
  Write-Host "自证完成：全部检查通过。"
  exit 0
}
Write-Host ("自证完成：$fail 项未达预期，见上面的 [FAIL]。")
exit 1
