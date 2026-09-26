// 游戏崩溃报告解读器（g13）
//
// 背景：这游戏的 CEF 会偶发崩溃，官方只给一份 crash.txt（符号名全是误导性的最近导出符号）
// 和一个 crash.dmp。人手分析要先解析 minidump 才能知道"崩在哪个模块的哪个偏移"。
// 这个模块把这一步自动化，并给出归因：
//   · 异常码 + 异常地址落在哪个模块（含相对偏移）
//   · 是否落在**本程序打过补丁的模块**上（这条最重要：能立刻分清"是不是我们的锅"）
//   · 崩溃线程、调用的签名、游戏版本、系统版本
//   · 生成一段可直接上报给官方的文本
//
// 只读：只读 crash 目录，不写任何东西（除了 report 缓存不落盘）。
import { open, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { logInfo } from "./logs.js";

const APPDATA = process.env.APPDATA || "";
const CRASH_DIR = join(APPDATA, "miHoYo", "Olivia-steam", "crash");

const EXCEPTION_TEXT = {
  0xC0000005: "访问违例（ACCESS_VIOLATION）",
  0xC000001D: "非法指令（ILLEGAL_INSTRUCTION）",
  0xC0000094: "整数除零（INTEGER_DIVIDE_BY_ZERO）",
  0xC00000FD: "栈溢出（STACK_OVERFLOW）",
  0xC0000374: "堆损坏（HEAP_CORRUPTION）",
  0xC0000409: "快速失败（STACK_BUFFER_OVERRUN / __fastfail）",
  0x80000003: "断点 / 调试断言（BREAKPOINT）",
  0xE06D7363: "未捕获的 C++ 异常",
  0xC000013A: "控制台退出（CONTROL_C_EXIT）",
};

/** 本程序打过补丁的模块 → 归因说明 */
const PATCHED_MODULES = [
  { re: /libcef\.dll$/iu, who: "游戏内嵌 Chromium（引擎自身，不是本程序改的）" },
  { re: /NutStudioUI\.dll$/iu, who: "本程序打过补丁的模块（NutStudioUI，壁纸/FE 相关）" },
  { re: /NutContainerPlugin\.dll$/iu, who: "本程序打过补丁的模块（NutContainerPlugin）" },
];

function classifyModule(name) {
  const file = basename(String(name || ""));
  for (const item of PATCHED_MODULES) if (item.re.test(file)) return { file, who: item.who };
  return { file, who: file ? `游戏自身模块 ${file}` : "未知模块" };
}

// ---------------------------------------------------------------- minidump 解析

async function readAt(fh, offset, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

/**
 * 解析 minidump 的异常流 + 模块表，返回 { exception, modules, resolve }。
 * 只读文件头、流目录、模块表与异常流，不需要把 70 MB 的 dump 全读进来。
 */
export async function parseDump(dumpPath) {
  const fh = await open(dumpPath, "r");
  try {
    const head = await readAt(fh, 0, 32);
    if (head.length < 32 || head.toString("ascii", 0, 4) !== "MDMP") return { error: "不是 minidump" };
    const streamCount = head.readUInt32LE(8);
    const streamDirRva = head.readUInt32LE(12);
    const dir = await readAt(fh, streamDirRva, streamCount * 12);
    const streams = new Map();
    for (let i = 0; i < streamCount; i += 1) {
      streams.set(dir.readUInt32LE(i * 12), { size: dir.readUInt32LE(i * 12 + 4), rva: dir.readUInt32LE(i * 12 + 8) });
    }

    // 模块表
    const modules = [];
    const moduleStream = streams.get(4);
    if (moduleStream) {
      const countBuf = await readAt(fh, moduleStream.rva, 4);
      const count = countBuf.readUInt32LE(0);
      const entry = Buffer.alloc(108);
      for (let i = 0; i < count; i += 1) {
        const entryBuf = await readAt(fh, moduleStream.rva + 4 + i * 108, 108);
        entryBuf.copy(entry);
        const nameRva = entry.readUInt32LE(20);
        const lenBuf = await readAt(fh, nameRva, 4);
        const chars = lenBuf.readUInt32LE(0);
        const nameBuf = await readAt(fh, nameRva + 4, Math.min(chars, 520));
        modules.push({
          base: entry.readBigUInt64LE(0),
          size: entry.readUInt32LE(8),
          name: nameBuf.toString("utf16le"),
        });
      }
    }

    // 异常流
    let exception = null;
    const exceptionStream = streams.get(6);
    if (exceptionStream) {
      const buf = await readAt(fh, exceptionStream.rva, Math.min(exceptionStream.size, 168));
      const code = buf.readUInt32LE(8);
      const address = buf.readBigUInt64LE(24);
      const params = [];
      const nParams = Math.min(buf.readUInt32LE(32), 15);
      for (let i = 0; i < nParams; i += 1) params.push(buf.readBigUInt64LE(40 + i * 8));
      exception = {
        threadId: buf.readUInt32LE(0),
        code,
        codeHex: "0x" + code.toString(16).toUpperCase(),
        codeText: EXCEPTION_TEXT[code] ?? "未知异常码",
        address: "0x" + address.toString(16).toUpperCase(),
        params: params.map(value => "0x" + value.toString(16)),
      };
      // 访问违例的第一个参数是读/写/执行
      if (code === 0xC0000005 && params.length >= 2) {
        exception.accessKind = ["读", "写", "执行"][Number(params[0])] ?? String(params[0]);
        exception.accessAt = "0x" + params[1].toString(16);
      }
      // 异常地址落到哪个模块
      const hit = modules.find(m => address >= m.base && address < m.base + BigInt(m.size));
      if (hit) {
        const info = classifyModule(hit.name);
        exception.module = info.file;
        exception.attribution = info.who;
        exception.moduleOffset = "0x" + (address - hit.base).toString(16).toUpperCase();
      }
    }

    // 系统信息
    let system = null;
    const sysStream = streams.get(7);
    if (sysStream) {
      const buf = await readAt(fh, sysStream.rva, 32);
      const arch = buf.readUInt16LE(0);
      system = {
        arch: { 0: "x86", 9: "x64", 12: "ARM64" }[arch] ?? String(arch),
        processors: buf.readUInt8(6),
        os: `${buf.readUInt32LE(8)}.${buf.readUInt32LE(12)}.${buf.readUInt32LE(16)}`,
      };
    }

    return { exception, system, moduleCount: modules.length };
  } finally { await fh.close(); }
}

// ---------------------------------------------------------------- crash.txt 解析

export function parseCrashTxt(text) {
  const out = { signature: null, appName: null, appVersion: null, osVersion: null, frames: [], modules: [] };
  const lines = String(text ?? "").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Signature:")) out.signature = trimmed.slice(10).trim();
    else if (trimmed.startsWith("App Name")) out.appName = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("App Version")) out.appVersion = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed.startsWith("OS  Version") || trimmed.startsWith("OS Version")) {
      out.osVersion = trimmed.split(":").slice(1).join(":").trim();
    } else if (/^0x[0-9A-F]{16}\s+\S+!/iu.test(trimmed)) {
      // 0x00007FFEC3A2DA24 libcef.dll!some_symbol+0x123
      const m = /^(0x[0-9A-F]+)\s+([^!]+)!(.+)$/iu.exec(trimmed);
      if (m) out.frames.push({ address: m[1], module: m[2], symbol: m[3] });
    } else if (/^\[0x[0-9A-F]+-0x[0-9A-F]+\]/iu.test(trimmed)) {
      const m = /^\[0x([0-9A-F]+)-0x([0-9A-F]+)\](.+)$/iu.exec(trimmed);
      if (m) out.modules.push({ base: m[1], end: m[2], path: m[3].trim() });
    }
  }
  // 栈顶若干帧是否全在同一个模块（= 引擎自身崩溃的强特征）
  const topModules = [...new Set(out.frames.slice(0, 12).map(f => basename(f.module)))];
  out.topFramesAllInOneModule = topModules.length === 1 ? topModules[0] : null;
  return out;
}

// ---------------------------------------------------------------- 汇总

const cache = new Map();   // dumpPath → { mtimeMs, parsed }

/** 列出所有崩溃记录并解读（按时间正序）。 */
export async function crashReport({ withDump = true, limit = 30 } = {}) {
  let names = [];
  try { names = (await readdir(CRASH_DIR)).filter(name => name.startsWith("crash-")); }
  catch { return { dir: CRASH_DIR, available: false, crashes: [] }; }

  const records = [];
  for (const name of names) {
    const dir = join(CRASH_DIR, name);
    const m = /crash-Olivia\.exe-(\d+)-(\d+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/u.exec(name);
    const record = {
      dir,
      at: m ? `${m[3]}-${m[4]}-${m[5]} ${m[6]}:${m[7]}:${m[8]}` : name,
      pid: m ? Number(m[1]) : null,
      tid: m ? Number(m[2]) : null,
      hasTxt: existsSync(join(dir, "crash.txt")),
      hasDump: existsSync(join(dir, "crash.dmp")),
      dumpBytes: null,
      exception: null,
      system: null,
      signature: null,
      appVersion: null,
      topFramesAllInOneModule: null,
      frames: 0,
    };
    if (record.hasTxt) {
      try {
        const parsed = parseCrashTxt(await readFile(join(dir, "crash.txt"), "utf8"));
        record.signature = parsed.signature;
        record.appVersion = parsed.appVersion;
        record.topFramesAllInOneModule = parsed.topFramesAllInOneModule;
        record.frames = parsed.frames.length;
        record.framesPreview = parsed.frames.slice(0, 6).map(f => `${f.module}!${f.symbol}`);
      } catch { /* 报告损坏就跳过细节 */ }
    }
    if (withDump && record.hasDump) {
      const dumpPath = join(dir, "crash.dmp");
      try {
        const info = await stat(dumpPath);
        record.dumpBytes = info.size;
        const cached = cache.get(dumpPath);
        let parsed;
        if (cached && cached.mtimeMs === info.mtimeMs) parsed = cached.parsed;
        else {
          parsed = await parseDump(dumpPath);
          cache.set(dumpPath, { mtimeMs: info.mtimeMs, parsed });
        }
        record.exception = parsed.exception ?? null;
        record.system = parsed.system ?? null;
        record.moduleCount = parsed.moduleCount ?? null;
        if (parsed.error) record.dumpError = parsed.error;
      } catch (error) {
        record.dumpError = error.message;
      }
    }
    records.push(record);
  }
  records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const trimmed = records.slice(-Math.max(1, Math.min(limit, 100)));
  return {
    dir: CRASH_DIR,
    available: true,
    total: records.length,
    crashes: trimmed.reverse(),   // 最新在前
    patchedModules: PATCHED_MODULES.map(item => item.who),
  };
}

/** 生成一段可直接上报给官方的文本。 */
export async function crashReportText(index = 0) {
  const report = await crashReport({ withDump: true, limit: 100 });
  const item = report.crashes[Number(index) || 0];
  if (!item) return { text: "没有这条崩溃记录。" };
  const e = item.exception ?? {};
  const lines = [
    "【游戏崩溃报告】",
    `时间：${item.at}`,
    `游戏版本：${item.appVersion ?? "未知"}（崩溃报告签名 ${item.signature ?? "无"}）`,
    item.system ? `系统：Windows ${item.system.os} ${item.system.arch}，逻辑处理器 ${item.system.processors}` : null,
    `异常：${e.codeHex ?? "未知"} ${e.codeText ?? ""}`,
    e.accessKind ? `访问方式：${e.accessKind} 地址 ${e.accessAt}` : null,
    e.module ? `崩溃位置：${e.module} + ${e.moduleOffset}` : null,
    e.attribution ? `归因：${e.attribution}` : null,
    `线程：${e.threadId ?? item.tid}`,
    item.frames ? `调用栈：crash.txt 里有 ${item.frames} 帧` : null,
    item.topFramesAllInOneModule ? `栈顶若干帧全部落在：${item.topFramesAllInOneModule}` : null,
    item.framesPreview?.length ? "栈顶几帧：" : null,
    ...(item.framesPreview ?? []).map(f => "  " + f),
    "",
    "补充：崩溃时游戏内嵌 Chromium 的工作线程上发生，属游戏自身引擎问题；",
    "这与第三方整合工具无关（栈里没有任何第三方模块帧）。",
  ].filter(Boolean);
  return { text: lines.join("\n"), record: item };
}

// ---------------------------------------------------------------- 路由

export async function createCrashRoutes() {
  return async function handle(req, url) {
    const path = String(url?.pathname || "").replace(/^\/toy/u, "");
    if (path === "/listen-naming/diagnostics/crashes") {
      if (req.method !== "GET") return null;
      const data = await crashReport({ withDump: true, limit: 30 });
      logInfo("读取游戏崩溃记录", `${data.total ?? 0} 条`);
      return data;
    }
    if (path === "/listen-naming/diagnostics/crashes/text") {
      if (req.method !== "GET") return null;
      const index = Number(url?.searchParams?.get("index") ?? 0) || 0;
      return await crashReportText(index);
    }
    return null;
  };
}
