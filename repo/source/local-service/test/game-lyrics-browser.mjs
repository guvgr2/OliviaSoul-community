// Real production script in Edge; isolated footer fixture and HTTP transport.
// 这个文件是**外部驱动**的：`node --test` 的默认 glob 会把它当测试捡起来裸跑，
// 而它靠 `process.argv[2]` 拿到 playwright 路径 —— 裸跑时 argv[2] 是 undefined，
// `createRequire(...)(undefined)` 直接抛 ERR_INVALID_ARG_TYPE ⇒ 恒红、且不在 $suites 里。
// 修法同 admin-responsive-ui.test.js:7-9：没设 OLIVIA_BROWSER_UI 就跳过。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

if (process.env.OLIVIA_BROWSER_UI !== '1') {
  console.log('SKIP game-lyrics-browser: 未设 OLIVIA_BROWSER_UI（这是外部驱动脚本，不是 node --test 的用例）');
  process.exit(0);
}

const {chromium} = createRequire(import.meta.url)(process.argv[2]);
