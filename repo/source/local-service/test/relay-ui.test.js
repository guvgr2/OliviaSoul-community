import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOliviaService } from '../server.js';
import { writeModelProfile, setActiveProvider, readModelConfig } from '../model-config.js';
import { cleanupDir } from "./lib/cleanup.mjs";
import { listenOnFetchablePort } from "./support/fetch-ports.js";
const browserTest=process.env.OLIVIA_BROWSER_UI==='1'?test:test.skip;
// ⚠️ playwright 必须在回调里加载（admin-responsive-ui.test.js:9 同款写法）：
//    顶层无条件 `createRequire(...)('playwright')` 会让没装 playwright 的机器在**收集阶段**
//    就抛 MODULE_NOT_FOUND，整个文件连"跳过"都做不到（S0 附带隐患）。
browserTest('manual model survives failed discovery and saves; candidate selection updates the submitted model',async t=>{
  const {chromium}=createRequire(import.meta.url)('playwright');
  const root=await mkdtemp(join(tmpdir(),'olivia-relay-ui-'));
  let allowDiscovery=false;const sent=[];
  const profile={provider:'local',baseUrl:'https://relay.fixture/v1',model:'old-model',authMode:'bearer',apiKey:'fixture-key'};
  await writeModelProfile({root,provider:'local',profile});await setActiveProvider({root,provider:'local'});
  const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'appdata'),worker:false,runMemoryRefresh:false,fetch:async(url,init)=>{
    assert.equal(new URL(url).origin,'https://relay.fixture');
    if(url.endsWith('/models'))return allowDiscovery?Response.json({data:[{id:'candidate-model'}]}):Response.json({error:{message:'not supported'}},{status:404});
    sent.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'OK'}}]});
  }});
  const address=await listenOnFetchablePort(service);const base=`http://127.0.0.1:${address.port}`;
  const browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(async()=>{await browser.close();await service.close();await cleanupDir(root);});
  const page=await browser.newPage({viewport:{width:1024,height:900}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  // 首次启动的「使用前请阅读：重要声明」合规弹窗（legal-notices.js，ACK_KEY=oliviaSoul.legalAck.v1）
  // 是异步弹出的（实测 +300ms 才出现），会拦截后续 click —— 之前用「点掉它」的方案在
  // 连跑 10 次里仍有 ~5% 偶发（它和失败 notice 的出现顺序竞态）。正解是从源头消灭：
  // 先置「已读」标记再进页面，声明弹窗根本不会弹。
  await page.addInitScript(()=>{try{localStorage.setItem('oliviaSoul.legalAck.v1',new Date().toISOString());}catch{}});
  await page.goto(base+'/admin/');
  await page.waitForFunction(()=>document.querySelector('#localModelBaseUrl')?.value==='https://relay.fixture/v1');
  await page.locator('.sideTab[data-tab="ai"]').click();
  assert.equal(await page.locator('#localModelName').evaluate(el=>el.tagName),'INPUT');
  await page.locator('#localModelName').fill('manual-only-model');
  await page.locator('#queryLocalModels').click();
  await page.waitForFunction(()=>document.querySelector('#localModelResult').textContent.includes('查询失败'));
  // 失败会弹「操作失败」notice（showError → void openNotice，app.js:1984），与结果文本的出现存在竞态，
  // 且下一动作前可能再弹。这里循环清空：关掉当前层后留 400ms 窗口确认没有下一层，再继续。
  const dismissNotice=async()=>{for(;;){if(!await page.locator('#noticeLayer').isVisible()){await page.waitForTimeout(400);if(!await page.locator('#noticeLayer').isVisible())return;}await page.locator('#noticeConfirm').click();await page.waitForFunction(()=>document.querySelector('#noticeLayer').hidden);}};
  await dismissNotice();
  assert.equal(await page.locator('#localModelName').inputValue(),'manual-only-model');
  await page.locator('#testLocalModel').click();
  await page.waitForFunction(()=>document.querySelector('#localModelResult').textContent.includes('配置已保存'));
  assert.equal((await readModelConfig({root})).profiles.local.model,'manual-only-model');
  assert.equal(sent.at(-1).model,'manual-only-model');
  allowDiscovery=true;
  await page.locator('#queryLocalModels').click();
  await page.waitForFunction(()=>document.querySelector('#localModelResult').textContent.includes('已查询'));
  assert.equal(await page.locator('#localModelName').inputValue(),'manual-only-model');
  await page.locator('#localModelNameOptions').selectOption('candidate-model');
  assert.equal(await page.locator('#localModelName').inputValue(),'candidate-model');
  await page.locator('#testLocalModel').click();
  await page.waitForFunction(()=>document.querySelector('#localModelResult').textContent.includes('配置已保存'));
  assert.equal((await readModelConfig({root})).profiles.local.model,'candidate-model');
  assert.deepEqual(errors,[]);
  if(process.env.OLIVIA_BROWSER_SCREENSHOT_DIR){await mkdir(process.env.OLIVIA_BROWSER_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.OLIVIA_BROWSER_SCREENSHOT_DIR,'relay-settings.png'),fullPage:true});}
});
