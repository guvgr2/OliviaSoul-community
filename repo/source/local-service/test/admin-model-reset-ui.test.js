import assert from "node:assert/strict";
import test from "node:test";
import { readSourceText } from "./lib/read-source.mjs";

test("model reset captures the clicked button before awaiting confirmation", async () => {
  const app = await readSourceText(new URL("../public/app.js", import.meta.url));
  const start = app.indexOf('$("#resetModelConfig").addEventListener');
  const end = app.indexOf('$("#localAuthMode").addEventListener', start);
  assert.ok(start >= 0 && end > start, "model reset handler should exist");
  const handler = app.slice(start, end);
  const capture = handler.indexOf("const button = event.currentTarget");
  const confirmation = handler.indexOf("await confirmNotice");
  assert.ok(capture >= 0, "handler should capture currentTarget");
  assert.ok(capture < confirmation, "currentTarget must be captured before the first await");
  assert.match(handler, /button\.disabled = true[\s\S]*finally \{[\s\S]*button\.disabled = false/u);
});
