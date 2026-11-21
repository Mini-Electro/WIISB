using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Browser;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Privacy;
using WIISBROWSING.Core.Tabs;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Views;

public partial class MainWindow : IBrowserHost
{
    public AdBlockEngine AdBlock => AppHost.AdBlock;
    public FaviconCache Favicons => AppHost.Favicons;
    CoreWebView2Environment? IBrowserHost.Environment => Environment;
    private BrowserTab? _watched;
    private Point _dragStart;
    private bool _dragging;

    // ---- wiring ---------------------------------------------------------------------------------------------------------

    private void WireTabPanel()
    {
        _tabPanel.NewTabRequested += () => NewTabAndFocus();
        _tabPanel.SearchRequested += () => ShowTabSearch();
        _tabPanel.ClusterMenuRequested += () => ShowClusterMenu(_tabPanel);
        _tabPanel.CollapseRequested += () => ToggleCompactTabs();
        _tabPanel.Rows.Drop += (_, e) => DropOnEmptyList(e);
        _tabPanel.Rows.DragOver += (_, e) => { e.Effects = e.Data.GetDataPresent("wiisb.tab") ? DragDropEffects.Move : DragDropEffects.None; e.Handled = true; };
        _tabPanel.Rows.MouseRightButtonUp += (_, e) => { if (e.OriginalSource is ScrollViewer or Border or ItemsPresenter or VirtualizingStackPanel) ShowListMenu(); };
    }

    private void WireTabManager()
    {
        Tabs.ActiveTabChanged += tab => _ = OnActiveTabChangedAsync(tab);
        Tabs.TabAdded += OnTabAdded;
        Tabs.TabRemoved += OnTabRemoved;
        Tabs.Changed += () => { ScheduleSave(); };
        Tabs.LayoutChanged += () => _tabPanel.SetWorkspace(Tabs.ActiveWorkspace?.Icon ?? "", Tabs.ActiveWorkspace?.Name ?? "");
        Tabs.LastTabClosed += () => Dispatcher.BeginInvoke(Close);
    }

    private void OnTabAdded(BrowserTab tab)
    {
        tab.PropertyChanged += OnAnyTabPropertyChanged;
        if (tab.Favicon is null && !string.IsNullOrEmpty(tab.Host) && Favicons.Get(tab.Host) is { } f) tab.Favicon = f;
    }

    private void OnTabRemoved(BrowserTab tab)
    {
        tab.PropertyChanged -= OnAnyTabPropertyChanged;
        tab.Prompt?.Decide?.Invoke("block");
        DisposeView(tab);
        if (_watched == tab) _watched = null;
    }

    private void DisposeView(BrowserTab tab)
    {
        if (tab.View is null) return;
        var v = tab.View;
        tab.View = null;
        WebHost.Children.Remove(v.Control);
        v.Dispose();
    }

    private void OnAnyTabPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (sender != Tabs.ActiveTab) return;
        switch (e.PropertyName)
        {
            case nameof(BrowserTab.HasError) or nameof(BrowserTab.IsCrashed): ShowActiveView(); UpdateStatusPanel(); UpdateToolbar(); break;
            case nameof(BrowserTab.HasPrompt): UpdatePromptBar(); break;
            case nameof(BrowserTab.Zoom): UpdateZoomButton(); break;
            case nameof(BrowserTab.BlockedCount): UpdateShieldCount(); break;
            default: UpdateToolbar(); break;
        }
    }

    // ---- activation & views ---------------------------------------------------------------------------------------------

    private async Task OnActiveTabChangedAsync(BrowserTab? tab)
    {
        if (tab is null) return;
        var previous = _watched;
        _watched = tab;
        if (Data.Settings.GetBool(SettingKeys.GamingMode) is false) { }
        HideTransientUi();
        UpdateToolbar();
        UpdateStatusPanel();
        UpdatePromptBar();
        UpdateBookmarkBar();
        ShowActiveView();
        try
        {
            await EnsureViewAsync(tab);
        }
        catch (Exception ex)
        {
            AppLog.Error("creating tab view", ex);
            tab.Error = new TabError("This tab couldn't start", "The browser engine couldn't create this tab.", ex.Message);
        }
        if (Tabs.ActiveTab != tab) return;
        ShowActiveView();
        FocusActivePage(tab);
    }

    private void FocusActivePage(BrowserTab tab)
    {
        bool blank = string.IsNullOrEmpty(tab.Url) || tab.Url == "wiisb://newtab" || tab.Url == "about:blank";
        if (blank) { FocusAddressBar(selectAll: false); return; }
        if (tab.View?.Control is { IsVisible: true } c) { c.Focus(); }
    }

    private void FocusAddressBarIfNewTab()
    {
        if (Tabs.ActiveTab is { } t && (t.Url == "wiisb://newtab" || string.IsNullOrEmpty(t.Url))) FocusAddressBar(false);
    }

    public async Task EnsureViewAsync(BrowserTab tab)
    {
        if (tab.View is not null || Environment is null) return;
        tab.Lifecycle = TabLifecycle.Restoring;
        var view = new TabWebView(tab, this);
        tab.View = view;
        WebHost.Children.Add(view.Control);
        try
        {
            await view.InitializeAsync(Environment);
        }
        catch
        {
            if (tab.View == view) { tab.View = null; WebHost.Children.Remove(view.Control); view.Dispose(); }
            throw;
        }
        if (tab.View != view) return; // the tab was closed while the engine was starting
        tab.Lifecycle = TabLifecycle.Background;
        var url = string.IsNullOrWhiteSpace(tab.Url) ? "wiisb://newtab" : tab.Url;
        if (UrlClassifier.IsInternal(url)) url = url.TrimEnd('/') + "/";
        view.Navigate(url);
        if (tab.IsMuted) view.SetMuted(true);
        ApplyTrackingLevel();
    }

    private void ShowActiveView()
    {
        var active = Tabs.ActiveTab;
        bool hideForStatus = active is not null && (active.HasError || active.IsCrashed);
        foreach (var t in Tabs.AllTabs)
        {
            if (t.View is null) continue;
            t.View.Control.Visibility = t == active && !hideForStatus ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    private void UpdateStatusPanel()
    {
        var t = Tabs.ActiveTab;
        if (t is null || (!t.HasError && !t.IsCrashed)) { StatusPanel.Visibility = Visibility.Collapsed; return; }
        if (t.IsCrashed)
        {
            ShowStatus(new TabError("This tab stopped responding", "The page crashed or ran out of memory. Your other tabs aren't affected.", "RENDER_PROCESS_EXITED", true));
            return;
        }
        ShowStatus(t.Error!);
    }

    private void ShowStatus(TabError err)
    {
        StatusTitle.Text = err.Title;
        StatusMessage.Text = err.Message;
        StatusDetails.Text = err.Details;
        StatusPrimary.Visibility = err.Retryable ? Visibility.Visible : Visibility.Collapsed;
        StatusPanel.Visibility = Visibility.Visible;
    }

    private void StatusRetry_Click(object sender, RoutedEventArgs e)
    {
        var t = Tabs.ActiveTab;
        if (t is null) return;
        t.Error = null;
        if (t.IsCrashed)
        {
            // Rebuild the page's view from scratch; the rest of the browser keeps running.
            DisposeView(t);
            t.Lifecycle = TabLifecycle.Background;
            _ = OnActiveTabChangedAsync(t);
            return;
        }
        ShowActiveView();
        StatusPanel.Visibility = Visibility.Collapsed;
        t.View?.Reload();
    }

    private void HideTransientUi()
    {
        SuggestPopup.IsOpen = false;
        if (FindBar.Visibility == Visibility.Visible && Tabs.ActiveTab?.View is null) CloseFind();
    }

    // ---- tab operations ------------------------------------------------------------------------------------------------------

    public BrowserTab NewTabAndFocus(string url = "wiisb://newtab")
    {
        var tab = Tabs.NewTab(url, null, true);
        if (url == "wiisb://newtab") FocusAddressBar(false);
        return tab;
    }

    private void NewTab_Click(object sender, RoutedEventArgs e) => NewTabAndFocus();

    private void CloseTab_Click(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BrowserTab tab }) Tabs.Close(tab);
        e.Handled = true;
    }

    public void NavigateActive(string url)
    {
        var tab = Tabs.ActiveTab;
        if (tab is null) return;
        tab.Error = null;
        if (UrlClassifier.IsInternal(url)) url = url.TrimEnd('/') + "/";
        if (tab.View is null || !tab.View.IsReady) { tab.Url = url; _ = EnsureViewAsync(tab); return; }
        tab.View.Navigate(url);
    }

    public void OpenUrlInNewTab(string url, bool background, BrowserTab? opener)
    {
        var t = UrlClassifier.Classify(url, CurrentSearchEngine());
        if (t.Kind is not (NavKind.Url or NavKind.Internal)) return;
        Tabs.NewTab(t.Url, opener, activate: !background);
        if (background) _ = Dispatcher.BeginInvoke(() => { var n = Tabs.AllTabs.LastOrDefault(); }); // background tabs stay asleep until first used
    }

    public async Task<CoreWebView2?> CreatePopupAsync(BrowserTab opener, string uri, bool background)
    {
        if (Environment is null) return null;
        var tab = Tabs.NewTab(uri, opener, activate: !background);
        var view = new TabWebView(tab, this);
        tab.View = view;
        WebHost.Children.Add(view.Control);
        await view.InitializeForPopupAsync(Environment);
        if (tab.View != view) return null;
        tab.Lifecycle = TabLifecycle.Background;
        ShowActiveView();
        return view.Core;
    }

    public void TogglePin(BrowserTab tab) => Tabs.SetPinned(tab, !tab.IsPinned);

    public void ToggleMute(BrowserTab tab)
    {
        tab.IsMuted = !tab.IsMuted;
        tab.View?.SetMuted(tab.IsMuted);
        Tabs.RebuildRows();
    }

    /// <param name="dropAt">Where the tab was let go (screen pixels): the new window opens there, the size of this one.</param>
    public async Task<bool> MoveTabToNewWindowAsync(BrowserTab tab, Point? dropAt = null)
    {
        var url = tab.Url;
        if (string.IsNullOrEmpty(url)) return false;
        var window = AppHost.OpenWindow(Profile, IsPrivate, new[] { url }, restoreSession: false);
        if (dropAt is { } px) PlaceNewWindow(window, px);
        await Task.Yield();
        Tabs.Close(tab, remember: false);
        return true;
    }

    /// <summary>Gives <paramref name="window"/> this window's size and puts its tab area under the pointer.</summary>
    private void PlaceNewWindow(Window window, Point screenPixels)
    {
        var toDip = PresentationSource.FromVisual(this)?.CompositionTarget?.TransformFromDevice;
        var at = toDip?.Transform(screenPixels) ?? screenPixels;
        var size = WindowState == WindowState.Normal ? new Size(ActualWidth, ActualHeight) : RestoreBounds.Size;
        var screen = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
        window.WindowState = WindowState.Normal;
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Width = Math.Min(Math.Max(size.Width, window.MinWidth), screen.Width);
        window.Height = Math.Min(Math.Max(size.Height, window.MinHeight), screen.Height);
        // Keep the grabbed spot near the top-left, like the tab is still in hand, and never leave the screen.
        window.Left = Math.Clamp(at.X - 90, screen.Left, Math.Max(screen.Left, screen.Right - window.Width));
        window.Top = Math.Clamp(at.Y - 24, screen.Top, Math.Max(screen.Top, screen.Bottom - 120));
    }

    private void ToggleCompactTabs()
    {
        var layout = Data.Settings.Get(SettingKeys.TabLayout);
        Data.Settings.Set(SettingKeys.TabLayout, layout == "compact" ? "vertical-left" : "compact");
    }

    private void CloseOthers(BrowserTab keep) =>
        Tabs.CloseMany(Tabs.TabsOf(keep.WorkspaceId).Where(t => t != keep && !t.IsPinned));

    private void CloseBelow(BrowserTab from)
    {
        var list = Tabs.TabsOf(from.WorkspaceId).ToList();
        Tabs.CloseMany(list.Skip(list.IndexOf(from) + 1).Where(t => !t.IsPinned));
    }

    private void CloseDuplicates()
    {
        int closed = 0;
        foreach (var group in DuplicateDetector.FindGroups(Tabs.DuplicateInput()))
        {
            var keep = group.Contains(Tabs.ActiveTab?.Id ?? "") ? Tabs.ActiveTab!.Id : group[0];
            foreach (var id in group.Where(id => id != keep)) { if (Tabs.Find(id) is { } t) { Tabs.Close(t); closed++; } }
        }
        ShowToast(closed == 0 ? "No duplicate tabs found." : $"Closed {closed} duplicate tab{(closed == 1 ? "" : "s")}.");
    }

    // ---- previews & sleeping --------------------------------------------------------------------------------------------------

    private readonly Dictionary<string, System.Windows.Threading.DispatcherTimer> _previewTimers = new();

    /// <summary>The hover card shows the page as it last looked. It is captured once, a moment after the page loads, while it is visible.</summary>
    private void SchedulePreview(BrowserTab tab)
    {
        if (!Data.Settings.GetBool(SettingKeys.TabPreviews)) return;
        if (_previewTimers.TryGetValue(tab.Id, out var old)) old.Stop();
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1800) };
        timer.Tick += (_, _) => { timer.Stop(); _previewTimers.Remove(tab.Id); if (tab == Tabs.ActiveTab) _ = CapturePreviewAsync(tab); };
        _previewTimers[tab.Id] = timer;
        timer.Start();
    }

    private async Task CapturePreviewAsync(BrowserTab tab)
    {
        if (!Data.Settings.GetBool(SettingKeys.TabPreviews) || tab.View is not { IsReady: true } view || tab.IsInternal && tab.Url == "wiisb://newtab") return;
        try
        {
            var png = await view.CapturePngAsync();
            if (png is null || png.Length == 0) return;
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.DecodePixelWidth = 320;   // previews stay small and live in memory only — never on disk
            bmp.StreamSource = new MemoryStream(png);
            bmp.EndInit();
            bmp.Freeze();
            tab.Preview = bmp;
            // keep memory bounded: only the most recently used tabs keep their preview
            foreach (var old in Tabs.AllTabs.Where(t => t.Preview is not null).OrderByDescending(t => t.LastActive).Skip(40)) old.Preview = null;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException or IOException or NotSupportedException) { }
    }

    private async void SleepIdleTabs()
    {
        int minutes = Data.Settings.GetInt(SettingKeys.SleepMinutes, 30);
        string mode = Data.Settings.Get(SettingKeys.PerfMode);
        bool gaming = Data.Settings.GetBool(SettingKeys.GamingMode);
        if (minutes <= 0 && mode != "aggressive" && !gaming) return;
        if (minutes <= 0) minutes = 15;
        if (mode == "aggressive" || gaming) minutes = Math.Max(1, minutes / 3);
        var threshold = TimeSpan.FromMinutes(minutes);
        foreach (var tab in Tabs.AllTabs.ToList())
            if (CanSleep(tab) && DateTime.UtcNow - tab.LastActive > threshold) await SleepTabAsync(tab);
    }

    public bool CanSleep(BrowserTab tab) =>
        tab != Tabs.ActiveTab && tab.View is not null && !tab.IsAudible && !tab.SleepExempt && tab.ActiveDownloads == 0 && !tab.HasPrompt
        && !tab.HasMediaCapture && !tab.IsLoading && tab.Lifecycle != TabLifecycle.Restoring && !tab.IsCrashed;

    public async Task SleepTabAsync(BrowserTab tab)
    {
        if (!CanSleep(tab)) return;
        try
        {
            if (tab.View is { IsReady: true } v)
            {
                var y = await v.RunScriptAsync("window.scrollY");
                if (double.TryParse(y, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var sy)) tab.SavedScrollY = sy;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
        if (!CanSleep(tab)) return;   // state may have changed while we were reading the page
        DisposeView(tab);
        tab.Lifecycle = TabLifecycle.Sleeping;
        AppLog.Info("tab put to sleep");
    }

    // ---- list interaction: click, middle-click, drag & drop -------------------------------------------------------------------

    private static object? RowItem(object sender) => (sender as FrameworkElement)?.DataContext;

    private void Row_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _dragStart = e.GetPosition(this);
        _dragging = false;
        if (e.OriginalSource is DependencyObject d && FindParent<Button>(d) is not null) return; // the close button handles itself
        switch (RowItem(sender))
        {
            case BrowserTab t: Tabs.Activate(t); break;
            case TabCluster c: Tabs.ToggleCollapsed(c); break;
        }
    }

    private void Row_PreviewMouseMove(object sender, MouseEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed || _dragging || RowItem(sender) is not BrowserTab tab) return;
        var p = e.GetPosition(this);
        if (Math.Abs(p.X - _dragStart.X) < SystemParameters.MinimumHorizontalDragDistance && Math.Abs(p.Y - _dragStart.Y) < SystemParameters.MinimumVerticalDragDistance) return;
        _dragging = true;
        BeginTabDrag(sender as DependencyObject ?? this, tab);
    }

    private void BeginTabDrag(DependencyObject source, BrowserTab tab)
    {
        var data = new DataObject("wiisb.tab", tab.Id);
        foreach (var t in Tabs.AllTabs) t.View?.SetExternalDrop(false);
        DragDropEffects effect;
        try { effect = DragDrop.DoDragDrop(source, data, DragDropEffects.Move); }
        finally { foreach (var t in Tabs.AllTabs) t.View?.SetExternalDrop(true); }
        _dragging = false;
        // Nobody took the tab (not the tab list, which would have reordered it). If it was let go outside the window or
        // over the page, it becomes a window of its own. WPF does not track the mouse during a drag, so ask Windows
        // where the pointer really is — Mouse.GetPosition would still report where the drag started.
        if (effect != DragDropEffects.None || !NativeMethods.GetCursorPos(out var p)) return;
        var topLeft = PointToScreen(new Point(0, 0));
        var bottomRight = PointToScreen(new Point(ActualWidth, ActualHeight));
        ScreenRect? page = null;
        if (WebHost.IsVisible && WebHost.ActualWidth > 0)
        {
            var a = WebHost.PointToScreen(new Point(0, 0));
            var b = WebHost.PointToScreen(new Point(WebHost.ActualWidth, WebHost.ActualHeight));
            page = new ScreenRect(a.X, a.Y, b.X, b.Y);
        }
        if (TabTearOff.ShouldTearOff(p.X, p.Y, new ScreenRect(topLeft.X, topLeft.Y, bottomRight.X, bottomRight.Y), page))
            _ = MoveTabToNewWindowAsync(tab, new Point(p.X, p.Y));
    }

    private static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)] public struct NativePoint { public int X, Y; }
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out NativePoint p);
    }

    private void Row_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Middle && RowItem(sender) is BrowserTab t) { Tabs.Close(t); e.Handled = true; }
    }

    private void Row_DragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent("wiisb.tab") ? DragDropEffects.Move : DragDropEffects.None;
        e.Handled = true;
    }

    private void Row_Drop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData("wiisb.tab") is not string id || Tabs.Find(id) is not { } dragged) return;
        switch (RowItem(sender))
        {
            case BrowserTab target when target != dragged: Tabs.MoveBefore(dragged, target); break;
            case TabCluster cluster: Tabs.AddToCluster(dragged, cluster); break;
        }
        e.Handled = true;
    }

    private void DropOnEmptyList(DragEventArgs e)
    {
        if (e.Handled) return;
        if (e.Data.GetData("wiisb.tab") is string id && Tabs.Find(id) is { } t) { t.IsPinned = false; Tabs.MoveBefore(t, null); }
    }

    private void Row_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        switch (RowItem(sender))
        {
            case BrowserTab t: ShowTabMenu(t, (FrameworkElement)sender); break;
            case TabCluster c: ShowClusterContextMenu(c, (FrameworkElement)sender); break;
        }
        e.Handled = true;
    }

    private void Pinned_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: BrowserTab t }) return;
        if (e.ChangedButton == MouseButton.Middle) { Tabs.Close(t); return; }
        if (e.ChangedButton != MouseButton.Left) return;
        Tabs.Activate(t);
        _dragStart = e.GetPosition(this);
    }

    private void Pinned_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BrowserTab t } fe) ShowTabMenu(t, fe);
        e.Handled = true;
    }

    private void Pinned_Drop(object sender, DragEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BrowserTab target } && e.Data.GetData("wiisb.tab") is string id && Tabs.Find(id) is { } t && t != target)
            Tabs.MoveBefore(t, target);
        e.Handled = true;
    }

    private void Strip_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: BrowserTab t }) return;
        if (e.ChangedButton == MouseButton.Middle) { Tabs.Close(t); return; }
        if (e.ChangedButton == MouseButton.Left)
        {
            Tabs.Activate(t);
            _dragStart = e.GetPosition(this);
            if (e.OriginalSource is DependencyObject d && FindParent<Button>(d) is null)
                Dispatcher.BeginInvoke(() => { if (Mouse.LeftButton == MouseButtonState.Pressed) BeginTabDrag((DependencyObject)sender, t); }, System.Windows.Threading.DispatcherPriority.Input);
        }
    }

    private void Strip_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BrowserTab t } fe) ShowTabMenu(t, fe);
        e.Handled = true;
    }

    private void Strip_Drop(object sender, DragEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BrowserTab target } && e.Data.GetData("wiisb.tab") is string id && Tabs.Find(id) is { } t && t != target)
            Tabs.MoveBefore(t, target);
        e.Handled = true;
    }

    private static T? FindParent<T>(DependencyObject child) where T : DependencyObject
    {
        for (var d = child; d is not null; d = d is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d))
            if (d is T t) return t;
        return null;
    }

    // ---- context menus ----------------------------------------------------------------------------------------------------------

    private static MenuItem Item(string header, Action? click, string? icon = null, string? gesture = null, bool enabled = true)
    {
        var mi = new MenuItem { Header = header, IsEnabled = enabled, InputGestureText = gesture ?? "" };
        if (icon is not null) mi.Icon = new TextBlock { Text = icon, FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 13 };
        if (click is not null) mi.Click += (_, _) => click();
        return mi;
    }

    private string? ShortcutText(string id) => Shortcuts.ChordFor(id)?.ToString();

    private void ShowTabMenu(BrowserTab tab, FrameworkElement anchor)
    {
        var m = new ContextMenu { PlacementTarget = anchor };
        m.Items.Add(Item("Reload", () => tab.View?.Reload(), "", "Ctrl+R", tab.View is not null));
        m.Items.Add(Item("Duplicate", () => Tabs.Duplicate(tab), ""));
        m.Items.Add(Item(tab.IsPinned ? "Unpin tab" : "Pin tab", () => TogglePin(tab), tab.IsPinned ? "" : ""));
        m.Items.Add(Item(tab.IsMuted ? "Unmute tab" : "Mute tab", () => ToggleMute(tab), tab.IsMuted ? "" : ""));
        m.Items.Add(new Separator());

        var marker = new MenuItem { Header = "Marker" };
        foreach (var mk in new[] { "⭐", "❤️", "⚠️", "💼", "🎮", "❗", "📌", "🔥" })
            marker.Items.Add(Item(mk, () => { tab.Marker = mk; ScheduleSave(); }));
        marker.Items.Add(new Separator());
        marker.Items.Add(Item("Custom…", () => { var v = Dialogs.Input(this, "Tab marker", "Type an emoji or a short label (up to 4 characters).", tab.Marker, 4); if (v is not null) { tab.Marker = v.Trim(); ScheduleSave(); } }));
        marker.Items.Add(Item("Remove marker", () => { tab.Marker = ""; ScheduleSave(); }, null, null, tab.HasMarker));
        m.Items.Add(marker);

        var move = new MenuItem { Header = "Move to workspace" };
        foreach (var w in Tabs.Workspaces.Where(w => w.Id != tab.WorkspaceId))
            move.Items.Add(Item($"{w.Icon}  {w.Name}", () => Tabs.MoveToWorkspace(tab, w)));
        move.IsEnabled = move.Items.Count > 0;
        m.Items.Add(move);

        var cluster = new MenuItem { Header = "Cluster" };
        cluster.Items.Add(Item("New cluster with this tab…", () => CreateClusterDialog(new[] { tab }), null, null, !tab.IsPinned));
        foreach (var c in Tabs.Clusters.Where(c => c.WorkspaceId == tab.WorkspaceId && c.Id != tab.ClusterId))
            cluster.Items.Add(Item($"{c.Emoji} {c.Name}".Trim(), () => Tabs.AddToCluster(tab, c), null, null, !tab.IsPinned));
        if (tab.IsClustered) { cluster.Items.Add(new Separator()); cluster.Items.Add(Item("Remove from cluster", () => Tabs.RemoveFromCluster(tab))); }
        m.Items.Add(cluster);
        m.Items.Add(Item(tab.SleepExempt ? "Allow this tab to sleep" : "Never put this tab to sleep", () => { tab.SleepExempt = !tab.SleepExempt; ScheduleSave(); }, ""));
        if (tab.View is not null && tab != Tabs.ActiveTab) m.Items.Add(Item("Put to sleep now", () => _ = SleepTabAsync(tab), ""));
        m.Items.Add(new Separator());
        m.Items.Add(Item("Bookmark tab", () => BookmarkTab(tab), "", "Ctrl+D", BookmarkStore.IsValidUrl(tab.Url)));
        m.Items.Add(Item("Copy link", () => { if (!string.IsNullOrEmpty(tab.Url)) Clipboard.SetText(tab.Url); }, ""));
        m.Items.Add(Item("Move to new window", () => _ = MoveTabToNewWindowAsync(tab), "", null, tab.Url != "wiisb://newtab"));
        m.Items.Add(new Separator());
        m.Items.Add(Item("Close tab", () => Tabs.Close(tab), "", "Ctrl+W"));
        m.Items.Add(Item("Close other tabs", () => CloseOthers(tab)));
        m.Items.Add(Item("Close tabs below", () => CloseBelow(tab)));
        m.Items.Add(Item("Close duplicate tabs", CloseDuplicates));
        m.Items.Add(Item("Reopen closed tab", () => Tabs.Reopen(), "", "Ctrl+Shift+T", Tabs.RecentlyClosed.Count > 0));
        m.IsOpen = true;
    }

    private void ShowClusterContextMenu(TabCluster c, FrameworkElement anchor)
    {
        var m = new ContextMenu { PlacementTarget = anchor };
        m.Items.Add(Item(c.Collapsed ? "Expand" : "Collapse", () => Tabs.ToggleCollapsed(c)));
        m.Items.Add(Item("Rename…", () => { var n = Dialogs.Input(this, "Rename cluster", "Cluster name", c.Name, 30); if (!string.IsNullOrWhiteSpace(n)) { c.Name = n.Trim(); ScheduleSave(); } }));
        m.Items.Add(Item("Choose emoji…", () => { var n = Dialogs.Input(this, "Cluster emoji", "An emoji or short symbol (leave empty for none).", c.Emoji, 4); if (n is not null) { c.Emoji = n.Trim(); ScheduleSave(); } }));
        var color = new MenuItem { Header = "Color" };
        foreach (var (name, hex) in new[] { ("Violet", "#8B5CF6"), ("Sky", "#38BDF8"), ("Mint", "#34D399"), ("Amber", "#FBBF24"), ("Rose", "#F43F5E"), ("Orange", "#FB923C"), ("Pink", "#EC4899"), ("Lime", "#A3E635") })
            color.Items.Add(Item(name, () => { c.Color = hex; Tabs.RebuildRows(); ScheduleSave(); }));
        m.Items.Add(color);
        var move = new MenuItem { Header = "Move to workspace" };
        foreach (var w in Tabs.Workspaces.Where(w => w.Id != c.WorkspaceId)) move.Items.Add(Item($"{w.Icon}  {w.Name}", () => Tabs.MoveClusterToWorkspace(c, w)));
        move.IsEnabled = move.Items.Count > 0;
        m.Items.Add(move);
        m.Items.Add(new Separator());
        m.Items.Add(Item("Save cluster as bookmarks folder", () => SaveClusterAsBookmarks(c), ""));
        m.Items.Add(Item("Ungroup tabs", () => Tabs.DeleteCluster(c, false)));
        m.Items.Add(Item("Close all tabs in cluster", () => Tabs.DeleteCluster(c, true), ""));
        m.IsOpen = true;
    }

    private void SaveClusterAsBookmarks(TabCluster c)
    {
        var folder = Data.Bookmarks.AddFolder(string.IsNullOrWhiteSpace(c.Name) ? "Cluster" : c.Name);
        int n = 0;
        foreach (var t in Tabs.AllTabs.Where(t => t.ClusterId == c.Id && BookmarkStore.IsValidUrl(t.Url) && !t.IsInternal)) { Data.Bookmarks.Add(t.Url, t.DisplayTitle, folder); n++; }
        ShowToast($"Saved {n} tab{(n == 1 ? "" : "s")} to the bookmarks folder “{c.Name}”.");
    }

    private void ShowListMenu()
    {
        var m = new ContextMenu();
        m.Items.Add(Item("New tab", () => NewTabAndFocus(), "", "Ctrl+T"));
        m.Items.Add(Item("Reopen closed tab", () => Tabs.Reopen(), "", "Ctrl+Shift+T", Tabs.RecentlyClosed.Count > 0));
        m.Items.Add(Item("Group suggestions…", () => ShowClusterMenu(_tabPanel), ""));
        m.Items.Add(Item("Close duplicate tabs", CloseDuplicates));
        m.Items.Add(Item("Close all unpinned tabs", () => Tabs.CloseMany(Tabs.TabsOf(Tabs.ActiveWorkspace.Id).Where(t => !t.IsPinned))));
        m.IsOpen = true;
    }

    /// <summary>Cluster menu: suggestions from the local heuristics, plus manual creation.</summary>
    private void ShowClusterMenu(FrameworkElement anchor)
    {
        var m = new ContextMenu { PlacementTarget = anchor };
        var excluded = (Data.Settings.GetJson<string[]>(SettingKeys.ClusterExclude) ?? Array.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var suggestions = ClusterSuggester.Suggest(Tabs.Facts(), excluded);
        if (suggestions.Count == 0) m.Items.Add(Item("No grouping suggestions right now", null, null, null, false));
        foreach (var s in suggestions)
        {
            var sg = s;
            m.Items.Add(Item($"Group “{sg.Name}” — {sg.Reason}", () =>
            {
                var tabs = sg.TabIds.Select(Tabs.Find).Where(t => t is not null).Cast<BrowserTab>().ToList();
                if (tabs.Count > 0) Tabs.CreateCluster(sg.Name, tabs);
            }, ""));
        }
        m.Items.Add(new Separator());
        m.Items.Add(Item("New empty cluster…", () => CreateClusterDialog(Tabs.ActiveTab is { IsPinned: false } t ? new[] { t } : Array.Empty<BrowserTab>()), ""));
        m.Items.Add(Item("Close duplicate tabs", CloseDuplicates));
        var mode = Data.Settings.Get(SettingKeys.AutoCluster);
        m.Items.Add(new Separator());
        m.Items.Add(Item(mode == "suggest" ? "✓ Suggest groups (current)" : "Suggest groups", () => Data.Settings.Set(SettingKeys.AutoCluster, "suggest")));
        m.Items.Add(Item(mode == "off" ? "✓ Group only when I ask (current)" : "Group only when I ask", () => Data.Settings.Set(SettingKeys.AutoCluster, "off")));
        m.IsOpen = true;
    }

    private void CreateClusterDialog(IReadOnlyList<BrowserTab> tabs)
    {
        var name = Dialogs.Input(this, "New cluster", "Cluster name", tabs.Count > 0 ? ClusterSuggester.NameFor(tabs[0].Host.Replace("www.", "")) : "Cluster", 30);
        if (string.IsNullOrWhiteSpace(name)) return;
        if (tabs.Count == 0) { ShowToast("Select a tab first, then add it to a cluster."); return; }
        Tabs.CreateCluster(name, tabs);
    }

    // ---- IBrowserHost: engine callbacks -------------------------------------------------------------------------------------------

    public void OnTabStateChanged(BrowserTab tab, bool persist)
    {
        if (persist) ScheduleSave();
        if (!IsPrivate && Data.History is { } h && !string.IsNullOrWhiteSpace(tab.Title)) h.UpdateTitle(tab.Url, tab.Title);
    }

    public void OnPageCommitted(BrowserTab tab)
    {
        tab.HasMediaCapture = false;
        SchedulePreview(tab);
        // Private windows have no history store at all, so there is nothing that could be written by mistake.
        Data.History?.RecordVisit(tab.Url, tab.Title);
        if (tab == Tabs.ActiveTab) UpdateToolbar();
        MaybeSuggestClusters();
    }

    private DateTime _lastClusterHint = DateTime.MinValue;

    private void MaybeSuggestClusters()
    {
        if (Data.Settings.Get(SettingKeys.AutoCluster) != "suggest" || DateTime.UtcNow - _lastClusterHint < TimeSpan.FromMinutes(10)) return;
        var excluded = (Data.Settings.GetJson<string[]>(SettingKeys.ClusterExclude) ?? Array.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var s = ClusterSuggester.Suggest(Tabs.Facts(), excluded, 3).FirstOrDefault();
        if (s is null) return;
        _lastClusterHint = DateTime.UtcNow;
        ShowToast($"Tip: {s.Reason} could be grouped as “{s.Name}” — open the cluster button above your tabs.");
    }

    public void OnDownloadStarting(BrowserTab tab, CoreWebView2DownloadStartingEventArgs e) =>
        Downloads.Start(tab, e, (name, folder) =>
        {
            var dlg = new Microsoft.Win32.SaveFileDialog { FileName = name, InitialDirectory = Directory.Exists(folder) ? folder : null, OverwritePrompt = true, Title = "Save file" };
            return dlg.ShowDialog(this) == true ? dlg.FileName : null;
        });

    private static readonly Dictionary<CoreWebView2PermissionKind, (string Key, string Text)> PermissionNames = new()
    {
        [CoreWebView2PermissionKind.Microphone] = ("microphone", "use your microphone"),
        [CoreWebView2PermissionKind.Camera] = ("camera", "use your camera"),
        [CoreWebView2PermissionKind.Geolocation] = ("location", "know your location"),
        [CoreWebView2PermissionKind.Notifications] = ("notifications", "show notifications"),
        [CoreWebView2PermissionKind.ClipboardRead] = ("clipboard", "read text and images from your clipboard"),
        [CoreWebView2PermissionKind.MultipleAutomaticDownloads] = ("downloads", "download several files automatically"),
        [CoreWebView2PermissionKind.WindowManagement] = ("windows", "manage windows on your screens"),
        [CoreWebView2PermissionKind.LocalFonts] = ("fonts", "see the fonts installed on your PC"),
    };

    public void OnPermissionRequested(BrowserTab tab, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (!PermissionNames.TryGetValue(e.PermissionKind, out var info)) return; // unlisted kinds keep the engine's safe default
        var origin = UrlClassifier.OriginOf(e.Uri);
        var saved = Data.Permissions.Get(origin, info.Key);
        e.SavesInProfile = false; // decisions are kept in our own per-profile store, not silently by the engine
        if (saved == PermissionStore.Allow) { e.State = CoreWebView2PermissionState.Allow; MarkCapture(tab, info.Key); return; }
        if (saved == PermissionStore.Block) { e.State = CoreWebView2PermissionState.Deny; return; }
        if (tab.Prompt is not null) { e.State = CoreWebView2PermissionState.Deny; return; } // one question at a time

        var deferral = e.GetDeferral();
        tab.Prompt = new PendingPrompt
        {
            Origin = origin,
            Kind = info.Key,
            Description = $"wants to {info.Text}",
            Decide = choice =>
            {
                if (tab.Prompt is null) return;
                tab.Prompt = null;
                switch (choice)
                {
                    case "allow-always": Data.Permissions.Set(origin, info.Key, PermissionStore.Allow); e.State = CoreWebView2PermissionState.Allow; MarkCapture(tab, info.Key); break;
                    case "allow-once": e.State = CoreWebView2PermissionState.Allow; MarkCapture(tab, info.Key); break;
                    default: if (choice == "block-always") Data.Permissions.Set(origin, info.Key, PermissionStore.Block); e.State = CoreWebView2PermissionState.Deny; break;
                }
                try { deferral.Complete(); } catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
            },
        };
        if (tab == Tabs.ActiveTab) UpdatePromptBar();
        else Tabs.Activate(tab);
    }

    private static void MarkCapture(BrowserTab tab, string key)
    {
        if (key is "camera" or "microphone") tab.HasMediaCapture = true;
    }

    // Only well-known, harmless handlers may be launched from a web page — and only after the user says yes.
    private static readonly HashSet<string> SafeExternalSchemes = new(StringComparer.OrdinalIgnoreCase)
        { "mailto", "tel", "sms", "steam", "discord", "spotify", "zoommtg", "zoomus", "msteams", "slack", "skype", "vscode", "vscode-insiders", "obsidian", "facetime" };

    public void OnExternalScheme(BrowserTab tab, CoreWebView2LaunchingExternalUriSchemeEventArgs e)
    {
        e.Cancel = true; // never launched by the engine itself
        var uri = e.Uri;
        var scheme = uri.Contains(':') ? uri[..uri.IndexOf(':')] : "";
        if (!SafeExternalSchemes.Contains(scheme))
        {
            ShowToast($"{UrlClassifier.OriginOf(tab.Url)} tried to open another app (“{scheme}:”). It was blocked.");
            return;
        }
        if (tab.Prompt is not null) return;
        tab.Prompt = new PendingPrompt
        {
            Origin = UrlClassifier.OriginOf(tab.Url),
            Kind = "external",
            Description = $"wants to open the “{scheme}” app",
            Decide = choice =>
            {
                tab.Prompt = null;
                if (choice.StartsWith("allow")) { try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Couldn't open that app."); } }
            },
        };
        if (tab == Tabs.ActiveTab) UpdatePromptBar();
    }

    public void OnFullscreenChanged(BrowserTab tab, bool fullscreen)
    {
        if (tab != Tabs.ActiveTab) return;
        if (fullscreen) SetFullscreen(true, fromPage: true);
        else if (IsFullscreen && _htmlFullscreen) SetFullscreen(false);
    }

    public void OnCrashed(BrowserTab tab, CoreWebView2ProcessFailedEventArgs e)
    {
        AppLog.Warn($"tab renderer failed: {e.ProcessFailedKind}");
        if (tab == Tabs.ActiveTab) { ShowActiveView(); UpdateStatusPanel(); }
    }

    public void OnFindResult(BrowserTab tab, int active, int total)
    {
        if (tab != Tabs.ActiveTab) return;
        FindCount.Text = string.IsNullOrEmpty(FindBox.Text) ? "" : total == 0 ? "No matches" : $"{active} of {total}";
    }

    public void OnStatusText(BrowserTab tab, string text)
    {
        if (tab != Tabs.ActiveTab) return;
        if (string.IsNullOrEmpty(text)) { LinkStatusPopup.IsOpen = false; return; }
        LinkStatusText.Text = text;
        LinkStatusPopup.HorizontalOffset = 0;
        LinkStatusPopup.VerticalOffset = WebArea.ActualHeight - 30;
        LinkStatusPopup.IsOpen = true;
    }

    public void OnContextMenu(BrowserTab tab, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        if (Environment is null || tab.IsInternal) return;
        var env = Environment;
        var items = e.MenuItems;
        var target = e.ContextMenuTarget;
        void Add(string label, Action action)
        {
            var mi = env.CreateContextMenuItem(label, null, CoreWebView2ContextMenuItemKind.Command);
            mi.CustomItemSelected += (_, _) => Dispatcher.BeginInvoke(action);
            items.Add(mi);
        }
        void Separator() => items.Add(env.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator));

        Separator();
        if (target.HasLinkUri)
        {
            var link = target.LinkUri;
            Add("Open link in background tab", () => OpenUrlInNewTab(link, true, tab));
            Add("Bookmark link", () => { if (BookmarkStore.IsValidUrl(link)) { Data.Bookmarks.Add(link, target.LinkText); ShowToast("Link bookmarked."); } });
        }
        if (!string.IsNullOrWhiteSpace(target.SelectionText))
        {
            var sel = target.SelectionText.Trim();
            var shortSel = sel.Length > 28 ? sel[..28] + "…" : sel;
            Add($"Search {CurrentSearchEngine().Name} for “{shortSel}”", () => Tabs.NewTab(SearchEngines.BuildUrl(CurrentSearchEngine(), sel), tab));
            Add("Read selection aloud", () => Speech.Speak(sel));
        }
        if (!target.HasLinkUri && string.IsNullOrWhiteSpace(target.SelectionText))
        {
            Add("Take screenshot", () => _ = TakeScreenshotAsync());
            Add("Bookmark this page", () => BookmarkTab(tab));
        }
    }

    // ---- keyboard ----------------------------------------------------------------------------------------------------------------

    public bool TryHandleKey(KeyChord chord)
    {
        var id = Shortcuts.CommandFor(chord);
        if (id is null) return false;
        var cmd = Commands.Get(id);
        if (cmd is null || !cmd.Available) return false;
        Dispatcher.BeginInvoke(() => Commands.Execute(id));
        return true;
    }

    private void OnWindowPreviewKeyDown(object sender, KeyEventArgs e)
    {
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (key is Key.LeftCtrl or Key.RightCtrl or Key.LeftShift or Key.RightShift or Key.LeftAlt or Key.RightAlt or Key.None) return;
        if (Keyboard.FocusedElement is TextBox && key is not (Key.Escape or Key.F5 or Key.F11 or Key.F12) && Keyboard.Modifiers == ModifierKeys.None) return;
        var chord = new KeyChord(Keyboard.Modifiers.HasFlag(ModifierKeys.Control), Keyboard.Modifiers.HasFlag(ModifierKeys.Shift), Keyboard.Modifiers.HasFlag(ModifierKeys.Alt), key.ToString());
        if (TryHandleKey(chord)) e.Handled = true;
    }

    // ---- theme push to internal pages -----------------------------------------------------------------------------------------------

    private void PushThemeToInternalPages()
    {
        foreach (var t in Tabs.AllTabs)
            if (t.IsInternal && t.View is { IsReady: true } v) v.PostJson(InternalApi.ThemeMessage(this));
        foreach (var p in _panelViews.Values)
            if (p.View is { IsReady: true } v) v.PostJson(InternalApi.ThemeMessage(this));
    }
}
