using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Views;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Themes;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>
/// The commands the wiisb:// pages may use. Messages only arrive from pages whose address starts with wiisb://
/// (checked in TabWebView), every command is looked up in a fixed list, and every setting is validated before it is stored.
/// </summary>
public static partial class InternalApi
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.Never };

    public static string ThemeMessage(MainWindow w) =>
        JsonSerializer.Serialize(new { push = "theme", vars = AppHost.Theme.CssVariables(), dark = AppHost.Theme.Current.IsDark, animated = AppHost.Theme.Current.Animated, themeId = AppHost.Theme.Current.Id }, Json);

    public static async Task HandleAsync(MainWindow w, BrowserTab tab, string json)
    {
        string id = "";
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            id = root.TryGetProperty("id", out var idEl) ? idEl.ToString() : "";
            var cmd = root.TryGetProperty("cmd", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString()! : "";
            var args = root.TryGetProperty("args", out var a) ? a.Clone() : JsonDocument.Parse("{}").RootElement.Clone();
            var data = await DispatchAsync(w, tab, cmd, args);
            Reply(tab, id, true, data, null);
        }
        catch (ApiException ex) { Reply(tab, id, false, null, ex.Message); }
        catch (JsonException) { Reply(tab, id, false, null, "Bad request."); }
        catch (Exception ex)
        {
            // Any failure is reported back to the page (which shows it) and logged; it never goes unobserved.
            AppLog.Error("internal api", ex);
            Reply(tab, id, false, null, ex.Message);
        }
    }

    private static void Reply(BrowserTab tab, string id, bool ok, object? data, string? error)
    {
        if (string.IsNullOrEmpty(id)) return;
        tab.View?.PostJson(JsonSerializer.Serialize(new { id, ok, data, error }, Json));
    }

    public sealed class ApiException : Exception { public ApiException(string m) : base(m) { } }

    private static string S(JsonElement a, string k, string def = "") => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? def : def;
    private static long L(JsonElement a, string k, long def = 0) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : def;
    private static bool B(JsonElement a, string k, bool def = false) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : def;
    private static long[] Ids(JsonElement a, string k) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.Number).Select(e => e.GetInt64()).ToArray() : Array.Empty<long>();

    private static async Task<object?> DispatchAsync(MainWindow w, BrowserTab tab, string cmd, JsonElement a)
    {
        var d = w.Data;
        switch (cmd)
        {
            // ---- session of the page ------------------------------------------------------------------------------------
            case "init":
                return new
                {
                    page = Uri.TryCreate(tab.Url, UriKind.Absolute, out var u) ? u.Host : "",
                    panel = tab.Url.Contains("panel=1"),
                    tabId = tab.Id,
                    theme = AppHost.Theme.CssVariables(), dark = AppHost.Theme.Current.IsDark, animated = AppHost.Theme.Current.Animated, themeId = AppHost.Theme.Current.Id,
                    profile = new { name = w.Profile.Name, id = w.Profile.Id, color = w.Profile.Color, isPrivate = w.IsPrivate },
                    firstRun = !AppHost.AppSettings.GetBool(SettingKeys.FirstRunDone),
                    version = typeof(InternalApi).Assembly.GetName().Version?.ToString(3),
                    reduceMotion = AppHost.Theme.ReduceMotion,
                };

            case "welcome.complete":
                AppHost.AppSettings.SetBool(SettingKeys.FirstRunDone, true);
                return true;

            // ---- navigation & commands ---------------------------------------------------------------------------------------
            case "nav.open":
            {
                var t = UrlClassifier.Classify(S(a, "url"), w.CurrentSearchEngine());
                if (t.Kind is not (NavKind.Url or NavKind.Search or NavKind.Internal)) throw new ApiException(t.Reason ?? "That can't be opened.");
                if (B(a, "newTab")) w.Tabs.NewTab(t.Url, tab); else w.NavigateActive(t.Url);
                return true;
            }
            case "nav.search":
            {
                var t = UrlClassifier.Classify(S(a, "query"), w.CurrentSearchEngine());
                if (t.Kind is not (NavKind.Url or NavKind.Search or NavKind.Internal)) throw new ApiException(t.Reason ?? "That can't be opened.");
                w.NavigateActive(t.Url);
                return true;
            }
            case "cmd.run": return w.Commands.Execute(S(a, "id"));
            case "panel.close": w.Dispatcher.Invoke(() => w.Commands.Execute("panel.close")); return true;

            // ---- settings ----------------------------------------------------------------------------------------------------------
            case "settings.get":
            {
                var all = new Dictionary<string, string>();
                foreach (var k in SettingsStore.Defaults.Keys) all[k] = d.Settings.Get(k);
                foreach (var (k, v) in d.Settings.Snapshot()) if (IsKnownKey(k)) all[k] = v;
                return new { values = all, searchEngines = SearchEngines.BuiltIn.Select(e => new { e.Id, e.Name }), customValid = SearchEngines.TryValidateTemplate(d.Settings.Get(SettingKeys.SearchCustom), out _) };
            }
            case "settings.set":
            {
                var key = S(a, "key");
                var value = a.TryGetProperty("value", out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.GetRawText()) : "";
                if (value is "true" or "false") value = value.ToLowerInvariant();
                var err = ValidateSetting(key, value);
                if (err is not null) throw new ApiException(err);
                d.Settings.Set(key, value);
                return true;
            }
            case "settings.reset":
                d.Settings.ResetAll();
                return true;

            // ---- themes -----------------------------------------------------------------------------------------------------------------
            case "theme.list":
                return new
                {
                    current = AppHost.Theme.Current.Id,
                    themes = AppHost.Theme.All.Select(t => new { t.Id, t.Name, t.IsDark, t.BuiltIn, t.Colors, t.CornerRadius, t.Density, t.ShadowStrength, t.AnimationScale, t.FontFamily, t.Animated }),
                    tokens = Tokens.All,
                };
            case "theme.select": AppHost.Theme.Select(S(a, "id")); return true;
            case "theme.save":
            {
                var t = a.GetProperty("theme").Deserialize<ThemeDef>(Json) ?? throw new ApiException("Missing theme.");
                var saved = AppHost.Theme.SaveCustom(t);
                AppHost.Theme.Select(saved.Id);
                return new { id = saved.Id };
            }
            case "theme.delete": AppHost.Theme.DeleteCustom(S(a, "id")); return true;
            case "theme.export": return JsonSerializer.Serialize(AppHost.Theme.Find(S(a, "id")), new JsonSerializerOptions { WriteIndented = true });
            case "theme.import":
            {
                if (!ThemeCatalog.TryImport(S(a, "json"), out var t, out var err)) throw new ApiException(err);
                var saved = AppHost.Theme.SaveCustom(t!);
                AppHost.Theme.Select(saved.Id);
                return new { id = saved.Id };
            }
            case "theme.pickWallpaper":
            {
                var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp", Title = "Choose a background image" };
                if (dlg.ShowDialog(w) != true) return false;
                var err = ValidateSetting(SettingKeys.WallpaperPath, dlg.FileName);
                if (err is not null) throw new ApiException(err);
                d.Settings.Set(SettingKeys.WallpaperPath, dlg.FileName);
                return true;
            }
            case "theme.clearWallpaper": d.Settings.Remove(SettingKeys.WallpaperPath); return true;

            // ---- history ----------------------------------------------------------------------------------------------------------------------
            case "history.query":
            {
                if (d.History is null) return new { entries = Array.Empty<object>(), isPrivate = true };
                long now = HistoryStore.NowMs();
                long dayStart = new DateTimeOffset(DateTime.Now.Date).ToUnixTimeMilliseconds();
                (long? from, long? to) = S(a, "range") switch
                {
                    "today" => ((long?)dayStart, (long?)null), "yesterday" => (dayStart - 86_400_000, dayStart),
                    "week" => (now - 7L * 86_400_000, null), "month" => (now - 30L * 86_400_000, null), _ => (null, null),
                };
                var entries = d.History.Query(S(a, "text"), from, to, (int)L(a, "limit", 200), (int)L(a, "offset", 0));
                return new { entries = entries.Select(e => new { e.Id, e.Url, e.Title, e.VisitCount, e.LastVisit, host = UrlClassifier.HostOf(e.Url) }), isPrivate = false, total = d.History.Count() };
            }
            case "history.delete": d.History?.Delete(Ids(a, "ids")); return true;
            case "history.clearRange":
            {
                long now = HistoryStore.NowMs();
                long dayStart = new DateTimeOffset(DateTime.Now.Date).ToUnixTimeMilliseconds();
                switch (S(a, "range"))
                {
                    case "hour": d.History?.DeleteRange(now - 3_600_000, now + 1000); break;
                    case "today": d.History?.DeleteRange(dayStart, now + 1000); break;
                    case "week": d.History?.DeleteRange(now - 7L * 86_400_000, now + 1000); break;
                    default: d.History?.Clear(); break;
                }
                return true;
            }

            // ---- bookmarks -----------------------------------------------------------------------------------------------------------------------
            case "bookmarks.tree":
                return new
                {
                    folders = d.Bookmarks.AllFolders().Select(f => new { f.Id, f.ParentId, f.Name }),
                    bookmarks = d.Bookmarks.All().Select(b => new { b.Id, b.FolderId, b.Url, b.Title, b.CreatedAt, host = UrlClassifier.HostOf(b.Url) }),
                };
            case "bookmarks.add": { var id = d.Bookmarks.Add(S(a, "url"), S(a, "title"), a.TryGetProperty("folderId", out var f) && f.ValueKind == JsonValueKind.Number ? f.GetInt64() : null); return new { id }; }
            case "bookmarks.update": d.Bookmarks.Update(L(a, "id"), S(a, "url"), S(a, "title"), a.TryGetProperty("folderId", out var f2) && f2.ValueKind == JsonValueKind.Number ? f2.GetInt64() : null); return true;
            case "bookmarks.remove": foreach (var i in Ids(a, "ids")) d.Bookmarks.Remove(i); return true;
            case "bookmarks.move": foreach (var i in Ids(a, "ids")) d.Bookmarks.MoveBookmark(i, a.TryGetProperty("folderId", out var f3) && f3.ValueKind == JsonValueKind.Number ? f3.GetInt64() : null, 9999); return true;
            case "bookmarks.addFolder": return new { id = d.Bookmarks.AddFolder(S(a, "name"), a.TryGetProperty("parentId", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt64() : null) };
            case "bookmarks.renameFolder": d.Bookmarks.RenameFolder(L(a, "id"), S(a, "name")); return true;
            case "bookmarks.removeFolder": d.Bookmarks.RemoveFolder(L(a, "id")); return true;
            case "bookmarks.export":
            {
                var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "Bookmarks HTML (*.html)|*.html", FileName = "WIISBROWSING bookmarks.html" };
                if (dlg.ShowDialog(w) != true) return false;
                await File.WriteAllTextAsync(dlg.FileName, d.Bookmarks.ExportHtml());
                return true;
            }
            case "bookmarks.import":
            {
                var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "Bookmarks HTML (*.html;*.htm)|*.html;*.htm", Title = "Import bookmarks" };
                if (dlg.ShowDialog(w) != true) return null;
                var info = new FileInfo(dlg.FileName);
                if (info.Length > 20_000_000) throw new ApiException("That file is too large to be a bookmarks export.");
                var (added, skipped) = d.Bookmarks.ImportHtml(await File.ReadAllTextAsync(dlg.FileName));
                return new { added, skipped };
            }

            // ---- downloads ------------------------------------------------------------------------------------------------------------------------------
            case "downloads.list":
                return d.Downloads.List(300).Select(r =>
                {
                    var live = w.Downloads.Items.FirstOrDefault(i => i.Id == r.Id);
                    return new
                    {
                        r.Id, r.Url, r.FileName, r.Path, state = live?.State ?? r.State, total = live?.Total ?? r.TotalBytes, received = live?.Received ?? r.ReceivedBytes,
                        speed = live?.Speed ?? 0, r.StartedAt, exists = r.State == DownloadStates.Completed && File.Exists(r.Path), risky = live?.IsRisky ?? false,
                        host = UrlClassifier.HostOf(r.Url),
                    };
                });
            case "downloads.pause": if (Live(w, a) is { } p1) w.Downloads.Pause(p1); return true;
            case "downloads.resume": if (Live(w, a) is { } p2) w.Downloads.Resume(p2); return true;
            case "downloads.cancel": if (Live(w, a) is { } p3) w.Downloads.Cancel(p3); return true;
            case "downloads.remove":
                if (Live(w, a) is { } p4) w.Downloads.Remove(p4); else d.Downloads.Remove(L(a, "id"));
                return true;
            case "downloads.clear": w.Downloads.ClearFinished(); return true;
            case "downloads.open":
            {
                var r = d.Downloads.Get(L(a, "id"));
                if (r is null || !File.Exists(r.Path)) throw new ApiException("The file was moved or deleted.");
                w.OpenDownloadedFile(r.Path, r.FileName);
                return true;
            }
            case "downloads.folder": w.ShowInFolder(d.Downloads.Get(L(a, "id"))?.Path); return true;
            case "downloads.pickFolder":
            {
                var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "Choose where downloads are saved" };
                if (dlg.ShowDialog(w) != true) return null;
                d.Settings.Set(SettingKeys.DownloadDir, dlg.FolderName);
                return dlg.FolderName;
            }

            // ---- new tab page -------------------------------------------------------------------------------------------------------------------------------
            case "newtab.data": return NewTabData(w);
            case "speeddial.add": return new { id = d.SpeedDial.Add(S(a, "title"), NormalizeUrl(S(a, "url"))) };
            case "speeddial.update": d.SpeedDial.Update(L(a, "id"), S(a, "title"), NormalizeUrl(S(a, "url"))); return true;
            case "speeddial.remove": d.SpeedDial.Remove(L(a, "id")); return true;
            case "speeddial.reorder": d.SpeedDial.Reorder(Ids(a, "ids")); return true;
            case "workspace.switch": if (w.Tabs.Workspaces.FirstOrDefault(x => x.Id == S(a, "id")) is { } ws) w.Tabs.SwitchWorkspace(ws); return true;
            case "tab.reopen": w.Tabs.Reopen(); return true;

            // ---- notes -------------------------------------------------------------------------------------------------------------------------------------------
            case "notes.list": return d.Notes.List(S(a, "search")).Select(n => new { n.Id, n.Title, n.Body, n.Url, n.Pinned, n.UpdatedAt });
            case "notes.add":
            {
                var cur = w.Tabs.ActiveTab;
                bool attach = B(a, "attachPage") && cur is not null && BookmarkStore.IsValidUrl(cur.Url);
                return new { id = d.Notes.Add(S(a, "title"), S(a, "body"), attach ? cur!.Url : "", w.Tabs.ActiveWorkspace.Id) };
            }
            case "notes.update": d.Notes.Update(L(a, "id"), S(a, "title"), S(a, "body"), B(a, "pinned")); return true;
            case "notes.remove": d.Notes.Remove(L(a, "id")); return true;
            case "notes.export":
            {
                var n = d.Notes.Get(L(a, "id")) ?? throw new ApiException("Note not found.");
                var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "Markdown (*.md)|*.md|Text (*.txt)|*.txt", FileName = (string.IsNullOrWhiteSpace(n.Title) ? "Note" : n.Title) };
                if (dlg.ShowDialog(w) != true) return false;
                await File.WriteAllTextAsync(dlg.FileName, (string.IsNullOrWhiteSpace(n.Title) ? "" : "# " + n.Title + "\n\n") + n.Body + (n.Url.Length > 0 ? "\n\nSource: " + n.Url : ""));
                return true;
            }

            // ---- permissions & privacy -------------------------------------------------------------------------------------------------------------------------------------
            case "permissions.list": return d.Permissions.List().Select(p5 => new { p5.Origin, p5.Permission, p5.State, p5.UpdatedAt });
            case "permissions.revoke": d.Permissions.Revoke(S(a, "origin"), S(a, "permission")); return true;
            case "permissions.revokeAll": d.Permissions.RevokeAll(); return true;
            case "adblock.info":
                return new
                {
                    enabled = AppHost.AdBlock.Enabled, rules = AppHost.AdBlock.RuleCount, unsupported = AppHost.AdBlock.UnsupportedLines, total = AppHost.AdBlock.Counters.Total,
                    exceptions = d.AdBlockExceptions.List(), recent = AppHost.AdBlock.Counters.Recent(30).Select(r => new { r.Host, r.Rule, at = new DateTimeOffset(r.At).ToUnixTimeMilliseconds() }),
                    lists = Directory.Exists(AppHost.Paths.AdBlockLists) ? Directory.GetFiles(AppHost.Paths.AdBlockLists, "*.txt").Select(f => new { name = Path.GetFileName(f), size = new FileInfo(f).Length }) : null,
                };
            case "adblock.removeException": d.AdBlockExceptions.Remove(S(a, "host")); AppHost.AdBlock.SetSiteException(S(a, "host"), false); return true;
            case "adblock.resetCounters": AppHost.AdBlock.Counters.Reset(); return true;
            case "adblock.update": return await UpdateFilterListsAsync();
            case "data.clear": return await ClearBrowsingDataAsync(w, S(a, "kind"));

            // ---- keyboard shortcuts ------------------------------------------------------------------------------------------------------------------------------------------
            case "shortcuts.list":
                return w.Commands.All.Where(c => !c.Hidden).OrderBy(c => c.Category).ThenBy(c => c.Name)
                    .Select(c => new { c.Id, c.Name, c.Category, chord = w.Shortcuts.ChordFor(c.Id)?.ToString() ?? "", dflt = c.DefaultShortcut ?? "" });
            case "shortcuts.set": return w.SetShortcut(S(a, "id"), S(a, "chord"));
            case "shortcuts.reset": w.ResetShortcuts(); return true;

            // ---- reader ----------------------------------------------------------------------------------------------------------------------------------------------------------
            case "reader.get": return ReaderMode.Get(tab.Id) ?? throw new ApiException("Nothing to show. Open reader mode from an article.");
            case "speech.voices": return Speech.Voices();
            case "speech.speak": return Speech.Speak(S(a, "text"), S(a, "voice"), (int)L(a, "rate"));
            case "speech.stop": Speech.Stop(); return true;
            case "speech.pause": Speech.Pause(); return true;
            case "speech.resume": Speech.Resume(); return true;

            default:
                return await DispatchExtraAsync(w, tab, cmd, a);
        }
    }

    private static DownloadItem? Live(MainWindow w, JsonElement a) => w.Downloads.Items.FirstOrDefault(i => i.Id == L(a, "id"));

    private static string NormalizeUrl(string url)
    {
        url = url.Trim();
        if (!url.Contains("://")) url = "https://" + url;
        return Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme is "http" or "https") ? u.AbsoluteUri : throw new ApiException("Enter a web address such as https://example.com");
    }

    private static readonly string[] SeedSites = { "YouTube|https://www.youtube.com/", "Wikipedia|https://www.wikipedia.org/", "GitHub|https://github.com/", "Reddit|https://www.reddit.com/", "Twitch|https://www.twitch.tv/", "Gmail|https://mail.google.com/" };

    private static object NewTabData(MainWindow w)
    {
        var d = w.Data;
        if (d.SpeedDial.IsEmpty() && !d.Settings.GetBool("newtab.seeded"))
        {
            foreach (var s in SeedSites) { var parts = s.Split('|'); d.SpeedDial.Add(parts[0], parts[1]); }
            d.Settings.SetBool("newtab.seeded", true);
        }
        var wallpaper = d.Settings.Get(SettingKeys.WallpaperPath);
        return new
        {
            speedDial = d.SpeedDial.List().Select(s => new { s.Id, s.Title, s.Url, host = UrlClassifier.HostOf(s.Url) }),
            topSites = d.History?.TopSites(8).Select(h => new { h.Title, h.Url, host = UrlClassifier.HostOf(h.Url) }) ?? Enumerable.Empty<object>(),
            workspaces = w.Tabs.Workspaces.Select(x => new { x.Id, x.Name, x.Icon, x.Color, active = x.IsActive, tabs = w.Tabs.TabsOf(x.Id).Count() }),
            recentlyClosed = w.Tabs.RecentlyClosed.Reverse().Take(5).Select(c => new { c.Title, c.Url }),
            hasWallpaper = !string.IsNullOrEmpty(wallpaper) && File.Exists(wallpaper),
            wallpaperBlur = d.Settings.GetInt(SettingKeys.WallpaperBlur), wallpaperDim = d.Settings.GetInt(SettingKeys.WallpaperDim),
            userName = d.Settings.Get(SettingKeys.UserName), engine = w.CurrentSearchEngine().Name, isPrivate = w.IsPrivate,
            activeDownloads = w.Downloads.ActiveCount,
        };
    }

    // ---- settings validation -------------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> KnownKeys = new()
    {
        SettingKeys.StartupMode, SettingKeys.StartupUrls, SettingKeys.HomeUrl, SettingKeys.ConfirmCloseMany, SettingKeys.ReduceMotion, SettingKeys.TabLayout,
        SettingKeys.TabPanelWidth, SettingKeys.TabPreviews, SettingKeys.HighlightRecent, SettingKeys.AutoCluster, SettingKeys.ClusterExclude, SettingKeys.SearchEngine,
        SettingKeys.SearchCustom, SettingKeys.SearchSuggest, SettingKeys.BookmarkBar, SettingKeys.TrackingMode, SettingKeys.AdBlockEnabled, SettingKeys.DownloadDir,
        SettingKeys.DownloadAsk, SettingKeys.SleepMinutes, SettingKeys.PerfMode, SettingKeys.GamingMode, SettingKeys.MouseGestures, SettingKeys.WallpaperPath,
        SettingKeys.WallpaperBlur, SettingKeys.WallpaperDim, SettingKeys.UserName, SettingKeys.ProxyMode, SettingKeys.ProxyServer,
    };

    private static bool IsKnownKey(string k) => KnownKeys.Contains(k);

    public static string? ValidateSetting(string key, string value)
    {
        if (!KnownKeys.Contains(key)) return "Unknown setting.";
        static bool Bool(string v) => v is "true" or "false";
        static bool IntIn(string v, int lo, int hi) => int.TryParse(v, out var n) && n >= lo && n <= hi;
        return key switch
        {
            SettingKeys.StartupMode => value is "newtab" or "blank" or "url" or "restore" ? null : "Choose one of the listed start-up options.",
            SettingKeys.TabLayout => value is "vertical-left" or "vertical-right" or "horizontal" or "compact" or "hidden" ? null : "Unknown tab layout.",
            SettingKeys.AutoCluster => value is "off" or "suggest" ? null : "Unknown cluster mode.",
            SettingKeys.BookmarkBar => value is "always" or "newtab" or "never" ? null : "Unknown bookmarks bar mode.",
            SettingKeys.TrackingMode => value is "off" or "balanced" or "strict" ? null : "Unknown tracking mode.",
            SettingKeys.PerfMode => value is "off" or "balanced" or "aggressive" ? null : "Unknown memory mode.",
            SettingKeys.ProxyMode => value is "system" or "none" or "custom" ? null : "Unknown proxy mode.",
            SettingKeys.ConfirmCloseMany or SettingKeys.ReduceMotion or SettingKeys.TabPreviews or SettingKeys.HighlightRecent or SettingKeys.SearchSuggest
                or SettingKeys.AdBlockEnabled or SettingKeys.DownloadAsk or SettingKeys.GamingMode or SettingKeys.MouseGestures => Bool(value) ? null : "Expected on or off.",
            SettingKeys.TabPanelWidth => IntIn(value, 160, 420) ? null : "The tab panel can be 160–420 pixels wide.",
            SettingKeys.SleepMinutes => IntIn(value, 0, 1440) ? null : "Choose 0 (never) to 1440 minutes.",
            SettingKeys.WallpaperBlur => IntIn(value, 0, 30) ? null : "Blur must be 0–30.",
            SettingKeys.WallpaperDim => IntIn(value, 0, 90) ? null : "Dimming must be 0–90.",
            SettingKeys.SearchEngine => value == "custom" || SearchEngines.BuiltIn.Any(e => e.Id == value) ? null : "Unknown search engine.",
            SettingKeys.SearchCustom => value.Length == 0 || SearchEngines.TryValidateTemplate(value, out var err) ? null : err,
            SettingKeys.HomeUrl => UrlClassifier.Classify(value, SearchEngines.Default).Kind is NavKind.Url or NavKind.Internal ? null : "Enter a web address.",
            SettingKeys.StartupUrls => ValidateUrlList(value),
            SettingKeys.ClusterExclude => ValidateDomainList(value),
            SettingKeys.DownloadDir => value.Length == 0 || (Path.IsPathFullyQualified(value) && Directory.Exists(value)) ? null : "That folder doesn't exist.",
            SettingKeys.WallpaperPath => value.Length == 0 || (File.Exists(value) && new[] { ".png", ".jpg", ".jpeg", ".webp", ".bmp" }.Contains(Path.GetExtension(value).ToLowerInvariant()) && new FileInfo(value).Length <= 30 * 1024 * 1024) ? null : "Choose a PNG, JPEG, WebP or BMP image under 30 MB.",
            SettingKeys.UserName => value.Length <= 40 && !value.Any(char.IsControl) ? null : "Names can be up to 40 characters.",
            SettingKeys.ProxyServer => value.Length == 0 || WebEnvironments.ProxyServerIsValid(value) ? null : "Enter a proxy like proxy.example.com:8080.",
            _ => "Unknown setting.",
        };
    }

    private static string? ValidateUrlList(string json)
    {
        try
        {
            var list = JsonSerializer.Deserialize<string[]>(json);
            if (list is null || list.Length > 10) return "Up to 10 start pages.";
            return list.All(u => UrlClassifier.Classify(u, SearchEngines.Default).Kind is NavKind.Url or NavKind.Internal) ? null : "Every start page must be a web address.";
        }
        catch (JsonException) { return "Invalid list."; }
    }

    private static string? ValidateDomainList(string json)
    {
        try
        {
            var list = JsonSerializer.Deserialize<string[]>(json);
            if (list is null || list.Length > 200) return "Too many sites.";
            return list.All(d => d.Length is > 3 and < 100 && d.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-')) ? null : "Use plain domain names such as example.com.";
        }
        catch (JsonException) { return "Invalid list."; }
    }
}
