using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OliviaSoul
{
    public sealed class MainForm : Form
    {
        private const int WmNcLButtonDown = 0x00A1;
        private const int WmNcHitTest = 0x0084;
        private const int HtCaption = 2;
        private const int HtLeft = 10;
        private const int HtRight = 11;
        private const int HtTop = 12;
        private const int HtTopLeft = 13;
        private const int HtTopRight = 14;
        private const int HtBottom = 15;
        private const int HtBottomLeft = 16;
        private const int HtBottomRight = 17;
        // A（工单 §2.3(b)）：点任务栏按钮时，前台窗口收到 SC_MINIMIZE、非前台 / 已收起窗口收到 SC_RESTORE。
        // 这套「前台 → 收起、非前台 → 展开」就是任务栏 toggle 的标准语义，别自创「看 Visible」的判定。
        private const int WmSysCommand = 0x0112;
        private const int ScMinimize = 0xF020;
        private const int ScRestore = 0xF120;
        private const int SlideDurationMs = 180;   // 与 LyricsOverlayForm 的 30ms × 6 步观感一致
        private const int SlideOffscreenGap = 8;
        // A（2026-10-08 真机反馈"点任务栏图标收不起来/要等很久"）：窗口样式里必须保住 WS_MINIMIZEBOX。
        // 这里是 *Window* style（不是 CreateParams.ClassStyle 那个 0x00020000 = CS_DROPSHADOW，同值不同字段）：
        // shell 只在"这个窗口能最小化"时才会把任务栏按钮的点击翻译成 SC_MINIMIZE 发给我们。
        private const int WsMinimizeBox = 0x00020000;
        // A（2026-10-08 第三轮真机反馈"我没点任务栏，它自己从任务栏弹出来了"）：
        // 收起后窗口只是滑到屏幕外、并没有真的最小化，所以它仍在 z 序里；用户关掉别的窗口时
        // 系统会把前台交给它，`Form.Activated` 一样会触发 —— 之前在那儿无条件 Expand()，
        // 就变成"没人点它，它自己滑回来"。
        // 只有"真鼠标点击带来的激活"（WM_ACTIVATE 的 WA_CLICKACTIVE，任务栏按钮点击也走这条）
        // 才允许展开；焦点被动回流（关掉别的窗口）是 WA_ACTIVE，必须原地不动。
        private const int WmActivate = 0x0006;
        private const int WaClickActive = 2;

        private readonly bool _hiddenAtLaunch;
        private readonly AppPaths _paths;
        private readonly NodeBackend _backend;
        private readonly object _runtimeLogLock = new object();
        private readonly Stopwatch _startupClock = Stopwatch.StartNew();
        private readonly WebView2 _webView;
        private readonly NotifyIcon _tray;
        private readonly ToolStripMenuItem _autoStartItem;
        private readonly LyricsPresenter _lyrics;
        private readonly WindowControlButton _maximizeButton;
        private WindowControlButton[] _windowControlButtons;
        private DesktopBridge _bridge;
        private Task _startupInitialization;
        private Task _uiShellInitialization;
        private Task _uiInitialization;
        private bool _backendReady;
        private bool _quitting;
        private bool _shutdownComplete;
        private bool _trayNoticeShown;
        private string _adminOrigin;

        // A（工单 §2.3(a)）：收起 / 展开的位移动画。**只做位移，不用 Opacity** ——
        // Opacity < 1 会让窗口变成 layered window，WebView2 子控件在那下面有花屏风险。
        private readonly Timer _slide = new Timer { Interval = 16 };
        private readonly Stopwatch _slideClock = Stopwatch.StartNew();
        private bool _collapsed;          // true = 已收起（停在屏幕底部之外，但没 Hide、没动 ShowInTaskbar）
        private bool _sliding;            // 动画进行中，防重入
        private Point _restoreLocation;   // 展开态的位置
        private Rectangle _restoreArea;   // 收起时窗口所在那块屏的整屏边界（多显示器下不能用主屏）
        private bool _wasMaximized;       // 收起时窗口是最大化状态（展开回来要还原成最大化）
        private Point _slideFrom;
        private Point _slideTo;
        private Action _slideDone;

        // ★ 未最大化时的窗口矩形，**自己记一份**，不信系统那份：
        // Collapse() 为了做滑出动画会把 Bounds 铺满整屏（`Bounds = maximizedArea;`），这一下会连
        // 系统维护的"还原矩形"（GetWindowPlacement 的 rcNormalPosition）一起改写成整屏大小。
        // 之后再点最大化按钮还原，窗口就还原到"整屏"——用户看到的就是
        // "点了最大化窗口后没法恢复成正常大小"（真机日志 2026-10-09 00:15:17
        // `collapse requested restoredMaximized=True location=0,0` 之后走的正是这条路径）。
        private Rectangle _normalBounds;
        private bool _hasNormalBounds;

        public bool IsQuitting { get { return _quitting; } }

        // 供 NodeBackend 打"node 起来时宿主已经跑了多久"，用来对齐两条时间线（g11 启动计时）。
        private static readonly Stopwatch HostStartClock = Stopwatch.StartNew();
        public static long HostStartElapsedMs { get { return HostStartClock.ElapsedMilliseconds; } }
        public static void MarkHostStarted() { HostStartClock.Restart(); }

        public MainForm(bool hiddenAtLaunch)
        {
            _hiddenAtLaunch = hiddenAtLaunch;
            _paths = AppPaths.Detect();
            _backend = new NodeBackend(_paths);
            _backend.PortChanged += NavigateToPort;
            _backend.Log += WriteRuntimeLog;
            WriteRuntimeLog("desktop constructed hidden=" + hiddenAtLaunch);

            Text = "Olivia Soul";
            var workingArea = Screen.PrimaryScreen.WorkingArea;
            Width = Math.Min(1120, Math.Max(820, workingArea.Width - 160));
            Height = Math.Min(720, Math.Max(620, workingArea.Height - 160));
            MinimumSize = new Size(820, 620);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(61, 65, 72);
            FormBorderStyle = FormBorderStyle.None;
            Padding = new Padding(1);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            if (_hiddenAtLaunch)
            {
                Opacity = 0;
                ShowInTaskbar = false;
            }

            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                DefaultBackgroundColor = Color.FromArgb(15, 16, 19),
                CreationProperties = new CoreWebView2CreationProperties
                {
                    UserDataFolder = System.IO.Path.Combine(_paths.UserData, "WebView2"),
                },
            };

            var titleBar = new Panel
            {
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                BackColor = Color.FromArgb(15, 16, 19),
            };
            var windowButtons = new TableLayoutPanel
            {
                ColumnCount = 3,
                Dock = DockStyle.Right,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                RowCount = 1,
                Width = 126,
            };
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 42));
            windowButtons.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var minimizeButton = new WindowControlButton(WindowControlKind.Minimize);
            _maximizeButton = new WindowControlButton(WindowControlKind.Maximize);
            var closeButton = new WindowControlButton(WindowControlKind.Close);
            minimizeButton.Click += delegate { Collapse(); };
            _maximizeButton.Click += delegate { ToggleMaximize(); };
            closeButton.Click += delegate { FinishSlide(); Close(); };
            windowButtons.Controls.Add(minimizeButton, 0, 0);
            windowButtons.Controls.Add(_maximizeButton, 1, 0);
            windowButtons.Controls.Add(closeButton, 2, 0);

            // 只靠 MouseEnter / MouseLeave 会让关闭键在鼠标"没动就离开"时一直红着
            // （窗口被键盘拖动、布局变化、弹窗抢焦点等）。这里在这些时机主动按真实光标位置校正。
            _windowControlButtons = new[] { minimizeButton, _maximizeButton, closeButton };
            Move += delegate { SyncWindowControlButtons(); };
            Resize += delegate { SyncWindowControlButtons(); };
            Activated += delegate
            {
                SyncWindowControlButtons();
                // 收起态窗口停在屏幕外；用户点任务栏按钮时系统通常只会「激活」它、不会发 SC_RESTORE，
                // 所以需要自己滑回来 —— 但**不能在这里无条件 Expand()**：焦点被动回流（用户关掉别的窗口、
                // 程序退出让出前台）时 Activated 一样会触发，那样窗口会"没人点它自己弹出来"。
                // 展开的判定统一放在 WndProc 的 WM_ACTIVATE 分支：只认带鼠标点击的激活（WA_CLICKACTIVE）。
            };
            Deactivate += delegate { SyncWindowControlButtons(); };

            titleBar.Controls.Add(windowButtons);
            titleBar.MouseDown += DragWindow;
            titleBar.DoubleClick += delegate { ToggleMaximize(); };
            var windowLayout = new TableLayoutPanel
            {
                ColumnCount = 1,
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                RowCount = 2,
            };
            windowLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            windowLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            windowLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            windowLayout.BackColor = Color.FromArgb(15, 16, 19);
            windowLayout.Controls.Add(titleBar, 0, 0);
            windowLayout.Controls.Add(_webView, 0, 1);
            Controls.Add(windowLayout);

            _autoStartItem = new ToolStripMenuItem("开机自动启动") { CheckOnClick = true };
            _autoStartItem.Click += async delegate { await SetAutoStartAsync(_autoStartItem.Checked); };
            var menu = new ContextMenuStrip();
            _lyrics = new LyricsPresenter(this, _backend, data =>
            {
                if (!_quitting && _webView.CoreWebView2 != null)
                    _webView.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(data));
            });
            _lyrics.SettingsRequested += delegate {
                if (_quitting) return;
                ShowFromTray();
                _webView.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"lyrics-open-settings\"}");
            };
            // A（工单 §2.3(d)）：收起态下点「打开管理窗口」要滑回来，不能走 ShowFromTray()
            // —— 那条路会把窗口 Show() 到原来的位置，跳过我们的位移动画。
            menu.Items.Add("打开管理窗口", null, delegate
            {
                if (_collapsed) Expand();
                else ShowFromTray();
            });
            menu.Items.Add(_autoStartItem);
            menu.Items.Add(_lyrics.EnabledItem);
            menu.Items.Add(_lyrics.LockedItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { RequestQuit(); });
            _tray = new NotifyIcon
            {
                Icon = Icon,
                Text = "Olivia Soul",
                Visible = true,
                ContextMenuStrip = menu,
            };
            _tray.MouseClick += delegate(object sender, MouseEventArgs args)
            {
                if (args.Button != MouseButtons.Left) return;
                // A（工单 §2.3(d)）：托盘左键 = 收起/展开切换。窗口真的被隐藏时（HideToTray 那条路，
                // 例如退出前的展示）仍退回原来的「从托盘显示」，避免用户点了没反应。
                if (!Visible)
                {
                    ShowFromTray();
                    return;
                }
                ToggleCollapse();
            };

            Load += async delegate
            {
                _startupInitialization = InitializeAsync();
                await _startupInitialization;
            };
            FormClosing += OnFormClosing;
            _slide.Tick += OnSlideTick;
            SizeChanged += delegate
            {
                _maximizeButton.IsRestore = WindowState == FormWindowState.Maximized;
            };
        }

        private void DragWindow(object sender, MouseEventArgs args)
        {
            if (args.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
        }

        private void ToggleMaximize()
        {
            // 滑入/滑出期间点最大化：先把动画收尾再执行，不要把这次点击吞掉（审查意见 S2）。
            FinishSlide();
            WriteRuntimeLog("maximize toggle state=" + WindowState.ToString()
                + " hasNormalBounds=" + _hasNormalBounds.ToString());
            if (WindowState == FormWindowState.Maximized)
            {
                RestoreNormalWindow();
                return;
            }
            // 记下"正常大小"，还原时要靠它（系统那份可能已被收起动画改写，见 _normalBounds 的注释）。
            RememberWindowBounds();
            MaximizedBounds = Screen.FromControl(this).WorkingArea;
            WindowState = FormWindowState.Maximized;
        }

        /// <summary>
        /// 记住"未最大化时的窗口矩形"。最大化状态下系统的还原矩形才是权威值；普通状态直接取 Bounds。
        /// </summary>
        private void RememberWindowBounds()
        {
            var candidate = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
            if (candidate.Width <= 0 || candidate.Height <= 0) return;
            // 收起动画进行中（窗口正滑向屏幕外）时点最大化，Bounds 会是屏幕外坐标，不能当正常大小记下来。
            if (!IsOnAnyScreen(candidate)) return;
            // 系统那份还原矩形有可能正被收起动画改写成"整屏"（见 _normalBounds 的注释）。
            // "正常窗口 == 整屏"没有意义，这种情况宁可留着手里的旧值，别把整屏当成正常大小记下来。
            var workingArea = Screen.FromControl(this).WorkingArea;
            if (_hasNormalBounds && candidate.Width >= workingArea.Width && candidate.Height >= workingArea.Height) return;
            _normalBounds = candidate;
            _hasNormalBounds = true;
        }

        private static bool IsOnAnyScreen(Rectangle bounds)
        {
            foreach (var screen in Screen.AllScreens)
            {
                if (screen.WorkingArea.IntersectsWith(bounds)) return true;
            }
            return false;
        }

        /// <summary>
        /// 从最大化切回正常大小。**只把 WindowState 改成 Normal 是不够的** —— 系统的还原矩形可能
        /// 已经被收起动画改写成"整屏"了（见 _normalBounds 的注释），那样切完看起来"什么都没变"。
        /// </summary>
        private void RestoreNormalWindow()
        {
            _wasMaximized = false;
            WindowState = FormWindowState.Normal;
            if (!_hasNormalBounds) return;
            // WindowState 落地之后系统还会按还原矩形重排一次，紧接着设 Bounds 会被它盖掉；
            // 推迟到这一轮消息处理完，再把自己记的正常大小贴回去。
            BeginInvoke((Action)ApplyNormalBounds);
        }

        private void ApplyNormalBounds()
        {
            if (_quitting || IsDisposed) return;
            if (WindowState != FormWindowState.Normal) return;
            var target = _normalBounds;
            if (target.Width <= 0 || target.Height <= 0) return;
            // 记下的那块屏要是已经不在了（拔显示器 / 改分辨率），按原大小挪回当前屏中央 ——
            // 绝不能退回"铺满工作区"，那看起来和"没还原"一模一样，等于把这次的 bug 又装回去。
            if (!IsOnAnyScreen(target))
            {
                var area = Screen.FromControl(this).WorkingArea;
                var width = Math.Min(target.Width, area.Width);
                var height = Math.Min(target.Height, area.Height);
                target = new Rectangle(
                    area.X + (area.Width - width) / 2,
                    area.Y + (area.Height - height) / 2,
                    width,
                    height);
            }
            Bounds = target;
            WriteRuntimeLog("normal bounds applied location=" + Bounds.X.ToString(CultureInfo.InvariantCulture)
                + "," + Bounds.Y.ToString(CultureInfo.InvariantCulture)
                + " size=" + Bounds.Width.ToString(CultureInfo.InvariantCulture)
                + "x" + Bounds.Height.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 让三个窗口按钮按真实光标位置重新判定悬停态，避免关闭键在鼠标"没动就离开"时一直红着。
        /// </summary>
        private void SyncWindowControlButtons()
        {
            var buttons = _windowControlButtons;
            if (buttons == null) return;
            foreach (var button in buttons)
            {
                if (button != null && !button.IsDisposed) button.SyncHover();
            }
        }

        private async Task InitializeAsync()
        {
            if (_quitting || IsDisposed) return;
            var uiTask = EnsureUiShellAsync();
            var backendTask = InitializeBackendAsync();
            try
            {
                await uiTask;
                await backendTask;
                if (_quitting || IsDisposed) return;
                if (_hiddenAtLaunch)
                {
                    BeginInvoke((Action)HideToTray);
                    // 隐藏启动（--hidden，开机自启）也要在后台把管理页面先加载好：否则用户第一次点托盘图标
                    // 才现建桥 + 导航，观感就是"点完等好几秒才展开"。用后台任务做，不拖慢收进托盘的时机，
                    // 也不影响上面的启动失败路径。
                    _ = PreloadUiAsync();
                    return;
                }
                await EnsureUiAsync();
                if (_quitting || IsDisposed) return;
                LogStartupStage("admin-visible");
            }
            catch (Exception error)
            {
                if (_quitting || IsDisposed) return;
                WriteRuntimeLog("desktop initialization failed " + error);
                File.WriteAllText(Path.Combine(_paths.UserData, "host-error.log"), error.ToString());
                try
                {
                    await uiTask;
                    if (_quitting || IsDisposed) return;
                    RenderStartupError(error);
                }
                catch (Exception uiError)
                {
                    if (_quitting || IsDisposed) return;
                    WriteRuntimeLog("startup error page failed " + uiError);
                    if (!_hiddenAtLaunch)
                        MessageBox.Show(error.Message, "Olivia Soul 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        /// <summary>
        /// 隐藏启动（--hidden，开机自启）时后台预热管理页面：第一次从托盘/任务栏展开就不用现建桥 + 导航。
        /// </summary>
        private async Task PreloadUiAsync()
        {
            if (_quitting || IsDisposed) return;
            try
            {
                await EnsureUiAsync();
                WriteRuntimeLog("hidden preload ui-ready");
            }
            catch (Exception error)
            {
                WriteRuntimeLog("hidden preload failed " + error);
            }
        }

        private async Task InitializeBackendAsync()
        {
            if (_quitting || IsDisposed) return;
            await _backend.StartAsync();
            if (_quitting || IsDisposed) return;
            _backendReady = true;
            _lyrics.Initialize();
            LogStartupStage("backend-ready");
            WriteRuntimeLog("desktop backend ready port=" + _backend.Port.ToString(CultureInfo.InvariantCulture));
            await RefreshAutoStartAsync();
        }

        private Task EnsureUiShellAsync()
        {
            if (_uiShellInitialization == null) _uiShellInitialization = InitializeUiShellAsync();
            return _uiShellInitialization;
        }

        private async Task InitializeUiShellAsync()
        {
            if (_quitting || IsDisposed) return;
            await _webView.EnsureCoreWebView2Async();
            if (_quitting || IsDisposed) return;
            _webView.CoreWebView2.ContextMenuRequested += delegate(object sender, CoreWebView2ContextMenuRequestedEventArgs args)
            {
                args.Handled = !args.ContextMenuTarget.IsEditable;
            };
            _webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
                // 兜底：面板改走 openExternal 通道了，这里只放行同样的 https 白名单域名
                string target;
                try { target = DesktopBridge.ExternalLinkTarget(args.Uri); }
                catch { WriteRuntimeLog("blocked-open-url " + Convert.ToString(args.Uri)); return; }
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            };
            _webView.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                if (_adminOrigin != null && !args.Uri.StartsWith(_adminOrigin, StringComparison.OrdinalIgnoreCase))
                    args.Cancel = true;
            };
            _webView.CoreWebView2.NavigateToString(BuildLoadingDocument());
            LogStartupStage("ui-shell-ready");
        }

        private Task EnsureUiAsync()
        {
            if (_uiInitialization == null) _uiInitialization = InitializeUiAsync();
            return _uiInitialization;
        }

        private async Task InitializeUiAsync()
        {
            if (_quitting || IsDisposed) return;
            await EnsureUiShellAsync();
            if (_quitting || IsDisposed) return;
            if (_bridge == null)
            {
                _bridge = new DesktopBridge(this, _backend);
                await _bridge.AttachAsync(_webView.CoreWebView2);
            }
            if (_quitting || IsDisposed) return;
            NavigateToPort(_backend.Port);
        }

        private static string BuildLoadingDocument()
        {
            return "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                "<style>html,body{height:100%;margin:0;background:#111114;color:#eeeae4;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}" +
                "body{display:grid;place-items:center}.box{text-align:center}.mark{font-size:28px;letter-spacing:.08em}" +
                ".line{width:220px;height:2px;margin:22px auto;background:#2f3035;overflow:hidden}.line:after{display:block;width:45%;height:100%;background:#d9d2c8;content:'';animation:move 1.2s infinite ease-in-out}" +
                "p{color:#85858b;font-size:13px}@keyframes move{from{transform:translateX(-110%)}to{transform:translateX(330%)}}</style>" +
                "<body><div class='box'><div class='mark'>OLIVIA SOUL</div><div class='line'></div><p>正在启动本地服务，请稍候……</p></div></body>";
        }

        private void RenderStartupError(Exception error)
        {
            if (_quitting || IsDisposed) return;
            if (_webView.CoreWebView2 == null) return;
            var message = WebUtility.HtmlEncode(error == null ? "未知错误" : error.Message);
            _webView.CoreWebView2.NavigateToString(
                "<!doctype html><meta charset='utf-8'><style>html,body{height:100%;margin:0;background:#111114;color:#eeeae4;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}" +
                "body{display:grid;place-items:center}.box{max-width:620px;padding:36px}h1{font-size:22px}p{color:#c9a4a4;line-height:1.7;overflow-wrap:anywhere}</style>" +
                "<body><div class='box'><h1>本地服务启动失败</h1><p>" + message + "</p><p>窗口会继续保留，请检查日志后重新启动。</p></div></body>");
            LogStartupStage("error-visible");
        }

        private void LogStartupStage(string stage)
        {
            var sinceProcessStart = DateTime.Now - Process.GetCurrentProcess().StartTime;
            WriteRuntimeLog("startup-stage=" + stage + " elapsedMs=" +
                _startupClock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) +
                // 进程启动到现在（含程序管理器加载 exe、CLR 启动、WebView2 运行时装载这些
                // "窗体构造之前"的耗时）——只看 elapsedMs 会漏掉最慢的那一段。
                " sinceProcessStartMs=" + ((long)sinceProcessStart.TotalMilliseconds).ToString(CultureInfo.InvariantCulture) +
                " pid=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
        }

        private async Task RefreshAutoStartAsync()
        {
            var result = await _backend.SendAsync("getSettings");
            if (_quitting || IsDisposed) return;
            var settings = result as IDictionary<string, object>;
            if (settings != null && settings.ContainsKey("autoStart"))
                _autoStartItem.Checked = Convert.ToBoolean(settings["autoStart"], CultureInfo.InvariantCulture);
        }

        private async Task SetAutoStartAsync(bool enabled)
        {
            try
            {
                await ChangeAutoStartAsync(enabled);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "开机自启设置失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private readonly System.Threading.SemaphoreSlim _autoStartGate = new System.Threading.SemaphoreSlim(1, 1);
        public async Task<object> ChangeAutoStartAsync(bool enabled)
        {
            await _autoStartGate.WaitAsync();
            try
            {
                var result = await _backend.SendAsync("setAutoStart", enabled);
                PublishAutoStart(result);
                return result;
            }
            catch
            {
                try { PublishAutoStart(await _backend.SendAsync("getSettings")); } catch { }
                throw;
            }
            finally { _autoStartGate.Release(); }
        }

        private void PublishAutoStart(object result)
        {
            if (_quitting || IsDisposed) return;
            var settings = result as IDictionary<string, object>;
            if (settings == null || !settings.ContainsKey("autoStart")) return;
            bool enabled = Convert.ToBoolean(settings["autoStart"], CultureInfo.InvariantCulture);
            _autoStartItem.Checked = enabled;
            _webView.CoreWebView2?.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(
                new { type = "auto-start-settings", autoStart = enabled }));
        }

        private void NavigateToPort(int port)
        {
            if (_quitting || IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke((Action)(() => NavigateToPort(port)));
                return;
            }
            _adminOrigin = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
            if (_webView.CoreWebView2 != null) _webView.CoreWebView2.Navigate(_adminOrigin + "/admin");
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if (_quitting)
            {
                args.Cancel = !_shutdownComplete;
                return;
            }
            args.Cancel = true;
            HideToTray();
            if (_trayNoticeShown) return;
            _tray.ShowBalloonTip(3000, "Olivia Soul", "应用仍在托盘运行，信件服务不会中断。", ToolTipIcon.Info);
            _trayNoticeShown = true;
        }

        public void HideToTray()
        {
            if (IsDisposed) return;
            // Changing this property can recreate a maximized native window.
            // Hide only after that recreation, so no empty HWND remains visible.
            ShowInTaskbar = false;
            Hide();
        }

        public void ShowFromTray()
        {
            if (_quitting || IsDisposed) return;
            Opacity = 1;
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            _ = FinishShowFromTrayAsync();
        }

        /// <summary>
        /// A（工单 §2.3(d)）：收起 = 滑到屏幕底部之外，不 Hide()、不动 ShowInTaskbar。
        /// 用 Hide() 会让任务栏按钮一起消失，那"点任务栏图标切换"就没有点击目标了。
        /// </summary>
        public void Collapse()
        {
            if (_quitting || IsDisposed) return;
            // 动画期间点第二下不能吞掉：先把当前这段动画收尾，再执行这次要的动作。
            if (_sliding) FinishSlide();
            if (_collapsed) return;
            // 不能用 _hiddenAtLaunch 判：开机自启（--hidden）进来的会话里，用户从托盘把窗口显示出来之后
            // 这个字段还是 true，结果收起永远被拒（真机反馈"点不动收回"）。
            // 没显示出来的窗口本来就没什么可收的，判 Visible 就够。
            if (!Visible) return;
            // 最大化窗口的位置由系统托管，直接位移会被系统拉回去，所以先切回普通窗口；
            // 但切的时候要把 Bounds 直接铺成最大化时那一块 —— 否则视觉上会先"缩回小窗口"再往下滑
            //（真机反馈"最大化时点收起，会变为原本大小窗口然后再收起"）。
            // ★ 先记下"正常大小"再动状态：下面切普通窗口、再把 Bounds 铺满整屏，会连系统的还原矩形
            // （GetWindowPlacement 的 rcNormalPosition）一起改写成整屏 —— 之后点还原就"回不到正常大小"了。
            // 这里窗口还没被改过，RestoreBounds / Bounds 拿到的都还是真值。
            RememberWindowBounds();
            if (WindowState == FormWindowState.Maximized)
            {
                var maximizedArea = Screen.FromControl(this).WorkingArea;
                WindowState = FormWindowState.Normal;
                Bounds = maximizedArea;
                _wasMaximized = true;
            }
            else
            {
                _wasMaximized = false;
            }
            _restoreLocation = Location;
            _restoreArea = Screen.FromControl(this).Bounds;
            WriteRuntimeLog("collapse requested restoredMaximized=" + _wasMaximized.ToString()
                + " location=" + _restoreLocation.X.ToString(CultureInfo.InvariantCulture)
                + "," + _restoreLocation.Y.ToString(CultureInfo.InvariantCulture));
            // 用 Bounds（整屏）而不是 WorkingArea：任务栏那几十像素也要滑出去，否则会露出一条边。
            SlideTo(
                new Point(_restoreLocation.X, _restoreArea.Bottom + SlideOffscreenGap),
                delegate { _collapsed = true; });
        }

        public void Expand()
        {
            if (_quitting || IsDisposed) return;
            if (_sliding) FinishSlide();
            if (!_collapsed) return;
            Opacity = 1;
            if (!Visible) Show();
            // 收起态窗口停在屏幕外，Screen.FromControl 可能给出主屏；用收起时记下的那一块屏，
            // 否则多显示器下会在两块屏之间跳。
            var area = _restoreArea.Width > 0 ? _restoreArea : Screen.FromControl(this).Bounds;
            Location = new Point(_restoreLocation.X, area.Bottom + SlideOffscreenGap);
            // uiReady 用来把"窗口没滑回来"和"页面还没加载好"分开：收不起来/等很久时要靠这行日志定位。
            WriteRuntimeLog("expand requested uiReady=" + IsUiReady().ToString()
                + " location=" + _restoreLocation.X.ToString(CultureInfo.InvariantCulture)
                + "," + _restoreLocation.Y.ToString(CultureInfo.InvariantCulture));
            SlideTo(_restoreLocation, delegate
            {
                _collapsed = false;
                // 最大化状态收起时被换成了"普通窗口 + 最大化那块 Bounds"，展开完把状态还回去。
                if (_wasMaximized) WindowState = FormWindowState.Maximized;
                Activate();
                BringToFront();
                _ = FinishShowFromTrayAsync();
            });
        }

        private bool IsUiReady()
        {
            return _uiInitialization != null && _uiInitialization.IsCompleted;
        }

        /// <summary>
        /// 立刻结束进行中的滑入/滑出：跳到终点、执行收尾回调。
        /// "动画期间点不动"就是这个方法存在的理由 —— 用户的点击永远不该被静默丢掉。
        /// </summary>
        private void FinishSlide()
        {
            if (!_sliding) return;
            _slide.Stop();
            Location = _slideTo;
            _sliding = false;
            var done = _slideDone;
            _slideDone = null;
            if (done != null) done();
        }

        /// <summary>
        /// 收起 / 展开切换（任务栏按钮、托盘左键都走这里）。
        /// 动画期间点第二下按"反向"处理：收起途中点 = 改成展开，展开途中点 = 改成收起 ——
        /// 比"动画期间一律忽略"跟手。
        /// </summary>
        public void ToggleCollapse()
        {
            if (_quitting || IsDisposed) return;
            if (_sliding)
            {
                var collapsing = _slideTo.Y > _slideFrom.Y;
                FinishSlide();
                if (collapsing) Expand();
                else Collapse();
                return;
            }
            if (_collapsed) Expand();
            else Collapse();
        }

        /// <summary>
        /// 只做位移的滑入/滑出。不用 Opacity 渐变：WebView2 在 layered window 下做透明度动画会花屏。
        /// </summary>
        private void SlideTo(Point target, Action done)
        {
            _slideFrom = Location;
            _slideTo = target;
            _slideDone = done;
            _sliding = true;
            _slideClock.Restart();
            _slide.Start();
        }

        private void OnSlideTick(object sender, EventArgs args)
        {
            var progress = Math.Min(1d, _slideClock.Elapsed.TotalMilliseconds / SlideDurationMs);
            // 往下滑（收起）用 ease-in：起步慢、收尾快，像"掉下去"；
            // 往上滑（展开）用 ease-out：起步快、收尾轻，不会在最后一帧砸在屏幕上。
            var eased = _slideTo.Y > _slideFrom.Y
                ? progress * progress
                : 1 - (1 - progress) * (1 - progress);
            var x = _slideFrom.X + (int)Math.Round((_slideTo.X - _slideFrom.X) * eased);
            var y = _slideFrom.Y + (int)Math.Round((_slideTo.Y - _slideFrom.Y) * eased);
            Location = new Point(x, y);
            if (progress < 1d) return;
            _slide.Stop();
            _sliding = false;
            // 真机"点了几秒才展开"要靠这行区分：动画真的只跑 180ms，还是被 UI 线程拖长了。
            WriteRuntimeLog("slide done elapsedMs=" + ((long)_slideClock.Elapsed.TotalMilliseconds).ToString(CultureInfo.InvariantCulture)
                + " y=" + y.ToString(CultureInfo.InvariantCulture)
                + " collapsed=" + _collapsed.ToString()
                + " maximized=" + (WindowState == FormWindowState.Maximized).ToString());
            var done = _slideDone;
            _slideDone = null;
            if (done != null) done();
        }

        private async Task FinishShowFromTrayAsync()
        {
            if (_quitting || IsDisposed) return;
            try
            {
                if (_backendReady) await EnsureUiAsync();
                else await EnsureUiShellAsync();
            }
            catch (Exception error)
            {
                if (_quitting || IsDisposed) return;
                WriteRuntimeLog("tray window initialization failed " + error);
                MessageBox.Show(error.Message, "Olivia Soul 窗口打开失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        public async void RequestQuit()
        {
            if (_quitting || IsDisposed) return;
            _quitting = true;
            _lyrics.Dispose();
            HideToTray();
            WriteRuntimeLog("desktop quit requested");
            _tray.Visible = false;
            try
            {
                await _backend.StopAsync();
                WriteRuntimeLog("desktop backend stopped");
            }
            catch (Exception error)
            {
                WriteRuntimeLog("desktop backend stop failed " + error);
            }
            finally
            {
                _shutdownComplete = true;
                try { if (!IsDisposed) Close(); }
                finally { Application.Exit(); }
            }
        }

        private void WriteRuntimeLog(string message)
        {
            Debug.WriteLine(message);
            try
            {
                var path = Path.Combine(_paths.UserData, "runtime.log");
                var previousPath = Path.Combine(_paths.UserData, "runtime.previous.log");
                lock (_runtimeLogLock)
                {
                    Directory.CreateDirectory(_paths.UserData);
                    if (File.Exists(path) && new FileInfo(path).Length > 4 * 1024 * 1024)
                    {
                        if (File.Exists(previousPath)) File.Delete(previousPath);
                        File.Move(path, previousPath);
                    }
                    File.AppendAllText(
                        path,
                        DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture) +
                        " desktop=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) +
                        " " + message + Environment.NewLine,
                        Encoding.UTF8);
                }
            }
            catch (Exception error)
            {
                Debug.WriteLine("runtime log failed: " + error.Message);
            }
        }

        protected override void OnHandleCreated(EventArgs args)
        {
            base.OnHandleCreated(args);
            var enabled = 1;
            var rounded = 2;
            var borderColor = ColorTranslator.ToWin32(Color.FromArgb(61, 65, 72));
            DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int));
            DwmSetWindowAttribute(Handle, 33, ref rounded, sizeof(int));
            DwmSetWindowAttribute(Handle, 34, ref borderColor, sizeof(int));
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ClassStyle |= 0x00020000;
                // A（2026-10-08 真机反馈）：保住 WS_MINIMIZEBOX，任务栏按钮的点击才会变成 SC_MINIMIZE。
                parameters.Style |= WsMinimizeBox;
                return parameters;
            }
        }

        protected override void WndProc(ref Message message)
        {
            // A（工单 §2.3(d)）：任务栏按钮的标准语义 —— 前台窗口点 = SC_MINIMIZE，其余 = SC_RESTORE。
            // 必须在 base.WndProc 之前拦：否则系统先把窗口最小化，无边框窗口会缩成桌面左下角一条小条。
            if (message.Msg == WmSysCommand)
            {
                var command = message.WParam.ToInt64() & 0xFFF0;
                if (command == ScMinimize)
                {
                    // 前台窗口点任务栏按钮 = 想收起；但收起态的窗口仍然是前台窗口，系统这时还会再发一次
                    // SC_MINIMIZE —— 所以这里必须按"切换"处理，不能一律 Collapse()，
                    // 否则用户想展开的那一下会因为"已经收起了"被静默丢掉（真机反馈"点不动收回"）。
                    WriteRuntimeLog("syscommand minimize collapsed=" + _collapsed.ToString() + " sliding=" + _sliding.ToString());
                    ToggleCollapse();
                    return;
                }
                if (command == ScRestore)
                {
                    WriteRuntimeLog("syscommand restore collapsed=" + _collapsed.ToString() + " sliding=" + _sliding.ToString());
                    if (_collapsed)
                    {
                        Expand();
                        return;
                    }
                }
            }

            // A（2026-10-08 第三轮真机反馈）：展开只认"带鼠标点击的激活"。
            // 任务栏按钮点击 → WA_CLICKACTIVE(2)；用户关掉别的窗口、别的程序退出让出前台
            // → 系统把前台交给下一个窗口，是 WA_ACTIVE(1) —— 那一下绝不能把收起的窗口滑回来。
            // 注意：不要用"鼠标左键是否按下"当兜底，用户点别的窗口的关闭按钮时左键同样是按下的，
            // 会把这个 bug 又放回来。
            if (message.Msg == WmActivate)
            {
                var reason = message.WParam.ToInt64() & 0xFFFF;
                WriteRuntimeLog(
                    "wm_activate reason=" + reason.ToString()
                    + " collapsed=" + _collapsed.ToString()
                    + " sliding=" + _sliding.ToString());
                if (_collapsed && reason == WaClickActive)
                {
                    // 推迟到消息处理完再动窗口，别在激活过程里改位置。
                    BeginInvoke((Action)Expand);
                }
            }

            base.WndProc(ref message);
            if (message.Msg != WmNcHitTest || (int)message.Result != 1 || WindowState != FormWindowState.Normal) return;

            var value = message.LParam.ToInt64();
            var point = PointToClient(new Point((short)(value & 0xffff), (short)((value >> 16) & 0xffff)));
            var border = (int)Math.Round(10 * CurrentAutoScaleDimensions.Width / 96f);
            var left = point.X < border;
            var right = point.X >= ClientSize.Width - border;
            var top = point.Y < border;
            var bottom = point.Y >= ClientSize.Height - border;
            if (left && top) message.Result = (IntPtr)HtTopLeft;
            else if (right && top) message.Result = (IntPtr)HtTopRight;
            else if (left && bottom) message.Result = (IntPtr)HtBottomLeft;
            else if (right && bottom) message.Result = (IntPtr)HtBottomRight;
            else if (left) message.Result = (IntPtr)HtLeft;
            else if (right) message.Result = (IntPtr)HtRight;
            else if (top) message.Result = (IntPtr)HtTop;
            else if (bottom) message.Result = (IntPtr)HtBottom;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _slide.Stop();
                _slide.Dispose();
                _lyrics.Dispose();
                _tray.Dispose();
                _webView.Dispose();
                _backend.Dispose();
            }
            base.Dispose(disposing);
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wordParameter, IntPtr longParameter);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);
    }
}
