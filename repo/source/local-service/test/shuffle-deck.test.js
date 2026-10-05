import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';

// ── 结构容忍的补丁脚本定位（与 library-removal-sync.test.js 同一套写法）──────────
// 定位失败一律抛明确错误，不静默取空 —— 历史上脆正则会抛 "Cannot read properties of null"。
const toolsDir=process.env.OLIVIA_TOOLS_SOURCE_DIR;
const patch=readFileSync(toolsDir?join(toolsDir,'patch-feapp-local.ps1'):new URL('../../tools/patch-feapp-local.ps1',import.meta.url),'utf8');

function patchAssignment(source,key,label){
 const head=new RegExp('\\$'+key+"\\s*=\\s*'").exec(source);
 assert.ok(head,`定位失败：${label} 里找不到赋值 $${key} = '...'`);
 const from=head.index+head[0].length;
 for(let cursor=from;cursor<source.length;){
  const nl=source.indexOf('\n',cursor);
  if(nl<0)break;
  const lineEnd=source[nl-1]==='\r'?nl-1:nl;
  const trimmed=source.slice(cursor,lineEnd).replace(/\s+$/,'');
  const next=source.slice(nl+1).split('\n',1)[0];
  if(trimmed.endsWith("'")&&!/^\s*\+/.test(next))return source.slice(from,cursor+trimmed.length-1);
  cursor=nl+1;
 }
 throw new Error(`定位失败：${label} 里 $${key} 的赋值没有以行尾单引号收尾`);
}

const deckHereString=patch.match(/\$shuffleDeckSource = @'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(deckHereString,'定位失败：patch-feapp-local.ps1 里找不到 $shuffleDeckSource 的 here-string');
const deckSource=deckHereString[1];
// 注释里会解释「为什么不用 I.value」，所以「不碰某个符号」的断言只看代码行。
const deckCode=deckSource.split(/\r?\n/u).filter((line)=>!/^\s*\/\//u.test(line)).join('\n');

const callSites=['shuffleNext','shufflePrev','shufflePlay','shuffleMode'].map(name=>({
 name,
 from:patchAssignment(patch,`${name}From`,'patch-feapp-local.ps1'),
 to:patchAssignment(patch,`${name}To`,'patch-feapp-local.ps1'),
}));

// ── 牌堆沙箱 ────────────────────────────────────────────────────────────────
// 只提供牌堆真正引用的东西：曲目列表 x.value、可用性 a()、当前曲 u/f、window.OliviaSoulSongEditor。
function memoryStorage(){
 const map=new Map();
 return {
  getItem:key=>(map.has(key)?map.get(key):null),
  setItem:(key,value)=>{map.set(key,String(value));},
  removeItem:key=>{map.delete(key);},
  keys:()=>[...map.keys()],
 };
}

// 与 public/song-editor.js:14-19 的 stableId 同源：本机媒体走 mediaUrl/videoUrl 里的
// /toy/midi/songs/<id>，其余退回 songId/id/itemId。牌堆靠它把「同一首歌的多条记录」合成一张牌。
function stableIdFromSongEditor(item){
 if(!item)return '';
 const match=String(item.videoUrl||item.mediaUrl||'').match(/\/toy\/midi\/songs\/([^/?#]+)/u);
 if(match){try{return decodeURIComponent(match[1]);}catch{return '';}}
 return String(item.songId||item.id||item.itemId||'');
}

function createDeck({songs,storage=memoryStorage(),stableId=stableIdFromSongEditor,withSongEditor=true}){
 const context={
  Math,JSON,String,Number,Map,Array,Object,Error,Boolean,
  window:withSongEditor?{OliviaSoulSongEditor:{stableId}}:{},
  localStorage:storage,
  x:{value:songs},
  a:item=>Boolean(item)&&item.available!==false,
  u:{value:null},
  f:{value:null},
 };
 vm.createContext(context);
 vm.runInContext(deckSource,context);
 return context;
}

function shortPlaylist(count,available=true){
 return Array.from({length:count},(unused,index)=>({itemId:`song-${index}`,title:`曲目 ${index}`,available}));
}

// ── 牌堆行为 ────────────────────────────────────────────────────────────────
test('短歌单（3 首）连点 20 次下一首：任何相邻两次都不重复',()=>{
 const deck=createDeck({songs:shortPlaylist(3)});
 const picks=[];
 for(let step=0;step<20;step++){
  const index=deck.OliviaSoulShuffleNextIndex();
  assert.ok(index>=0&&index<3,`第 ${step} 次返回了越界下标 ${index}`);
  picks.push(index);
 }
 for(let step=1;step<picks.length;step++){
  assert.notEqual(picks[step],picks[step-1],`第 ${step} 次与上一次抽到同一首（下标 ${picks[step]}）`);
 }
 // 每一轮都是 0..2 的一个排列：连续 3 次取满全部三首。
 for(let round=0;round<6;round++){
  assert.deepEqual([...picks.slice(round*3,round*3+3)].sort(),[0,1,2],`第 ${round+1} 轮不是完整排列`);
 }
});

test('长列表（20 首）一轮内每首恰好一次，且下一轮开头不接重复',()=>{
 const deck=createDeck({songs:shortPlaylist(20)});
 const picks=[];
 for(let step=0;step<30;step++)picks.push(deck.OliviaSoulShuffleNextIndex());
 assert.deepEqual([...picks.slice(0,20)].sort((left,right)=>left-right),Array.from({length:20},(unused,index)=>index));
 assert.notEqual(picks[20],picks[19],'第二轮开头与第一轮结尾重复');
 assert.deepEqual([...picks.slice(20,30)].sort((left,right)=>left-right).length,10);
});

test('上一首回到真正播过的那首，再下一首回到原曲（游标对称）',()=>{
 const deck=createDeck({songs:shortPlaylist(6)});
 const first=deck.OliviaSoulShuffleNextIndex();
 const second=deck.OliviaSoulShuffleNextIndex();
 assert.notEqual(first,second);
 const back=deck.OliviaSoulShufflePrevIndex();
 assert.equal(back,first,'上一首没有回到刚播过的那首');
 const forward=deck.OliviaSoulShuffleNextIndex();
 assert.equal(forward,second,'上一首之后再次下一首没有回到原曲');
});

test('进度落 localStorage：换一个沙箱也能接着播，不重头乱抽',()=>{
 const storage=memoryStorage();
 const songs=shortPlaylist(5);
 const first=createDeck({songs,storage});
 const played=[first.OliviaSoulShuffleNextIndex(),first.OliviaSoulShuffleNextIndex()];
 const saved=JSON.parse(storage.getItem('olivia-soul-shuffle-deck-v1'));
 assert.ok(saved&&Array.isArray(saved.ids)&&saved.ids.length===5,'牌堆没有写进 localStorage');
 assert.equal(saved.cursor,2);
 // 新沙箱共享同一份存储 = 切页面/重启后回到同一首歌单
 const second=createDeck({songs,storage});
 const resumed=second.OliviaSoulShuffleNextIndex();
 const expectedIndex=songs.findIndex((item)=>item.itemId===saved.ids[saved.cursor]);
 assert.equal(resumed,expectedIndex,'恢复后没有接着牌堆游标播');
 assert.notEqual(resumed,played[played.length-1],'恢复后立刻重复了上一首');
});

test('同一首歌在列表里出现多条（不同 itemId、同一媒体文件）时只占一张牌',()=>{
 const songs=[
  {itemId:'entry-1',mediaUrl:'/toy/midi/songs/same-file.mp4',available:true},
  {itemId:'entry-2',mediaUrl:'/toy/midi/songs/same-file.mp4',available:true},
  {itemId:'entry-3',mediaUrl:'/toy/midi/songs/other.mp4',available:true},
  {itemId:'entry-4',mediaUrl:'/toy/midi/songs/third.mp4',available:true},
 ];
 const deck=createDeck({songs});
 const ids=[];
 for(let step=0;step<6;step++)ids.push(stableIdFromSongEditor(songs[deck.OliviaSoulShuffleNextIndex()]));
 for(let round=0;round<2;round++){
  assert.deepEqual([...ids.slice(round*3,round*3+3)].sort(),['other.mp4','same-file.mp4','third.mp4'],`第 ${round+1} 轮出现重复曲目`);
 }
});

test('播放器里没有 OliviaSoulSongEditor 时退回 itemId/id，不会因此空转',()=>{
 const songs=[
  {itemId:'a',available:true},
  {itemId:'b',available:true},
  {itemId:'c',available:true},
 ];
 const deck=createDeck({songs,withSongEditor:false});
 const picks=[deck.OliviaSoulShuffleNextIndex(),deck.OliviaSoulShuffleNextIndex(),deck.OliviaSoulShuffleNextIndex()];
 assert.deepEqual([...picks].sort(),[0,1,2],'没有 OliviaSoulSongEditor 时牌堆失效');
});

test('不可用曲目被跳过；全部不可用时返回 -1（按工单要求不变）',()=>{
 const deck=createDeck({songs:[
  {itemId:'a',available:false},
  {itemId:'b',available:true},
  {itemId:'c',available:false},
  {itemId:'d',available:true},
 ]});
 for(let step=0;step<8;step++){
  const index=deck.OliviaSoulShuffleNextIndex();
  assert.ok(index===1||index===3,`返回了不可用曲目下标 ${index}`);
 }
 const empty=createDeck({songs:shortPlaylist(3,false)});
 assert.equal(empty.OliviaSoulShuffleNextIndex(),-1);
 assert.equal(empty.OliviaSoulShufflePrevIndex(),-1);
});

test('切到随机模式会重起一轮，且不在新的一轮开头重复当前曲',()=>{
 const deck=createDeck({songs:shortPlaylist(4)});
 deck.f.value={itemId:'song-2',available:true};
 deck.OliviaSoulShuffleRestart();
 const picks=[deck.OliviaSoulShuffleNextIndex(),deck.OliviaSoulShuffleNextIndex()];
 assert.notEqual(picks[0],picks[1]);
 assert.notEqual(picks[0],2,'切到随机模式后第一首就是当前正在播的那首');
 assert.deepEqual([...picks].length,2);
});

test('换歌单（切列表/换一批歌）后重洗一轮，不会把新列表按原顺序播一遍',()=>{
 const deck=createDeck({songs:shortPlaylist(5)});
 // 先在旧歌单里播 3 首，游标停在中段 —— 回归点就在这里
 deck.OliviaSoulShuffleNextIndex();
 deck.OliviaSoulShuffleNextIndex();
 deck.OliviaSoulShuffleNextIndex();
 // 整张列表被换掉（模拟切歌单页/导入新一批）：旧牌全部失效、新条目按 x.value 顺序补尾巴
 const fresh=Array.from({length:12},(unused,index)=>({itemId:`fresh-${index}`,available:true}));
 deck.x.value=fresh;
 const picks=[];
 for(let step=0;step<8;step++)picks.push(deck.OliviaSoulShuffleNextIndex());
 // 没重洗时会得到原顺序切片 3,4,5,6,7,8,9,10（旧 deck 长度 5 保留不下、Sync 把 12 首按顺序补上）
 assert.notDeepEqual(picks,[3,4,5,6,7,8,9,10],'换歌单后的第一轮仍按原顺序播，牌堆没有重洗');
 // 12 首取满 12 次必须恰好是 new 列表的一个完整排列（既没有旧歌单残留，也没有重复）
 const round=picks.slice();
 for(let step=picks.length;step<12;step++)round.push(deck.OliviaSoulShuffleNextIndex());
 assert.deepEqual([...round].sort((left,right)=>left-right),Array.from({length:12},(unused,index)=>index),'新一轮不是 12 首的完整排列');
});

test('歌单没变（同一批 id）时不重洗，进度照旧接着走',()=>{
 const songs=shortPlaylist(6);
 const deck=createDeck({songs});
 const first=deck.OliviaSoulShuffleNextIndex();
 const second=deck.OliviaSoulShuffleNextIndex();
 // 模拟列表刷新：对象重建但 id 不变
 deck.x.value=songs.map((item)=>({...item}));
 const third=deck.OliviaSoulShuffleNextIndex();
 assert.notEqual(third,second,'列表刷新后重复了上一首（说明被误判成换歌单并重洗）');
 const back=deck.OliviaSoulShufflePrevIndex();
 assert.equal(back,second,'列表刷新后上一首没能回到真正播过的那首');
 assert.equal(first>=0,true);
});

// ── 补丁脚本接线（四个调用点 + 注入 + 校验）────────────────────────────────
test('四个调用点是「全有或全无」的整块替换：任何一处命中数不为 1 就整块跳过，而不是让补丁失败',()=>{
 assert.equal(callSites.length,4);
 for(const site of callSites){
  assert.notEqual(site.from,site.to,`${site.name} 的替换前后一模一样`);
  assert.ok(patch.includes(`From = $${site.name}From; To = $${site.name}To`),`${site.name} 没有进 $shuffleSites`);
 }
 assert.match(patch,/\$shuffleSite\.Count = \(\[regex\]::Matches\(\$text, \[regex\]::Escape\(\$shuffleSite\.From\)\)\)\.Count/u,'缺少命中数统计');
 assert.match(patch,/if \(\$shuffleSite\.Count -ne 1\) \{ \$shuffleMisses\.Add/u,'命中数不为 1 时没有记进 $shuffleMisses');
 assert.match(patch,/\$shuffleDeckApplied = \$shuffleMisses\.Count -eq 0/u,'缺少 $shuffleDeckApplied 判定');
 assert.match(patch,/if \(\$shuffleDeckApplied\) \{\r?\n\s+foreach \(\$shuffleSite in \$shuffleSites\) \{ \$text = \$text\.Replace\(\$shuffleSite\.From, \$shuffleSite\.To\) \}/u,
  '替换没有整块挂在 $shuffleDeckApplied 下面');
 // 这四处是压缩后的函数体，官方重建 bundle 就会失配；单点 throw 会让整个前端补丁跟着失败，
 // 所以必须保留「整块跳过 + 报出来」的降级路径。
 for(const site of callSites){
  assert.ok(!patch.includes(`if ($${site.name}Count -ne 1) { throw`),`${site.name} 又变回单点 throw（失配时会拖垮整个前端补丁）`);
 }
 const skipped=patch.includes('$shuffleDeckState = "skipped(');
 assert.ok(skipped,'跳过时没有留下可查的状态值');
 assert.ok(patch.includes('Write-Warning "random-playback deck skipped'),'跳过时没有任何警告输出');
});

test('下一首/上一首走牌堆，songlist 页面在随机模式下也走牌堆',()=>{
 const next=callSites.find((site)=>site.name==='shuffleNext');
 const prev=callSites.find((site)=>site.name==='shufflePrev');
 const play=callSites.find((site)=>site.name==='shufflePlay');
 assert.match(next.to,/if\(p\.value===ot\.Shuffle\)return OliviaSoulShuffleNextIndex\(\);/u);
 assert.match(prev.to,/if\(p\.value===ot\.Shuffle\)return OliviaSoulShufflePrevIndex\(\);/u);
 assert.ok(!prev.to.includes('I.value'),'上一首的随机分支不应再依赖会被清空的播放历史');
 assert.match(play.from,/if\(h\.value==="songlist"\)\{/u);
 assert.match(play.to,/if\(h\.value==="songlist"&&p\.value!==ot\.Shuffle\)\{/u);
 // 非随机模式下 songlist 页面依旧播第一首可用曲（红线：不改原有行为）
 assert.ok(play.to.includes('const K=x.value.findIndex(W=>a(W));K!==-1&&M(x.value[K]);return'));
 assert.ok(play.to.includes('const B=$();B!==-1&&x.value[B]&&M(x.value[B])'));
});

test('切换播放模式：进入随机时重起牌堆，I.value 的既有重置原样保留',()=>{
 const mode=callSites.find((site)=>site.name==='shuffleMode');
 assert.match(mode.to,/p\.value=ot\.Shuffle,OliviaSoulShuffleRestart\(\),u\.value\?I\.value=\[u\.value\.itemId\]:I\.value=\[\]/u);
 assert.ok(mode.to.includes('t.value===Se.LITE&&Ct({cmd:"setPlayMode",mode:p.value})'));
 assert.ok(!deckCode.includes('I.value'),'牌堆不该自己去动播放历史 I.value');
 assert.ok(!deckCode.includes('S='),'牌堆不该改写上一首按钮 S()');
});

test('$shuffleSites 块排在四个 $shuffleXxxFrom 之后（否则变量未定义会静默判成全部失配）',()=>{
 const blockAt=patch.indexOf('$shuffleSites = @(');
 assert.ok(blockAt>0,'找不到 $shuffleSites 块');
 for(const site of callSites){
  const fromAt=patch.indexOf(`$${site.name}From = '`);
  assert.ok(fromAt>0,`找不到 $${site.name}From 的定义`);
  assert.ok(fromAt<blockAt,`$${site.name}From 定义在 $shuffleSites 之后：未定义变量会静默变成空串，四处全判失配`);
 }
 // 只允许定义一次，避免误匹配到 $shuffleXxxFrom 的其它引用
 assert.equal(patch.split('$shuffleSites = @(').length-1,1,'$shuffleSites 只应该定义一次');
});

test('牌堆会注入到 bundle 顶部并在打包后复核（注入 + 解包复核都跟着 $shuffleDeckApplied 走）',()=>{
 assert.ok(patch.includes('$shuffleInjection = if ($shuffleDeckApplied) { $shuffleDeckSource + "`n" } else { "" }'),
  '整块跳过时没有把牌堆从注入内容里去掉');
 assert.ok(patch.includes('$text = $patchMarker + "`n" + $songEditorSource + "`n" + $shuffleInjection + $songEditorBridge + "`n" +'),
  '拼接注入时没有带上 $shuffleInjection');
 assert.match(patch,/if \(\$shuffleDeckApplied\) \{\r?\n\s+if \(-not \$verifyText\.Contains\(\$shuffleDeckSource\)\) \{ throw "patched archive missing the shuffle deck" \}/u,
  '解包复核没有跟着 $shuffleDeckApplied 走（跳过时会把可选功能缺失升级成补丁失败）');
 assert.ok(patch.includes('if (-not $verifyText.Contains($shuffleSite.To)) { throw "patched archive missing the $($shuffleSite.Name)" }'));
 assert.ok(patch.includes('if ($verifyText.Contains($shuffleSite.From)) { throw "patched archive retains the original $($shuffleSite.Name)" }'));
 assert.ok(patch.includes('Write-Output "shuffleDeck=$shuffleDeckState"'),'补丁脚本没有输出 shuffleDeck 状态，静默跳过时无从发现');
});

test('牌堆主体只依赖 x.value/a()/u/f 与 localStorage，不碰游戏原生播放函数',()=>{
 for(const symbol of ['function OliviaSoulShuffleNextIndex','function OliviaSoulShufflePrevIndex','function OliviaSoulShuffleRestart']){
  assert.ok(deckSource.includes(symbol),`牌堆缺少 ${symbol}`);
 }
 assert.match(deckSource,/const OliviaSoulShuffleKey="olivia-soul-shuffle-deck-v1";/u);
 assert.match(deckSource,/let OliviaSoulShuffleDeck=\[\],OliviaSoulShuffleCursor=0,OliviaSoulShuffleTail="",OliviaSoulShuffleReady=false,OliviaSoulShuffleSource="";/u);
 for(const forbidden of ['playSong','OliviaSoulPlaySong','startForeground','stopForeground','pendingUpload']){
  assert.ok(!deckCode.includes(forbidden),`牌堆出现了不该碰的符号 ${forbidden}`);
 }
 // localStorage 的两处用法都必须包在 try/catch 里（CEF 下可能直接抛 SecurityError）
 assert.equal([...deckSource.matchAll(/try\{/gu)].length,[...deckSource.matchAll(/catch\(error\)/gu)].length);
});
