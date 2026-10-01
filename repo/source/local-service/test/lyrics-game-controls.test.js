import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';
import {setImmediate as turn} from 'node:timers/promises';

// ── 结构容忍的补丁脚本定位 ──────────────────────────────────────────────────
// 历史教训：原实现取「脚本里第一行以 $key = 开头的行」，再把该行首尾引号切掉。
// PowerShell 单引号字符串允许换行，补丁脚本把一个赋值拆成两行后，这里只拿到第一行，
// window.OliviaSoulLyricsPlayback 随之消失（测试报「is not a function」，看着像功能坏了）。
// 现在按赋值语句的收尾引号定位（允许跨行、允许前后插入无关行），定位失败抛明确错误、不静默取空。
// 反向验证入口：OLIVIA_TOOLS_SOURCE_DIR 指向 tools/ 的副本目录（缺省=仓库里的真实脚本）。
const toolsDir=process.env.OLIVIA_TOOLS_SOURCE_DIR;
function readToolsFile(file){
  return readFileSync(toolsDir?join(toolsDir,file):new URL('../../tools/'+file,import.meta.url),'utf8');
}
// 取出 $key = '<单引号字符串>' 的字符串内容（跨行时取到收尾引号那行为止）。
function patchAssignment(source,key,label) {
  const head=new RegExp('\\$'+key+"\\s*=\\s*'").exec(source);
  assert.ok(head,`定位失败：${label} 里找不到赋值 $${key} = '...'`);
  const from=head.index+head[0].length;
  for(let cursor=from;cursor<source.length;){
    const nl=source.indexOf('\n',cursor);
    if(nl<0)break;
    const lineEnd=source[nl-1]==='\r'?nl-1:nl;
    const raw=source.slice(cursor,lineEnd),trimmed=raw.replace(/\s+$/,'');
    const next=source.slice(nl+1).split('\n',1)[0];
    if(trimmed.endsWith("'")&&!/^\s*\+/.test(next))return source.slice(from,cursor+trimmed.length-1);
    cursor=nl+1;
  }
  throw new Error(`定位失败：${label} 里 $${key} 的赋值没有以行尾单引号收尾（可能被改写成了多行拼接）`);
}
function sliceBetween(source,startMarker,endMarker,label) {
  const start=source.indexOf(startMarker);
  assert.notEqual(start,-1,`定位失败：${label} —— 找不到起始标记 ${JSON.stringify(startMarker)}`);
  const end=source.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(end,-1,`定位失败：${label} —— 从 ${JSON.stringify(startMarker)} 之后找不到结束标记 ${JSON.stringify(endMarker)}`);
  return source.slice(start,end);
}
function fragment(file,key) {
  return patchAssignment(readToolsFile(file),key,file).replace(/' \+ \$player(?:Command|State)Url \+ '/g,'http://127.0.0.1:1234/toy/player-command');
}

test('WebPlayer notification fetches immediately without waiting for the one-second fallback',async()=>{
  let interval,stream,requests=0;
  const window={};const context={window,f:null,y:null,l:{value:[]},i:{value:null},
    ke:fn=>fn(),qe:()=>null,Je:()=>null,OliviaSoulNativeControl(){},me(){},
    sessionStorage:{getItem:()=>null},setInterval:fn=>{interval=fn;return 1},clearInterval(){},
    EventSource:class {constructor(){stream=this}close(){}},AbortController,queueMicrotask,
    fetch:async()=>{requests++;return {json:async()=>({data:{revision:0,command:null}})}},OliviaSoulReportPausedPlayback(){}};
  vm.runInNewContext(fragment('patch-webplayer-local.ps1','mountedTo'),context);
  assert.equal(requests,0);assert.equal(typeof interval,'function');
  stream.onmessage();await turn();assert.equal(requests,1);
});
test('game adapter invokes existing previous/next and preserves session in pause/resume requests',async()=>{
  const store=fragment('patch-feapp-local.ps1','playerStateStoreTo');
  const source=sliceBetween(store,'window.OliviaSoulLyricsPlayback=',';return{isSongAvailable:a','lyrics-game-controls 的歌词播放适配器片段');
  let prev=0,next=0;const requests=[];
  const window={__OliviaSoulSongId:'a',__OliviaSoulSessionId:'s'};
  vm.runInNewContext(source,{window,S:()=>prev++,U:()=>next++,fetch:async(url,options)=>{
    requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({code:0,data:{revision:7}})};
  }});
  await window.OliviaSoulLyricsPlayback('previous');await window.OliviaSoulLyricsPlayback('next');
  assert.equal(prev,1);assert.equal(next,1);
  await window.OliviaSoulLyricsPlayback('pause');await window.OliviaSoulLyricsPlayback('resume');
  assert.deepEqual(requests,[{cmd:'suspend',songId:'a',sessionId:'s'},{cmd:'resume',songId:'a',sessionId:'s'}]);
  assert.equal(window.__OliviaSoulCommandRevision,7);
});
test('WebPlayer pause retains media identity and stop retains wallpaper restoration',()=>{
  const source=fragment('patch-webplayer-local.ps1','stopTo');
  let pauses=0,restores=0,aborts=0;
  const window={__OliviaSoulActiveSessionId:'s',__OliviaSoulActiveSongId:'a',__OliviaSoulActivePlayerRevision:8,
    __OliviaSoulAbortPlayerRequests:()=>aborts++,__OliviaSoulRestoreDefaultPlayback:()=>restores++};
  const context={window,i:{value:{pause:()=>pauses++,currentSrc:'song.mp4',currentTime:42.5,duration:120}}};
  vm.createContext(context);
  vm.runInContext(readToolsFile('webplayer-pause.js'),context);
  const run=command=>{context.e=command;vm.runInNewContext('switch(e.cmd){'+source+'}',context)};
  run({cmd:'pause',preserveSession:true,songId:'a',sessionId:'s'});
  assert.equal(pauses,1);assert.equal(restores,1);assert.equal(aborts,0);
  assert.equal(window.__OliviaSoulActiveSessionId,'s');
  assert.equal(window.__OliviaSoulSuspendedPlayback.offset,42.5);
  context.i.value.currentSrc='wallpaper.mp4';context.i.value.currentTime=9;
  run({cmd:'pause',preserveSession:true,songId:'a',sessionId:'s'});
  assert.equal(window.__OliviaSoulSuspendedPlayback.offset,42.5);
  assert.equal(restores,1);
  run({cmd:'pause',preserveSession:true,songId:'b',sessionId:'other'});assert.equal(pauses,1);
  run({cmd:'stop',songId:'a',sessionId:'s'});assert.equal(restores,2);assert.equal(window.__OliviaSoulActiveSessionId,null);
  assert.equal(window.__OliviaSoulSuspendedPlayback,null);
  new vm.Script(fragment('patch-webplayer-local.ps1','mountedTo'));
});

test('resume restores saved media and offset, not the wallpaper position; old sessions cannot resume',()=>{
  const loads=[];const posts=[];
  const window={__OliviaSoulActiveSessionId:'s',__OliviaSoulActiveSongId:'a',__OliviaSoulActivePlayerRevision:9,
    __OliviaSoulSuspendedPlayback:{url:'song.mp4',offset:42.5,duration:120,songId:'a',sessionId:'s'},
    __OliviaSoulRememberDefaultPlayback(){},__OliviaSoulPlayerPost:frame=>posts.push(frame)};
  const context={window,i:{value:{currentSrc:'wallpaper.mp4',currentTime:5,pause(){},removeAttribute(){},load(){}}},
    le:(url,options)=>loads.push({url,offset:options.offset}),ce:()=>assert.fail('must reload the performance, not play wallpaper')};
  vm.createContext(context);
  vm.runInContext(readToolsFile('webplayer-pause.js')+
    'function pe(e){switch(e.cmd){'+fragment('patch-webplayer-local.ps1','playTo')+'}}',context);
  // Media loading is exercised separately by webplayer-swap.test.js.
  context.OliviaSoulSwapPlayback=(url,options)=>loads.push({url,offset:options.offset});
  context.OliviaSoulReportPausedPlayback();
  assert.equal(posts[0].currentTime,42.5);assert.equal(posts[0].mediaUrl,'song.mp4');assert.equal(posts[0].paused,true);
  context.OliviaSoulResumeLocalPlayback({songId:'b',sessionId:'old'});assert.equal(loads.length,0);
  context.OliviaSoulResumeLocalPlayback({songId:'a',sessionId:'s'});
  assert.deepEqual(loads,[{url:'song.mp4',offset:42.5}]);
  assert.equal(window.__OliviaSoulSuspendedPlayback,null);
  assert.equal(window.__OliviaSoulActiveSessionId,'s');assert.equal(window.__OliviaSoulActivePlayerRevision,9);
});

test('wallpaper progress and end cannot overwrite or finish a paused performance',()=>{
  const posts=[];let defaultUpdates=0;
  const window={__OliviaSoulSuspendedPlayback:{offset:42.5},__OliviaSoulActivePlayerRevision:9,
    __OliviaSoulActiveSongId:'a',__OliviaSoulActiveSessionId:'s',__OliviaSoulPlayerPost:frame=>posts.push(frame),
    __OliviaSoulRememberDefaultPlayback:()=>defaultUpdates++};
  const player={currentSrc:'wallpaper.mp4',currentTime:5,duration:30};
  const context={window,i:{value:player},a:{value:120},m:false,v:{value:null},Z:()=>assert.fail('no native song event'),console};
  vm.createContext(context);
  vm.runInContext(fragment('patch-webplayer-local.ps1','timeUpdateTo')+';'+fragment('patch-webplayer-local.ps1','endedTo'),context);
  context.z({target:player});context.q({target:player});
  assert.equal(defaultUpdates,1);assert.equal(posts.length,0);assert.equal(context.a.value,120);
  window.__OliviaSoulSuspendedPlayback=null;window.__OliviaSoulMediaSwap={};
  context.z({target:player});context.q({target:player});assert.equal(posts.length,0);
});
