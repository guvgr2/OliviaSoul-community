// 合并社区投稿：data/community/*.json（每人一个文件）→ data/catalog.json
//
// 为什么按人分文件：多人同时投稿时不会互相踩，也不至于几千条挤在一个文件里打架。
// 为什么能自动去重：靠音乐指纹。同一首歌在不同用户那里文件夹编号不同，但指纹相同（≥ 0.90）。
//
// 用法:
//   node tools/merge-inbox.js            # 合并并写回 catalog.json
//   node tools/merge-inbox.js --dry-run  # 只看报告不写
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildEntry, checkCatalog, CATALOG_VERSION } from "./sanitize.js";
import { verifyMatch, FP_ALGO, FP_VERSION, FP_SIMILARITY_THRESHOLD } from "./fingerprint.js";

const DATA = "data";
const COMMUNITY = `${DATA}/community`;
const CATALOG = `${DATA}/catalog.json`;
const dry = process.argv.includes("--dry-run");

async function loadDir(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter(n => n.endsWith(".json"));
  const out = [];
  for (const name of files) {
    let document;
    try {
      document = JSON.parse(await readFile(`${dir}/${name}`, "utf8"));
    } catch (error) {
      out.push({ file: `${dir}/${name}`, error: `解析失败: ${error.message}` });
      continue;
    }
    for (const [key, value] of Object.entries(document.entries ?? {})) {
      const songName = typeof value === "string" ? value : value?.name;
      const raw = typeof value === "object" ? value : {};
      const fps = Array.isArray(raw.fps) && raw.fps.length ? raw.fps : (raw.fp ? [raw.fp] : []);
      const checked = buildEntry(key, songName);
      if (!checked.ok) out.push({ file: `${dir}/${name}`, key, error: checked.reason });
      else out.push({ file: `${dir}/${name}`, key, name: checked.entry.name, hash: checked.entry.hash, fps });
    }
  }
  return out;
}

const incoming = [...await loadDir(COMMUNITY), ...await loadDir(`${DATA}/inbox`)];
const existing = existsSync(CATALOG) ? JSON.parse(await readFile(CATALOG, "utf8")) : { entries: {} };
const merged = new Map();
for (const [key, value] of Object.entries(existing.entries ?? {})) {
  merged.set(key, typeof value === "string" ? { name: value, fps: [] } : value);
}

const report = { added: 0, sameKey: 0, duplicateByFp: 0, rejected: [], conflicts: [] };
for (const item of incoming) {
  if (item.error) { report.rejected.push(`${item.key ?? item.file}: ${item.error}`); continue; }
  if (merged.has(item.key)) { report.sameKey += 1; continue; }
  let duplicateOf = "";
  if (item.fps.length) {
    for (const [key, value] of merged) {
      const other = Array.isArray(value.fps) && value.fps.length ? value.fps : (value.fp ? [value.fp] : []);
      if (!other.length) continue;
      if (verifyMatch(item.fps, other).ok) { duplicateOf = key; break; }
    }
  }
  if (duplicateOf) {
    report.duplicateByFp += 1;
    const kept = merged.get(duplicateOf);
    if (kept.name !== item.name) report.conflicts.push(`${item.key}(${item.name}) 与 ${duplicateOf}(${kept.name}) 指纹相同但名字不同`);
    continue;
  }
  merged.set(item.key, { name: item.name, hash: item.hash, fps: item.fps });
  report.added += 1;
}

const catalog = {
  version: CATALOG_VERSION,
  fingerprint: { algo: FP_ALGO, version: FP_VERSION, threshold: FP_SIMILARITY_THRESHOLD },
  updatedAt: new Date().toISOString(),
  license: "CC0-1.0",
  entries: Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b))),
};

console.log(`读入投稿 ${incoming.length} 条`);
console.log(`  新增 ${report.added}，同编号跳过 ${report.sameKey}，指纹判定重复 ${report.duplicateByFp}`);
if (report.rejected.length) console.log(`  门禁拒绝 ${report.rejected.length} 条:\n    ${report.rejected.slice(0, 20).join("\n    ")}`);
if (report.conflicts.length) console.log(`  需人工核对 ${report.conflicts.length} 条:\n    ${report.conflicts.slice(0, 20).join("\n    ")}`);
const check = checkCatalog(catalog);
console.log(`  合并后 ${check.count} 条，门禁: ${check.ok ? "通过" : `不通过 ${check.problems.slice(0, 5).join("; ")}`}`);
if (dry) console.log("  [--dry-run] 未写入");
else { await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`, "utf8"); console.log(`  已写入 ${CATALOG}`); }