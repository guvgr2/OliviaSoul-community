// 【最大化后无法恢复正常大小】修复的护栏（2026-10-09）。
//
// 现场：用户运行目录 UserData/runtime.log
//   00:15:17.361 collapse requested restoredMaximized=True location=0,0
//   00:15:18.343 expand requested uiReady=True location=0,0
// 之后点最大化按钮想还原，窗口看起来"什么都没变"。
//
// 根因（C# 侧，见 native-host/MainForm.cs 里 _normalBounds 的注释）：
// Collapse() 为了消除"最大化 → 先缩回小窗口再往下滑"的闪烁，会把 Bounds 直接铺成最大化那一块
// （`Bounds = maximizedArea;`）。窗口处于 Normal 时设 Bounds，会**同时改写系统维护的还原矩形**
// （GetWindowPlacement 的 rcNormalPosition）。于是：
//   最大化 → 收起（还原矩形被改写成整屏）→ 展开（回到最大化）→ 点还原
// 系统把窗口"还原"到那个整屏矩形 —— 和最大化时一模一样，用户看到的就是"没法恢复成正常大小"。
//
// 修法：自己记一份正常大小（_normalBounds），还原时不信系统那份，直接贴回去。
// 这份套件钉死下面这些点，行号会漂移，所以一律按「方法体 + 关键语句顺序」断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const rawSource = readFileSync(new URL('../native-host/MainForm.cs', import.meta.url), 'utf8').replace(/\r/g, '');

function methodFrom(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => /^        (public|private|protected) /.test(line) && line.includes(` ${name}(`));
  const end = lines.findIndex((line, index) => index > start && line === '        }');
  assert.ok(start >= 0 && end > start, `MainForm.cs 里找不到方法 ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

// —— 全部不变量：对任意一份源码跑一遍，任何一条不成立就抛 ——
function checkInvariants(source) {
  const collapse = methodFrom(source, 'Collapse');
  const toggle = methodFrom(source, 'ToggleMaximize');
  const remember = methodFrom(source, 'RememberWindowBounds');
  const onScreen = methodFrom(source, 'IsOnAnyScreen');
  const restore = methodFrom(source, 'RestoreNormalWindow');
  const apply = methodFrom(source, 'ApplyNormalBounds');

  // 1) 字段：必须是"自己记一份"，不能没有地方存正常大小
  assert.match(source, /private Rectangle _normalBounds;/u);
  assert.match(source, /private bool _hasNormalBounds;/u);

  // 2) ★ 最要紧的顺序：Collapse() 必须在**改状态之前**就记下正常大小。
  //    「切 Normal」和「Bounds = maximizedArea」两步都会改写系统的还原矩形，晚一步就记到整屏了。
  const remembered = collapse.indexOf('RememberWindowBounds();');
  const switched = collapse.indexOf('WindowState = FormWindowState.Normal;');
  const clobbered = collapse.indexOf('Bounds = maximizedArea;');
  assert.ok(remembered >= 0, 'Collapse() 里必须调用 RememberWindowBounds()');
  assert.ok(switched > remembered,
    'RememberWindowBounds() 必须在 `WindowState = FormWindowState.Normal;` 之前 —— 那行一执行，RestoreBounds 就不是原值了');
  assert.ok(clobbered > remembered,
    'RememberWindowBounds() 必须在 `Bounds = maximizedArea;` 之前 —— 那行会把系统的还原矩形改写成整屏');

  // 3) 取值来源：最大化时信系统的还原矩形，普通状态直接取 Bounds
  assert.match(remember, /WindowState == FormWindowState\.Maximized \? RestoreBounds : Bounds/u,
    '最大化时系统的还原矩形才是权威值；普通状态取 Bounds');
  assert.match(remember, /if \(candidate\.Width <= 0 \|\| candidate\.Height <= 0\) return;/u);
  assert.match(remember, /if \(!IsOnAnyScreen\(candidate\)\) return;/u,
    '收起动画进行中窗口在屏幕外，那时的 Bounds 不能当正常大小记下来');
  assert.match(remember, /_normalBounds = candidate;/u);
  assert.match(remember, /_hasNormalBounds = true;/u);
  assert.match(remember, /_hasNormalBounds && candidate\.Width >= workingArea\.Width/u,
    '系统那份还原矩形可能已经被改写成了整屏，别把"整屏"当成正常大小记下来');

  // 4) ToggleMaximize 的还原分支必须走 RestoreNormalWindow()，不许裸改 WindowState
  assert.match(toggle, /if \(WindowState == FormWindowState\.Maximized\)[\s\S]{0,120}RestoreNormalWindow\(\);[\s\S]{0,60}return;/u,
    '最大化状态下点按钮要走 RestoreNormalWindow()：只把 WindowState 改成 Normal 会因为还原矩形已被改写而"看起来没反应"');
  assert.doesNotMatch(toggle, /WindowState = FormWindowState\.Normal;/u,
    'ToggleMaximize() 不许自己裸改 WindowState = Normal（要交给 RestoreNormalWindow 把正常大小一并贴回）');
  assert.match(toggle, /RememberWindowBounds\(\);/u, '最大化之前要记住正常大小，否则还原时没得可用');
  assert.match(toggle, /maximize toggle state=/u, '要留日志：真机争议靠它定位');

  // 5) RestoreNormalWindow：延后到消息循环之后再贴 Bounds（紧接着设会被系统的还原重排盖掉）
  assert.match(restore, /WindowState = FormWindowState\.Normal;/u);
  assert.match(restore, /if \(!_hasNormalBounds\) return;/u);
  assert.match(restore, /BeginInvoke\(\(Action\)ApplyNormalBounds\);/u,
    '必须 BeginInvoke 延后贴 Bounds：WindowState 落地后系统还会按还原矩形重排一次');
  assert.doesNotMatch(restore, /Bounds = _normalBounds;/u, '不许在 RestoreNormalWindow 里同步设 Bounds');

  // 6) ApplyNormalBounds：守卫 + 屏幕兜底 + 日志
  assert.match(apply, /if \(WindowState != FormWindowState\.Normal\) return;/u,
    '只有确实处于普通状态才贴 Bounds，别在最大化/收起态乱动窗口');
  assert.match(apply, /if \(!IsOnAnyScreen\(target\)\)/u, '要判断记下的那块屏还在不在（拔显示器 / 改分辨率）');
  assert.match(apply, /Bounds = target;/u);
  assert.doesNotMatch(apply, /Bounds = Screen\.FromControl\(this\)\.WorkingArea;/u,
    '兜底绝不能"铺满工作区"—— 那看起来和"没还原"一模一样，等于把这次的 bug 又装回去');
  assert.match(apply, /normal bounds applied/u);

  // 7) 屏幕判定只认"窗口区与某个屏的工作区相交"
  assert.match(onScreen, /Screen\.AllScreens/u);
  assert.match(onScreen, /screen\.WorkingArea\.IntersectsWith\(bounds\)/u);

  // 8) 收起时是最大化状态的话，展开回来仍要还原成最大化（原有行为不许被这次修复碰坏）
  assert.match(methodFrom(source, 'Expand'), /if \(_wasMaximized\) WindowState = FormWindowState\.Maximized;/u);
}

test('最大化 → 收起 → 展开 → 还原：自己记的正常大小必须贴得回去', () => {
  checkInvariants(rawSource);
});

test('变异测试：护栏必须抓住每一处破坏（拿掉任意一条就变红）', () => {
  const mutations = [
    ['Collapse 不再记正常大小',
      s => s.replace(/\n\s*RememberWindowBounds\(\);\n(\s*if \(WindowState == FormWindowState\.Maximized\))/, '\n$1')],
    ['把 RememberWindowBounds 挪到「改写还原矩形」之后',
      s => s.replace(
        /\n\s*RememberWindowBounds\(\);\n(\s*if \(WindowState == FormWindowState\.Maximized\)[\s\S]*?Bounds = maximizedArea;)/,
        '\n$1\n                RememberWindowBounds();')],
    ['最大化还原分支改成裸改 WindowState',
      s => s.replace('                RestoreNormalWindow();', '                WindowState = FormWindowState.Normal;')],
    ['还原时同步贴 Bounds（不延后）',
      s => s.replace('            BeginInvoke((Action)ApplyNormalBounds);', '            ApplyNormalBounds();')],
    ['取值来源改成永远读 Bounds',
      s => s.replace('WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds', 'Bounds')],
    ['去掉"整屏不算正常大小"的兜底',
      s => s.replace(/            if \(_hasNormalBounds && candidate\.Width >= workingArea\.Width && candidate\.Height >= workingArea\.Height\) return;\n/, '')],
    ['去掉"屏幕外坐标不能当正常大小"的兜底',
      s => s.replace('            if (!IsOnAnyScreen(candidate)) return;\n', '')],
    ['去掉 ApplyNormalBounds 的状态守卫',
      s => s.replace('            if (WindowState != FormWindowState.Normal) return;\n            var target = _normalBounds;', '            var target = _normalBounds;')],
    ['去掉"那块屏没了"的判断',
      s => s.replace('            if (!IsOnAnyScreen(target))\n', '            if (false)\n')],
    ['兜底退回「铺满工作区」（看起来就是没还原）',
      s => s.replace('                var area = Screen.FromControl(this).WorkingArea;\n                var width = Math.Min',
        '                Bounds = Screen.FromControl(this).WorkingArea;\n                return;\n                var area = Screen.FromControl(this).WorkingArea;\n                var width = Math.Min')],
  ];

  for (const [name, mutate] of mutations) {
    const mutated = mutate(rawSource);
    assert.notEqual(mutated, rawSource, `变异没生效（说明源码已经长得不一样了）：${name}`);
    assert.throws(() => checkInvariants(mutated),
      `破坏「${name}」之后护栏仍然全绿 = 这条护栏形同虚设`);
  }
});
