// 本机系统体检：可用内存、内核内存池、页面文件、开机时长、常驻进程汇总。
//
// 隐私红线（重要）：
//   1. 这里采集的一切【只在本机展示 / 只进本机导出的诊断包】，绝不上传；
//   2. 进程名走白名单 —— 只有本程序、游戏与常见系统/驱动组件会写出名字，
//      其余一律只汇总数量与内存，避免把用户私人程序名（银行、工作软件等）带出去；
//   3. 不采集用户名、机器名、IP、路径等任何身份信息。
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

/** 白名单：只有这些进程会写出名字，其余只做汇总。 */
const KNOWN_PROCESSES = new Set([
  "oliviasoul", "node", "olivia", "steam", "steamwebhelper", "steamservice",
  "msedge", "msedgewebview2", "chrome", "ffmpeg", "ffprobe", "whisper-server",
  "avp", "avpui", "kavfs", "system", "registry", "memory compression",
  "explorer", "dwm", "svchost", "csrss", "wininit", "services", "lsass", "audiodg",
]);

const PS = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$c = Get-Counter -Counter @(
  '\\Memory\\Available MBytes',
  '\\Memory\\Pool Nonpaged Bytes',
  '\\Memory\\Pool Paged Bytes',
  '\\Memory\\Committed Bytes',
  '\\Memory\\Commit Limit',
  '\\System\\System Up Time'
) -ErrorAction SilentlyContinue
function pick($frag) {
  $s = $c.CounterSamples | Where-Object { $_.Path -like "*$frag*" } | Select-Object -First 1
  if ($s) { return [double]$s.CookedValue } else { return $null }
}
$procs = @()
foreach ($p in (Get-Process)) {
  $procs += [pscustomobject]@{ name = $p.ProcessName; count = 1; commit = [double]$p.PagedMemorySize64 }
}
[ordered]@{
  availableMB  = pick 'available mbytes'
  nonpagedBytes = pick 'pool nonpaged'
  pagedBytes   = pick 'pool paged'
  committedBytes = pick 'committed bytes'
  commitLimitBytes = pick 'commit limit'
  uptimeSeconds = pick 'system up time'
  processes = $procs
} | ConvertTo-Json -Compress -Depth 4
`;

function round(value, digits = 1) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

/**
 * 采集本机系统状态。任何一步拿不到就标 null（不抛错）——
 * 体检是"参考信息"，不该因为它失败而让调用方崩溃。
 */
export async function probeSystem({ timeoutMs = 8000 } = {}) {
  const result = {
    collectedAt: new Date().toISOString(),
    memory: { totalMB: round(os.totalmem() / 1e6, 0), availableMB: null, committedMB: null, commitLimitMB: null, commitPercent: null },
    kernelPool: { nonpagedMB: null, pagedMB: null, verdict: "unknown", note: "" },
    pageFile: { totalGB: null, usagePercent: null },
    uptimeHours: null,
    processes: { count: null, known: [], other: { count: 0, commitMB: 0 } },
    warnings: [],
    probeError: null,
  };

  try {
    const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
    const data = JSON.parse(String(stdout).replace(/^\uFEFF/u, ""));
    const MB = 1024 * 1024;

    result.memory.availableMB = data.availableMB === null ? null : round(data.availableMB, 0);
    result.memory.committedMB = data.committedBytes === null ? null : round(data.committedBytes / MB, 0);
    result.memory.commitLimitMB = data.commitLimitBytes === null ? null : round(data.commitLimitBytes / MB, 0);
    if (result.memory.committedMB && result.memory.commitLimitMB) {
      result.memory.commitPercent = round((result.memory.committedMB / result.memory.commitLimitMB) * 100, 0);
    }
    result.kernelPool.nonpagedMB = data.nonpagedBytes === null ? null : round(data.nonpagedBytes / MB, 0);
    result.kernelPool.pagedMB = data.pagedBytes === null ? null : round(data.pagedBytes / MB, 0);
    result.uptimeHours = data.uptimeSeconds === null ? null : round(data.uptimeSeconds / 3600, 1);

    // 进程汇总：白名单写名字，其余只累计
    const named = new Map();
    for (const item of Array.isArray(data.processes) ? data.processes : []) {
      const name = String(item?.name ?? "").trim();
      const commitMB = Number(item?.commit ?? 0) / MB;
      if (!name) continue;
      if (KNOWN_PROCESSES.has(name.toLowerCase())) {
        const hit = named.get(name) ?? { name, count: 0, commitMB: 0 };
        hit.count += 1; hit.commitMB += commitMB;
        named.set(name, hit);
      } else {
        result.processes.other.count += 1;
        result.processes.other.commitMB += commitMB;
      }
    }
    result.processes.count = (Array.isArray(data.processes) ? data.processes.length : 0) || null;
    result.processes.known = [...named.values()]
      .map(item => ({ name: item.name, count: item.count, commitMB: round(item.commitMB, 0) }))
      .sort((a, b) => b.commitMB - a.commitMB).slice(0, 12);
    result.processes.other.commitMB = round(result.processes.other.commitMB, 0);

    // 页面文件（拿不到就留 null）
    for (const drive of ["C:", "D:", "E:", "F:"]) {
      const file = `${drive}\\pagefile.sys`;
      try { if (existsSync(file)) { result.pageFile.totalGB = round(statSync(file).size / 1024 ** 3, 2); break; } } catch { /* 忽略 */ }
    }
  } catch (error) {
    result.probeError = error instanceof Error ? error.message : String(error);
  }

  // 结论与人话建议（① 体检页与 ⑦ 诊断包都用这段）
  const nonpaged = result.kernelPool.nonpagedMB;
  if (nonpaged !== null) {
    if (nonpaged > 4096) {
      result.kernelPool.verdict = "critical";
      result.kernelPool.note = `内核非分页池 ${nonpaged} MB，明显偏高（正常 < 1000 MB）。这类内存由驱动分配、不会被换出，`
        + "会持续占用物理内存；常见原因是网络过滤/加速器/抓包类驱动的泄漏。只有重启能回收。";
    } else if (nonpaged > 1536) {
      result.kernelPool.verdict = "high";
      result.kernelPool.note = `内核非分页池 ${nonpaged} MB，偏高（正常 < 1000 MB），建议留意它的增长速度。`;
    } else {
      result.kernelPool.verdict = "normal";
      result.kernelPool.note = `内核非分页池 ${nonpaged} MB，正常。`;
    }
  }
  if (result.memory.availableMB !== null && result.memory.availableMB < 1500) {
    result.warnings.push(`可用物理内存只剩 ${result.memory.availableMB} MB，系统正在大量换页 —— 游戏与内嵌浏览器在这种状态下更容易崩，建议重启后再玩。`);
  }
  if (result.memory.commitPercent !== null && result.memory.commitPercent >= 85) {
    result.warnings.push(`提交内存已到上限的 ${result.memory.commitPercent}%，页面文件压力很大。`);
  }
  if (result.uptimeHours !== null && result.uptimeHours >= 72 && result.kernelPool.verdict !== "normal") {
    result.warnings.push(`已开机 ${result.uptimeHours} 小时没重启，内核池偏高与长时间不重启通常同时出现。`);
  }
  if (result.probeError) {
    result.warnings.push("系统状态有一部分没取到（可能是权限或系统策略限制），下面的结论可能不完整。");
  }
  return result;
}
