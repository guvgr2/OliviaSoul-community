// 曲名条目脱敏与校验：社区曲目名单的发布门禁
//
// 只允许「文件夹编号 + 曲名」这一对数据进入仓库。
// 任何看起来像个人信息的曲名都会被拒绝：绝对路径、UNC 路径、用户名目录、
// 邮箱、网址、超长数字（UID/设备号/时间戳泄漏）、控制字符。
//
// 用法：
//   node tools/sanitize.js check  data/catalog.json
//   node tools/sanitize.js export 本地命名.csv data/inbox/<你的名字>.json
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const CATALOG_VERSION = 1;

const KEY_RE = /^midi_\d{1,12}_\d{6,}$/u;
const MAX_NAME_LENGTH = 80;
const FP_LENGTH = 512;   // chroma4x64 指纹的 base64 长度，固定值

// 顺序即理由：每一条都是一个真实的泄漏面
const FORBIDDEN = [
  [/[A-Za-z]:[\\/]/u, "包含盘符绝对路径"],
  [/\\\\[^\\\s]/u, "包含 UNC 网络路径"],
  [/\bUsers\b/iu, "包含 Windows 用户目录"],
  [/\bAppData\b/iu, "包含 AppData 路径"],
  [/\bUserData\b/iu, "包含 UserData 路径"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, "包含邮箱地址"],
  [/https?:\/\//iu, "包含网址"],
  [/\b\d{7,}\b/u, "包含超长数字（UID/设备号/时间戳）"],
  [/[\u0000-\u001f\u007f]/u, "包含控制字符"],
];

export function sanitizeName(raw) {
  const text = String(raw ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) return { ok: false, reason: "曲名为空" };
  if (text.length > MAX_NAME_LENGTH) return { ok: false, reason: `曲名超过 ${MAX_NAME_LENGTH} 字` };
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(text)) return { ok: false, reason };
  }
  return { ok: true, name: text };
}

export function entryHash(key, name) {
  return createHash("sha256").update(`${key}\n${name}`, "utf8").digest("hex").slice(0, 16);
}

/** 构造一条可上传的社区条目；不合法就返回 null（并给出原因）。 */
export function buildEntry(key, name) {
  const folder = String(key ?? "").trim();
  if (!KEY_RE.test(folder)) return { ok: false, reason: "编号格式不对（应为 midi_数字_数字）" };
  const checked = sanitizeName(name);
  if (!checked.ok) return checked;
  return { ok: true, entry: { key: folder, name: checked.name, hash: entryHash(folder, checked.name) } };
}

export function checkCatalog(document) {
  const problems = [];
  const entries = document && typeof document === "object" ? document.entries : null;
  if (!entries || typeof entries !== "object") return { ok: false, problems: ["缺少 entries 对象"] };
  for (const [key, value] of Object.entries(entries)) {
    const songName = typeof value === "string" ? value : value?.name;
    const raw = typeof value === "object" ? value : {};
    const list = Array.isArray(raw.fps) && raw.fps.length ? raw.fps : (raw.fp ? [raw.fp] : []);
    if (list.length !== 3) problems.push(`${key}: 指纹段数 ${list.length}，应为 3`);
    for (const [index, one] of list.entries()) {
      if (String(one).length !== FP_LENGTH) problems.push(`${key}: 第 ${index + 1} 段指纹长度 ${String(one).length}，应为 ${FP_LENGTH}`);
    }
    const result = buildEntry(key, songName);
    if (!result.ok) problems.push(`${key}: ${result.reason}`);
  }
  return { ok: problems.length === 0, problems, count: Object.keys(entries).length };
}

/** 从本地命名记录（CSV：时间,文件夹,曲名,...）导出 inbox 文件。 */
export async function exportFromCsv(csvPath, outPath) {
  const text = await readFile(csvPath, "utf8");
  const entries = {};
  const rejected = [];
  for (const line of text.split(/\r?\n/u).slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const key = (cells[1] ?? "").trim();
    const name = (cells[2] ?? "").trim();
    if (!key) continue;
    const result = buildEntry(key, name);
    if (result.ok) entries[result.entry.key] = result.entry.name;
    else rejected.push(`${key}: ${result.reason}`);
  }
  const document = { version: CATALOG_VERSION, updatedAt: new Date().toISOString(), entries };
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { exported: Object.keys(entries).length, rejected };
}

if (process.argv[1] && process.argv[1].endsWith("sanitize.js")) {
  const [command, a, b] = process.argv.slice(2);
  if (command === "check") {
    const document = JSON.parse(await readFile(a, "utf8"));
    const result = checkCatalog(document);
    console.log(result.ok ? `门禁通过：${result.count} 条` : `门禁拒绝 ${result.problems.length} 条：\n${result.problems.slice(0, 30).join("\n")}`);
    process.exit(result.ok ? 0 : 1);
  } else if (command === "export") {
    const result = await exportFromCsv(a, b);
    console.log(`导出 ${result.exported} 条到 ${b}`);
    if (result.rejected.length) console.log(`被拒绝 ${result.rejected.length} 条：\n${result.rejected.slice(0, 20).join("\n")}`);
  } else {
    console.log("用法: node tools/sanitize.js check <catalog.json> | export <命名.csv> <out.json>");
  }
}