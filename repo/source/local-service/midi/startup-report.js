// 启动耗时报表（g13 从 listen-naming.js 抽出来，诊断包与面板共用同一份实现，避免两处逻辑漂移）
//
// 输入：<UserData>\runtime.log（必要时连上一份 runtime.previous.log）里的 startup-stage 行。
// 原生宿主与 node 宿主都会打这些行（g11 加的埋点）。
//
// g13 修正：以前只按宿主 pid 归组，会把这些情况算成"一次启动"，导致出现「启动耗时 18394 秒」这种数字：
//   · 宿主一直开着，中途重启了本地 node 服务（node started 的 sinceProcessStartMs 很大是正常的）
//   · pid 被复用后，两次不同的启动被并成一条时间线
// 现在：① 同一 pid 内按时间窗（>10 分钟算新会话）切分；② 宿主总耗时只看宿主自己打的阶段；
//      ③ node 侧阶段单独作为"本地服务就绪"这一段，不混进宿主总耗时；④ 缺宿主阶段时标记为记录不完整。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {{ userDataDir: string, limit?: number }} options
 * @returns {Promise<{boots: Array<object>, logFile: string, note: string}>}
 */
export async function startupReport({ userDataDir, limit = 3 } = {}) {
  if (!userDataDir) throw new Error("startupReport 需要 userDataDir");
  const stages = [];
  const nodeStarts = [];   // 同一宿主可能启动多次 node（运行中重启）
  const files = [
    join(userDataDir, "runtime.previous.log"),
    join(userDataDir, "runtime.log"),
  ];
  for (const file of files) {
    let text = "";
    try { text = await readFile(file, "utf8"); } catch { continue; }
    // 只保留最后 4000 行，避免把几 MB 的日志全解析一遍
    const lines = text.split(/\r?\n/u).slice(-4000);
    for (const line of lines) {
      const bootLine = /desktop=(\d+)\s+.*?node started.*?sinceProcessStartMs=(\d+)/u.exec(line);
      if (bootLine) {
        nodeStarts.push({ host: bootLine[1], at: line.slice(0, 23), hostUpMs: Number(bootLine[2]) });
        continue;
      }
      const match = /desktop=(\d+)\s+.*?startup-stage=(\S+)(.*)$/u.exec(line);
      if (!match) continue;
      const elapsed = /elapsedMs=(\d+)/u.exec(match[3]);
      const sinceProcess = /sinceProcessStartMs=(\d+)/u.exec(match[3]);
      const sinceNode = /sinceNodeStartMs=(\d+)/u.exec(match[3]);
      stages.push({
        host: match[1],
        stage: match[2],
        at: line.slice(0, 23),
        elapsedMs: elapsed ? Number(elapsed[1]) : null,
        sinceProcessStartMs: sinceProcess ? Number(sinceProcess[1]) : null,
        sinceNodeStartMs: sinceNode ? Number(sinceNode[1]) : null,
        // 宿主自己打的阶段行带 pid=；node 打的只有 sinceNodeStartMs
        hostSide: /(?:^|\s)pid=\d+/u.test(match[3]),
      });
    }
  }

  const ms = value => (Number.isFinite(value) ? value : null);
  const SESSION_GAP_MS = 10 * 60 * 1000;

  // 按宿主 pid 归组，再在组内按时间窗切会话
  const byHost = new Map();
  for (const item of stages) {
    if (!byHost.has(item.host)) byHost.set(item.host, []);
    byHost.get(item.host).push(item);
  }
  const startsByHost = new Map();
  for (const item of nodeStarts) {
    if (!startsByHost.has(item.host)) startsByHost.set(item.host, []);
    startsByHost.get(item.host).push(item);
  }

  const sessions = [];
  for (const [host, items] of byHost) {
    items.sort((left, right) => String(left.at).localeCompare(String(right.at)));
    let current = null;
    for (const item of items) {
      const at = Date.parse(String(item.at).replace(" ", "T"));
      if (!current || at - current.lastAt > SESSION_GAP_MS) {
        current = { host, first: item.at, lastAt: at, stages: [] };
        sessions.push(current);
      }
      current.lastAt = at;
      current.stages.push(item);
    }
  }

  const list = sessions
    .sort((left, right) => String(left.first).localeCompare(String(right.first)))
    .slice(-limit)
    .reverse();

  for (const boot of list) {
    const bootAt = Date.parse(String(boot.first).replace(" ", "T"));
    // 这次会话里的 node 启动：第一个算"本次启动拉起"，之后的算"宿主运行中重启服务"
    const starts = (startsByHost.get(boot.host) ?? [])
      .filter(item => {
        const at = Date.parse(String(item.at).replace(" ", "T"));
        return at >= bootAt - 1000 && at <= boot.lastAt + 1000;
      })
      .sort((left, right) => String(left.at).localeCompare(String(right.at)));

    // 宿主侧阶段：同阶段保留最小耗时的那条
    const rawStages = boot.stages.slice();
    const merged = new Map();
    for (const item of rawStages) {
      if (!item.hostSide) continue;
      const key = item.stage;
      const value = item.sinceProcessStartMs ?? item.elapsedMs ?? 0;
      const currentItem = merged.get(key);
      if (!currentItem
        || value < (currentItem.sinceProcessStartMs ?? currentItem.elapsedMs ?? Infinity)) merged.set(key, item);
    }
    boot.stages = [...merged.values()].sort((left, right) => (left.elapsedMs ?? 0) - (right.elapsedMs ?? 0));
    boot.totalMs = boot.stages.length
      ? Math.max(...boot.stages.map(item => item.sinceProcessStartMs ?? item.elapsedMs ?? 0))
      : null;
    boot.partial = boot.stages.length === 0;   // 只有 node 阶段行时，这次会话的记录不完整

    // "最慢的一段"按相邻阶段差值算（累计值最大的永远是最后一段，没有信息量）
    const ordered = [...boot.stages].sort((left, right) =>
      (left.sinceProcessStartMs ?? 0) - (right.sinceProcessStartMs ?? 0));
    let worst = null;
    let previous = 0;
    for (const item of ordered) {
      const at = item.sinceProcessStartMs ?? item.elapsedMs ?? 0;
      const delta = Math.max(0, at - previous);
      if (!worst || delta > worst.deltaMs) worst = { stage: item.stage, at, deltaMs: delta };
      previous = Math.max(previous, at);
    }
    boot.slowest = worst;

    // node 侧：最大 sinceNodeStartMs = 本地服务就绪耗时（跟宿主总耗时是两把尺子，分开显示）
    boot.nodeReadyMs = null;
    for (const item of rawStages) {
      if (item.hostSide || item.sinceNodeStartMs == null) continue;
      boot.nodeReadyMs = Math.max(boot.nodeReadyMs ?? 0, item.sinceNodeStartMs);
    }
    // 本次会话对应的 node 启动记录（用于"运行中重启服务"的展示）
    boot.restarts = starts.slice(1).map((item, index) => ({
      at: item.at,
      hostUpMs: item.hostUpMs,
      order: index + 2,
    }));
    boot.nodeStartAt = starts[0]?.at ?? null;
    boot.nodeStartHostUpMs = ms(starts[0]?.hostUpMs);
    // 宿主已经跑了一会儿才拉起 node（>60 秒）→ 这是"运行中重启本地服务"，不是一次新启动
    boot.nodeRestartedInPlace = (boot.nodeStartHostUpMs ?? 0) > 60_000;
  }

  return {
    boots: list,
    logFile: join(userDataDir, "runtime.log"),
    note: "宿主耗时 = 宿主进程启动 → 界面可见；本地服务就绪 = node 起来 → 服务可用（另一把尺子）；"
      + "若日志里出现「宿主运行中重启服务」，那是本地服务被重新拉起，不是一次新启动",
  };
}
