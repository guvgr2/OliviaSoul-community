import assert from "node:assert/strict";
import test from "node:test";
import { readSourceText } from "./lib/read-source.mjs";

test("admin layout keeps controls usable at desktop, middle, and compact widths", async () => {
  const [styles, app, html] = await Promise.all([
    readSourceText(new URL("../public/styles.css", import.meta.url)),
    readSourceText(new URL("../public/app.js", import.meta.url)),
    readSourceText(new URL("../public/index.html", import.meta.url)),
  ]);

  // ★ 必须用 [^}]*（块内）而不是 [\s\S]*（跨块）：styles.css 里有 14 处 overflow: hidden，
  //   跨块匹配会把「别的块里的同名属性」当成这一块的 ⇒ 注释掉这一个也照样绿（U3 假绿的根因）。
  assert.match(styles, /html, body \{[^}]*overflow: hidden/u);
  assert.match(styles, /\.workspace \{[^}]*height: 100%;[^}]*align-items: stretch;[^}]*overflow: hidden/u);
  assert.match(styles, /\.content \{[^}]*display: block;[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow-y: auto/u);
  assert.match(styles, /\.tabPage \{[^}]*height: max-content/u);
  assert.match(styles, /\.sidebar \{[^}]*position: sticky;[^}]*overflow-y: auto/u);
  assert.match(styles, /\.workspace, \.content, \.panel,[\s\S]*min-width: 0/u);
  assert.match(styles, /button, input, select, textarea \{[\s\S]*min-height: 40px/u);
  assert.match(styles, /\.actions \{[^}]*flex-wrap: wrap/u);
  assert.match(styles, /\.result, \.mountDetail,[\s\S]*overflow-wrap: anywhere/u);
  assert.match(styles, /\.quotaReset \{[^}]*display: flex;[^}]*flex-wrap: wrap/u);
  assert.match(styles, /\.quotaSummary \{[^}]*flex: 1 1 260px/u);
  assert.match(styles, /\.quotaLimit \{[^}]*flex: 0 1 230px/u);
  assert.match(styles, /\.quotaReset \.actions \{[^}]*flex: 0 0 auto;[^}]*flex-wrap: nowrap/u);
  assert.match(styles, /\.desktopSection, \.storageSection \{[^}]*margin-inline:/u);
  assert.match(styles, /\.libraryPathRow \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto/u);
  assert.match(styles, /\.libraryPathRow > \.fieldHint \{[^}]*grid-column: 1 \/ -1/u);
  assert.match(styles, /\.libraryPathRow > button \{[^}]*white-space: nowrap/u);
  assert.match(styles, /\.modelSettingsHead \{[^}]*flex-wrap: wrap/u);
  assert.match(styles, /\.modelSettingsHead > div \{[^}]*flex: 1 1 200px;[^}]*min-width: 0/u);
  assert.match(styles, /\.activeProvider \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/u);
  assert.match(styles, /@container \(max-width: 560px\)[\s\S]*\.providerSwitch \{ grid-template-columns: 1fr; \}/u);
  assert.match(app, /active\.title = active\.textContent/u);
  assert.doesNotMatch(html, /0 表示今天不能写/u);

  assert.match(styles, /@media \(min-width: 980px\)/u);
  assert.match(styles, /@media \(min-width: 621px\) and \(max-width: 979px\)/u);
  assert.match(styles, /@media \(max-width: 620px\)/u);
  assert.match(styles, /@media \(min-width: 621px\) and \(max-width: 979px\)[\s\S]*\.libraryPathRow \{ grid-template-columns: minmax\(0, 1fr\) auto auto/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.headerActions \{ flex-wrap: wrap/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.modelSettingsHead > div \{[^}]*flex-basis: auto/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.noticeActions button \{ flex: 1 1 120px/u);

  assert.match(app, /const content = document\.querySelector\("\.content"\);[\s\S]{0,120}content\.scrollTop = 0/u);
  assert.doesNotMatch(app, /window\.scrollTo|sidebar\.scrollTop/u);
});
