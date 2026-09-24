// 音乐指纹：让程序靠"音频内容"认出同一首歌，而不是靠文件夹编号
//
// 为什么需要：同一首歌在不同用户曲库里文件夹编号完全不同
// （midi_8815_1786281418 / midi_130991_1784281291），只传曲名没法自动命名。
//
// 为什么要**多段校验**：单段指纹偶尔会撞车。所以取 3 个不同位置的片段
// （第 20s / 80s / 140s 起，各 60 秒），候选匹配必须"至少 2 段通过且没有一段过差"，
// 才允许自动填名 —— 填错了比没填更糟。
//
// 实测（289 对样本，单段）：同一录音 ≈ 1.00，不同歌 0.30~0.62 → 阈值 0.90 安全。
//
// 隐私：指纹是量化色度特征（64 帧 × 12 维 × 4 比特），单向派生数据，
// 还原不出音频，也不含任何个人信息。用户可在同意页拒绝上传。
//
// 算法（前后端约定，改了必须升 FP_VERSION）：
//   1. ffmpeg 一次性解码 200 秒（从第 20 秒起）单声道 22050Hz s16le
//   2. 4096 窗 + Hann，跳 4096，55~2000Hz 映射到 12 音级 → 每帧 12 维，L2 归一
//   3. 每 5 帧取 1 帧、共 64 帧；每帧按最大值归一到 0..15（4 比特）
//   4. 打包：两个 4 比特一字节 → 384 字节 → base64（512 字符）
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FP_VERSION = 2;
export const FP_ALGO = "chroma4x64x3";
export const FP_FRAMES = 64;
export const FP_STRIDE = 5;
export const FP_SEGMENTS = 3;
export const FP_SEGMENT_SECONDS = 60;
export const FP_SEGMENT_OFFSETS = [20, 80, 140];
export const FP_SIMILARITY_THRESHOLD = 0.90;
export const FP_MIN_SEGMENTS_PASSED = 2;
export const FP_FLOOR = 0.70;          // 任何一段低于这个分数就否决，防止"两段勉强过一段全错"
const SR = 22050, FFT = 4096, MAX_SHIFT = 10;

export function resolveFfmpeg() {
  const explicit = process.env.OLIVIA_FFMPEG || "";
  if (explicit && existsSync(explicit)) return explicit;
  // 应用自带的 ffmpeg：安装版固定在 <安装目录>\\runtime\\ffmpeg\\bin（build-release.ps1 会打进包里）
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = [
    join(here, "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
    join(here, "..", "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
  ].find(candidate => existsSync(candidate));
  if (bundled) return bundled;
  // 最后才退回系统 PATH
  return "ffmpeg";
}

function decode(file, offset, seconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolveFfmpeg(), ["-v", "quiet", "-ss", String(offset), "-t", String(seconds),
      "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", c => chunks.push(c));
    child.on("error", rejectPromise);
    child.on("close", () => resolvePromise(Buffer.concat(chunks)));
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function chromaFrames(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const frames = [];
  const hann = new Float64Array(FFT);
  for (let i = 0; i < FFT; i += 1) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1));
  const loBin = Math.ceil(55 * FFT / SR), hiBin = Math.floor(2000 * FFT / SR);
  const binChroma = new Int8Array(hiBin + 1);
  for (let b = loBin; b <= hiBin; b += 1) {
    const f = b * SR / FFT;
    binChroma[b] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }
  for (let off = 0; off + FFT <= samples.length; off += FFT) {
    const re = new Float64Array(FFT), im = new Float64Array(FFT);
    for (let i = 0; i < FFT; i += 1) re[i] = samples[off + i] * hann[i];
    fft(re, im);
    const chroma = new Float64Array(12);
    for (let b = loBin; b <= hiBin; b += 1) chroma[binChroma[b]] += Math.hypot(re[b], im[b]);
    let norm = 0;
    for (let i = 0; i < 12; i += 1) norm += chroma[i] * chroma[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i += 1) chroma[i] /= norm;
    frames.push(chroma);
  }
  return frames;
}

function pack(frames) {
  const picked = [];
  for (let i = 0; i < frames.length && picked.length < FP_FRAMES; i += FP_STRIDE) picked.push(frames[i]);
  while (picked.length < FP_FRAMES) picked.push(picked[picked.length - 1] ?? new Float64Array(12));
  const nibbles = [];
  for (const frame of picked) {
    let max = 0;
    for (const v of frame) max = Math.max(max, v);
    if (max <= 0) { for (let i = 0; i < 12; i += 1) nibbles.push(0); continue; }
    for (const v of frame) nibbles.push(Math.max(0, Math.min(15, Math.round(v / max * 15))));
  }
  const bytes = Buffer.alloc(nibbles.length / 2);
  for (let i = 0; i < nibbles.length; i += 2) bytes[i / 2] = (nibbles[i] << 4) | nibbles[i + 1];
  return bytes.toString("base64");
}

function unpack(text) {
  const bytes = Buffer.from(String(text), "base64");
  const frames = [];
  for (let f = 0; f < FP_FRAMES; f += 1) {
    const frame = new Float64Array(12);
    for (let i = 0; i < 12; i += 1) {
      const index = f * 12 + i;
      const byte = bytes[index >> 1] ?? 0;
      frame[i] = (index % 2 === 0 ? byte >> 4 : byte & 15) / 15;
    }
    let norm = 0;
    for (const v of frame) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i += 1) frame[i] /= norm;
    frames.push(frame);
  }
  return frames;
}

/** 两个单段指纹的相似度：允许 ±10 帧错位，取最大平均余弦。 */
export function similarity(fpA, fpB) {
  if (!fpA || !fpB) return 0;
  const a = unpack(fpA), b = unpack(fpB);
  let best = 0;
  for (let shift = -MAX_SHIFT; shift <= MAX_SHIFT; shift += 1) {
    let sum = 0, count = 0;
    for (let i = 0; i < FP_FRAMES; i += 1) {
      const j = i + shift;
      if (j < 0 || j >= FP_FRAMES) continue;
      let dot = 0;
      for (let k = 0; k < 12; k += 1) dot += a[i][k] * b[j][k];
      sum += dot; count += 1;
    }
    if (count) best = Math.max(best, sum / count);
  }
  return best;
}

/** 多段校验：必须"至少 N 段通过且没有任何一段低于 FP_FLOOR"才算同一首。 */
export function verifyMatch(fpsA, fpsB) {
  const a = Array.isArray(fpsA) ? fpsA : [fpsA];
  const b = Array.isArray(fpsB) ? fpsB : [fpsB];
  const scores = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) scores.push(similarity(a[i], b[i]));
  const passed = scores.filter(s => s >= FP_SIMILARITY_THRESHOLD).length;
  const worst = scores.length ? Math.min(...scores) : 0;
  const mean = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : 0;
  const ok = scores.length >= FP_MIN_SEGMENTS_PASSED
    && passed >= FP_MIN_SEGMENTS_PASSED
    && worst >= FP_FLOOR;
  return { ok, scores: scores.map(s => Math.round(s * 1000) / 1000), passed, worst: Math.round(worst * 1000) / 1000, mean: Math.round(mean * 1000) / 1000 };
}

/** 取多个片段的指纹；返回 { fp, fps, seconds }，fp 是第一段（供快速预筛）。 */
export async function fingerprintFile(file) {
  const fps = [];
  for (const offset of FP_SEGMENT_OFFSETS) {
    const pcm = await decode(file, offset, FP_SEGMENT_SECONDS);
    if (pcm.length < SR * 2) break;
    fps.push(pack(chromaFrames(pcm)));
  }
  if (!fps.length) return null;
  return { fp: fps[0], fps, algo: FP_ALGO, version: FP_VERSION, segments: fps.length };
}

export async function fingerprintFolder(folder) {
  const entries = await readdir(folder);
  const mp4 = entries.filter(n => n.toLowerCase().endsWith(".mp4")).sort()[0];
  if (!mp4) return null;
  return fingerprintFile(join(folder, mp4));
}

// ---------------------------------------------------------------- 自检
if (process.argv[1] && process.argv[1].endsWith("fingerprint.js")) {
  const folders = process.argv.slice(2);
  if (!folders.length) {
    console.log("用法: node tools/fingerprint.js <文件夹1> <文件夹2> [...]");
    console.log("     同一录音应多段全过；不同歌应被否决");
  } else {
    const prints = [];
    for (const folder of folders) {
      const result = await fingerprintFolder(folder);
      prints.push(result);
      console.log(`${folder} → ${result ? `${result.segments} 段指纹，首段 ${result.fp.length} 字符` : "取不到音频"}`);
    }
    for (let i = 0; i < prints.length; i += 1) {
      for (let j = i + 1; j < prints.length; j += 1) {
        if (!prints[i] || !prints[j]) continue;
        const verdict = verifyMatch(prints[i].fps, prints[j].fps);
        console.log(`  ${folders[i].split("\\").pop()} × ${folders[j].split("\\").pop()} = [${verdict.scores.join(", ")}] 最差 ${verdict.worst} → ${verdict.ok ? "同一首 ✓（可自动命名）" : "不是同一首 ✗"}`);
      }
    }
  }
}