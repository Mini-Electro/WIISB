using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Privacy;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Browser;

/// <summary>What a tab needs from the window that hosts it. Keeps engine code separate from window code.</summary>
public interface IBrowserHost
{
    ProfileData Data { get; }
    AdBlockEngine AdBlock { get; }
    FaviconCache Favicons { get; }
    InternalPages Internal { get; }
    CoreWebView2Environment? Environment { get; }
    Task<CoreWebView2?> CreatePopupAsync(BrowserTab opener, string uri, bool background);
    void OpenUrlInNewTab(string url, bool background, BrowserTab? opener);
    void OnDownloadStarting(BrowserTab tab, CoreWebView2DownloadStartingEventArgs e);
    void OnPermissionRequested(BrowserTab tab, CoreWebView2PermissionRequestedEventArgs e);
    void OnExternalScheme(BrowserTab tab, CoreWebView2LaunchingExternalUriSchemeEventArgs e);
    void OnFullscreenChanged(BrowserTab tab, bool fullscreen);
    void OnContextMenu(BrowserTab tab, CoreWebView2ContextMenuRequestedEventArgs e);
    void OnInternalMessage(BrowserTab tab, string json);
    void OnTabStateChanged(BrowserTab tab, bool persist);
    void OnPageCommitted(BrowserTab tab);
    void OnCrashed(BrowserTab tab, CoreWebView2ProcessFailedEventArgs e);
    bool TryHandleKey(KeyChord chord);
    void OnFindResult(BrowserTab tab, int active, int total);
    void OnStatusText(BrowserTab tab, string text);
}

/// <summary>
/// Owns one tab's WebView2 and translates its events into <see cref="BrowserTab"/> state. Each tab has its own
/// instance, so URL, history, scroll position, zoom and loading state are never shared between tabs.
/// </summary>
public sealed class TabWebView : IDisposable
{
    private readonly BrowserTab _tab;
    private readonly IBrowserHost _host;
    private CoreWebView2Environment? _env;
    private bool _disposed;
    private string _lastCommittedUrl = "";
    private ulong _currentNavigation;

    public WebView2 Control { get; }
    public CoreWebView2? Core => _disposed ? null : Control.CoreWebView2;
    public bool IsReady => Core is not null;
    public bool HasAcceleratorHook { get; private set; }

    /// <summary>
    /// The engine accepts drops from other programs (files onto an upload box…). While one of our own tabs is being
    /// dragged that would swallow the drop, so the tab never became a window; the drag switches it off and back on.
    /// </summary>
    public void SetExternalDrop(bool on) { try { Control.AllowExternalDrop = on; } catch (InvalidOperationException) { } }

    public TabWebView(BrowserTab tab, IBrowserHost host)
    {
        _tab = tab;
        _host = host;
        Control = new WebView2
        {
            Visibility = Visibility.Collapsed,
            DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 9, 10, 15),
            AllowExternalDrop = true,
        };
    }

    public async Task InitializeAsync(CoreWebView2Environment env)
    {
        _env = env;
        // Private tabs also ask the engine for its own private mode (in-memory storage) on top of the throw-away folder.
        CoreWebView2ControllerOptions? options = null;
        if (_tab.IsPrivate) { options = env.CreateCoreWebView2ControllerOptions(); options.IsInPrivateModeEnabled = true; }
        await Control.EnsureCoreWebView2Async(env, options);
        if (_disposed) return;
        ConfigureCore(Control.CoreWebView2);
    }

    /// <summary>Used for popups created by <c>window.open</c>: the engine already made the CoreWebView2.</summary>
    public async Task InitializeForPopupAsync(CoreWebView2Environment env)
    {
        _env = env;
        CoreWebView2ControllerOptions? options = null;
        if (_tab.IsPrivate) { options = env.CreateCoreWebView2ControllerOptions(); options.IsInPrivateModeEnabled = true; }
        await Control.EnsureCoreWebView2Async(env, options);
        if (_disposed) return;
        ConfigureCore(Control.CoreWebView2);
    }

    private void ConfigureCore(CoreWebView2 core)
    {
        var s = core.Settings;
        s.IsStatusBarEnabled = false;
        s.AreDevToolsEnabled = true;
        s.IsZoomControlEnabled = true;
        s.IsPasswordAutosaveEnabled = true;
        s.IsGeneralAutofillEnabled = true;
        s.IsReputationCheckingRequired = true;   // SmartScreen stays on
        s.IsWebMessageEnabled = true;
        s.AreHostObjectsAllowed = false;          // pages never get native objects
        s.AreBrowserAcceleratorKeysEnabled = true;
        s.IsSwipeNavigationEnabled = false;
        s.AreDefaultContextMenusEnabled = true;

        try { core.Profile.PreferredTrackingPreventionLevel = WebEnvironments.TrackingLevel(_host.Data.Settings.Get(SettingKeys.TrackingMode)); }
        catch (Exception ex) { AppLog.Warn("tracking level: " + ex.Message); }

        core.SourceChanged += (_, _) => OnSourceChanged(core);
        core.NavigationStarting += (_, e) => OnNavigationStarting(e);
        core.NavigationCompleted += (_, e) => OnNavigationCompleted(core, e);
        core.DocumentTitleChanged += (_, _) => { _tab.Title = core.DocumentTitle; _host.OnTabStateChanged(_tab, true); };
        core.HistoryChanged += (_, _) => { _tab.CanGoBack = core.CanGoBack; _tab.CanGoForward = core.CanGoForward; };
        core.FaviconChanged += async (_, _) => await UpdateFaviconAsync(core);
        core.IsDocumentPlayingAudioChanged += (_, _) => _tab.IsAudible = core.IsDocumentPlayingAudio;
        core.IsMutedChanged += (_, _) => _tab.IsMuted = core.IsMuted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DownloadStarting += (_, e) => _host.OnDownloadStarting(_tab, e);
        core.PermissionRequested += (_, e) => _host.OnPermissionRequested(_tab, e);
        core.LaunchingExternalUriScheme += (_, e) => _host.OnExternalScheme(_tab, e);
        core.ContainsFullScreenElementChanged += (_, _) => _host.OnFullscreenChanged(_tab, core.ContainsFullScreenElement);
        core.ContextMenuRequested += (_, e) => _host.OnContextMenu(_tab, e);
        core.ProcessFailed += (_, e) => OnProcessFailed(e);
        core.WebMessageReceived += OnWebMessage;
        core.StatusBarTextChanged += (_, _) => _host.OnStatusText(_tab, core.StatusBarText);
        Control.ZoomFactorChanged += (_, _) => _tab.Zoom = Control.ZoomFactor;

        // Requests: ad blocking for the web, resource serving for wiisb://.
        core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
        core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All);
        core.AddWebResourceRequestedFilter("wiisb://*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;

        if (core.Find is { } find)
        {
            find.MatchCountChanged += (_, _) => _host.OnFindResult(_tab, find.ActiveMatchIndex, find.MatchCount);
            find.ActiveMatchIndexChanged += (_, _) => _host.OnFindResult(_tab, find.ActiveMatchIndex, find.MatchCount);
        }

        HookAccelerators();
        _tab.Lifecycle = TabLifecycle.Background;
    }

    // ---- keyboard accelerators: shortcuts must work while the page has focus -------------------------------

    private void HookAccelerators()
    {
        // The WPF control hides its CoreWebView2Controller inside a helper (m_webview2Base). Read it so shortcuts
        // (Ctrl+T, Ctrl+L…) also work while the web page owns the keyboard focus.
        var controller = FindController(Control, 0);
        if (controller is not null) { controller.AcceleratorKeyPressed += OnAccelerator; HasAcceleratorHook = true; }
        else AppLog.Warn("could not reach the WebView2 controller; shortcuts only work while the browser UI has focus");
    }

    private static CoreWebView2Controller? FindController(object owner, int depth)
    {
        if (depth > 2) return null;
        for (Type? t = owner.GetType(); t is not null && t != typeof(object); t = t.BaseType)
        {
            foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly))
            {
                if (f.FieldType == typeof(CoreWebView2Controller)) { if (f.GetValue(owner) is CoreWebView2Controller c) return c; }
                else if (f.FieldType.Name.Contains("WebView2Base") && f.GetValue(owner) is { } inner)
                {
                    var found = FindController(inner, depth + 1);
                    if (found is not null) return found;
                }
            }
        }
        return null;
    }

    private void OnAccelerator(object? sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
    {
        if (e.KeyEventKind is not (CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown)) return;
        var key = KeyInterop.KeyFromVirtualKey((int)e.VirtualKey);
        var keyName = key.ToString();
        if (keyName is "LeftCtrl" or "RightCtrl" or "LeftShift" or "RightShift" or "LeftAlt" or "RightAlt" or "System" or "None") return;
        var mods = Keyboard.Modifiers;
        var chord = new KeyChord(
            mods.HasFlag(ModifierKeys.Control),
            mods.HasFlag(ModifierKeys.Shift),
            mods.HasFlag(ModifierKeys.Alt),
            keyName);
        if (_host.TryHandleKey(chord)) e.Handled = true;
    }

    // ---- navigation ----------------------------------------------------------------------------------------

    private void OnSourceChanged(CoreWebView2 core)
    {
        var src = core.Source;
        if (UrlClassifier.IsInternal(src)) src = src.TrimEnd('/');
        _tab.Url = src;
        _tab.Security = SecurityOf(src);
        _host.OnTabStateChanged(_tab, true);
    }

    public static SecurityState SecurityOf(string url)
    {
        if (UrlClassifier.IsInternal(url) || url.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return SecurityState.Internal;
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return SecurityState.Secure;
        if (url.StartsWith("file:", StringComparison.OrdinalIgnoreCase) || UrlClassifier.IsLocalAddress(url)) return SecurityState.Local;
        return SecurityState.Insecure;
    }

    private void OnNavigationStarting(CoreWebView2NavigationStartingEventArgs e)
    {
        _currentNavigation = e.NavigationId;
        _tab.IsLoading = true;
        _tab.Error = null;
        _tab.BlockedCount = e.IsRedirected ? _tab.BlockedCount : (e.IsUserInitiated || _tab.Url != e.Uri ? 0 : _tab.BlockedCount);
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && u.Scheme is "javascript" or "vbscript")
            e.Cancel = true;
    }

    private void OnNavigationCompleted(CoreWebView2 core, CoreWebView2NavigationCompletedEventArgs e)
    {
        // A navigation that was replaced by a newer one (a redirect, or the user clicking something else) reports
        // "aborted". That isn't a failure of the page now being shown, so it must not put up an error page.
        if (!e.IsSuccess && e.NavigationId != _currentNavigation) return;
        _tab.IsLoading = false;
        if (e.IsSuccess) _tab.Error = null;
        _tab.CanGoBack = core.CanGoBack;
        _tab.CanGoForward = core.CanGoForward;
        _tab.Title = core.DocumentTitle;
        if (e.IsSuccess && _tab.SavedScrollY > 1)
        {
            var y = _tab.SavedScrollY;
            _tab.SavedScrollY = 0;
            _ = core.ExecuteScriptAsync($"window.scrollTo(0,{y.ToString(System.Globalization.CultureInfo.InvariantCulture)})");
        }
        if (e.IsSuccess)
        {
            _tab.Security = SecurityOf(core.Source);
            if (_lastCommittedUrl != core.Source)
            {
                _lastCommittedUrl = core.Source;
                _host.OnPageCommitted(_tab);
            }
        }
        else
        {
            var err = DescribeError(e.WebErrorStatus, core.Source);
            if (err is not null) { _tab.Error = err; _tab.Security = SecurityState.Error; }
        }
        _host.OnTabStateChanged(_tab, true);
    }

    /// <summary>Friendly error pages. Certificate problems are left to the engine's own warning page, which lets the user decide.</summary>
    public static TabError? DescribeError(CoreWebView2WebErrorStatus status, string url)
    {
        string host = UrlClassifier.HostOf(url);
        string Dev(string code) => $"{code}\n{url}";
        bool offline = !System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable();
        return status switch
        {
            CoreWebView2WebErrorStatus.OperationCanceled or CoreWebView2WebErrorStatus.Unknown => null,
            CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect or CoreWebView2WebErrorStatus.CertificateExpired
                or CoreWebView2WebErrorStatus.ClientCertificateContainsErrors or CoreWebView2WebErrorStatus.CertificateRevoked
                or CoreWebView2WebErrorStatus.CertificateIsInvalid => null,
            CoreWebView2WebErrorStatus.HostNameNotResolved when offline => new TabError("No internet connection", "Your computer isn't connected to a network. Check your Wi-Fi or cable and try again.", Dev("ERR_INTERNET_DISCONNECTED")),
            CoreWebView2WebErrorStatus.HostNameNotResolved => new TabError("We can't find that website", $"The address {host} couldn't be found. Check it for typing mistakes, or try again later.", Dev("ERR_NAME_NOT_RESOLVED")),
            CoreWebView2WebErrorStatus.CannotConnect or CoreWebView2WebErrorStatus.ServerUnreachable =>
                new TabError(UrlClassifier.IsLocalAddress(url) ? "Nothing is listening there" : "The website is unavailable", UrlClassifier.IsLocalAddress(url) ? $"Nothing answered at {host}. Make sure your local server is running on that port." : $"{host} refused the connection or can't be reached right now.", Dev("ERR_CONNECTION_REFUSED")),
            CoreWebView2WebErrorStatus.Timeout => new TabError("The website took too long", $"{host} didn't answer in time.", Dev("ERR_TIMED_OUT")),
            CoreWebView2WebErrorStatus.ConnectionAborted or CoreWebView2WebErrorStatus.ConnectionReset or CoreWebView2WebErrorStatus.Disconnected =>
                new TabError("The connection was interrupted", $"The connection to {host} was lost while loading the page.", Dev("ERR_CONNECTION_RESET")),
            CoreWebView2WebErrorStatus.RedirectFailed => new TabError("Too many redirects", $"{host} keeps sending the browser in circles.", Dev("ERR_TOO_MANY_REDIRECTS")),
            CoreWebView2WebErrorStatus.ErrorHttpInvalidServerResponse => new TabError("Unexpected response", $"{host} sent a response the browser couldn't understand.", Dev("ERR_INVALID_RESPONSE")),
            _ => new TabError("This page can't be displayed", "Something stopped the page from loading.", Dev(status.ToString())),
        };
    }

    private async Task UpdateFaviconAsync(CoreWebView2 core)
    {
        try
        {
            using var stream = await core.GetFaviconAsync(CoreWebView2FaviconImageFormat.Png);
            if (stream is null || _disposed) return;
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
            var img = _host.Favicons.Store(_tab.Host, ms.ToArray(), persist: !_tab.IsPrivate);
            if (img is not null) _tab.Favicon = img;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            // Icon fetch can fail when the tab is closing; the fallback icon is shown instead.
        }
    }

    // ---- popups & links -------------------------------------------------------------------------------------

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        bool background = false;
        try { background = e.WindowFeatures.HasPosition is false && e.IsUserInitiated && Keyboard.Modifiers.HasFlag(ModifierKeys.Control); }
        catch (Exception) { }

        // window.open with an opener (OAuth sign-in, payment popups…): give the page a real linked tab.
        var deferral = e.GetDeferral();
        _ = HandlePopupAsync(e, deferral, background);
    }

    private async Task HandlePopupAsync(CoreWebView2NewWindowRequestedEventArgs e, CoreWebView2Deferral deferral, bool background)
    {
        try
        {
            var popupCore = await _host.CreatePopupAsync(_tab, e.Uri, background);
            if (popupCore is not null) { e.NewWindow = popupCore; e.Handled = true; }
            else { e.Handled = true; _host.OpenUrlInNewTab(e.Uri, background, _tab); }
        }
        catch (Exception ex)
        {
            AppLog.Error("popup failed", ex);
            e.Handled = true;
            _host.OpenUrlInNewTab(e.Uri, background, _tab);
        }
        finally { deferral.Complete(); }
    }

    // ---- requests ---------------------------------------------------------------------------------------------

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = e.Request.Uri;
        if (uri.StartsWith("wiisb://", StringComparison.OrdinalIgnoreCase))
        {
            if (_env is not null) _host.Internal.Serve(_env, e, _tab);
            return;
        }
        if (e.ResourceContext == CoreWebView2WebResourceContext.Document) return; // never block the page the user asked for
        var decision = _host.AdBlock.Evaluate(uri, _tab.Url);
        if (!decision.Block) return;
        e.Response = _env!.CreateWebResourceResponse(null, 403, "Blocked", "X-Blocked-By: WIISBROWSING");
        _tab.BlockedCount++;
        _host.AdBlock.Counters.Add(UrlClassifier.HostOf(uri), decision.Rule);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only our own pages may talk to the browser. A website can call postMessage, but it is ignored here.
        if (!UrlClassifier.IsInternal(e.Source)) return;
        try { _host.OnInternalMessage(_tab, e.WebMessageAsJson); }
        catch (Exception ex) { AppLog.Error("internal message failed", ex); }
    }

    private void OnProcessFailed(CoreWebView2ProcessFailedEventArgs e)
    {
        if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive or CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            _tab.IsLoading = false;
            _tab.Lifecycle = TabLifecycle.Crashed;
            _host.OnCrashed(_tab, e);
        }
    }

    // ---- actions ------------------------------------------------------------------------------------------------

    public void Navigate(string url)
    {
        if (Core is null) return;
        try { Core.Navigate(url); }
        catch (ArgumentException ex) { AppLog.Warn("navigate rejected: " + ex.Message); }
    }

    public void Reload() => Core?.Reload();
    public void Stop() => Core?.Stop();
    public void GoBack() { if (Core?.CanGoBack == true) Core.GoBack(); }
    public void GoForward() { if (Core?.CanGoForward == true) Core.GoForward(); }
    public void SetMuted(bool muted) { if (Core is not null) Core.IsMuted = muted; }
    public Task<string?> RunScriptAsync(string js) => Core is null ? Task.FromResult<string?>(null) : Core.ExecuteScriptAsync(js)!;

    public void PostJson(string json) { try { Core?.PostWebMessageAsJson(json); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { } }

    public async Task<byte[]?> CapturePngAsync()
    {
        if (Core is null || Control.Visibility != Visibility.Visible) return null;   // a hidden page can't be captured
        using var ms = new MemoryStream();
        var capture = Core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
        if (await Task.WhenAny(capture, Task.Delay(2500)) != capture) return null;
        await capture;
        return ms.ToArray();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { Control.Dispose(); } catch (Exception ex) { AppLog.Warn("dispose webview: " + ex.Message); }
    }
}
