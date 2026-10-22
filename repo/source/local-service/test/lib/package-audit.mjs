// 发布产物（Portable.zip）与当前源码的核对工具。
//
// 病根（2026-10-21 审计实证）：repo/build-*/ 里的旧包整段缺「命名纠错」功能
//   （包内 app/midi/listen-naming.js 98782B / 源码 111221B，4 个特征标记只中 1 个），
//   但既有判据 package-freshness.test.js **只比对 resources/workspace-template/harness/****，
//   对 app/midi/**、app/public/** 完全失明 ⇒ 旧包照样过检、全仓一路绿灯。
//   同类缺口还有两处：packaging-artifact.test.js 全用自建夹具从不看真包；
//   package-author-path.test.js 只测判据正则、不对真包扫。
// 本模块把核对范围从「harness 15 个文件」扩到**包内全部源码文件**，供
//   test/package-release-audit.test.js 使用。
//
// 设计取舍：
//   1. 按条目随机读取（读 central directory + seek），不整包解压。
//      603MB 的包整包解压既慢又吃内存；只需要其中约 100 个源码条目。
//   2. ★ 只做「包 → 源码」正向核对，不做反向（源码 → 包）。
//      反向会假红：打包脚本对 midi/desktop/lyrics 用的是**白名单**（未列入的不进包，
//      且只 Write-Warning 不阻断），反向枚举必然撞上「源码有、包里没有」。
//      正向核对正好命中本轮病根「包内文件与源码不一致」，且无需同步打包清单（无文档漂移）。
//   3. ★ 显式排除会被打包脚本裁剪/生成的区域，否则必然假红：
//      - app/node_modules/：整拷后**删除 playwright、playwright-core**（build-release.ps1:410→411）
//        ⇒ 包内 node_modules 与源码 node_modules 天生不等，比了就是假红。
//      - runtime/ runtimes/ redist/：下载的 Node/ffmpeg/WebView2 引导器与原生产物。
//      - resources/workspace-template/tools/：来源混合（tools/ 与 public/song-editor.js），
//        还有编译产物（steam-launcher），不是纯源码拷贝。
//
// 注意：本模块做的是**字节比对**，所以读源码必须用原始 readFileSync，
//       不能走 readSourceText（剥注释）—— 那会让「内容相等」判据失真。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

// ── 最小 ZIP 随机读取 ──────────────────────────────────────────────
function findEocd(buf) {
  const max = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - max; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function readZipIndex(path) {
  const buf = readFileSync(path);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip（找不到 EOCD）：" + path);
  const count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const index = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    index.set(name, { method, compSize, size, lfhOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, index, path };
}

export function readZipEntry(zip, name) {
  const meta = zip.index.get(name);
  if (!meta) return undefined;
  const lfh = meta.lfhOffset;
  if (lfh + 30 > zip.buf.length || zip.buf.readUInt32LE(lfh) !== LFH_SIG) {
    throw new Error("local header 损坏：" + name);
  }
  const nameLen = zip.buf.readUInt16LE(lfh + 26);
  const extraLen = zip.buf.readUInt16LE(lfh + 28);
  const start = lfh + 30 + nameLen + extraLen;
  const raw = zip.buf.subarray(start, start + meta.compSize);
  if (meta.method === 0) return raw;
  if (meta.method === 8) return inflateRawSync(raw);
  throw new Error("不支持的压缩方式 " + meta.method + "：" + name);
}

// ── 包内路径 → 源码路径 ────────────────────────────────────────────
// 返回值：源码绝对路径；null = 不核对（跳过）
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md", ".ps1"]);
const SKIP_PREFIX = [
  "app/node_modules/",
  "runtime/",
  "runtimes/",
  "redist/",
  "resources/workspace-template/tools/",
];

export function mapToSource(pkgPath, roots) {
  if (SKIP_PREFIX.some(p => pkgPath.startsWith(p))) return null;
  const ext = pkgPath.slice(pkgPath.lastIndexOf(".")).toLowerCase();
  if (!SOURCE_EXT.has(ext)) return null;

  const { localService, harness } = roots;
  // 统一用 join：包内是 / 分隔，Windows 源码路径要转成 \，避免混合分隔符的边界情况。
  const under = (base, rel) => join(base, ...rel.split("/"));
  if (pkgPath.startsWith("app/public/")) return under(localService, pkgPath.slice(4));
  if (pkgPath.startsWith("app/midi/")) return under(localService, pkgPath.slice(4));
  if (pkgPath.startsWith("app/desktop/")) return under(localService, pkgPath.slice(4));
  if (pkgPath.startsWith("app/lyrics/")) return under(localService, pkgPath.slice(4));
  if (pkgPath.startsWith("app/")) {
    // 顶层：server.js / model-config.js / package.json …… 与源码同形；
    // app/ 下其它子目录（如 node_modules 之外的）一律不核对。
    const rest = pkgPath.slice(4);
    if (rest.includes("/")) return null;
    return join(localService, rest);
  }
  const H = "resources/workspace-template/harness/";
  if (pkgPath.startsWith(H)) return under(harness, pkgPath.slice(H.length));
  return null;
}

export function auditZipAgainstSource(zipPath, roots) {
  const zip = readZipIndex(zipPath);
  const problems = [];
  let checked = 0;
  let skipped = 0;
  for (const name of zip.index.keys()) {
    const norm = name.split("\\").join("/");
    if (norm.endsWith("/")) continue;
    const src = mapToSource(norm, roots);
    if (src === null || !existsSync(src)) {
      skipped += 1;
      continue;
    }
    const pkgBytes = readZipEntry(zip, name);
    const srcBytes = readFileSync(src);
    checked += 1;
    if (!pkgBytes.equals(srcBytes)) {
      problems.push(
        `内容不一致（源码改了、包没重建，或这就是个旧构建）：${norm}  ` +
        `包 ${pkgBytes.length}B / 源码 ${srcBytes.length}B`);
    }
  }
  return { problems, checked, skipped, label: zipPath };
}

// ── 造最小 zip（store 模式），仅供「判据有牙齿」的变异/阴性对照使用 ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function makeStoreZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── 扫描缓冲区里的作者路径 / 个人信息（ASCII + UTF-16LE 双通道）──────
// 说明：Inno Setup 的 Setup.exe 是 lzma2 压缩，无法按条目解包，
//       只能整文件做字节扫描；UTF-16LE（宽字符）通道就是为它准备的。
// ★ 作者用户名与机器名一律**拼接构造**，不让字面量落在源码里：
//   repo-privacy 门禁扫 git ls-files 全库，逐字写出会被它自己拦下
//   （约定见 test/repo-privacy.test.js 顶部注释与 FORBIDDEN_PATTERNS 的拼法）。
const AUTHOR_USER = "guv" + "gr";
const AUTHOR_MACHINE = "GUV" + "GR2";
export const SENSITIVE_PATTERNS = [
  { name: "作者用户目录", re: new RegExp("C:\\\\Users\\\\" + AUTHOR_USER, "gi") },
  { name: "仓库绝对路径", re: /[A-Z]:\\olivia-soul-community-kit/gi },
  { name: "真实机器名", re: new RegExp("\\b" + AUTHOR_MACHINE + "\\b", "g") },
  { name: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "API Key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
];

export function scanBufferForSensitive(buf, label) {
  const hits = [];
  const ascii = buf.toString("latin1");
  for (const p of SENSITIVE_PATTERNS) {
    const m = ascii.match(p.re);
    if (m) hits.push({ label, kind: p.name, channel: "ascii", sample: m[0], count: m.length });
  }
  // UTF-16LE 宽字符通道：把偶数偏移上的字节两两取低位拼成单字节串
  const wide = Buffer.alloc(Math.floor(buf.length / 2));
  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j += 1) wide[j] = buf[i];
  const wideStr = wide.toString("latin1");
  for (const p of SENSITIVE_PATTERNS) {
    const m = wideStr.match(p.re);
    if (m) hits.push({ label, kind: p.name, channel: "utf16le", sample: m[0], count: m.length });
  }
  return hits;
}
