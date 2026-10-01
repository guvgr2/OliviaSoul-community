import { isAbsolute, relative, resolve, win32 } from "node:path";

// 探针只允许在固定的规范数据目录下运行；换盘或换机器时可用 OLIVIA_PROBE_ROOT 覆盖。
const PRODUCTION_ROOT = win32.resolve(
  process.env.OLIVIA_PROBE_ROOT || "X:\\OliviaSoulData\\MidiRenderer",
);

export function assertContained(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel)) {
    throw new Error(`路径越过根目录: ${target}`);
  }
  return target;
}

export function resolveProbeLayout(dataRoot) {
  const root = win32.resolve(dataRoot);
  try {
    assertContained(PRODUCTION_ROOT, root);
  } catch {
    throw new Error(`运行数据根目录必须位于 X 盘规范目录: ${root}`);
  }
  const evidenceDir = assertContained(root, win32.join(root, "evidence"));
  return Object.freeze({
    root,
    evidenceDir,
    reportJson: assertContained(root, win32.join(evidenceDir, "stage1a-report.json")),
    reportMarkdown: assertContained(root, win32.join(evidenceDir, "stage1a-report.md")),
    binaryEvidenceJson: assertContained(root, win32.join(evidenceDir, "binary-protocol-evidence.json")),
  });
}
