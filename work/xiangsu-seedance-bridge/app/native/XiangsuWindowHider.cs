using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PureamDramaSlot
{
    internal static class XiangsuWindowHider
    {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        private const int SwHide = 0;
        private const int SwRestore = 9;

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 1 || string.IsNullOrWhiteSpace(args[0])) return 2;
            string targetPath = args[0];
            string mode = args.Length >= 3 ? args[2].Trim().ToLowerInvariant() : "hide";
            bool show = mode == "show";
            bool loginOnly = mode == "login";
            bool probeLogin = mode == "probe-login";
            string controlPath = args.Length >= 4 ? args[3] : string.Empty;
            string expectedControlValue = args.Length >= 5 && !string.IsNullOrWhiteSpace(args[4])
                ? args[4]
                : loginOnly ? "login" : show ? "visible" : "hidden";
            DateTime cutoffUtc = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            if (args.Length >= 2)
            {
                DateTime parsed;
                if (DateTime.TryParse(args[1], null, System.Globalization.DateTimeStyles.RoundtripKind, out parsed))
                {
                    cutoffUtc = parsed.ToUniversalTime();
                }
            }

            string targetName = Path.GetFileNameWithoutExtension(targetPath);
            if (probeLogin)
            {
                var probeProcessIds = FindTargetProcessIds(targetName, targetPath, cutoffUtc);
                return FindLoginWindow(probeProcessIds) == IntPtr.Zero ? 3 : 0;
            }
            for (int attempt = 0; attempt < 600; attempt++)
            {
                if (!string.IsNullOrWhiteSpace(controlPath))
                {
                    try
                    {
                        if (File.Exists(controlPath))
                        {
                            string requestedMode = File.ReadAllText(controlPath).Trim();
                            if (!string.Equals(requestedMode, expectedControlValue, StringComparison.Ordinal)) return 0;
                        }
                    }
                    catch { }
                }
                var processIds = FindTargetProcessIds(targetName, targetPath, cutoffUtc);

                if (processIds.Count > 0)
                {
                    IntPtr loginWindow = loginOnly ? FindLoginWindow(processIds) : IntPtr.Zero;
                    EnumWindows(delegate(IntPtr window, IntPtr state)
                    {
                        uint processId;
                        GetWindowThreadProcessId(window, out processId);
                        if (processIds.Contains(processId))
                        {
                            if (loginOnly)
                            {
                                if (loginWindow != IntPtr.Zero && window == loginWindow)
                                {
                                    if (!IsWindowVisible(window)) ShowWindowAsync(window, SwRestore);
                                    SetForegroundWindow(window);
                                }
                                else if (IsWindowVisible(window)) ShowWindowAsync(window, SwHide);
                            }
                            else if (show)
                            {
                                if (!IsWindowVisible(window)) ShowWindowAsync(window, SwRestore);
                                if (!string.IsNullOrEmpty(GetTitle(window))) SetForegroundWindow(window);
                            }
                            else if (IsWindowVisible(window)) ShowWindowAsync(window, SwHide);
                        }
                        return true;
                    }, IntPtr.Zero);
                }
                Thread.Sleep(100);
            }
            return 0;
        }

        private static string GetTitle(IntPtr window)
        {
            var text = new StringBuilder(256);
            GetWindowText(window, text, text.Capacity);
            return text.ToString();
        }

        private static bool IsLoginTitle(string title)
        {
            return string.Equals(title, "\u767b\u5f55", StringComparison.Ordinal)
                || string.Equals(title, "\u6296\u97f3\u767b\u5f55", StringComparison.Ordinal)
                || string.Equals(title, "\u624b\u673a\u53f7\u767b\u5f55", StringComparison.Ordinal);
        }

        private static HashSet<uint> FindTargetProcessIds(string targetName, string targetPath, DateTime cutoffUtc)
        {
            var processIds = new HashSet<uint>();
            foreach (Process process in Process.GetProcessesByName(targetName))
            {
                try
                {
                    if (string.Equals(process.MainModule.FileName, targetPath, StringComparison.OrdinalIgnoreCase)
                        && process.StartTime.ToUniversalTime() >= cutoffUtc)
                    {
                        processIds.Add((uint)process.Id);
                    }
                }
                catch { }
                finally { process.Dispose(); }
            }
            return processIds;
        }

        private static IntPtr FindLoginWindow(HashSet<uint> processIds)
        {
            IntPtr loginWindow = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr state)
            {
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (processIds.Contains(processId) && IsLoginTitle(GetTitle(window)))
                {
                    loginWindow = window;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return loginWindow;
        }
    }
}
