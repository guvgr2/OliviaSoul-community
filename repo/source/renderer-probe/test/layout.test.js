import test from "node:test";
import assert from "node:assert/strict";
import { assertContained, resolveProbeLayout } from "../src/layout.js";

test("default runtime layout stays on X drive", () => {
  const layout = resolveProbeLayout("X:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.root, "X:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.reportJson, "X:\\OliviaSoulData\\MidiRenderer\\evidence\\stage1a-report.json");
});

test("production layout rejects a C drive root", () => {
  assert.throws(() => resolveProbeLayout("C:\\temp\\MidiRenderer"), /必须位于 X 盘/u);
});

test("production layout accepts only the fixed root or its subdirectories", () => {
  assert.equal(
    resolveProbeLayout("X:\\OliviaSoulData\\MidiRenderer\\run-1").root,
    "X:\\OliviaSoulData\\MidiRenderer\\run-1",
  );
  for (const path of [
    "X:\\OliviaSoulData\\Other",
    "X:\\OliviaSoulData\\MidiRenderer-Evil",
    "X:\\OliviaSoulData",
    "C:\\OliviaSoulData\\MidiRenderer",
  ]) {
    assert.throws(() => resolveProbeLayout(path));
  }
});

test("containment rejects path traversal", () => {
  assert.throws(
    () => assertContained("X:\\OliviaSoulData\\MidiRenderer", "X:\\OliviaSoulData\\outside.json"),
    /越过根目录/u,
  );
});
