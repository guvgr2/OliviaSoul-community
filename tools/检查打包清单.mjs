// 打包后防呆检查：server.js 引用的 midi/ 模块是否都真的打进了包
// 这类"加了新模块忘了同步打包清单"的坑已经踩过两次，跑一下这个就不会再犯。
//
// 用法: node tools/检查打包清单.mjs <解压后的程序目录 或 frozen-stage 目录>
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2] || "";
const appDir = target.endsWith("app") ? target : join(target, "app");
const serverPath = join(appDir, "server.js");
if (!existsSync(serverPath)) {
  console.log(`找不到 ${serverPath}，请传入解压后的程序目录（含 app\\server.js）`);
  process.exit(2);
}
const source = await readFile(serverPath, "utf8");
const imported = new Set([...source.matchAll(/from "\.\/(midi|lyrics|desktop)\/([^"]+)"/gu)].map(m => `${m[1]}/${m[2]}`));
const missing = [];
for (const rel of imported) if (!existsSync(join(appDir, rel))) missing.push(rel);

const publicDir = join(appDir, "public");
const scripts = [...source.matchAll(/"([a-z0-9-]+\.js)"/gu)].map(m => m[1]);
const publicMissing = [];
for (const name of new Set(scripts)) {
  if (name.endsWith(".js") && !existsSync(join(publicDir, name)) && !existsSync(join(appDir, name))) {
    // 只报前端目录里应该存在的那些
    if (/^(listen-naming|legal-notices|logs-page|dependency-check)/u.test(name)) publicMissing.push(name);
  }
}

console.log(`检查目录: ${appDir}`);
console.log(`server.js 引用的模块: ${imported.size} 个`);
if (missing.length) {
  console.log(`✗ 缺失模块（打包清单漏了）: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("✓ 后端模块齐全");
if (publicMissing.length) {
  console.log(`✗ 前端脚本缺失: ${publicMissing.join(", ")}`);
  process.exit(1);
}
console.log("✓ 前端脚本齐全");