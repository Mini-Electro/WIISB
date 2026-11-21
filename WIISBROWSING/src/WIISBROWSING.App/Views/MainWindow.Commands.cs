using System.Diagnostics;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Services;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Views;

public partial class MainWindow
{
    private void Cmd(string id, string name, string category, Action run, string? shortcut = null, string keywords = "", Func<bool>? available = null, bool hidden = false) =>
        Commands.Register(new BrowserCommand { Id = id, Name = name, Category = category, Execute = run, DefaultShortcut = shortcut, Keywords = keywords, IsAvailable = available, Hidden = hidden });

    private bool HasTab => Tabs.ActiveTab is not null;
    private bool HasPage => Tabs.ActiveTab?.View?.IsReady == true;

    private void RegisterCommands()
    {
        // ---- tabs
        Cmd("tab.new", "New tab", "Tabs", () => NewTabAndFocus(), "Ctrl+T", "open create blank");
        Cmd("tab.close", "Close tab", "Tabs", () => { if (Tabs.ActiveTab is { } t) Tabs.Close(t); }, "Ctrl+W", "", () => HasTab);
        Cmd("tab.reopen", "Reopen closed tab", "Tabs", () => Tabs.Reopen(), "Ctrl+Shift+T", "restore undo", () => Tabs.RecentlyClosed.Count > 0);
        Cmd("tab.next", "Next tab", "Tabs", () => Tabs.SelectRelative(1), "Ctrl+Tab");
        Cmd("tab.prev", "Previous tab", "Tabs", () => Tabs.SelectRelative(-1), "Ctrl+Shift+Tab");
        for (int i = 1; i <= 8; i++) { int n = i; Cmd($"tab.select{n}", $"Go to tab {n}", "Tabs", () => Tabs.SelectNumber(n), $"Ctrl+{n}", "", null, true); }
        Cmd("tab.last", "Go to last tab", "Tabs", () => Tabs.SelectNumber(9), "Ctrl+9", "", null, true);
        Cmd("tab.duplicate", "Duplicate tab", "Tabs", () => { if (Tabs.ActiveTab is { } t) Tabs.Duplicate(t); }, null, "copy clone", () => HasTab);
        Cmd("tab.pin", "Pin or unpin tab", "Tabs", () => { if (Tabs.ActiveTab is { } t) TogglePin(t); }, null, "pinned", () => HasTab);
        Cmd("tab.mute", "Mute or unmute tab", "Tabs", () => { if (Tabs.ActiveTab is { } t) ToggleMute(t); }, null, "audio sound volume", () => HasTab);
        Cmd("tab.muteAll", "Mute all tabs", "Tabs", () => { foreach (var t in Tabs.AllTabs.Where(t => t.IsAudible)) { t.IsMuted = true; t.View?.SetMuted(true); } Tabs.RebuildRows(); }, null, "audio silence");
        Cmd("tab.unmuteAll", "Unmute all tabs", "Tabs", () => { foreach (var t in Tabs.AllTabs.Where(t => t.IsMuted)) { t.IsMuted = false; t.View?.SetMuted(false); } Tabs.RebuildRows(); });
        Cmd("tab.closeOthers", "Close other tabs", "Tabs", () => { if (Tabs.ActiveTab is { } t) CloseOthers(t); }, null, "", () => HasTab);
        Cmd("tab.closeBelow", "Close tabs below", "Tabs", () => { if (Tabs.ActiveTab is { } t) CloseBelow(t); }, null, "", () => HasTab);
        Cmd("tab.closeUnpinned", "Close all unpinned tabs", "Tabs", () => Tabs.CloseMany(Tabs.TabsOf(Tabs.ActiveWorkspace.Id).Where(t => !t.IsPinned)));
        Cmd("tab.closeDuplicates", "Close duplicate tabs", "Tabs", CloseDuplicates, null, "dedupe same");
        Cmd("tab.sleepOthers", "Put background tabs to sleep", "Tabs", async () => { foreach (var t in Tabs.AllTabs.ToList()) await SleepTabAsync(t); ShowToast("Background tabs are asleep."); }, null, "memory save ram");
        Cmd("tab.search", "Search tabs", "Tabs", ShowTabSearch, "Ctrl+Shift+A", "find switch");
        Cmd("tab.copyUrls", "Copy all tab addresses", "Tabs", () => { Clipboard.SetText(string.Join(Environment_NewLine, Tabs.TabsOf(Tabs.ActiveWorkspace.Id).Where(t => BookmarkStore.IsValidUrl(t.Url) && !t.IsInternal).Select(t => t.Url))); ShowToast("Tab addresses copied."); }, null, "links");
        Cmd("tab.bookmarkAll", "Bookmark all tabs", "Tabs", BookmarkAllTabs, null, "save");
        Cmd("cluster.suggest", "Suggest tab clusters", "Tabs", () => ShowClusterMenu(_tabPanel), null, "group organise island");
        Cmd("cluster.new", "New cluster from current tab", "Tabs", () => { if (Tabs.ActiveTab is { IsPinned: false } t) CreateClusterDialog(new[] { t }); }, null, "group", () => HasTab);

        // ---- navigation
        Cmd("nav.focusAddress", "Focus the address bar", "Navigation", () => FocusAddressBar(), "Ctrl+L", "url omnibox");
        Cmd("nav.focusAddress2", "Focus the address bar (alias)", "Navigation", () => FocusAddressBar(), "Alt+D", "", null, true);
        Cmd("nav.back", "Back", "Navigation", () => Tabs.ActiveTab?.View?.GoBack(), "Alt+Left", "previous", () => Tabs.ActiveTab?.CanGoBack == true);
        Cmd("nav.forward", "Forward", "Navigation", () => Tabs.ActiveTab?.View?.GoForward(), "Alt+Right", "next", () => Tabs.ActiveTab?.CanGoForward == true);
        Cmd("nav.reload", "Reload", "Navigation", () => { if (Tabs.ActiveTab is { } t) { t.Error = null; t.View?.Reload(); } }, "Ctrl+R", "refresh", () => HasPage);
        Cmd("nav.reload2", "Reload (alias)", "Navigation", () => { if (Tabs.ActiveTab is { } t) { t.Error = null; t.View?.Reload(); } }, "F5", "", () => HasPage, true);
        Cmd("nav.hardReload", "Hard reload (ignore cache)", "Navigation", HardReload, "Ctrl+Shift+R", "refresh cache", () => HasPage);
        Cmd("nav.stop", "Stop loading", "Navigation", () => Tabs.ActiveTab?.View?.Stop(), null, "", () => Tabs.ActiveTab?.IsLoading == true);
        Cmd("nav.home", "Go home", "Navigation", () => NavigateActive(HomeUrl()), null, "start");

        // ---- windows & panels
        Cmd("window.new", "New window", "Window", () => AppHost.OpenWindow(Profile, false, null, false), "Ctrl+N", "");
        Cmd("window.private", "New private window", "Window", () => AppHost.OpenWindow(Profile, true), "Ctrl+Shift+N", "incognito guest");
        Cmd("window.close", "Close window", "Window", Close, "Ctrl+Shift+W");
        Cmd("view.fullscreen", "Toggle full screen", "Window", () => SetFullscreen(!IsFullscreen), "F11", "presentation");
        Cmd("ui.escape", "Close the topmost overlay", "Window", () => { if (FindBar.Visibility == Visibility.Visible) CloseFind(); else if (IsFullscreen) SetFullscreen(false); }, "Escape", "", () => FindBar.Visibility == Visibility.Visible || IsFullscreen, true);
        Cmd("palette.open", "Command bar", "Window", () => ShowCommandPalette(), "Ctrl+K", "actions search commands");
        Cmd("panel.bookmarks", "Bookmarks panel", "Panels", () => _ = TogglePanelAsync("bookmarks", "Bookmarks", "wiisb://bookmarks/?panel=1"), "Ctrl+Shift+O", "favorites");
        Cmd("panel.history", "History panel", "Panels", () => _ = TogglePanelAsync("history", "History", "wiisb://history/?panel=1"), null);
        Cmd("panel.notes", "Notes panel", "Panels", () => _ = TogglePanelAsync("notes", "Notes", "wiisb://notes/?panel=1"), null, "write memo");
        Cmd("panel.close", "Close side panel", "Panels", ClosePanel, null, "", () => _activePanelKey is not null);
        Cmd("page.history", "History", "Pages", () => OpenInternal("history"), "Ctrl+H", "visited past");
        Cmd("page.downloads", "Downloads", "Pages", () => OpenInternal("downloads"), "Ctrl+J", "files");
        Cmd("page.bookmarks", "Bookmark manager", "Pages", () => OpenInternal("bookmarks"), null, "favorites organise");
        Cmd("page.settings", "Settings", "Pages", () => OpenInternal("settings"), null, "preferences options");
        Cmd("page.themes", "Themes", "Pages", () => OpenInternal("themes"), null, "appearance colors wallpaper");
        Cmd("page.performance", "WIISB Control (performance)", "Pages", () => OpenInternal("performance"), null, "memory cpu resource");
        Cmd("page.profiles", "Profiles", "Pages", () => OpenInternal("profiles"), null, "accounts");
        Cmd("page.extensions", "Extensions", "Pages", () => OpenInternal("extensions"), null, "addons");
        Cmd("page.notes", "Notes page", "Pages", () => OpenInternal("notes"), null);
        Cmd("page.about", "About WIISBROWSING", "Pages", () => OpenInternal("about"), null, "version help");
        Cmd("page.help", "Help and limitations", "Pages", () => OpenInternal("help"), null, "docs");

        // ---- page tools
        Cmd("bookmark.toggle", "Bookmark this page", "Page", () => { if (Tabs.ActiveTab is { } t) ToggleBookmark(t); }, "Ctrl+D", "favorite star", () => HasTab);
        Cmd("page.find", "Find in page", "Page", ShowFind, "Ctrl+F", "search text", () => HasPage);
        Cmd("page.print", "Print", "Page", PrintPage, "Ctrl+P", "pdf", () => HasPage);
        Cmd("page.savePdf", "Save page as PDF", "Page", () => _ = SavePdfAsync(), null, "print", () => HasPage);
        Cmd("page.screenshot", "Take screenshot", "Page", () => _ = TakeScreenshotAsync(), null, "capture snip", () => HasPage);
        Cmd("page.reader", "Reader mode", "Page", () => _ = OpenReaderAsync(), null, "article clean distraction", () => HasPage);
        Cmd("page.readAloud", "Read aloud", "Page", () => _ = ReadAloudAsync(), null, "speech tts voice", () => HasPage);
        Cmd("page.stopReading", "Stop reading aloud", "Page", Speech.Stop, null, "speech");
        Cmd("page.devtools", "Developer tools", "Page", ShowDevTools, "F12", "inspect console network", () => HasPage);
        Cmd("page.devtools2", "Developer tools (alias)", "Page", ShowDevTools, "Ctrl+Shift+I", "", () => HasPage, true);
        Cmd("page.source", "View page source", "Page", () => { if (Tabs.ActiveTab is { } t && BookmarkStore.IsValidUrl(t.Url) && !t.IsInternal) Tabs.NewTab("view-source:" + t.Url, t); }, "Ctrl+U", "html", () => HasPage);
        Cmd("zoom.in", "Zoom in", "Page", () => ZoomBy(0.1), "Ctrl+Plus", "bigger", () => HasPage);
        Cmd("zoom.in2", "Zoom in (alias)", "Page", () => ZoomBy(0.1), "Ctrl+Add", "", () => HasPage, true);
        Cmd("zoom.out", "Zoom out", "Page", () => ZoomBy(-0.1), "Ctrl+Minus", "smaller", () => HasPage);
        Cmd("zoom.out2", "Zoom out (alias)", "Page", () => ZoomBy(-0.1), "Ctrl+Subtract", "", () => HasPage, true);
        Cmd("zoom.reset", "Reset zoom", "Page", () => SetZoom(1.0), "Ctrl+0", "", () => HasPage);
        Cmd("zoom.reset2", "Reset zoom (alias)", "Page", () => SetZoom(1.0), "Ctrl+NumPad0", "", () => HasPage, true);

        // ---- workspaces
        Cmd("workspace.new", "New workspace", "Workspaces", CreateWorkspaceDialog, null, "create space");
        Cmd("workspace.next", "Next workspace", "Workspaces", () => SwitchWorkspaceBy(1), "Ctrl+Alt+Right");
        Cmd("workspace.prev", "Previous workspace", "Workspaces", () => SwitchWorkspaceBy(-1), "Ctrl+Alt+Left");
        for (int i = 1; i <= 5; i++) { int n = i; Cmd($"workspace.go{n}", $"Go to workspace {n}", "Workspaces", () => { if (n <= Tabs.Workspaces.Count) Tabs.SwitchWorkspace(Tabs.Workspaces[n - 1]); }, $"Alt+{n}", "", null, true); }
        Cmd("workspace.moveTab", "Move tab to another workspace…", "Workspaces", ShowMoveToWorkspace, null, "send", () => HasTab);

        // ---- layout & look
        Cmd("layout.verticalLeft", "Tabs on the left (vertical)", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, "vertical-left"), null, "toggle vertical tabs sidebar");
        Cmd("layout.verticalRight", "Tabs on the right (vertical)", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, "vertical-right"));
        Cmd("layout.horizontal", "Tabs on top (horizontal)", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, "horizontal"), null, "traditional");
        Cmd("layout.compact", "Compact tab rail", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, "compact"), null, "narrow icons");
        Cmd("layout.hidden", "Hide the tab strip", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, "hidden"), null, "keyboard only");
        Cmd("layout.toggleVertical", "Toggle vertical tabs", "Appearance", () => Data.Settings.Set(SettingKeys.TabLayout, Data.Settings.Get(SettingKeys.TabLayout) is "horizontal" ? "vertical-left" : "horizontal"), null, "horizontal");
        Cmd("bookmarkbar.toggle", "Toggle bookmarks bar", "Appearance", () => { Data.Settings.Set(SettingKeys.BookmarkBar, Data.Settings.Get(SettingKeys.BookmarkBar) == "always" ? "never" : "always"); });
        foreach (var theme in ThemeCatalogList()) { var id = theme.Id; Cmd("theme." + id, "Switch theme: " + theme.Name, "Appearance", () => AppHost.Theme.Select(id), null, "color style look"); }
        Cmd("theme.next", "Next theme", "Appearance", () => { var all = AppHost.Theme.All.ToList(); var i = all.FindIndex(t => t.Id == AppHost.Theme.Current.Id); AppHost.Theme.Select(all[(i + 1) % all.Count].Id); }, null, "cycle");

        // ---- privacy & performance
        Cmd("adblock.toggle", "Turn ad blocking on or off", "Privacy", () => { var on = !Data.Settings.GetBool(SettingKeys.AdBlockEnabled); Data.Settings.SetBool(SettingKeys.AdBlockEnabled, on); ShowToast(on ? "Ad blocking is on." : "Ad blocking is off."); }, null, "ads shield tracker");
        Cmd("privacy.clearHistory", "Clear browsing history…", "Privacy", ClearHistoryCommand, "Ctrl+Shift+Delete", "delete erase", () => !IsPrivate);
        Cmd("privacy.clearSiteData", "Clear cookies and site data…", "Privacy", () => _ = ClearAllSiteDataAsync(), null, "cookies storage cache");
        Cmd("gaming.toggle", "Gaming mode on or off", "Performance", () => { var on = !Data.Settings.GetBool(SettingKeys.GamingMode); Data.Settings.SetBool(SettingKeys.GamingMode, on); ShowToast(on ? "Gaming mode: calmer animations and quicker tab sleeping." : "Gaming mode is off."); }, null, "game opera gx");
        Cmd("perf.balanced", "Memory mode: Balanced", "Performance", () => Data.Settings.Set(SettingKeys.PerfMode, "balanced"));
        Cmd("perf.aggressive", "Memory mode: Aggressive (sleep tabs sooner)", "Performance", () => Data.Settings.Set(SettingKeys.PerfMode, "aggressive"));
        Cmd("perf.off", "Memory mode: Off (never sleep tabs)", "Performance", () => { Data.Settings.Set(SettingKeys.PerfMode, "off"); Data.Settings.SetInt(SettingKeys.SleepMinutes, 0); });
        Cmd("app.setDefault", "Set WIISBROWSING as the default browser…", "System", OpenDefaultAppsSettings, null, "default windows");
        Cmd("app.exit", "Exit WIISBROWSING", "System", () => { foreach (var w in AppHost.Windows.ToList()) w.Close(); }, "Alt+F4", "quit close all", null, true);

        // Keyboard map: defaults from the commands, overridden by the user's saved choices.
        var overrides = Data.Settings.GetJson<Dictionary<string, string>>(SettingKeys.Shortcuts);
        Shortcuts = ShortcutMap.WithDefaults(Commands.All, overrides);
    }

    private const string Environment_NewLine = "\r\n";

    private static IEnumerable<Core.Themes.ThemeDef> ThemeCatalogList() => Core.Themes.ThemeCatalog.BuiltIn;

    private void SwitchWorkspaceBy(int delta)
    {
        var visible = Tabs.Workspaces.Where(w => !w.Hidden || w.IsActive).ToList();
        int i = visible.IndexOf(Tabs.ActiveWorkspace);
        if (visible.Count > 0) Tabs.SwitchWorkspace(visible[(i + delta + visible.Count) % visible.Count]);
    }

    private void ShowMoveToWorkspace()
    {
        if (Tabs.ActiveTab is not { } tab) return;
        var items = Tabs.Workspaces.Where(w => w.Id != tab.WorkspaceId)
            .Select(w => new PaletteItem($"{w.Icon}  {w.Name}", "Move this tab here", "", "", () => Tabs.MoveToWorkspace(tab, w))).ToList();
        PaletteWindow.Show(this, "Move tab to…", _ => items);
    }

    private void BookmarkAllTabs()
    {
        var folder = Data.Bookmarks.AddFolder($"Tabs {DateTime.Now:d MMM HH:mm}");
        int n = 0;
        foreach (var t in Tabs.TabsOf(Tabs.ActiveWorkspace.Id).Where(t => BookmarkStore.IsValidUrl(t.Url) && !t.IsInternal)) { Data.Bookmarks.Add(t.Url, t.DisplayTitle, folder); n++; }
        ShowToast($"Bookmarked {n} tab{(n == 1 ? "" : "s")} in a new folder.");
        UpdateBookmarkBar();
    }

    private async void HardReload()
    {
        if (Tabs.ActiveTab?.View?.Core is not { } core) return;
        try { await core.CallDevToolsProtocolMethodAsync("Page.reload", "{\"ignoreCache\":true}"); }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException or ArgumentException) { core.Reload(); }
    }

    private void ClearHistoryCommand()
    {
        if (Data.History is null) return;
        var choice = Dialogs.Choose(this, "Clear browsing history", "Which history do you want to remove? Bookmarks, passwords and downloaded files are kept.",
            new[] { "Last hour", "Today", "Everything", "Cancel" });
        var now = HistoryStore.NowMs();
        switch (choice)
        {
            case 0: Data.History.DeleteRange(now - 3_600_000, now + 1000); break;
            case 1: Data.History.DeleteRange(DateTimeOffset.Now.Date.ToUniversalTime().Ticks / 10_000 - DateTimeOffset.UnixEpoch.Ticks / 10_000, now + 1000); break;
            case 2: Data.History.Clear(); break;
            default: return;
        }
        ShowToast("History cleared. Cookies and cached files are separate — clear them from “Clear cookies and site data”.");
    }

    private async Task ClearAllSiteDataAsync()
    {
        if (!Dialogs.Confirm(this, "Clear cookies and site data?", "You'll be signed out of websites in this profile. Bookmarks, history and downloads are kept.", "Clear", "Cancel")) return;
        var core = Tabs.AllTabs.Select(t => t.View?.Core).FirstOrDefault(c => c is not null);
        if (core is null) { ShowToast("Open a page first, then try again."); return; }
        try
        {
            await core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.AllSite | CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage);
            ShowToast("Cookies, site data and cached files were cleared.");
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { ShowToast("Couldn't clear the site data."); }
    }

    private void OpenDefaultAppsSettings()
    {
        // Windows decides the default browser; the app can only open the page where the user chooses.
        try { Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { ShowToast("Open Windows Settings → Apps → Default apps and choose WIISBROWSING."); }
    }

    // ---- palette & tab search ----------------------------------------------------------------------------------------------------------

    public void ShowCommandPalette(string initial = "")
    {
        PaletteWindow.Show(this, "Type a command, a tab, a bookmark or an address…", q =>
        {
            var items = new List<PaletteItem>();
            q = q.Trim();
            bool commandOnly = q.StartsWith('>');
            foreach (var c in Commands.Search(q, 9))
            {
                var cmd = c;
                items.Add(new PaletteItem(cmd.Name, cmd.Category, "", ShortcutText(cmd.Id) ?? "", () => Commands.Execute(cmd.Id)));
            }
            if (q.Length > 0 && !commandOnly)
            {
                var target = UrlClassifier.Classify(q, CurrentSearchEngine());
                if (target.Kind is NavKind.Url or NavKind.Search or NavKind.Internal)
                    items.Insert(Math.Min(1, items.Count), new PaletteItem(target.Kind == NavKind.Search ? $"Search for “{q}”" : $"Go to {q}", target.Kind == NavKind.Search ? CurrentSearchEngine().Name : target.Url, target.Kind == NavKind.Search ? "" : "", "", () => Open(target.Url, false)));
                foreach (var t in TabsMatching(q).Take(4))
                {
                    var tt = t;
                    items.Add(new PaletteItem(tt.Tab.DisplayTitle, $"Tab — {tt.Window.Tabs.Workspaces.FirstOrDefault(w => w.Id == tt.Tab.WorkspaceId)?.Name} · {tt.Tab.DisplayUrl}", "", "", () => ActivateRemote(tt.Window, tt.Tab)));
                }
                foreach (var b in Data.Bookmarks.Search(q, 3))
                {
                    var url = b.Url;
                    items.Add(new PaletteItem(b.Title, "Bookmark — " + b.Url, "", "", () => Open(url, false)));
                }
            }
            return items;
        }, initial);
    }

    public void ShowTabSearch()
    {
        PaletteWindow.Show(this, "Search open tabs by title or address…", q =>
        {
            var hits = string.IsNullOrWhiteSpace(q)
                ? AppHost.Windows.Where(w => w.IsPrivate == IsPrivate).SelectMany(w => w.Tabs.AllTabs.Select(t => (Window: w, Tab: t))).OrderByDescending(x => x.Tab.LastActive).Take(15)
                : TabsMatching(q).Take(15);
            return hits.Select(x => new PaletteItem(x.Tab.DisplayTitle,
                $"{x.Window.Tabs.Workspaces.FirstOrDefault(w => w.Id == x.Tab.WorkspaceId)?.Name}" + (x.Tab.IsClustered ? $" · {x.Window.Tabs.Clusters.FirstOrDefault(c => c.Id == x.Tab.ClusterId)?.Name}" : "") + $" · {x.Tab.DisplayUrl}" + (x.Tab.IsSleeping ? " · sleeping" : ""),
                x.Tab.IsPinned ? "" : "", "", () => ActivateRemote(x.Window, x.Tab))).ToList();
        });
    }

    private IEnumerable<(MainWindow Window, BrowserTab Tab)> TabsMatching(string q) =>
        AppHost.Windows.Where(w => w.IsPrivate == IsPrivate)   // private tabs are never listed from normal windows, or the other way round
            .SelectMany(w => w.Tabs.AllTabs.Select(t => (Window: w, Tab: t, Score: Fuzzy.Score(q, t.Title + " " + t.Url + " " + t.Marker))))
            .Where(x => x.Score is not null && !(x.Tab.IsInternal && x.Tab.Url == "wiisb://newtab"))
            .OrderByDescending(x => x.Score)
            .Select(x => (x.Window, x.Tab));

    private static void ActivateRemote(MainWindow w, BrowserTab tab)
    {
        w.BringToFront();
        w.Tabs.Activate(tab);   // switches workspace, expands the cluster and wakes the tab if needed
    }

    // ---- reader mode -------------------------------------------------------------------------------------------------------------------------

    private async Task OpenReaderAsync()
    {
        if (Tabs.ActiveTab is not { } tab || tab.View is not { IsReady: true } view) return;
        if (!BookmarkStore.IsValidUrl(tab.Url) || tab.IsInternal) { ShowToast("Reader mode works on web articles."); return; }
        var json = await view.RunScriptAsync(ReaderMode.ExtractScript);
        var article = ReaderMode.Parse(json);
        if (article is null) { ShowToast("This page doesn't look like an article, so reader mode isn't available."); return; }
        article.SourceUrl = tab.Url;
        var reader = Tabs.NewTab("wiisb://reader", tab);
        ReaderMode.Store(reader.Id, article);
    }
}
