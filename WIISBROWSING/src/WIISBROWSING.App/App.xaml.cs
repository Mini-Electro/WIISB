using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Windows;
using System.Windows.Threading;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App;

public partial class App : Application
{
    private const string PipeName = "WIISBROWSING.Launch.v1";
    private Mutex? _singleInstance;
    private CancellationTokenSource? _pipeCts;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandled;

        var args = Parse(e.Args);

        // One browser process per user (like every browser): a second launch hands its links to the first.
        _singleInstance = new Mutex(true, "WIISBROWSING.SingleInstance." + (args.DataRoot is null ? "main" : Convert.ToHexString(Encoding.UTF8.GetBytes(args.DataRoot))[..16]), out bool first);
        if (!first)
        {
            if (!await TrySendToRunningInstanceAsync(args)) MessageBox.Show("WIISBROWSING is already starting. Please try again in a moment.", "WIISBROWSING");
            Shutdown();
            return;
        }

        if (!WebEnvironments.IsRuntimeInstalled(out var version))
        {
            var r = MessageBox.Show("WIISBROWSING needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\nOpen the download page now?",
                "WIISBROWSING — WebView2 Runtime required", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (r == MessageBoxResult.Yes)
                Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            Shutdown();
            return;
        }

        try
        {
            AppHost.Init(args.DataRoot);
            AppHost.SelfTestDir = args.SelfTest;
            AppHost.WebView2Version = version;
            var profile = args.ProfileId is not null && AppHost.Profiles.Get(args.ProfileId) is { } p ? p : AppHost.Profiles.EnsureDefault();
            AppHost.OpenWindow(profile, args.Private, args.Urls);
            StartPipeServer();
            UpdateService.Start();
        }
        catch (Exception ex)
        {
            AppLog.Error("startup failed", ex);
            MessageBox.Show("WIISBROWSING couldn't open your browser data.\n\n" + ex.Message + "\n\nLogs: " + (AppHost.Paths?.Logs ?? ""), "WIISBROWSING", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        AppLog.Info("app exit: begin");
        _pipeCts?.Cancel();
        UpdateService.Stop();
        UpdateService.InstallOnExitIfStaged();
        try { AppHost.Shutdown(); } catch (Exception ex) { AppLog.Warn("shutdown: " + ex.Message); }
        try { _singleInstance?.ReleaseMutex(); } catch (ApplicationException) { }
        AppLog.Info("app exit: done");
        // Everything is saved and released by now. If the runtime still doesn't finish (a helper thread keeping the
        // process alive), end it so no ghost process is left behind.
        new Thread(() => { Thread.Sleep(3000); Environment.Exit(0); }) { IsBackground = true, Name = "exit-watchdog" }.Start();
        base.OnExit(e);
    }

    private void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        AppLog.Error("unhandled UI exception", e.Exception);
        // A bug in one feature must not take every tab down with it.
        e.Handled = true;
    }

    // ---- command line -----------------------------------------------------------------------------------------------

    private sealed record LaunchArgs(bool Private, string? ProfileId, string? DataRoot, IReadOnlyList<string> Urls, string? SelfTest = null);

    private static LaunchArgs Parse(string[] args)
    {
        bool priv = false; string? profile = null, data = null, selftest = null;
        var urls = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--private" or "--incognito": priv = true; break;
                case "--profile" when i + 1 < args.Length: profile = args[++i]; break;
                case "--data-dir" when i + 1 < args.Length: data = args[++i]; break;
                case "--selftest" when i + 1 < args.Length: selftest = args[++i]; break;
                default:
                    if (!args[i].StartsWith("--")) urls.Add(args[i]);
                    break;
            }
        }
        return new LaunchArgs(priv, profile, data, urls, selftest);
    }

    // ---- single instance pipe -----------------------------------------------------------------------------------------

    private static async Task<bool> TrySendToRunningInstanceAsync(LaunchArgs args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            await client.ConnectAsync(2000);
            using var w = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
            await w.WriteLineAsync(args.Private ? "private" : "normal");
            foreach (var u in args.Urls) await w.WriteLineAsync(u);
            return true;
        }
        catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException) { return false; }
    }

    private void StartPipeServer()
    {
        _pipeCts = new CancellationTokenSource();
        var token = _pipeCts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(token);
                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var mode = await reader.ReadLineAsync(token);
                    var urls = new List<string>();
                    string? line;
                    while ((line = await reader.ReadLineAsync(token)) is not null && urls.Count < 20) urls.Add(line);
                    await Dispatcher.InvokeAsync(() => HandleForwarded(mode == "private", urls));
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException) { await Task.Delay(300, CancellationToken.None); }
            }
        }, token);
    }

    private void HandleForwarded(bool isPrivate, List<string> urls)
    {
        var web = urls.Where(u => UrlClassifier.Classify(u, SearchEngines.Default).Kind is NavKind.Url or NavKind.Internal).ToList();
        var existing = AppHost.Windows.FirstOrDefault(w => w.IsPrivate == isPrivate);
        if (existing is null) { AppHost.OpenWindow(AppHost.Profiles.EnsureDefault(), isPrivate, web); return; }
        existing.BringToFront();
        foreach (var u in web) existing.OpenExternalUrl(u);
        if (web.Count == 0 && isPrivate) AppHost.OpenWindow(AppHost.Profiles.EnsureDefault(), true);
    }
}
