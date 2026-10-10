// A（工单《工单-托盘图标切换与一键启动游戏》第 1 部分 · 2026-10-08）：
// 任务栏图标点击 = 收起/展开（从屏幕底部滑入滑出）。这份套件钉死这些事：
//   1. 收起态**不能** Hide()、**不能**动 ShowInTaskbar —— 否则任务栏按钮一起消失，
//      「点任务栏图标切换」就没有点击目标了（`HideToTray()` 是给退出路径用的，必须原样保留）；
//   2. 收起靠**位移**滑到 Screen.Bounds.Bottom 之外，动画只改 Location、不碰 Opacity
//      （WebView2 在 layered window 下做透明度动画会花屏）；
//   3. `WM_SYSCOMMAND` 必须在 `base.WndProc` **之前**拦：前台点任务栏按钮 = SC_MINIMIZE、
//      其余 = SC_RESTORE；交给系统处理的话无边框窗口会缩成桌面左下角一条小条；
//   4. 最小化按钮、托盘左键、右键「打开管理窗口」三个入口都要走同一套 Collapse()/Expand()；
//   5. **点击不能被静默吞掉**（2026-10-08 真机反馈"点不动收回 / 点了几秒才展开"）：
//      动画期间来的第二下先 FinishSlide() 再执行、SC_MINIMIZE 按切换处理、
//      窗口样式保住 WS_MINIMIZEBOX、最大化状态收起时不许先缩回小窗口；
//   6. 隐藏启动（--hidden）要后台预热页面，别让用户第一次展开现等建桥 + 导航；
//   7. 展开只认「真鼠标点击带来的激活」（WM_ACTIVATE 的 WA_CLICKACTIVE）——收起后窗口只是滑到
//      屏幕外、没有真最小化，仍在 z 序里；用户关掉别的窗口时系统会把前台交给它（WA_ACTIVE），
//      那一下绝不许自己滑回来（2026-10-08 第三轮真机反馈"我没点它，它自己从任务栏弹出来"）。
// 行号会漂移，所以这里一律按「方法体 + 关键语句」断言，不按行号。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../native-host/MainForm.cs', import.meta.url), 'utf8').replace(/\r/g, '');

function method(name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => /^        (public|private|protected) /.test(line) && line.includes(` ${name}(`));
  const end = lines.findIndex((line, index) => index > start && line === '        }');
  assert.ok(start >= 0 && end > start, `MainForm.cs 里找不到方法 ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

test('收起 = 位移到屏幕外，不 Hide、不动 ShowInTaskbar', () => {
  const collapse = method('Collapse');
  assert.doesNotMatch(collapse, /\.Hide\(\)/u, 'Collapse() 不许 Hide()：任务栏按钮会一起消失');
  assert.doesNotMatch(collapse, /ShowInTaskbar/u, 'Collapse() 不许动 ShowInTaskbar：改它会把最大化窗口重建');
  assert.match(collapse, /_restoreLocation = Location;/u, '收起前要记住原位置，展开时才能回到原地');
  assert.match(collapse, /Screen\.FromControl\(this\)\.Bounds/u,
    '要用 Bounds（整屏）而不是 WorkingArea：任务栏那几十像素也要滑出去，否则会露出一条边');
  assert.match(collapse, /SlideOffscreenGap/u);
  assert.match(collapse, /WindowState == FormWindowState\.Maximized[\s\S]{0,200}FormWindowState\.Normal/u,
    '最大化状态要切回普通窗口：最大化窗口的位置由系统托管，直接位移会被系统拉回去');
});

test('收起不再被 _hiddenAtLaunch 挡住（真机"点不动收回"的根因）', () => {
  const collapse = method('Collapse');
  assert.doesNotMatch(collapse, /if \(_hiddenAtLaunch/u,
    '开机自启（--hidden）的会话里显示过窗口后 _hiddenAtLaunch 仍是 true，拿它当守卫会让收起永远被拒');
  assert.match(collapse, /if \(!Visible\) return;/u, '没显示出来的窗口没什么可收的，判 Visible 就够');
  assert.match(collapse, /if \(_sliding\) FinishSlide\(\);/u,
    '动画期间的点击要先收尾当前动画，不能因为 _sliding 直接 return 把点击吞掉');
  assert.match(collapse, /if \(_collapsed\) return;/u);
  assert.match(collapse, /WriteRuntimeLog\("collapse requested/u, '收起要留一行日志，真机问题靠它定位');
});

test('最大化状态收起：先铺成最大化那块 Bounds，不许先缩回小窗口', () => {
  const collapse = method('Collapse');
  assert.match(collapse, /var maximizedArea = Screen\.FromControl\(this\)\.WorkingArea;/u);
  assert.match(collapse, /Bounds = maximizedArea;/u,
    '切回普通窗口时要把 Bounds 铺成最大化那一块，否则视觉上会先"变回原本大小"再往下滑');
  assert.match(collapse, /_wasMaximized = true;/u);
  assert.match(collapse, /_wasMaximized = false;/u);
});

test('展开 = 从屏幕外滑回记录的坐标，先复位状态再激活', () => {
  const expand = method('Expand');
  assert.match(expand, /SlideTo\(_restoreLocation/u);
  assert.match(expand, /_restoreArea/u,
    '收起态窗口在屏幕外，Screen.FromControl 可能给出主屏；要用收起时记下的那一块屏');
  assert.match(expand, /_collapsed = false;[\s\S]{0,260}Activate\(\);/u,
    'done 回调里必须先 _collapsed = false 再 Activate()，否则 Activated 里的 Expand() 会递归');
  assert.match(expand, /if \(_wasMaximized\) WindowState = FormWindowState\.Maximized;/u,
    '最大化时收起的，展开回来要还原成最大化状态');
  assert.match(expand, /if \(_sliding\) FinishSlide\(\);/u, '展开也要先收尾进行中的动画');
  assert.match(expand, /WriteRuntimeLog\("expand requested uiReady="/u,
    '日志里要能看出是"页面没加载好"还是"根本没响应"，真机争议靠它定位');
});

test('FinishSlide / ToggleCollapse：动画期间的第二下点击按反向处理，不吞掉', () => {
  const finish = method('FinishSlide');
  assert.match(finish, /if \(!_sliding\) return;/u);
  assert.match(finish, /Location = _slideTo;/u, '收尾要直接跳到终点，别留下半截位置');
  assert.match(finish, /_sliding = false;/u);
  assert.match(finish, /var done = _slideDone;/u, '收尾要执行原本的 done 回调（_collapsed 的位要靠它翻）');

  const toggle = method('ToggleCollapse');
  assert.match(toggle, /var collapsing = _slideTo\.Y > _slideFrom\.Y;/u);
  assert.match(toggle, /if \(collapsing\) Expand\(\);/u);
  assert.match(toggle, /if \(_collapsed\) Expand\(\);\s*\n\s*else Collapse\(\);/u);
});

test('动画只改 Location、不碰 Opacity，且收尾会记耗时', () => {
  const tick = method('OnSlideTick');
  assert.match(tick, /Location = new Point\(/u);
  assert.doesNotMatch(tick, /Opacity/u, 'Opacity 渐变在 WebView2 + layered window 下会花屏');
  assert.match(tick, /_slideClock\.Elapsed\.TotalMilliseconds \/ SlideDurationMs/u);
  assert.match(tick, /slide done elapsedMs=/u, '动画结束要记实测耗时：真机"几秒才展开"就是靠它区分动画被拖长');
  assert.match(source, /_slide\.Tick \+= OnSlideTick;/u, '构造函数里要绑定 _slide.Tick');
  assert.match(source, /SlideDurationMs = 180/u, '动画时长约 160–200ms');
});

test('WndProc 在 base.WndProc 之前拦 WM_SYSCOMMAND，SC_MINIMIZE 按切换处理', () => {
  const wndProc = method('WndProc');
  const guard = wndProc.indexOf('WmSysCommand');
  const baseCall = wndProc.indexOf('base.WndProc(ref message);');
  assert.ok(guard >= 0, 'WndProc 里必须有 WmSysCommand 分支');
  assert.ok(baseCall >= 0 && guard < baseCall, '必须在 base.WndProc 之前 return，否则系统会先把窗口最小化');
  assert.match(wndProc, /command == ScMinimize[\s\S]{0,400}ToggleCollapse\(\);[\s\S]{0,40}return;/u,
    '前台点任务栏按钮收到 SC_MINIMIZE；收起态的窗口仍是前台窗口，所以必须按切换处理，不能一律 Collapse()');
  assert.match(wndProc, /command == ScRestore[\s\S]{0,200}if \(_collapsed\)[\s\S]{0,80}Expand\(\);[\s\S]{0,40}return;/u);
  assert.match(wndProc, /syscommand minimize collapsed=/u, '系统消息要留日志：真机点击有没有到我们这里，只有日志能说清');
  assert.match(source, /WmSysCommand = 0x0112/u);
  assert.match(source, /ScMinimize = 0xF020/u);
  assert.match(source, /ScRestore = 0xF120/u);
});

test('窗口样式保住 WS_MINIMIZEBOX（否则任务栏按钮的点击不会变成 SC_MINIMIZE）', () => {
  assert.match(source, /private const int WsMinimizeBox = 0x00020000;/u);
  assert.match(source, /CreateParams[\s\S]{0,240}parameters\.Style \|= WsMinimizeBox;/u);
  assert.match(source, /parameters\.ClassStyle \|= 0x00020000;/u, 'CS_DROPSHADOW 那行要保持原样');
});

test('三个入口都走 Collapse/Expand（最小化按钮 / 托盘左键 / 右键打开管理窗口）', () => {
  assert.match(source, /minimizeButton\.Click \+= delegate \{ Collapse\(\); \};/u);
  assert.doesNotMatch(source, /minimizeButton\.Click[^;]*WindowState/u,
    '最小化按钮不许再 WindowState = Minimized：无边框窗口会缩成桌面左下角一条小条');
  assert.match(source, /_tray\.MouseClick[\s\S]{0,500}ToggleCollapse\(\);/u, '托盘左键 = toggle');
  assert.match(source, /closeButton\.Click \+= delegate \{ FinishSlide\(\); Close\(\); \};/u,
    '关闭键要先把动画收尾再关窗，不能因为动画期间就静默忽略这次点击');
  assert.doesNotMatch(source, /if \(!_sliding\) Close\(\);/u);
  assert.match(source, /menu\.Items\.Add\("打开管理窗口"[\s\S]{0,160}if \(_collapsed\) Expand\(\);[\s\S]{0,60}else ShowFromTray\(\);/u);
  assert.doesNotMatch(source, /Activated \+= delegate[\s\S]{0,600}if \(_collapsed\) Expand\(\);/u,
    'Activated 里不许无条件 Expand()：关掉别的窗口让出前台时它也会触发，窗口会"没人点它自己弹出来"');
});

test('展开只认带鼠标点击的激活（WM_ACTIVATE + WA_CLICKACTIVE），焦点回流不许弹窗', () => {
  const wndProc = method('WndProc');
  assert.match(wndProc, /message\.Msg == WmActivate/u, 'WndProc 里要有 WM_ACTIVATE 分支');
  assert.match(wndProc, /message\.WParam\.ToInt64\(\) & 0xFFFF/u, 'WA_* 在 WParam 低 16 位，高 16 位是被停用的窗口句柄');
  assert.match(wndProc, /if \(_collapsed && reason == WaClickActive\)[\s\S]{0,200}BeginInvoke\(\(Action\)Expand\)/u,
    '只有"点了它"（任务栏按钮点击 = WA_CLICKACTIVE）才滑回来；系统把前台交给它（WA_ACTIVE）必须原地不动');
  assert.doesNotMatch(wndProc, /MouseButtons/u,
    '不许用"左键是否按下"当兜底：用户点别的窗口关闭按钮时左键也是按下的，会把这个 bug 放回来');
  assert.match(wndProc, /wm_activate reason=/u, '激活原因要留日志，真机才能分辨是点击还是焦点回流');
  assert.match(source, /WmActivate = 0x0006/u);
  assert.match(source, /WaClickActive = 2/u);
});

test('退出路径原样保留：HideToTray/ShowFromTray 不动，最大化不再吞点击', () => {
  const hide = method('HideToTray');
  assert.match(hide, /ShowInTaskbar = false;[\s\S]{0,80}Hide\(\);/u, 'HideToTray() 是退出路径，保持原样');
  const show = method('ShowFromTray');
  assert.match(show, /ShowInTaskbar = true;/u);
  assert.match(show, /Opacity = 1;/u);
  assert.match(source, /_slide\.Stop\(\);[\s\S]{0,40}_slide\.Dispose\(\);/u, 'Dispose 里要停掉并释放动画 Timer');
  const maximize = method('ToggleMaximize');
  assert.match(maximize, /FinishSlide\(\);/u, '最大化前先收尾动画，而不是把这次点击吞掉（审查意见 S2）');
  assert.doesNotMatch(maximize, /_sliding\) return;/u);
});

test('隐藏启动后台预热管理页面（第一次展开不用现等建桥 + 导航）', () => {
  assert.match(source, /_ = PreloadUiAsync\(\);/u, '--hidden 分支要起后台预热任务');
  const preload = method('PreloadUiAsync');
  assert.match(preload, /await EnsureUiAsync\(\);/u);
  assert.match(preload, /catch \(Exception error\)/u, '预热失败只写日志，不能让隐藏启动走进启动失败页');
  assert.match(preload, /hidden preload/u);
  assert.match(source, /private bool IsUiReady\(\)/u);
  assert.match(method('IsUiReady'), /_uiInitialization \.IsCompleted|_uiInitialization != null/u);
});
