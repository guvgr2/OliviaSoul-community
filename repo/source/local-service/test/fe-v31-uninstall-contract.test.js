import assert from "node:assert/strict";
import test from "node:test";
import { readSourceText } from "./lib/read-source.mjs";

test("uninstall legacy adoption recognizes the current v31 FE locale patch", async () => {
  const source = await readSourceText(new URL("../desktop/uninstall-restore.js", import.meta.url));
  assert.match(source, /allowKnownFeLocale:[\s\S]{0,200}feappRevisionAtLeast\(statuses\.feapp\.revision,\s*"v29"\)/u);
});
