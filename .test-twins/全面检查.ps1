# 全面检查 —— 每次更新都必须运行
#
# 覆盖：单元测试全量 → 端到端 → 数据库自愈 → 补丁注入 → 搬家 → 打包门禁
# 每个阶段都有硬超时：任何一步卡住都会判失败并继续，整轮必定结束。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .test-twins\全面检查.ps1
param(
  [switch]$SkipUnit,      # 跳过全量单元测试
  [switch]$SkipGate,      # 跳过打包门禁
  [int]$UnitTimeout = 420,
  [int]$E2eTimeout = 300,
  [int]$SelfHealTimeout = 240,
  [int]$PatchTimeout = 240,
  [int]$MigrateTimeout = 360,
  # 每个阶段（RunStep）的超时秒数。6/6 打包门禁里光 client-backups 单套件实测就要 318 s，
  # 300 / 420 都会把整个阶段误判成超时（2026-10-07 首跑踩过）⇒ 统一放宽到 900 s。
  # 这是全局值，不是「每个阶段都需要 900」：将来若某阶段确认用不了这么多，按阶段拆开设置，
  # 不要继续靠「反正够大」蒙下去（审查意见 S1）。
  [int]$GateTimeout = 900)
$ErrorActionPreference = 'Continue'
$kit = 'E:\olivia-soul-community-kit'
$tw = Join-Path $kit '.test-twins'
# 禁用「自动退出重启」，否则测试进程会被搬家逻辑结束
$env:OLIVIA_DISABLE_AUTO_RESTART = '1'
$env:E2E_TIMEOUT_MS = '200000'
$steps = @()

# ── 轮次戳与逐条失败清单（2026-10-17 [审查-5] 🟠-3 / 🟡-2）──────────────────────────
# 病根：门禁正文只打印 `pass=1167 fail=17`，而**逐条清单在另一个文件里**（阶段 1 的
# 全面检查-单元测试.log 每次覆盖）⇒ 三天后没人能回答「那 17 条是什么」。上一轮审查就是
# 因此无法复核，只能拿另一份 `pass=1168 fail=16` 的日志凑，差 1 条对不上。
# 修法：① 整轮带轮次戳（`GATE-RUN-ID`）；② 阶段 1 跑完把 `failing tests:` 段原样抄进
# **本轮的汇总日志**里（不依赖那个会被覆盖的中间文件）；③ 所有文本落盘一律显式 UTF-8，
# 不再走 `Out-File` 的默认编码（阶段 2/6 的中文曾整段被按 GBK 解成 `鉁?[C] 濯掍綋…`）。
$runId = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$script:unitFailList = @()
$script:unitSummary = ''

# ── 单元测试豁免表（E1，2026-10-18 独立审查报告-1）────────────────────────────────
# **这张表是本文件唯一的豁免来源**，AGENTS.md §四 是它的说明文档 —— 两处不一致时以本表为准。
#
# 为什么必须写成机器可读的表：旧实现是「单元层有已知豁免项」⇒ 阶段 1 的 EXITCODE 一律硬写 0。
# 于是 2026-10-18 那次审查里 fail=1（native-tray-exit，真问题）时，门禁照样打印
# 「结论：全部通过 —— 可以进入打包流程」。任何一条回归都能这样被吞掉。
#
# 字段：
#   Match    —— 失败条目 file 的 `-like` 匹配模式（路径相对 `test\`、正斜杠）
#   Count    —— 该文件**允许**失败的条数；不写 = 整体豁免（多条都算已登记）。**Count = 0 = 一条都不许失败**
#   Variadic —— 条数随环境变化（依赖打包产物 / 浏览器 / 沙箱），无法钉死 N ⇒ 必须同时给 `Max`
#   Max      —— Variadic 项的**上限**。2026-10-19 第三轮审查加：原来 `Variadic` 是 `continue`
#               一句带过，「无论失败多少条都放过」= 永久免检。现在超过 Max 照样算未登记。
#   Why      —— 为什么它不是产品缺陷（写给半年后的自己看）
#   Ref      —— 可复核的出处
#
# ⚠️ 新增豁免必须同时改 AGENTS.md §四，否则下一轮复核又会回到「红数对不对」的老路。
$UnitExemptions = @(
  @{ Match = '@(*-browser).mjs'; Variadic = $true; Max = 12
     Why = '需要真实浏览器的 opt-in 套件，本机默认不装 playwright（上限 12 条：超过即视为新回归）'; Ref = 'AGENTS.md §四' }
  # ★ 2026-10-19 第三轮审查：本轮删掉 4 条「连续多轮没出现」的豁免 —— 删之前逐个单跑验过，
  #   全部 0 失败，确实已经修好，留着只会让豁免表比实际宽松：
  #     native-tray-exit        1/1 绿
  #     song-editor-entry       6/6 绿
  #     client-network-execution 18/18 绿
  #     periodic-backup         18/18 绿
  @{ Match = 'packaging-artifact.test.js'; Count = 0
     Why = '依赖打包产物：产物在时实测 8/8 绿，所以不再给它「允许失败 3 条」的额度。产物被清掉时这里会红，那是在提醒你重新打包，不是产品缺陷'; Ref = 'AGENTS.md §四' }
  # ★ N9（2026-10-19 第四轮审查）：① 那 2 条是**本机必现**（6 次全量 + 5 轮并发 = 11/11 全中），
  #   不是偶发。原来只写「ZIP fixture 建包方式」，半年后照着「偶发」去查间歇性故障是白费工夫。
  @{ Match = 'release-privacy.test.js'; Variadic = $true; Max = 4
     Why = '① ZIP fixture 2 项本机必现（11/11 轮全中，根因 Compress-Archive 建包方式使 ZIP 逐 entry 的 SHA-256 与 audited stage 不一致，要治得重出包）；② 沙箱 mkdtemp EPERM。上限 4 条（正常权限下实测 2 条，超出即回归）'; Ref = 'AGENTS.md §四' }
  # ★ A2（2026-10-19 第三轮审查）：这两条原来是 `Variadic = $true`。豁免理由「Windows 临时目录
  #   并发 ENOTEMPTY」已随 P1 修复（三次全量 0 条）失效 ⇒ 理由没了、豁免还在、而且是无上限的，
  #   等于给 29 处清理点的 api.test.js 开了永久免检。改成 Count = 0：一条都不许失败。
  @{ Match = 'api.test.js'; Count = 0
     Why = '2026-10-19 起不再豁免：ENOTEMPTY 已由 test/helpers/cleanup.mjs 的重试治好，再红就是真回归'; Ref = 'analysis/未修缺陷清单-2026-10-19.md A2' }
  @{ Match = 'relay-compatibility.test.js'; Count = 0
     Why = '2026-10-19 起不再豁免：同上（单独跑一直通过，并发下的 ENOTEMPTY 已治）'; Ref = 'analysis/未修缺陷清单-2026-10-19.md A2' }
  @{ Match = 'patch-injection-safety.test.js'; Variadic = $true; Max = 4
     Why = '受限沙箱 spawn 被拦（上限 4 条）'; Ref = 'AGENTS.md §四' }
  @{ Match = 'rollback-patch-ui.test.js'; Variadic = $true; Max = 4
     Why = '受限沙箱 spawn 被拦（上限 4 条）'; Ref = 'AGENTS.md §四' }
  @{ Match = 'update-channel.test.js'; Variadic = $true; Max = 4
     Why = '受限沙箱 spawn 被拦（上限 4 条）'; Ref = 'AGENTS.md §四' }
  # ★ N8（2026-10-19 第四轮审查）：压测实测**并发下 2/5 = 40% 红**（`empty space under pointer
  #   resolves to drag cursor` / `overlay stole focus`），是多个 C# 窗口互相抢前台焦点，不是产品缺陷。
  #   40% 不叫偶发，但门禁是分片**串行**跑所以碰不到 ⇒ 记在这里：**哪天把门禁改成并行，它立刻变成
  #   噪声源**。要么让这套用例各自独立取焦点，要么永不加并行。
  @{ Match = 'lyrics-native.test.js'; Variadic = $true; Max = 4
     Why = 'C# harness：编译偶发 + 并发抢前台焦点（并发实测 40% 红，门禁分片串行故不触发）；上限 4 条'; Ref = 'AGENTS.md §四' }
)

# 从 node --test 的输出里抽出失败条目。node 的 `failing tests:` 段格式是：
#   test at <file>:<line>:<col>          ← 分隔行
#   ✖ <名称> (<ms>)                      ← 条目
# 名称里可能带 ✔/✖ 与中文；这里只认行首的 `✖`，不靠缩进（缩进会随嵌套变）。
function Get-UnitFailEntries([string]$Text) {
  $items = New-Object System.Collections.ArrayList
  if (-not $Text) { return $items }
  $idx = $Text.IndexOf('failing tests:')
  if ($idx -lt 0) { return $items }
  $current = ''
  $currentLine = ''
  foreach ($raw in ($Text.Substring($idx) -split "`r?`n")) {
    $line = $raw.Trim()
    $loc = [regex]::Match($line, '^test at (.+?):(\d+):\d+$')
    if ($loc.Success) {
      $current = $loc.Groups[1].Value -replace '\\', '/'
      $current = $current -replace '^\./', ''
      $current = $current -replace '^.*?/test/', ''   # 绝对路径 → 相对 test\
      $current = $current -replace '^test/', ''       # 相对路径（node --test 的写法）→ 只剩文件名
      $currentLine = $loc.Groups[2].Value
      continue
    }
    $head = [regex]::Match($line, '^\W{0,2}\s*✖\s*(.+?)(?:\s*\(\d+(?:\.\d+)?\s*ms\))?$')
    if ($head.Success -and $current) {
      [void]$items.Add([pscustomobject]@{
        File = $current
        Line = $currentLine
        Name = $head.Groups[1].Value.Trim()
      })
      continue
    }
  }
  return $items
}

# 带硬超时执行一个阶段。body 内必须把退出码写成最后一行 EXITCODE=<n>。
#
# ⚠️ `-InitializationScript` 不是可选项，是修 🟡-2 的关键（2026-10-17 实测）：
# `Start-Job` 起的是**独立 PowerShell 进程**，它的 `[Console]::OutputEncoding` 是
# **Codepage 936（GBK）**，而 node 写的是 UTF-8 字节 ⇒ 阶段 2/6 的中文整段被按 GBK 解，
# 日志里出现 `鉁?[C] 濯掍綋鏀寔 Range…` 这种双重编码乱码（审查据此判定「日志正文损坏、
# 无法复核」，记 🟡-2）。实测对照：不注入时乱码、注入后干净。
$jobInit = {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
}
function RunStep([string]$name, [int]$timeoutSec, [scriptblock]$body) {
  Write-Host ""
  Write-Host "──────── $name （上限 ${timeoutSec}s）────────"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $job = Start-Job -InitializationScript $jobInit -ScriptBlock $body
  $finished = Wait-Job $job -Timeout $timeoutSec
  $code = 1
  if ($finished) {
    $out = Receive-Job $job 2>&1 | Out-String
    Write-Host $out.TrimEnd()
    $m = [regex]::Matches($out, "EXITCODE=(-?\d+)")
    # ★ A1 同族漏洞（2026-10-19 第三轮审查补）：原来是 `else { $code = 0 }` ——
    #   Start-Job 里的脚本**抛异常提前死掉**时，输出里根本没有 `EXITCODE=` 这一行，
    #   于是被判成 0（通过）。和「超时算通过」是同一个病：**「没跑完」被当成「跑完了且成功」**。
    #   现在改成：拿不到 EXITCODE 一律按失败（1）处理，并在日志里明说。
    if ($m.Count -gt 0) { $code = [int]$m[$m.Count - 1].Groups[1].Value }
    else { $code = 1; Write-Host "  [FAIL] $name 没有输出 EXITCODE（脚本可能中途抛异常/被截断），按失败处理" }
  } else {
    Write-Host "  [超时] 已等待 ${timeoutSec}s，判定失败并结束该阶段"
    Stop-Job $job -ErrorAction SilentlyContinue
    $code = 124
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $script:steps += [pscustomobject]@{ Name = $name; Code = $code; Seconds = $secs }
  if ($code -eq 0) { Write-Host "  [OK]   $name 通过（${secs}s）" }
  elseif ($code -eq 124) { Write-Host "  [FAIL] $name 超时（${secs}s）" }
  else { Write-Host "  [FAIL] $name 失败（退出码 $code，${secs}s）" }
}

# 终止占用某个目录的残留进程。
# 为什么需要：阶段 5/6 会在固定目录里启动真实宿主；若上次运行的进程没退干净，
# 会锁住 sqlite/exe，导致「数据搬家」或「打包门禁」出现与产品无关的失败。
# （真实踩过：阶段 5 单独跑 9/0 通过，在全面检查里却失败，原因就是残留进程。）
function Stop-ProcessesUnder([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) { return 0 }
  $killed = 0
  foreach ($n in @('OliviaSoul', 'node', 'msedgewebview2')) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
      $p = try { $_.Path } catch { '' }
      if ($p -and $p.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $killed++
      }
    }
  }
  if ($killed -gt 0) { Start-Sleep -Seconds 2 }
  return $killed
}

Write-Host "=== 全面检查开始 $runId ==="
Write-Host "检查目录：$tw"
Write-Host "轮次：GATE-RUN-ID=$runId（本轮所有结论都以这个 id 为准）"

if (-not $SkipUnit) {
  RunStep '1/6 单元测试全量' $UnitTimeout {
    Set-Location (Join-Path $using:kit 'repo\source\local-service')
    # ★ 2026-10-19 独立审查修复：`--test-reporter=spec` 不能省。
    #   node 的 test runner 在 stdout 不是 TTY 时会**自动改用 TAP reporter**，而这里的输出被
    #   管道接给 Out-File ⇒ 一直是 TAP ⇒ 下面的 `failing tests:` 锚点永远命中不了
    #   （实测：默认跑法该锚点出现 0 次）。后果是 fail=21 却抽不出任何条目，
    #   豁免比对在**空集**上进行 ⇒ 打印「全部落在已登记豁免内」放行 —— 典型假绿。
    #   强制 spec 后锚点回来（实测出现 1 次），且 `ℹ pass/fail/tests N` 汇总行仍在，
    #   现有的 pass/fail/tests 正则不受影响。
    node --test --test-force-exit --test-reporter=spec 2>&1 | Out-File (Join-Path $using:tw '全面检查-单元测试.log') -Encoding UTF8
    # ★ E1（2026-10-18 独立审查报告-1）：这里曾**硬写** "EXITCODE=0"，注释理由是「单元层有已知豁免项」。
    #   后果是任何单元失败都不阻断发版 —— 审查实测 fail=1（native-tray-exit）时，本门禁照样打印
    #   「结论：全部通过 —— 可以进入打包流程」。豁免项该不该放过，必须由**逐条比对豁免清单**决定，
    #   不能由「一律不管」决定。所以这里照实回传退出码，判定放到下面的「豁免判定」段。
    "EXITCODE=$LASTEXITCODE"
  }
  $log = Join-Path $tw '全面检查-单元测试.log'
  if (Test-Path $log) {
    $c = Get-Content $log -Raw -Encoding UTF8
    $p = [regex]::Match($c, 'pass (\d+)').Groups[1].Value
    $f = [regex]::Matches($c, 'fail (\d+)')
    $fv = if ($f.Count) { $f[$f.Count - 1].Groups[1].Value } else { '?' }
    $script:unitSummary = "pass=$p fail=$fv"
    Write-Host "  单元测试：pass=$p fail=$fv（豁免项见 全面检查说明.md，须逐版复核）"
    # ★ 逐条失败清单**原地抄进本轮汇总**（[审查-5] 🟠-3）：
    #   中间文件 `全面检查-单元测试.log` 每次覆盖，只留最后一次；三天后没人能回答「那 17 条是什么」。
    #   抄的是 node 自己的 `failing tests:` 段（ASCII 锚点，中文乱码也不影响定位）。
    $idx = $c.IndexOf('failing tests:')
    if ($idx -ge 0) {
      $script:unitFailList = @($c.Substring($idx) -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    # ★ C2（2026-10-19 第三轮独立审查 A1 根因 1）：这里原来是裸 `[int]$fv -gt 0`。
    #   阶段超时时 $fv 的值是字符串 `'?'`，`[int]'?'` 直接抛 `InvalidArgument`
    #   （原文：无法将值"?"转换为类型"System.Int32"），异常没被拦、流程继续往下 ⇒
    #   一行人眼可见的报错，被后面「判定通过」覆盖掉。必须先自证是数字再转。
    } elseif ($fv -match '^\d+$' -and [int]$fv -gt 0) {
      $script:unitFailList = @("⚠️ fail=$fv 但日志里找不到 'failing tests:' 段 —— 逐条清单缺失，不能只用总数交差")
    }
    Write-Host "  逐条失败清单：$(if ($script:unitFailList.Count) { "$($script:unitFailList.Count) 行已抄进本轮汇总" } else { '无（本轮 0 失败）' })"
    # ★ O1（2026-10-17 发版前必修清单）：把 `tests` 总数也打出来。
    #   起因：审查机构两路独立实测都是 `tests 1200`，而我方门禁自报 `tests 1322`，差 122 项 ——
    #   tests 数对不上说明**有一批测试没被跑到**（没跑到的测试等于不存在）。
    #   根因是旧汇总只打 `pass/fail`：`tests` 少了 122 而 `fail` 一致（16）时，肉眼完全看不出异常。
    $tv = [regex]::Match($c, 'tests (\d+)').Groups[1].Value
    if ($tv) {
      $script:unitTotal = $tv
      Write-Host "  单元测试总数：tests=$tv（pass+skipped+fail 应对得上；与外部复现值不一致时，先查有没有测试没被跑到）"
    }
    # ★ E1（2026-10-18 独立审查报告-1）：把「失败条目」与「已登记豁免」**逐条**比对。
    #   旧写法是「单元层有已知豁免项 ⇒ EXITCODE 一律写 0」，于是新增真缺陷也照样绿灯。
    #   判据：每一条失败必须能认领到下面 $UnitExemptions 里的某一项；认领不到的（新增失败）
    #   一律阻断，并且把条目的身份原样打印出来 —— 不允许出现「fail 数变了但说不出是哪条」。
    $script:unitFailEntries = @(Get-UnitFailEntries -Text $c)
    $script:unitExemptUnmatched = @()
    $script:unitFailUnregistered = @()
    # ★ C2（2026-10-19 第三轮审查）：`$ex.Seen` 必须**先归零**再统计。
    #   旧写法只在命中时 `$hit.Seen++`，从没命中的条目连 `Seen` 这个键都不存在 ⇒
    #   过期提示打印成「登记 1 条，本轮只出现  条」（数字是空白），读起来像脚本坏了、
    #   而不是豁免过期了。另外 `$ex.Count` 在 PowerShell 里**对哈希表是内置属性**
    #   （键数），不写 `Count` 键的 Variadic 条目会取到 2 或 3 —— 一律改用 `$ex['Count']`。
    foreach ($ex in $UnitExemptions) { $ex.Seen = 0 }
    foreach ($entry in $script:unitFailEntries) {
      $hit = $null
      foreach ($ex in $UnitExemptions) {
        if ($entry.File -like $ex.Match) { $hit = $ex; break }
      }
      if (-not $hit) { $script:unitFailUnregistered += $entry; continue }
      # ★ A2（同上）：Variadic 原来是 `continue` 一句带过 —— **该文件失败多少条都放过**。
      #   `api.test.js` / `relay-compatibility.test.js` 的豁免理由正是「Windows 临时目录并发
      #   ENOTEMPTY」，而这个病 2026-10-19 已治好（三次全量 0 条）⇒ 理由失效、豁免还在，还是无上限。
      #   现在改成：Variadic 也要给 `Max` 上限，超了照样算未登记。
      if ($hit.Variadic) {
        $hit.Seen++
        $cap = $hit['Max']
        if ($null -eq $cap) { $script:unitFailUnregistered += $entry }
        elseif ($hit.Seen -gt [int]$cap) { $script:unitFailUnregistered += $entry }
        continue
      }
      # 非整体豁免：同一文件只放过 $Count 条，超出的（新增失败）算未登记
      if ($hit.Seen -lt $hit['Count']) { $hit.Seen++ } else { $script:unitFailUnregistered += $entry }
    }
    foreach ($ex in $UnitExemptions) {
      if (-not $ex.Variadic -and $ex['Count'] -gt 0 -and $ex.Seen -lt $ex['Count']) { $script:unitExemptUnmatched += $ex }
    }
    Write-Host "  豁免比对：失败 $($script:unitFailEntries.Count) 条；已登记豁免 $($UnitExemptions.Count) 项；未登记新增失败 $($script:unitFailUnregistered.Count) 条；登记了但本轮没出现的豁免 $($script:unitExemptUnmatched.Count) 项"
    if ($script:unitExemptUnmatched.Count) {
      foreach ($ex in $script:unitExemptUnmatched) {
        Write-Host "  ! 豁免已过期（登记 $($ex['Count']) 条，本轮只出现 $($ex.Seen) 条）：$($ex.Why) [$($ex.Match)] —— 它可能已被修好，请从豁免表里删掉"
      }
    }
    # ★ C1（2026-10-19 第三轮审查）：过期只打印提示 ⇒ 豁免表永远比实际宽松（本轮 5 项已连续多轮
    #   没出现，没人删）。改成**连续 2 轮没出现就判红**，计数落盘在 `.test-twins\豁免过期计数.json`。
    #   只对非 Variadic（有确切 Count 的）生效：Variadic 项的「没出现」可能只是环境不同，
    #   拿它判红会变成噪声，反而让人习惯性忽略红灯。
    $stalePath = Join-Path $tw '豁免过期计数.json'
    $staleState = @{}
    if (Test-Path -LiteralPath $stalePath) {
      try {
        $staleRaw = Get-Content -LiteralPath $stalePath -Raw -Encoding UTF8
        if ($staleRaw -and $staleRaw.Trim()) {
          foreach ($pp in (ConvertFrom-Json $staleRaw).PSObject.Properties) { $staleState[$pp.Name] = [int]$pp.Value }
        }
      } catch {
        Write-Host "  ! 豁免过期计数文件无法解析，按「首次过期」处理（不会因此放行）：$($_.Exception.Message)"
      }
    }
    $script:unitExemptStale = @()
    $staleEligible = @($UnitExemptions | Where-Object { -not $_.Variadic -and [int]$_['Count'] -gt 0 })
    # ★ N4（2026-10-19 第四轮审查）：上面这句 `continue` 现在会把**每一项**都跳过
    #   （表里已经没有 `Count > 0` 的非 Variadic 豁免了）⇒ C1 是**死代码**：逻辑写得对，
    #   但下一轮审查它不会发出任何信号。静默的死代码最容易被忘记，所以 0 个对象时要显式说一句。
    if ($staleEligible.Count -eq 0) {
      Write-Host "  · C1（豁免连续 2 轮没出现就判红）本轮**无生效对象**：豁免表里没有 Count > 0 的非 Variadic 项。若将来把某条 Variadic 收紧成 Count = 0，这里会一直保持 0 —— 见 AGENTS.md §四 的说明"
    }
    foreach ($ex in $UnitExemptions) {
      if ($ex.Variadic -or [int]$ex['Count'] -le 0) { continue }
      $key = "$($ex.Match)#$($ex['Count'])"
      if ($ex.Seen -ge $ex['Count']) { $staleState[$key] = 0 }
      else { $staleState[$key] = 1 + $(if ($staleState.ContainsKey($key)) { [int]$staleState[$key] } else { 0 }) }
      if ($staleState[$key] -ge 2) { $script:unitExemptStale += $ex }
    }
    try {
      $lines = @($staleState.GetEnumerator() | Sort-Object Name | ForEach-Object { '  "' + ($_.Key -replace '"', '\"') + '": ' + $_.Value })
      $json = '{' + "`r`n" + ($lines -join ",`r`n") + "`r`n}" + "`r`n"
      [IO.File]::WriteAllText($stalePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
      Write-Host "  ! 豁免过期计数写入失败（不影响本轮判定）：$($_.Exception.Message)"
    }
    if ($script:unitExemptStale.Count) {
      foreach ($ex in $script:unitExemptStale) {
        # ★ 注意：这一行必须用反引号转义 `$UnitExemptions`。第一次写漏了，PowerShell 在双引号里
        #   把它当数组插值，输出成 13 个 "System.Collections.Hashtable" 连成一长串（实测踩到）。
        Write-Host "  x 豁免连续 2 轮没出现，判为已过期：$($ex.Match)（登记 $($ex['Count']) 条）—— 请从 `$UnitExemptions 删掉该条；若功能仍需保留豁免，请在 Why 里写明为什么"
      }
    }

    if ($script:unitFailUnregistered.Count) {
      foreach ($e in $script:unitFailUnregistered) { Write-Host "  x 未登记的失败：$($e.File):$($e.Line) $($e.Name)" }
    }
    # ★ A1（2026-10-19 第三轮独立审查）：阶段超时 ⇒ **一套测试根本没跑完**，但旧代码在这里
    #   无条件往下走判定。三处根因缺一不可，已全部堵住：
    #     ① 209 行 `[int]$fv` 在 $fv='?' 时抛 InvalidArgument（本轮已改成先 `-match '^\d+$'`）；
    #     ② 判定段在 RunStep 返回之后无条件执行 —— 没有「超时就不判」的短路（本段补）；
    #     ③ 最后的 else 无条件 `Code = 0` —— 把 RunStep 记下的 124 **覆盖回 0**（本段加前置条件）。
    #   受控实验（`-UnitTimeout 3 -SkipGate`）修复前实测：退出码 0、结论「全部通过」。
    $lastStep = $script:steps[$script:steps.Count - 1]
    $fvNum = 0
    $hasFailNum = ($fv -match '^\d+$') -and [int]::TryParse($fv, [ref]$fvNum)
    $hasPassNum = ($p -match '^\d+$')
    if ($lastStep.Code -eq 124 -or -not $hasFailNum -or -not $hasPassNum) {
      # 超时保留 124（区分「超时」与「判定不可读」）；其它不可读一律记 3。
      $lastStep.Code = if ($lastStep.Code -eq 124) { 124 } else { 3 }
      Write-Host "  [FAIL] 阶段 1 结果不可判定（超时 / 日志里读不到 pass、fail 数字：pass='$p' fail='$fv'），禁止放行"
    } elseif ($fvNum -gt 0 -and $script:unitFailEntries.Count -lt $fvNum) {
      $lastStep.Code = 1
      Write-Host "  [FAIL] 阶段 1 判定失败：fail=$fvNum 但只抽出 $($script:unitFailEntries.Count) 条逐条清单 —— 有失败没被比对豁免，禁止放行（先修解析或 reporter）"
    } elseif ($script:unitFailUnregistered.Count -gt 0) {
      $lastStep.Code = 1
      Write-Host "  [FAIL] 阶段 1 判定失败：$($script:unitFailUnregistered.Count) 条失败不在豁免表里 —— 先修复，或补齐豁免登记与理由"
    } elseif ($script:unitExemptStale.Count -gt 0) {
      $lastStep.Code = 1
      Write-Host "  [FAIL] 阶段 1 判定失败：$($script:unitExemptStale.Count) 项豁免已连续 2 轮没出现（功能可能已修好）—— 清掉豁免表里的过期项再放行"
    } else {
      $lastStep.Code = 0
      Write-Host "  [OK]   阶段 1 判定通过：失败条目全部落在已登记豁免内"
    }
  }
}

RunStep '2/6 端到端（启动/曲库/媒体/播放/续播/端点）' $E2eTimeout {
  Set-Location $using:tw
  # node 往 stderr 写的业务日志会被 PowerShell 当成异常刷屏；这里只保留 stdout 与退出码
  $ErrorActionPreference = "Continue"
  node ./g28-e2e-full.mjs 2>$null | Select-Object -Last 26
  "EXITCODE=$LASTEXITCODE"
}

RunStep '3/6 数据库自愈（陈旧伴随文件）' $SelfHealTimeout {
  Set-Location $using:tw
  node ./g28-e2e-selfheal.mjs 2>&1 | Select-Object -Last 18
  "EXITCODE=$LASTEXITCODE"
}

RunStep '4/6 补丁注入（自动跟随补丁版本与注入符号）' $PatchTimeout {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $using:tw 'g28-e2e-patch.ps1') 2>&1 | Select-Object -Last 22
  "EXITCODE=$LASTEXITCODE"
}

# H 组直接执行（Start-Job 的独立会话收不到子进程 exit 事件，会误判）。
# 关键：本组验证的就是「搬家后主动 exit(86)」，而该机制受 OLIVIA_DISABLE_AUTO_RESTART 控制；
# 全面检查为了保护单元测试把它设成了 1 —— 必须在本组临时恢复，否则等于把要测的机制关掉。
Write-Host ''
# 阶段 5 前先清理上次残留：realtest 目录被占用会导致搬家测试出现假失败。
$realtestDir = 'E:\OliviaSoul-g28-realtest'
$killedMigrate = Stop-ProcessesUnder $realtestDir
if ($killedMigrate -gt 0) { Write-Host "  已清理 $killedMigrate 个占用搬家测试目录的残留进程" }
Write-Host "──────── 5/6 数据搬家（服务主动重启） （直接执行，临时启用自动重启）────────"
$sw5 = [Diagnostics.Stopwatch]::StartNew()
Set-Location $tw
$savedAutoRestart = $env:OLIVIA_DISABLE_AUTO_RESTART
$env:OLIVIA_DISABLE_AUTO_RESTART = '0'
node ./g28-e2e-migrate.mjs 2>&1 | Select-Object -Last 22
$code5 = $LASTEXITCODE
$env:OLIVIA_DISABLE_AUTO_RESTART = $savedAutoRestart
$sw5.Stop()
$secs5 = [math]::Round($sw5.Elapsed.TotalSeconds, 1)
$steps += [pscustomobject]@{ Name = '5/6 数据搬家（服务主动重启）'; Code = $code5; Seconds = $secs5 }
if ($code5 -eq 0) { Write-Host "  [OK]   5/6 数据搬家 通过（${secs5}s）" } else { Write-Host "  [FAIL] 5/6 数据搬家 失败（退出码 $code5，${secs5}s）" }

if (-not $SkipGate) {
  # 阶段 6 前也清理：打包测试目录被占用会让解压出「新旧混合」的目录，
  # 产物哈希随之改变，门禁会给出与产品无关的失败。
  $killedPack = Stop-ProcessesUnder 'E:\OliviaSoul-_packaging-test-1.0'
  if ($killedPack -gt 0) { Write-Host "  已清理 $killedPack 个占用打包测试目录的残留进程" }
  # A7（2026-10-09 复审）：通用「包内文档 vs 源码」护栏（源码侧，不写死功能名）。
# 打包源目录里的两份用户文档必须存在、非空、且带当前版本号（版本号从 package.json 读）。
# 产物侧的对应检查在 1.0-final-check.ps1 的 2h-12。
$docFullVersion = (([System.IO.File]::ReadAllText("$kit\repo\source\local-service\package.json", [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version)
$docProblems = @()
foreach ($docRel in @("packaging\发布说明.md", "packaging\使用说明.txt")) {
  $docPath = Join-Path "$kit\repo\source\local-service" $docRel
  if (-not (Test-Path -LiteralPath $docPath)) { $docProblems += "缺少 $docRel"; continue }
  $docText = [System.IO.File]::ReadAllText($docPath, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($docText)) { $docProblems += "$docRel 是空文件"; continue }
  if (-not $docText.Contains($docFullVersion)) { $docProblems += "$docRel 里没有当前版本号 $docFullVersion" }
}
if ($docProblems.Count -gt 0) {
  Write-Host ("✗ 包内文档护栏失败：" + ($docProblems -join "；")) -ForegroundColor Red
  exit 1
}
else { Write-Host ("✓ 包内文档护栏通过（发布说明.md / 使用说明.txt 带当前版本号 $docFullVersion）") -ForegroundColor Green }

  RunStep '6/6 打包门禁（关键套件 + 打包脚本自检）' $GateTimeout {
    # 打包脚本自检：必须能在删除测试目录前终止占用进程，并在结束后清理自己启动的进程。
    # 否则上次打包残留的宿主会锁住 exe/dll，解压出「新旧混合」的目录，产物哈希随之改变。
    # 这个缺陷曾逃过全量测试（全面检查用的是另一个 realtest 目录），只在真正打包时暴露。
    $failed = 0
    $finalCheck = Get-ChildItem (Join-Path $using:kit '.test-twins') -Filter '*-final-check.ps1' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $finalCheck) { Write-Host '  x 打包脚本自检：找不到 *-final-check.ps1'; $failed += 1 }
    else {
      $fc = Get-Content -LiteralPath $finalCheck.FullName -Raw -Encoding UTF8
      foreach ($pair in @(
        @('Stop-ProcessesUnder', '删除前终止占用进程'),
        @('无法清理', '删除失败即报错退出'),
        @('已清理', '结束时清理冒烟进程'))) {
        if ($fc -like "*$($pair[0])*") { Write-Host "  ok 打包脚本自检：$($pair[1])" }
        else { Write-Host "  x 打包脚本自检缺少：$($pair[1])"; $failed += 1 }
      }
    }
    Set-Location (Join-Path $using:kit 'repo\source\local-service')
    $suites = @('feapp-revisions-consistency','source-encoding','player-resume','player-progress-report','port-fallback','port-fallback-guidance','patch-injection-safety','version-sync','repo-health','client-backups',
      'client-service-controller','client-patch-controller-integration','uninstall-restore',
      'db-self-heal','db-self-heal-g24','faststart-cache','no-autoplay','release-version-order','model-presets',
      'rollback-patch-ui','update-channel','update-download','update-network','repo-privacy',
      'bump-version','patch-loss-notice','periodic-backup',
      # 时段三联封面（g14）与壁纸恢复时段（webplayer v20）三个套件：
      # 它们守的是「时段可视化列全部变体」「手动指定能指到第 2/3 段」「恢复默认画面按当前时段换段」，
      # 不注册就会在门禁里静默漏跑。
      'time-of-day-variants','time-of-day-inspect-ui','webplayer-tod-restore',
      # 1.0.8：时段复核面板的显示层修复（卡片排布 / 亮度与色温取整）。
      # 它守的是界面上的真实缺陷，不注册就会在门禁里静默漏跑。
      'time-of-day-inspect-display',
      # 1.0.8：「曲名与时段」在显式 dataDir（便携版/搬家后的异位数据目录）下读不到曲库
      # —— server.js 起 listen-naming 路由时漏注入 databasePath，模块去开了安装目录下的库。
      'listen-naming-database-path',
      # 1.0.9：时段复核面板反馈（每张卡写明「当前：…」、确认框讲清被清空/被替换的时段、
      # 写库回执不再被重渲染刷掉）与「时段备份目录跟着本次启动的库走」
      # —— 后者是同一个类缺陷（模块级默认值顶掉注入路径），便携版/异位数据目录下
      # 备份会写进安装目录树，数据安全相关的文件跑到别处比读不到更糟。
      'time-of-day-backup-dir',
      # 1.1.0：/admin 静态文件白名单与 public/ 实际文件双向比对
      # —— 白名单是手工硬编码数组，漏登记不报错，但 app.js 等 ESM import 会 404 白屏。
      'admin-static-whitelist',
      # 1.1.1：游戏「我的信箱」的「一键导出」按钮 + /toy/letter/export 导出接口。
      # 它守的是：导出物真落盘且完整、未到点的回信不剧透、导出物不带本机路径/密钥/模型名。
      'letter-export',
      # 1.1.1：随机播放不再连续抽到同一首（牌堆 + 游标 + localStorage）。
      # 它守的是：短歌单里相邻两次不重复、一轮内每首恰好一次、进度跨会话接得上、
      # 以及补丁脚本四个调用点都真的换成牌堆（不再用会被切页面清空的播放历史）。
      'shuffle-deck',
      # 1.2.0：歌单与收藏夹的数据层（/toy/folders 与 /admin/api/folders 同一份数据）。
      # 它守的是：playlist_items 结构一个字段都没动、显示层重名后缀不改曲库真名、
      # 一键导入不静默丢不可播曲目、导出导入闭环、以及写接口来源闸门
      # （恶意网页的 Origin 写不进去，游戏页面 https://olivia.local 与本机脚本照旧）。
      'song-folders',
      # 1.2.0：歌曲行状态（「已在 N 个歌单」/勾选态）要的 membership 只读接口。
      # 它守的是：一批 id 一次问完不做按行循环、未命中的 id 也回声、空歌单计数回 0、
      # membership 是保留字不被当成歌单 id、两端（/toy 与 /admin/api）同数据、500 个 id 上限截断。
      'song-folder-membership',
      # 信件时间线（B 块，程序端接口）：游标分页不重不漏、不剧透（未到 available_at 算待回信）、
      # 筛选与统计全服务端做、/admin/api/letters 不传参仍是最近 100 条数组（老前端不许被破坏）、
      # 以及信件 JSON 导入的严格校验 + 已存在跳过不覆盖 + 写库前自动备份 + 同一 preview 只能确认一次。
      'letter-timeline',
      # 曲库体检（C1 块）：默认每类最多列 30/20 条但 counts/totals 必须仍是全量（不许静默截断）、
      # ?full=1 才不截断、占位名只统计不猜曲名、缺失 MIDI 是 missingVideo 的反向、
      # 同款群分「可合并的同名」与「要核对的异名」两种、旧诊断面板用的既有键一个都不能少。
      'library-health',
      # 备份可视化与清理（C2 块）：删备份必须 basename + 目录内双重校验（越界一律拒）、
      # 当前库与「已安排恢复」的那份不能删、必须 confirm 才真删并连 -wal/-shm 一起清、
      # 周期备份保留份数可配置且改小**不立刻删**（要再点一次「确认清理」，调大即可撤销）。
      'data-safety-cleanup',
      # 删备份的越界防护细节：basename 与 path.relative 两层都必须在位、
      # 「已安排恢复」的那份不能删、两处 confirm 一个都不能少。
      # 这套件 1.2.0 之前一直没登记进门禁（2026-10-07 审查指出覆盖缺口），现在补上。
      # 没设曲库目录时的指路文案（1.2.0 第二轮独立审核报告 2.2/2.3）：四个 midi 模块不许再把人
      # 指去没有这项设置的旧页；无库时 health/tags 必须回 needsLibrary + 真实入口；
      # dependencies 不能被本模块截胡（新端点忘了排除就会截胡，这套件就是防它）。
      'library-missing-guidance',
      'data-safety-backup-delete',
      # #64（第四轮审核 · 审-5）：所有走 #noticeLayer 的确认框必须共用同一份 resolver。
      # app.js 是 module，它的 openNotice/closeNotice 默认不在 window 上；两个面板脚本各自
      # 摸 DOM + 自挂 click 并自持 Promise，而 app.js 的全局 keydown 在 Esc/Enter 时直接
      # closeNotice（只兑付它自己的 resolver）⇒ 自建框的 Promise 永久 pending：
      # 「删除备份 / 清理周期备份 / 删除歌单 / 分享同意 / 合规声明」按 Esc 或 Enter 后静默挂起。
      # 这套件钉死修法：app.js 暴露 window.OliviaSoulNotice，四个脚本优先用它。
      'notice-layer-keyboard',
      # A（工单《托盘图标切换与一键启动游戏》第 1 部分 · 2026-10-08）：任务栏图标点击 = 收起/展开。
      # 它守的是：收起态不能 Hide()、不能动 ShowInTaskbar（否则任务栏按钮一起消失、没有点击目标）、
      # 收起靠位移滑到 Screen.Bounds.Bottom 之外、动画只改 Location 不碰 Opacity（WebView2 会花屏）、
      # WM_SYSCOMMAND 在 base.WndProc 之前拦（否则无边框窗口缩成桌面左下角一条），
      # 以及退出路径 HideToTray()/ShowFromTray() 原样保留。
      'native-taskbar-collapse',
      'native-maximize-restore',
      # 打包清单护栏（1.2.0 第十四轮 P0）：harness 脚本目录新增文件必须同步
      # packaging/build-release.ps1 的手写清单，否则产物里缺文件 ⇒ 写回信启动即退出码 1。
      'harness-package-manifest',
      # 「她主动写信」harness 链路（1.2.1 第 32 轮）：-Proactive 开关 + 7 个 prompt 的
      # {{proactiveNote}} 注入 + 每个 prompt map 都带该键 + 由头档案不写成「我（信件）」。
      'harness-proactive',
      # 「她主动写信」的决策引擎（1.2.1 第 32 轮）：由头驱动（隔太久了 + 她上封信问过你的事）、
      # 每周 2 封 / 每天 1 封、她睡觉或上课时不写、她写过你还没回就不再写 —— 每个「不发」都有名字。
      # 由头来源只用确定有数据的两种（silence / letter_question），播放历史留待后续。
      'proactive-letters',
      # 「主动来信」设置页（1.2.1 第 32 轮）：页签 / 静态白名单 / 脚本引用 / 页内引导分散在
      # 几个文件里，漏一处都不报错 —— 用户看到的是「侧栏没这一页」或者「点了没反应」。
      'proactive-settings',
      'diagnostic-package-privacy', 'diagnostic-package-privacy-edge',
      # UAC 黑屏修复（1.2.0）：提权命令构造 + 「先不提权、只有权限不足才提权」的回归锁。
      'elevation-command',
      # 1.2.0 真机反馈修复单（2026-10-11）：文件选择器顶部黑条（触发前切浅色 + cancel/focus
      # 两路兜底，少一路就会出现「按了取消、界面永久变白」）与游戏端歌单入口
      # （常驻按钮 + 一个歌单都没有时也能进面板新建）。
      'file-picker-guard',
      'game-favorites-entry',
      'letter-harness-budget','letter-harness-antifabrication',
      # S1（2026-10-16 两端写信引擎同步）：harness 渲染严格化 —— Expand-Harness 对
      # 「未登记变量 / 必填缺值 / 残留占位符」三类静默污染当场抛错，并与 harness-manifest.json
      # 的 optionalVariables 双向钉死。变异件 .test-twins/mut-config-strict-render.json（5/5 全抓）。
      'letter-harness-strict-render',
      # S5（2026-10-16 两端写信引擎同步）：行为参数单一真相源 harness/行为参数.json。
      # 守三件事：① 硬校验不严于规范目标值（否则照规范写的信会被程序拒掉）；② targets 与
      # 00-栏目.md / 写法.md 里的中文数字一致（规范改了参数没改即红）；③ harness-manifest.json
      # 覆盖 harness 目录里每个文件且逐项与磁盘一致（清单过期即红）。
      'harness-behavior-params',
      # S2（2026-10-16 两端写信引擎同步）：预检账本十四行 → 十七行。
      # 守三处联动：① 三份模板声明的行数 = 实际字段行数 = 十七；② 三份模板字段名与顺序一致，
      # 末行是结论；③ 脚本用 $ledgerLineWords 词表解析行数（不硬编码、未登记即抛错），
      # 且 $statePrefixes 继承说话者与未决、但不继承摘要待核实。
      'letter-harness-ledger-lines',
      # S6（2026-10-16 两端写信引擎同步）：规则与人设一律「整份读」，不再靠标题嗅探。
      # 守两件事：① harness-4step.ps1 与 deepseek-reply.ps1 都改成 Strip-Yaml(Read-Utf8 ...)，
      # 且不得再有 Take-FromHeading 调用与残留的 $writeHeading / $personaHeading 死常量；
      # ② 数据契约 —— 林离人设.md 的 ## 基础 不在首行（旧实现会静默丢掉首行标题），写法.md 首行恰是 # 写法。
      'letter-harness-whole-file-read',
      'letter-harness-writing-structure',
      # D（工单《工单-日常聊天与写回信》D + 委派《委派-豆包模型ID核实结果与追加要求》）：聊天向模型预设。
      # 它守的是：豆包（火山方舟）三项 preset 的 id / 地址 / 模型名一一对应、既有 9 项 + M2-her
      # 不许被动过、打包审计白名单与两份文档都要覆盖、「先到方舟控制台开通模型」的提示不能丢、
      # 以及豆包不许被当成已知推理家族（认错家族会发出方舟不认的参数被 400 拒）。
      'doubao-presets',
      # 委派 §2.4 的回归：连通性自测的输出预算。推理 token 与正文共享 max_tokens，
      # 探测只给 128 会被思考链吃光 ⇒ finish_reason=length ⇒ 用户看到「模型正文未完整生成」的
      # 假失败（kimi-k3 只发顶层 reasoning_effort、kimi-k2.7-code 什么都不发、豆包家族认不出）。
      # 这套件钉住共享判断 probeNeedsReasoningBudget、中文 max_tokens 回退与 403 分诊文案。
      'model-probe-budget',
      # 漏测闸门（2026-10-11，用户反馈「新功能老是忘记加进测试」）：源码里有、但没有任何
      # 测试提到的功能文件 —— 白名单外的一律红；补了测试却忘删白名单条目的也红。
      'untested-modules',
      # 错误号体系（1.2.3）：用户原话「报错一定要有能让程序快速识别的报错号和方便用户查看的
      # 显式报错」。建立前实测 144 处 httpError 有 132 处吃默认 -1 —— 响应体有 code 字段，
      # 但 132 种错共用一个号，程序区分不了、日志检索不到。
      # 这套件钉死：每处都给号 / 号取自 ERR 表 / 一号不对应两种错 / 号拼进 message（用户看得见）。
      # 数据目录必须由调用方注入（2026-10-18 独立审查报告-1 的 E4）：dependency-check.js
      # 与 logs.js 原先把路径写成模块级常量，server.js 从不设那个环境变量 ⇒ 界面「依赖
      # 检查」报安装树里的假路径、安装树里躺了 633,887 B 的 listen-naming.log。
      # 同一类 bug 在 1.0.8 / 1.0.9 各修过一次，这两处是漏修的。
      'error-codes',
      # 来源闸门（2026-10-19 数据安全与个人信息审计）：/toy/* 的读接口同样要过来源校验。
      # 在此之前只有写方法过闸门，而 /toy/* 的 GET 会吐信件正文、用户信息、诊断包、运行日志，
      # 且 corsHeaders 对 /toy/* 反射任意 Origin ⇒ 任意网页可跨域读到全部信件。
      'source-guard',
      # 密钥落盘加密（2026-10-19 数据安全审计）：API Key 写盘前用 Windows DPAPI 加密（dpapi-v1）。
      # 守三件事：磁盘上没有明文 / 读回来还能用 / 密文解不开时不能把密文当 Key 发出去。
      'secure-secret',
      # 命名纠错（2026-10-20，用户原话「命名了以后就不能修改命名了」）：已命名的歌必须能改名。
      # 它守的是：清单能列全（搜索/排序/分页）、改名只动本文件夹且不碰时段、没命名的作品
      # 不许走改名、空名/超长/控制字符/非法文件夹一律拒绝且不落库、撤回是把旧名写回去
      # （而不是清空）且不扣「今天命名了多少」。
      'listen-naming-rename',
      # 发布产物与源码逐字节核对（2026-10-21）：package-freshness 只比对 harness 15 个文件，
      # 实证漏检了「旧包整段缺命名纠错」；本套件把核对范围扩到包内全部源码文件
      # （app/public、app/midi、app/desktop、app/lyrics、app 顶层、workspace-template/harness）。
      # 没打包时（repo/build-* 不存在）相关用例 t.skip，不会假红；有旧包而源码已改必红。
      # ★ 与 .test-twins/1.0-final-check.ps1 的 $suites 必须集合一致（AGENTS.md 登记卡第 3 条），
      #   由 .test-twins/check-doc-sync.mjs 机器把关。
      'package-release-audit',
      'user-data-path-injection')
    # 套件数量动态打印：以前写死「12 个套件」，加了新套件后标题就与事实不符（真实踩过）。
    Write-Host "  关键套件：$($suites.Count) 个"
    # 多个套件连跑时会出现偶发失败（Windows 临时目录/子进程资源竞争）。
    # 失败时重试一次并留痕：重试通过不静默放过，但仍算通过。
    foreach ($s in $suites) {
      $o = node --test "test/$s.test.js" 2>&1 | Out-String
      $ms = [regex]::Matches($o, 'fail (\d+)')
      $n = if ($ms.Count) { [int]$ms[$ms.Count - 1].Groups[1].Value } else { 0 }
      if ($n -gt 0) {
        Write-Host "  ! $s 首次失败 $n 项，重试一次"
        $o2 = node --test "test/$s.test.js" 2>&1 | Out-String
        $ms2 = [regex]::Matches($o2, 'fail (\d+)')
        $n2 = if ($ms2.Count) { [int]$ms2[$ms2.Count - 1].Groups[1].Value } else { 0 }
        if ($n2 -gt 0) { Write-Host "  x $s 重试后仍失败 $n2 项"; $failed += $n2 }
        else { Write-Host "  ok $s（重试后通过，首次失败已留痕）" }
      } else { Write-Host "  ok $s" }
    }
    if ($failed -gt 0) { "EXITCODE=1" } else { "EXITCODE=0" }
  }
}

Write-Host ""
Write-Host "=== 汇总 ==="
Write-Host "轮次：GATE-RUN-ID=$runId"
$failCount = 0
$total = 0
foreach ($s in $steps) {
  $flag = if ($s.Code -eq 0) { '[OK]  ' } else { '[FAIL]' }
  if ($s.Code -ne 0) { $failCount++ }
  $total += $s.Seconds
  Write-Host "  $flag $($s.Name)  $($s.Seconds)s"
}
Write-Host ""
if ($script:unitSummary) {
  Write-Host "阶段 1 单元测试：$($script:unitSummary)（RID=$runId）"
}
# ★ 逐条失败清单原地留档（[审查-5] 🟠-3）——
#   以前这里只有一行总数，逐条清单在被覆盖的中间文件里 ⇒ 事后无法复核「那 N 条是什么」。
#   现在把它整段抄进本轮日志；抄不到而 fail>0 时**显式写出「清单缺失」**，不再让总数冒充结论。
if ($script:unitFailList.Count) {
  Write-Host ""
  Write-Host "--- 阶段 1 逐条失败清单（RID=$runId，共 $($script:unitFailList.Count) 行）---"
  foreach ($l in $script:unitFailList) { Write-Host "  $l" }
  Write-Host "--- 逐条失败清单结束 ---"
}
Write-Host ""
Write-Host "总耗时：$([math]::Round($total,1))s（$([math]::Round($total/60,1)) 分钟）"
if ($failCount -eq 0) { Write-Host "结论：全部通过 —— 可以进入打包流程（RID=$runId）" }
else { Write-Host "结论：$failCount 个阶段失败 —— 先修复，不要打包（RID=$runId）" }
Write-Host "提醒：新增功能时必须同步更新检测脚本（见 全面检查说明.md 与 AGENTS.md）。"
exit $failCount
