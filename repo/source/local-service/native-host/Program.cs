using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace OliviaSoul
{
    internal static class Program
    {
        private const string MutexName = "Local\\OliviaSoul.SingleInstance";
        private const string ShowEventName = "Local\\OliviaSoul.Show";
        private const string QuitEventName = "Local\\OliviaSoul.Quit";
        private const string AppUserModelId = "OliviaSoul.Desktop.9";

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    SignalExisting(args.Contains("--quit") ? QuitEventName : ShowEventName);
                    return;
                }

                SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
                // g11 启动计时：从这里开始记（窗口构造前），这样"进程起来→界面可见"能报出完整耗时，
                // 包括 WebView2 运行时装载与 dotnet 启动这些窗体构造之前的部分。
                MainForm.MarkHostStarted();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    var hiddenAtLaunch = args.Contains("--hidden");
                    var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OliviaSoul");
                    var errorFile = Path.Combine(data, "host-error.log");
                    if (File.Exists(errorFile)) File.Delete(errorFile);
                    WebViewRuntime.EnsureInstalled();
                    using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName))
                    using (var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName))
                    using (var form = new MainForm(hiddenAtLaunch))
                    using (var context = new StartupContext(form, !hiddenAtLaunch))
                    {
                        var showRegistration = ThreadPool.RegisterWaitForSingleObject(showEvent, delegate
                        {
                            if (!form.IsDisposed) form.BeginInvoke((Action)form.ShowFromTray);
                        }, null, Timeout.Infinite, false);
                        var quitRegistration = ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate
                        {
                            if (!form.IsDisposed) form.BeginInvoke((Action)form.RequestQuit);
                        }, null, Timeout.Infinite, false);
                        try
                        {
                            Application.Run(context);
                        }
                        finally
                        {
                            showRegistration.Unregister(null);
                            quitRegistration.Unregister(null);
                        }
                    }
                }
                catch (Exception error)
                {
                    var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OliviaSoul");
                    Directory.CreateDirectory(data);
                    File.WriteAllText(Path.Combine(data, "host-error.log"), error.ToString());
                    MessageBox.Show(error.Message, "Olivia Soul 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static void SignalExisting(string eventName)
        {
            try
            {
                using (var signal = EventWaitHandle.OpenExisting(eventName)) signal.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    }
}
