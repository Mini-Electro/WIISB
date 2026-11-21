using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Views;

/// <summary>
/// One browser window. The behaviour is split by area across partial files (tabs, toolbar, panels, commands);
/// everything that isn't about drawing lives in services (<see cref="TabManager"/>, <see cref="DownloadService"/>, Core).
/// </summary>
public partial class MainWindow : Window
{
    private readonly VerticalTabPanel _tabPanel = new();
    private readonly DispatcherTimer _saveTimer = new() { Interval = TimeSpan.FromMilliseconds(1500) };
    private readonly DispatcherTimer _sleepTimer = new() { Interval = TimeSpan.FromSeconds(30) };
    private readonly IReadOnlyList<string> _startUrls;
    private readonly bool _restoreSession;
    private string? _privateFolder;
    private string _envKey = "";
    private bool _closingForReal;
    private bool _initialised;
    private static bool _selfTestStarted;

    public ProfileInfo Profile { get; }
    public bool IsPrivate { get; }
    /// <summary>Only the first normal window of a profile saves and restores the session, so a second window can't overwrite it.</summary>
    public bool OwnsSession { get; }
    public ProfileData Data { get; }
    public TabManager Tabs { get; }
    public DownloadService Downloads { get; }
    public CommandRegistry Commands { get; } = new();
    public ShortcutMap Shortcuts { get; private set; } = new();
    public CoreWebView2Environment? Environment { get; private set; }
    public InternalPages Internal { get; }

    public MainWindow(ProfileInfo profile, bool isPrivate, IReadOnlyList<string>? urls, bool restoreSession)
    {
        Profile = profile;
        IsPrivate = isPrivate;
        OwnsSession = !isPrivate && restoreSession && !AppHost.Windows.Any(w => !w.IsPrivate && w.Profile.Id == profile.Id && w.OwnsSession);
        _startUrls = urls ?? Array.Empty<string>();
        _restoreSession = restoreSession;
        var baseData = AppHost.OpenProfile(profile);
        Data = isPrivate ? ProfileData.OpenPrivate(baseData) : baseData;
        Tabs = new TabManager(isPrivate);
        Downloads = new DownloadService(Data);
        Internal = new InternalPages(() => Data, AppHost.Favicons);

        InitializeComponent();
        if (AppHost.SelfTestDir is not null) ShowActivated = false;   // automated runs must never steal focus
        Title = isPrivate ? "WIISBROWSING — Private" : "WIISBROWSING";
        TabPanelSlotLeft.Content = _tabPanel;
        PrivacyBadge.Visibility = isPrivate ? Visibility.Visible : Visibility.Collapsed;
        ProfileBtn.ToolTip = $"Profile: {profile.Name}";

        WorkspaceList.ItemsSource = Tabs.Workspaces;
        _tabPanel.Rows.ItemsSource = Tabs.Rows;
        _tabPanel.Pinned.ItemsSource = Tabs.Pinned;
        StripList.ItemsSource = Tabs.Strip;
        DownloadsList.ItemsSource = Downloads.Items;

        WireTabPanel();
        WireTabManager();
        RegisterCommands();
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); SaveSessionNow(); };
        _sleepTimer.Tick += (_, _) => SleepIdleTabs();
        Data.Settings.Changed += OnSettingChanged;
        Downloads.Changed += UpdateDownloadsIndicator;
        Downloads.Started += _ => { if (!IsFullscreen) ShowDownloadsPopover(); };
        Downloads.Failed += msg => ShowToast(msg);
        AppHost.Theme.Changed += _ => PushThemeToInternalPages();

        Loaded += async (_, _) => await InitializeBrowserAsync();
        StateChanged += OnWindowStateChanged;
        Closing += OnClosing;
        SourceInitialized += (_, _) => RestoreWindowBounds();
        PreviewKeyDown += OnWindowPreviewKeyDown;
        Activated += (_, _) => { if (Tabs.ActiveTab?.View?.Core is not null) { } };
    }

    // ---- start-up -----------------------------------------------------------------------------------------------------

    private async Task InitializeBrowserAsync()
    {
        if (_initialised) return;
        _initialised = true;
        try
        {
            string folder;
            if (IsPrivate)
            {
                // A private window gets its own throw-away browser data folder: separate cookies, cache and storage.
                _privateFolder = System.IO.Path.Combine(AppHost.Paths.PrivateTemp, Guid.NewGuid().ToString("N"));
                folder = _privateFolder;
                _envKey = "private-" + System.IO.Path.GetFileName(folder);
            }
            else
            {
                folder = AppHost.Profiles.WebDataPath(Profile);
                _envKey = "profile-" + Profile.Id;
            }
            Environment = await AppHost.Envs.GetAsync(_envKey, folder, Data);
        }
        catch (Exception ex)
        {
            AppLog.Error("web environment", ex);
            ShowStatus(new TabError("The browser engine couldn't start", "WIISBROWSING couldn't start the Microsoft Edge WebView2 engine for this profile. Try restarting the browser.", ex.Message, false));
            return;
        }

        ApplyLayout();
        ApplySidebarApps();
        UpdateBookmarkBar();
        ApplyAdBlockSettings();
        _sleepTimer.Start();

        bool restored = false;
        if (OwnsSession && Data.Session is { } session)
        {
            bool crashed = session.PreviousRunCrashed() && session.HasSession();
            string mode = Data.Settings.Get(SettingKeys.StartupMode);
            bool want = _restoreSession && (mode == "restore" || (crashed && Dialogs.Confirm(this, "Restore your previous browsing session?", "WIISBROWSING closed unexpectedly last time. Do you want to reopen the tabs you had?", "Restore", "Start fresh")));
            if (session.HasSession() && _restoreSession)
            {
                var snap = session.Load();
                if (!want)
                    snap = snap with { Tabs = snap.Tabs.Where(t => t.Pinned).ToList(), ActiveTabId = null };
                Tabs.Restore(snap);
                restored = Tabs.AllTabs.Count > 0;
            }
            session.MarkRunning();
        }
        if (!restored) Tabs.InitDefaults();

        bool opened = false;
        foreach (var u in _startUrls)
        {
            var t = UrlClassifier.Classify(u, CurrentSearchEngine());
            if (t.Kind is NavKind.Url or NavKind.Internal) { Tabs.NewTab(t.Url, null, true); opened = true; }
        }
        if (!opened && Tabs.TabsOf(Tabs.ActiveWorkspace.Id).All(t => false) || Tabs.AllTabs.Count == 0)
        {
            string mode = Data.Settings.Get(SettingKeys.StartupMode);
            string home = mode == "blank" ? "about:blank" : mode == "url" && Data.Settings.GetJson<string[]>(SettingKeys.StartupUrls) is { Length: > 0 } urls ? urls[0] : "wiisb://newtab";
            Tabs.NewTab(home);
        }
        else if (Tabs.ActiveTab is null && Tabs.AllTabs.Count > 0) Tabs.Activate(Tabs.TabsOf(Tabs.ActiveWorkspace.Id).FirstOrDefault() ?? Tabs.AllTabs[0]);

        _tabPanel.SetWorkspace(Tabs.ActiveWorkspace.Icon, Tabs.ActiveWorkspace.Name);
        FocusAddressBarIfNewTab();
        AppLog.Info($"window ready: profile={Profile.Name} private={IsPrivate} tabs={Tabs.AllTabs.Count}");
        if (AppHost.SelfTestDir is { } dir && !IsPrivate && !_selfTestStarted) { _selfTestStarted = true; _ = SelfTest.RunAsync(this, dir); }
    }

    public CoreWebView2Environment RequireEnvironment() => Environment ?? throw new InvalidOperationException("Browser engine not ready");

    public SearchEngine CurrentSearchEngine()
    {
        var id = Data.Settings.Get(SettingKeys.SearchEngine);
        if (id == "custom" && SearchEngines.TryValidateTemplate(Data.Settings.Get(SettingKeys.SearchCustom), out _))
            return new SearchEngine("custom", "Custom", Data.Settings.Get(SettingKeys.SearchCustom).Trim());
        return SearchEngines.ById(id);
    }

    // ---- layout (vertical / horizontal / compact / hidden) ---------------------------------------------------------------

    private bool _tabsCompact;
    private bool _chromeHidden;

    private double TabPanelWidth => Math.Clamp(Data.Settings.GetInt(SettingKeys.TabPanelWidth, 236), 160, 420);

    private void ApplyLayout()
    {
        var layout = Data.Settings.Get(SettingKeys.TabLayout);
        _tabsCompact = layout == "compact";
        _tabPanel.SetCompact(_tabsCompact);
        TabPanelSlotLeft.Content = null;
        TabPanelSlotRight.Content = null;
        StripHost.Visibility = Visibility.Collapsed;
        RowStrip.Height = new GridLength(0);

        double left = 0, right = 0;
        switch (layout)
        {
            case "vertical-right": right = TabPanelWidth; TabPanelSlotRight.Content = _tabPanel; break;
            case "horizontal":
                StripHost.Visibility = Visibility.Visible; RowStrip.Height = new GridLength(44); break;
            case "hidden": break;
            case "compact": left = 58; TabPanelSlotLeft.Content = _tabPanel; break;
            default: left = TabPanelWidth; TabPanelSlotLeft.Content = _tabPanel; break;
        }
        if (_chromeHidden) { left = 0; right = 0; }
        ColTabsLeft.Width = new GridLength(left);
        ColSplitLeft.Width = new GridLength(left > 0 && !_tabsCompact ? 5 : 0);
        ColTabsRight.Width = new GridLength(right);
        ColSplitRight.Width = new GridLength(right > 0 ? 5 : 0);
        ColTabsLeft.MinWidth = left > 0 && !_tabsCompact ? 160 : 0;
        ColTabsLeft.MaxWidth = left > 0 && !_tabsCompact ? 420 : double.PositiveInfinity;
        ColTabsRight.MinWidth = right > 0 ? 160 : 0;
        ColTabsRight.MaxWidth = right > 0 ? 420 : double.PositiveInfinity;
        // The toolbar's window controls sit in the toolbar row; in horizontal mode they move to the strip's right edge.
        UpdateWindowControlsPlacement(layout == "horizontal");
    }

    private void TabSplitter_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e)
    {
        double w = Data.Settings.Get(SettingKeys.TabLayout) == "vertical-right" ? ColTabsRight.ActualWidth : ColTabsLeft.ActualWidth;
        if (w >= 160) Data.Settings.SetInt(SettingKeys.TabPanelWidth, (int)Math.Round(w));
    }

    private void OnSettingChanged(string key)
    {
        Dispatcher.BeginInvoke(() =>
        {
            switch (key)
            {
                case SettingKeys.TabLayout or SettingKeys.TabPanelWidth: ApplyLayout(); break;
                case SettingKeys.BookmarkBar: UpdateBookmarkBar(); break;
                case SettingKeys.AdBlockEnabled: ApplyAdBlockSettings(); break;
                case SettingKeys.SidebarApps: ApplySidebarApps(); break;
                case SettingKeys.ReduceMotion: AppHost.Theme.ReduceMotion = Data.Settings.GetBool(SettingKeys.ReduceMotion); AppHost.Theme.Apply(AppHost.Theme.Current, false); break;
                case SettingKeys.TrackingMode: ApplyTrackingLevel(); break;
                case SettingKeys.GamingMode: ApplyGamingMode(); break;
            }
            PushThemeToInternalPages();
        });
    }

    private void ApplyAdBlockSettings() => AppHost.AdBlock.Enabled = Data.Settings.GetBool(SettingKeys.AdBlockEnabled);

    private void ApplyTrackingLevel()
    {
        var level = WebEnvironments.TrackingLevel(Data.Settings.Get(SettingKeys.TrackingMode));
        foreach (var t in Tabs.AllTabs)
            if (t.View?.Core is { } c) { try { c.Profile.PreferredTrackingPreventionLevel = level; } catch (Exception ex) { AppLog.Warn("tracking level: " + ex.Message); } }
    }

    private void ApplyGamingMode()
    {
        // Gaming mode only tunes WIISBROWSING itself: calmer animations and quicker tab sleeping.
        bool on = Data.Settings.GetBool(SettingKeys.GamingMode);
        AppHost.Theme.ReduceMotion = on || Data.Settings.GetBool(SettingKeys.ReduceMotion);
        AppHost.Theme.Apply(AppHost.Theme.Current, false);
    }

    // ---- window chrome ---------------------------------------------------------------------------------------------------

    private void UpdateWindowControlsPlacement(bool horizontal)
    {
        // In horizontal-tab mode the strip row sits above the toolbar; the controls belong in the top-right corner.
        var parent = (Panel?)WindowControls.Parent;
        parent?.Children.Remove(WindowControls);
        if (horizontal)
        {
            StripOverlay.Children.Add(WindowControls);
            WindowControls.HorizontalAlignment = HorizontalAlignment.Right;
        }
        else
        {
            ToolbarGrid.Children.Add(WindowControls);
            Grid.SetColumn(WindowControls, 3);
            WindowControls.HorizontalAlignment = HorizontalAlignment.Left;
        }
    }

    private void DragZone_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is not (Border or Grid or StackPanel or Image)) return;
        if (e.ClickCount == 2) { ToggleMaximize(); return; }
        if (e.ButtonState != MouseButtonState.Pressed) return;
        if (WindowState == WindowState.Maximized)
        {
            // Pull the window off the maximized state keeping the cursor at the same relative spot.
            var p = e.GetPosition(this);
            double ratio = p.X / ActualWidth;
            WindowState = WindowState.Normal;
            var screen = PointToScreen(e.GetPosition(this));
            Left = screen.X - RestoreBounds.Width * ratio;
            Top = Math.Max(0, screen.Y - 20);
        }
        try { DragMove(); } catch (InvalidOperationException) { }
    }

    private void ToggleMaximize() =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Maximize_Click(object sender, RoutedEventArgs e) => ToggleMaximize();
    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        MaxBtn.Content = WindowState == WindowState.Maximized ? "î¤£" : "î¤¢";
        MaxBtn.ToolTip = WindowState == WindowState.Maximized ? "Restore" : "Maximize";
        // A maximized borderless window overhangs the screen by the invisible resize frame; pull it back in.
        Root.Margin = new Thickness(0);
        if (WindowState == WindowState.Maximized && !IsFullscreen)
        {
            var b = SystemParameters.WindowResizeBorderThickness;
            Root.Margin = new Thickness(b.Left, b.Top, b.Right, b.Bottom);
        }
    }

    public void BringToFront()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true; Topmost = false;
    }

    // ---- window bounds (remembers size, position and monitor) -------------------------------------------------------------

    private sealed record Bounds(double Left, double Top, double Width, double Height, bool Maximized);

    private void RestoreWindowBounds()
    {
        if (IsPrivate) return;
        try
        {
            var b = JsonSerializer.Deserialize<Bounds>(AppHost.AppSettings.Get("window.bounds", "null"));
            if (b is null || b.Width < MinWidth || b.Height < MinHeight) return;
            // Only use the saved position if it's still on a connected monitor (monitors get unplugged).
            var vs = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
            var rect = new Rect(b.Left, b.Top, b.Width, b.Height);
            rect.Intersect(vs);
            if (rect.IsEmpty || rect.Width < 200 || rect.Height < 120) return;
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = b.Left; Top = b.Top; Width = Math.Min(b.Width, vs.Width); Height = Math.Min(b.Height, vs.Height);
            if (b.Maximized) WindowState = WindowState.Maximized;
        }
        catch (JsonException) { }
    }

    private void SaveWindowBounds()
    {
        if (IsPrivate || IsFullscreen) return;
        var r = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        AppHost.AppSettings.Set("window.bounds", JsonSerializer.Serialize(new Bounds(r.Left, r.Top, r.Width, r.Height, WindowState == WindowState.Maximized)));
    }

    // ---- fullscreen (F11 and page-requested) ------------------------------------------------------------------------------

    public bool IsFullscreen { get; private set; }
    private bool _htmlFullscreen;
    private WindowState _beforeFullscreen;
    private Rect _boundsBeforeFullscreen;

    public void SetFullscreen(bool on, bool fromPage = false)
    {
        if (on == IsFullscreen) return;
        IsFullscreen = on;
        _htmlFullscreen = on && fromPage;
        if (on)
        {
            _beforeFullscreen = WindowState;
            _boundsBeforeFullscreen = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
            Root.Margin = new Thickness(0);
            WindowState = WindowState.Normal;
            var hwnd = new WindowInteropHelper(this).Handle;
            var mon = Native.MonitorBoundsDip(hwnd, this);
            Left = mon.Left; Top = mon.Top; Width = mon.Width; Height = mon.Height;
            ResizeMode = ResizeMode.NoResize;
        }
        else
        {
            ResizeMode = ResizeMode.CanResize;
            Left = _boundsBeforeFullscreen.Left; Top = _boundsBeforeFullscreen.Top; Width = _boundsBeforeFullscreen.Width; Height = _boundsBeforeFullscreen.Height;
            WindowState = _beforeFullscreen;
        }
        _chromeHidden = on;
        SidebarBorder.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        ColSidebar.Width = new GridLength(on ? 0 : 56);
        ToolbarHost.Visibility = on && fromPage ? Visibility.Collapsed : Visibility.Visible;
        StripHost.Visibility = on ? Visibility.Collapsed : (Data.Settings.Get(SettingKeys.TabLayout) == "horizontal" ? Visibility.Visible : Visibility.Collapsed);
        ApplyLayout();
        OnWindowStateChanged(null, EventArgs.Empty);
    }

    // ---- session ---------------------------------------------------------------------------------------------------------

    private void ScheduleSave()
    {
        if (!OwnsSession) return;
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    private void SaveSessionNow()
    {
        if (!OwnsSession || Data.Session is null || !_initialised || Tabs.ActiveWorkspace is null) return;
        try { Data.Session.Save(Tabs.Snapshot()); }
        catch (Exception ex) { AppLog.Error("saving session", ex); }
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closingForReal) return;
        int others = AppHost.Windows.Count(w => w != this && w.IsPrivate == IsPrivate);
        int active = Downloads.ActiveCount;
        if (AppHost.SelfTestDir is null && active > 0 && AppHost.Windows.Count == 1 &&
            !Dialogs.Confirm(this, "Downloads in progress", $"{active} download{(active == 1 ? " is" : "s are")} still running. Closing the browser will cancel {(active == 1 ? "it" : "them")}.", "Close anyway", "Keep browsing"))
        { e.Cancel = true; return; }
        if (AppHost.SelfTestDir is null && !IsPrivate && Tabs.AllTabs.Count > 6 && Data.Settings.GetBool(SettingKeys.ConfirmCloseMany) && AppHost.Windows.Count == 1 &&
            !Dialogs.Confirm(this, $"Close {Tabs.AllTabs.Count} tabs?", "Your tabs are saved and will come back next time you open WIISBROWSING.", "Close", "Cancel"))
        { e.Cancel = true; return; }

        _closingForReal = true;
        AppLog.Info($"window closing (private={IsPrivate})");
        _saveTimer.Stop(); _sleepTimer.Stop();
        SaveWindowBounds();
        if (OwnsSession)
        {
            SaveSessionNow();
            Data.Session?.MarkCleanShutdown();
        }
        Downloads.CancelAll();
        foreach (var t in Tabs.AllTabs.ToList()) { t.Prompt?.Decide?.Invoke("block"); t.View?.Dispose(); t.View = null; }
        foreach (var p in _panelViews.Values) p.View.Dispose();
        _panelViews.Clear();
        if (IsPrivate)
        {
            Data.Dispose();
            AppHost.Envs.Forget(_envKey);
            var folder = _privateFolder;
            // The engine releases its files a moment after the last view closes; remove the throw-away folder then.
            if (folder is not null) _ = Task.Run(async () =>
            {
                for (int i = 0; i < 10; i++)
                {
                    await Task.Delay(1500);
                    try { if (System.IO.Directory.Exists(folder)) System.IO.Directory.Delete(folder, true); return; }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                }
            });
        }
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------

    private void ShowToast(string message)
    {
        ToastText.Text = message;
        ToastPopup.VerticalOffset = WebArea.ActualHeight / 2 - 80;
        ToastPopup.IsOpen = true;
        var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        t.Tick += (_, _) => { t.Stop(); ToastPopup.IsOpen = false; };
        t.Start();
    }

    private void OpenSettings_Click(object sender, RoutedEventArgs e) => OpenInternal("settings");

    public void OpenInternal(string page, bool newTab = true)
    {
        var url = "wiisb://" + page;
        var existing = Tabs.AllTabs.FirstOrDefault(t => t.Url.StartsWith(url, StringComparison.OrdinalIgnoreCase));
        if (existing is not null) { Tabs.Activate(existing); return; }
        if (newTab) Tabs.NewTab(url, Tabs.ActiveTab); else NavigateActive(url);
    }

    public void OpenExternalUrl(string url)
    {
        var target = UrlClassifier.Classify(url, CurrentSearchEngine());
        if (target.Kind is NavKind.Url or NavKind.Internal) Tabs.NewTab(target.Url, null, true);
    }

    private static class Native
    {
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }

        public static Rect MonitorBoundsDip(IntPtr hwnd, Visual visual)
        {
            var mon = MonitorFromWindow(hwnd, 2);
            var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
            GetMonitorInfo(mon, ref info);
            var src = PresentationSource.FromVisual(visual);
            var m = src?.CompositionTarget?.TransformFromDevice ?? System.Windows.Media.Matrix.Identity;
            var tl = m.Transform(new Point(info.Monitor.Left, info.Monitor.Top));
            var br = m.Transform(new Point(info.Monitor.Right, info.Monitor.Bottom));
            return new Rect(tl, br);
        }
    }
}

