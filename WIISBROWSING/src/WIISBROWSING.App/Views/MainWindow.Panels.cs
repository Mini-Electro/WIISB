using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using WIISBROWSING.App.Browser;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Views;

public partial class MainWindow
{
    private sealed class PanelView
    {
        public required BrowserTab Tab { get; init; }
        public required TabWebView View { get; init; }
        public required string Title { get; init; }
        public required string Url { get; init; }
    }

    private readonly Dictionary<string, PanelView> _panelViews = new();
    private readonly ObservableCollection<SidebarApp> _apps = new();
    private string? _activePanelKey;

    // ---- sidebar web apps ---------------------------------------------------------------------------------------------------

    private List<SidebarAppRecord> LoadAppRecords()
    {
        var saved = Data.Settings.GetJson<List<SidebarAppRecord>>(SettingKeys.SidebarApps);
        return saved is { Count: > 0 } ? saved : SidebarApp.Defaults();
    }

    private void SaveAppRecords() =>
        Data.Settings.SetJson(SettingKeys.SidebarApps, _apps.Select(a => new SidebarAppRecord { Name = a.Name, Url = a.Url, Color = a.ColorHex }).ToList());

    private void ApplySidebarApps()
    {
        _apps.Clear();
        foreach (var r in LoadAppRecords().Where(r => Uri.TryCreate(r.Url, UriKind.Absolute, out var u) && u.Scheme == "https"))
        {
            var app = new SidebarApp { Name = r.Name, Url = r.Url, ColorHex = r.Color };
            app.Icon = AppHost.Favicons.Get(app.Host);
            _apps.Add(app);
        }
        AppList.ItemsSource = _apps;
    }

    private void SidebarApp_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { Tag: SidebarApp app }) _ = TogglePanelAsync("app:" + app.Host, app.Name, app.Url, app);
    }

    private void SidebarApp_RightClick(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: SidebarApp app } fe) return;
        var m = new ContextMenu { PlacementTarget = fe };
        m.Items.Add(Item("Open in side panel", () => _ = TogglePanelAsync("app:" + app.Host, app.Name, app.Url, app), ""));
        m.Items.Add(Item("Open in a tab", () => Tabs.NewTab(app.Url, Tabs.ActiveTab), ""));
        m.Items.Add(Item("Open in a new window", () => AppHost.OpenWindow(Profile, IsPrivate, new[] { app.Url }, false)));
        m.Items.Add(new Separator());
        m.Items.Add(Item("Edit…", () => EditApp(app), ""));
        m.Items.Add(Item("Move up", () => MoveApp(app, -1), "", null, _apps.IndexOf(app) > 0));
        m.Items.Add(Item("Move down", () => MoveApp(app, 1), "", null, _apps.IndexOf(app) < _apps.Count - 1));
        m.Items.Add(Item("Remove from sidebar", () => { _apps.Remove(app); SaveAppRecords(); CloseApp(app); }, ""));
        m.IsOpen = true;
    }

    private void CloseApp(SidebarApp app)
    {
        var key = "app:" + app.Host;
        if (_panelViews.Remove(key, out var pv)) { PanelWebHost.Children.Remove(pv.View.Control); pv.View.Dispose(); if (_activePanelKey == key) ClosePanel(); }
    }

    private void MoveApp(SidebarApp app, int delta)
    {
        int i = _apps.IndexOf(app), j = i + delta;
        if (j < 0 || j >= _apps.Count) return;
        _apps.Move(i, j);
        SaveAppRecords();
    }

    private void EditApp(SidebarApp app)
    {
        var name = Dialogs.Input(this, "Edit shortcut", "Name", app.Name, 30);
        if (string.IsNullOrWhiteSpace(name)) return;
        var url = Dialogs.Input(this, "Edit shortcut", "Web address (https://…)", app.Url, 300);
        if (url is null) return;
        if (!ValidAppUrl(url, out var norm)) { Dialogs.Message(this, "That address isn't valid", "Use a full https:// address, for example https://web.whatsapp.com"); return; }
        var idx = _apps.IndexOf(app);
        _apps[idx] = new SidebarApp { Name = name.Trim(), Url = norm, ColorHex = app.ColorHex, Icon = AppHost.Favicons.Get(UrlClassifier.HostOf(norm)) };
        SaveAppRecords();
    }

    private static bool ValidAppUrl(string text, out string url)
    {
        url = "";
        text = text.Trim();
        if (!text.Contains("://")) text = "https://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps || !u.Host.Contains('.')) return false;
        url = u.AbsoluteUri;
        return true;
    }

    private void AddSidebarApp_Click(object sender, RoutedEventArgs e)
    {
        var url = Dialogs.Input(this, "Add to the sidebar", "Web address (for example https://discord.com/app)", Tabs.ActiveTab?.Url is { } u && u.StartsWith("https://") ? u : "https://", 300);
        if (url is null) return;
        if (!ValidAppUrl(url, out var norm)) { Dialogs.Message(this, "That address isn't valid", "Use a full https:// address."); return; }
        var host = UrlClassifier.HostOf(norm).Replace("www.", "");
        var name = Dialogs.Input(this, "Add to the sidebar", "Name", ClusterName(host), 30);
        if (string.IsNullOrWhiteSpace(name)) return;
        var colors = new[] { "#6366F1", "#EC4899", "#10B981", "#F59E0B", "#0EA5E9", "#EF4444", "#8B5CF6" };
        _apps.Add(new SidebarApp { Name = name.Trim(), Url = norm, ColorHex = colors[_apps.Count % colors.Length], Icon = AppHost.Favicons.Get(UrlClassifier.HostOf(norm)) });
        SaveAppRecords();
    }

    private static string ClusterName(string host) => Core.Tabs.ClusterSuggester.NameFor(UrlClassifier.RegistrableDomain(host));

    // ---- side panel ---------------------------------------------------------------------------------------------------------

    private void PanelBookmarks_Click(object s, RoutedEventArgs e) => _ = TogglePanelAsync("bookmarks", "Bookmarks", "wiisb://bookmarks/?panel=1");
    private void PanelHistory_Click(object s, RoutedEventArgs e) => _ = TogglePanelAsync("history", "History", "wiisb://history/?panel=1");
    private void PanelNotes_Click(object s, RoutedEventArgs e) => _ = TogglePanelAsync("notes", "Notes", "wiisb://notes/?panel=1");

    public async Task TogglePanelAsync(string key, string title, string url, SidebarApp? app = null)
    {
        if (_activePanelKey == key) { ClosePanel(); return; }
        if (Environment is null) return;
        if (!_panelViews.TryGetValue(key, out var pv))
        {
            var tab = new BrowserTab { Url = url, IsPrivate = IsPrivate };
            var view = new TabWebView(tab, this);
            pv = new PanelView { Tab = tab, View = view, Title = title, Url = url };
            _panelViews[key] = pv;
            PanelWebHost.Children.Add(view.Control);
            if (app is not null)
                tab.PropertyChanged += (_, ev) => { if (ev.PropertyName == nameof(BrowserTab.Favicon) && tab.Favicon is { } f) { app.Icon = f; } };
            try { await view.InitializeAsync(Environment); }
            catch (Exception ex) { AppLog.Error("panel", ex); _panelViews.Remove(key); PanelWebHost.Children.Remove(view.Control); view.Dispose(); ShowToast("The panel couldn't start."); return; }
            view.Navigate(url);
        }
        foreach (var other in _panelViews.Values) other.View.Control.Visibility = other == pv ? Visibility.Visible : Visibility.Collapsed;
        _activePanelKey = key;
        PanelTitle.Text = title;
        double w = Math.Clamp(Data.Settings.GetInt(SettingKeys.SidebarPanelWidth, 380), 280, 760);
        ColPanel.Width = new GridLength(w);
        ColPanel.MinWidth = 280;
        ColSplitPanel.Width = new GridLength(5);
    }

    private void ClosePanel()
    {
        _activePanelKey = null;
        foreach (var p in _panelViews.Values) p.View.Control.Visibility = Visibility.Collapsed;
        ColPanel.MinWidth = 0;
        ColPanel.Width = new GridLength(0);
        ColSplitPanel.Width = new GridLength(0);
    }

    private PanelView? ActivePanel => _activePanelKey is not null && _panelViews.TryGetValue(_activePanelKey, out var p) ? p : null;
    private void PanelClose_Click(object s, RoutedEventArgs e) => ClosePanel();
    private void PanelReload_Click(object s, RoutedEventArgs e) => ActivePanel?.View.Reload();

    private void PanelOpenInTab_Click(object s, RoutedEventArgs e)
    {
        if (ActivePanel is not { } p) return;
        var url = p.View.Core?.Source is { Length: > 0 } cur ? cur : p.Url;
        url = url.Replace("?panel=1", "").TrimEnd('/');
        ClosePanel();
        Tabs.NewTab(url, Tabs.ActiveTab);
    }

    private void PanelSplitter_DragCompleted(object sender, System.Windows.Controls.Primitives.DragCompletedEventArgs e)
    {
        if (ColPanel.ActualWidth >= 280) Data.Settings.SetInt(SettingKeys.SidebarPanelWidth, (int)ColPanel.ActualWidth);
    }

    // ---- workspaces ----------------------------------------------------------------------------------------------------------

    private void Workspace_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { Tag: Workspace w }) Tabs.SwitchWorkspace(w);
    }

    private void Workspace_Drop(object sender, DragEventArgs e)
    {
        if (sender is FrameworkElement { Tag: Workspace w } && e.Data.GetData("wiisb.tab") is string id && Tabs.Find(id) is { } t) Tabs.MoveToWorkspace(t, w);
        e.Handled = true;
    }

    private void Workspace_RightClick(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: Workspace w } fe) return;
        var m = new ContextMenu { PlacementTarget = fe };
        m.Items.Add(Item("Edit workspace…", () => EditWorkspace(w), ""));
        m.Items.Add(Item("Duplicate", () => Tabs.DuplicateWorkspace(w), ""));
        m.Items.Add(Item(w.Hidden ? "Show in sidebar" : "Hide from sidebar", () => { w.Hidden = !w.Hidden; Tabs.RebuildRows(); ScheduleSave(); }, "", null, !w.IsActive));
        m.Items.Add(Item("Move up", () => Tabs.MoveWorkspace(w, Tabs.Workspaces.IndexOf(w) - 1), "", null, Tabs.Workspaces.IndexOf(w) > 0));
        m.Items.Add(Item("Move down", () => Tabs.MoveWorkspace(w, Tabs.Workspaces.IndexOf(w) + 1), "", null, Tabs.Workspaces.IndexOf(w) < Tabs.Workspaces.Count - 1));
        m.Items.Add(new Separator());
        m.Items.Add(Item("Delete workspace…", () => DeleteWorkspace(w), "", null, Tabs.Workspaces.Count > 1));
        m.IsOpen = true;
    }

    private void NewWorkspace_Click(object sender, RoutedEventArgs e) => CreateWorkspaceDialog();

    public void CreateWorkspaceDialog()
    {
        var name = Dialogs.Input(this, "New workspace", "Workspace name (for example Work, Study, Gaming)", "", 24);
        if (string.IsNullOrWhiteSpace(name)) return;
        var icon = Dialogs.Input(this, "New workspace", "Icon: an emoji (you can paste one)", "⭐", 4) ?? "⭐";
        var colors = new[] { "#8B5CF6", "#38BDF8", "#34D399", "#FBBF24", "#F43F5E", "#FB923C" };
        var ws = Tabs.CreateWorkspace(name, icon, colors[Tabs.Workspaces.Count % colors.Length]);
        Tabs.SwitchWorkspace(ws);
    }

    private void EditWorkspace(Workspace w)
    {
        var name = Dialogs.Input(this, "Edit workspace", "Name", w.Name, 24);
        if (string.IsNullOrWhiteSpace(name)) return;
        var icon = Dialogs.Input(this, "Edit workspace", "Icon (emoji)", w.Icon, 4);
        w.Name = name.Trim();
        if (!string.IsNullOrWhiteSpace(icon)) w.Icon = icon.Trim();
        _tabPanel.SetWorkspace(Tabs.ActiveWorkspace.Icon, Tabs.ActiveWorkspace.Name);
        ScheduleSave();
    }

    private void DeleteWorkspace(Workspace w)
    {
        int count = Tabs.TabsOf(w.Id).Count();
        var others = Tabs.Workspaces.Where(x => x != w).ToList();
        if (count == 0) { Tabs.DeleteWorkspace(w, others[0]); return; }
        var choice = Dialogs.Choose(this, $"Delete “{w.Name}”?", $"It has {count} tab{(count == 1 ? "" : "s")}. What should happen to {(count == 1 ? "it" : "them")}?",
            new[] { $"Move to “{others[0].Name}”", "Close them", "Cancel" });
        switch (choice)
        {
            case 0: Tabs.DeleteWorkspace(w, others[0]); break;
            case 1: Tabs.DeleteWorkspace(w, null); break;
        }
    }
}
