// 源码编码不变量：防止「用错编码写文件」把脚本写坏。
//
// 真实事故：用 latin1 往 packaging/build-release.ps1 里写中文注释，
// 中文字符被写成乱码字节，PowerShell 解析直接失败（The term 'e' is not recognized），
// 打包中止。这类问题代码审查看不出来，但一个编码检查就能永久挡住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const SKIP = /node_modules|dist-native|_build|package-work|\.git/u;
const rel = pathname => pathname.replace(/^.*\/local-service\//u, '');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      if (SKIP.test(url.pathname)) continue;
      await walk(url, out);
      continue;
    }
    if (/\.(js|mjs|cjs|ps1|json)$/u.test(entry.name)) out.push(url);
  }
  return out;
}

test('所有源文件必须是合法 UTF-8（用错编码写文件会直接写坏脚本）', async () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const offenders = [];
  for (const url of await walk(ROOT)) {
    try { decoder.decode(await readFile(url)); }
    catch { offenders.push(rel(url.pathname)); }
  }
  assert.deepEqual(offenders, [],
    `这些文件不是合法 UTF-8（很可能被用错编码写过）：\n${offenders.join('\n')}`);
});

test('含中文的 PowerShell 脚本必须带 UTF-8 BOM（否则 PS 5.1 会按 GBK 读坏）', async () => {
  const offenders = [];
  for (const url of await walk(ROOT)) {
    if (!url.pathname.endsWith('.ps1')) continue;
    const bytes = await readFile(url);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    if (hasBom) continue;
    const text = new TextDecoder('utf-8').decode(bytes);
    if (/[\u4e00-\u9fff]/u.test(text)) offenders.push(rel(url.pathname));
  }
  assert.deepEqual(offenders, [],
    `这些 ps1 含中文却没有 BOM（PS 5.1 会读成乱码）：\n${offenders.join('\n')}`);
});
