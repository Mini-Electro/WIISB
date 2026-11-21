using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Views;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Themes;
using WIISBROWSING.Core.Urls;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

public static partial class InternalApi
{
    private static readonly HttpClient Download = new() { Timeout = TimeSpan.FromSeconds(60) };

    private static async Task<object?> DispatchExtraAsync(MainWindow w, BrowserTab tab, string cmd, JsonElement a)
    {
        var d = w.Data;
        switch (cmd)
        {
            case "about.info":
            {
                var asm = typeof(InternalApi).Assembly.GetName().Version?.ToString(3);
                return new
                {
                    version = asm, engine = AppHost.WebView2Version, dotnet = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
                    os = System.Runtime.InteropServices.RuntimeInformation.OSDescription, data = AppHost.Paths.Root, logs = AppHost.Paths.Logs, profile = w.Profile.Name,
                    profileFolder = AppHost.Profiles.FolderPath(w.Profile),
                };
            }
            case "update.info": return new { auto = UpdateService.AutoEnabled, version = typeof(InternalApi).Assembly.GetName().Version?.ToString(3), staged = UpdateService.Staged?.Offer.Version.ToString() };
            case "update.setAuto": UpdateService.SetAuto(B(a, "value")); return true;
            case "update.check": return await UpdateService.CheckNowAsync();
            case "about.openFolder": ShellOpenFolder(S(a, "which") == "logs" ? AppHost.Paths.Logs : AppHost.Paths.Root); return true;

            // ---- performance (WIISB Control) ----------------------------------------------------------------------------------------------
            case "perf.get": return ResourceMonitor.Snapshot(AppHost.Windows, w);
            case "perf.sleepTab":
                if (w.Tabs.Find(S(a, "id")) is { } t1) await w.SleepTabAsync(t1);
                return true;
            case "perf.tabs":
                return w.Tabs.AllTabs.Select(t => new
                {
                    t.Id, title = t.DisplayTitle, url = t.DisplayUrl, workspace = w.Tabs.Workspaces.FirstOrDefault(x => x.Id == t.WorkspaceId)?.Name,
                    state = t.IsSleeping ? "sleeping" : t.View is null ? "not loaded" : t == w.Tabs.ActiveTab ? "active" : "background", audible = t.IsAudible,
                    idleMinutes = (int)(DateTime.UtcNow - t.LastActive).TotalMinutes, canSleep = w.CanSleep(t), exempt = t.SleepExempt,
                });
            case "perf.wakeAll": return true;

            // ---- profiles -------------------------------------------------------------------------------------------------------------------------------
            case "profiles.list":
                return AppHost.Profiles.List().Select(p => new { p.Id, p.Name, p.Color, current = p.Id == w.Profile.Id, open = AppHost.IsProfileInUse(p.Id), p.CreatedAt });
            case "profiles.create":
            {
                var p = AppHost.Profiles.Create(S(a, "name"), S(a, "color", "#8B5CF6"));
                return new { id = p.Id };
            }
            case "profiles.rename": AppHost.Profiles.Rename(S(a, "id"), S(a, "name")); return true;
            case "profiles.open":
            {
                var p = AppHost.Profiles.Get(S(a, "id")) ?? throw new ApiException("That profile doesn't exist.");
                var existing = AppHost.Windows.FirstOrDefault(x => !x.IsPrivate && x.Profile.Id == p.Id);
                if (existing is not null) existing.BringToFront(); else AppHost.OpenWindow(p, false);
                return true;
            }
            case "profiles.delete":
            {
                var id = S(a, "id");
                if (AppHost.IsProfileInUse(id)) throw new ApiException("Close that profile's windows first.");
                AppHost.CloseProfile(id);
                AppHost.Profiles.Delete(id, B(a, "deleteData", true));
                return true;
            }

            // ---- extensions (only what WebView2 supports: unpacked extensions) ---------------------------------------------------------------------
            case "extensions.list": return await ListExtensionsAsync(w);
            case "extensions.add":
            {
                var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "Choose an unpacked extension folder (the one that contains manifest.json)" };
                if (dlg.ShowDialog(w) != true) return null;
                var manifest = Path.Combine(dlg.FolderName, "manifest.json");
                if (!File.Exists(manifest)) throw new ApiException("That folder has no manifest.json.");
                var info = new FileInfo(manifest);
                if (info.Length > 1_000_000) throw new ApiException("That manifest is too large.");
                using var mdoc = JsonDocument.Parse(await File.ReadAllTextAsync(manifest));
                if (!mdoc.RootElement.TryGetProperty("manifest_version", out var mv) || mv.ValueKind != JsonValueKind.Number || mv.GetInt32() is not (2 or 3))
                    throw new ApiException("Only extensions with manifest version 2 or 3 can be added.");
                var core = ProfileCore(w) ?? throw new ApiException("Open a web page first, then add the extension.");
                var ext = await core.Profile.AddBrowserExtensionAsync(dlg.FolderName);
                var paths = d.Settings.GetJson<Dictionary<string, string>>("ext.paths") ?? new();
                paths[ext.Id] = dlg.FolderName;
                d.Settings.SetJson("ext.paths", paths);
                return new { id = ext.Id, name = ext.Name };
            }
            case "extensions.enable":
            {
                var ext = await FindExtensionAsync(w, S(a, "id")) ?? throw new ApiException("Extension not found.");
                await ext.EnableAsync(B(a, "enabled"));
                return true;
            }
            case "extensions.remove":
            {
                var ext = await FindExtensionAsync(w, S(a, "id")) ?? throw new ApiException("Extension not found.");
                await ext.RemoveAsync();
                return true;
            }

            // ---- import from other browsers & backup -------------------------------------------------------------------------------------------------
            case "import.detect": return BookmarkImporter.Detect();
            case "import.run":
            {
                var (added, skipped, name) = BookmarkImporter.Run(S(a, "id"), d.Bookmarks);
                return new { added, skipped, name };
            }
            case "backup.export": return await ExportBackupAsync(w);
            case "backup.import": return await ImportBackupAsync(w);

            default: throw new ApiException("Unknown command.");
        }
    }

    private static CoreWebView2? ProfileCore(MainWindow w) =>
        w.Tabs.AllTabs.Select(t => t.View?.Core).FirstOrDefault(c => c is not null);

    private static async Task<IReadOnlyList<CoreWebView2BrowserExtension>> ExtensionsAsync(MainWindow w)
    {
        var core = ProfileCore(w);
        return core is null ? Array.Empty<CoreWebView2BrowserExtension>() : await core.Profile.GetBrowserExtensionsAsync();
    }

    private static async Task<CoreWebView2BrowserExtension?> FindExtensionAsync(MainWindow w, string id) =>
        (await ExtensionsAsync(w)).FirstOrDefault(e => e.Id == id);

    private static async Task<object> ListExtensionsAsync(MainWindow w)
    {
        var paths = w.Data.Settings.GetJson<Dictionary<string, string>>("ext.paths") ?? new();
        var list = new List<object>();
        foreach (var e in await ExtensionsAsync(w))
        {
            string[] perms = Array.Empty<string>();
            if (paths.TryGetValue(e.Id, out var folder) && File.Exists(Path.Combine(folder, "manifest.json")))
            {
                try
                {
                    using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(folder, "manifest.json")));
                    if (doc.RootElement.TryGetProperty("permissions", out var p) && p.ValueKind == JsonValueKind.Array)
                        perms = p.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToArray();
                }
                catch (Exception ex) when (ex is JsonException or IOException) { }
            }
            list.Add(new { e.Id, e.Name, enabled = e.IsEnabled, permissions = perms });
        }
        return new { extensions = list, available = ProfileCore(w) is not null };
    }

    private static void ShellOpenFolder(string path)
    {
        try { Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    // ---- filter lists ---------------------------------------------------------------------------------------------------------------------

    /// <summary>Downloads the public EasyList / EasyPrivacy lists when the user asks. They are saved untouched in the browser's data folder.</summary>
    private static async Task<object> UpdateFilterListsAsync()
    {
        var results = new List<object>();
        foreach (var (name, url) in new[] { ("easylist.txt", "https://easylist.to/easylist/easylist.txt"), ("easyprivacy.txt", "https://easylist.to/easylist/easyprivacy.txt") })
        {
            try
            {
                using var resp = await Download.GetAsync(url);
                resp.EnsureSuccessStatusCode();
                var text = await resp.Content.ReadAsStringAsync();
                if (text.Length < 1000 || text.Length > 20_000_000 || !text.Contains("Adblock", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unexpected file.");
                await File.WriteAllTextAsync(Path.Combine(AppHost.Paths.AdBlockLists, name), text);
                results.Add(new { name, ok = true, bytes = text.Length });
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidDataException or IOException)
            {
                results.Add(new { name, ok = false, error = ex.Message });
            }
        }
        AppHost.ReloadAdBlock();
        return new { results, rules = AppHost.AdBlock.RuleCount, unsupported = AppHost.AdBlock.UnsupportedLines };
    }

    private static async Task<object> ClearBrowsingDataAsync(MainWindow w, string kind)
    {
        var d = w.Data;
        if (kind == "history") { d.History?.Clear(); }
        var core = ProfileCore(w);
        if (core is null) return new { ok = kind == "history", note = "Open a page first to clear engine data." };
        var kinds = kind switch
        {
            "cookies" => CoreWebView2BrowsingDataKinds.Cookies,
            "cache" => CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage,
            "sitedata" => CoreWebView2BrowsingDataKinds.AllSite,
            "all" => CoreWebView2BrowsingDataKinds.AllSite | CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage | CoreWebView2BrowsingDataKinds.BrowsingHistory,
            _ => (CoreWebView2BrowsingDataKinds)0,
        };
        if (kind == "all") d.History?.Clear();
        if (kinds != 0) await core.Profile.ClearBrowsingDataAsync(kinds);
        return new { ok = true };
    }

    // ---- backup -----------------------------------------------------------------------------------------------------------------------------

    private sealed class Backup
    {
        public int Version { get; set; } = 1;
        public string App { get; set; } = "WIISBROWSING";
        public List<BackupFolder> Folders { get; set; } = new();
        public List<BackupBookmark> Bookmarks { get; set; } = new();
        public List<SpeedDialEntry> SpeedDial { get; set; } = new();
        public List<Note> Notes { get; set; } = new();
        public List<ThemeDef> Themes { get; set; } = new();
        public List<WorkspaceRecord> Workspaces { get; set; } = new();
    }

    private sealed record BackupFolder(long Id, long? ParentId, string Name);
    private sealed record BackupBookmark(long? FolderId, string Url, string Title);

    private static async Task<object> ExportBackupAsync(MainWindow w)
    {
        var d = w.Data;
        var b = new Backup
        {
            Folders = d.Bookmarks.AllFolders().Select(f => new BackupFolder(f.Id, f.ParentId, f.Name)).ToList(),
            Bookmarks = d.Bookmarks.All().Select(x => new BackupBookmark(x.FolderId, x.Url, x.Title)).ToList(),
            SpeedDial = d.SpeedDial.List().ToList(), Notes = d.Notes.List().ToList(), Themes = AppHost.Theme.Custom.ToList(),
            Workspaces = w.Tabs.Workspaces.Select((x, i) => new WorkspaceRecord(x.Id, x.Name, x.Icon, x.Color, i, x.Hidden)).ToList(),
        };
        var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "WIISBROWSING backup (*.wiisbbackup)|*.wiisbbackup", FileName = $"WIISBROWSING backup {DateTime.Now:yyyy-MM-dd}" };
        if (dlg.ShowDialog(w) != true) return new { saved = false };
        await File.WriteAllTextAsync(dlg.FileName, JsonSerializer.Serialize(b, new JsonSerializerOptions { WriteIndented = true }));
        return new { saved = true, bookmarks = b.Bookmarks.Count, notes = b.Notes.Count, themes = b.Themes.Count, note = "The backup has bookmarks, notes, Speed Dial, workspaces and custom themes. It does not contain cookies, passwords or history." };
    }

    private static async Task<object?> ImportBackupAsync(MainWindow w)
    {
        var d = w.Data;
        var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "WIISBROWSING backup (*.wiisbbackup)|*.wiisbbackup", Title = "Restore from a backup" };
        if (dlg.ShowDialog(w) != true) return null;
        var info = new FileInfo(dlg.FileName);
        if (info.Length > 50_000_000) throw new ApiException("That file is too large to be a backup.");
        Backup? b;
        try { b = JsonSerializer.Deserialize<Backup>(await File.ReadAllTextAsync(dlg.FileName)); }
        catch (JsonException) { throw new ApiException("That isn't a valid WIISBROWSING backup."); }
        if (b is null || b.App != "WIISBROWSING" || b.Version != 1) throw new ApiException("That backup isn't from a compatible version.");

        // Merge, never overwrite: existing items stay untouched.
        var map = new Dictionary<long, long>();
        foreach (var f in b.Folders.OrderBy(f => f.ParentId is null ? 0 : 1))
            map[f.Id] = d.Bookmarks.AddFolder(f.Name, f.ParentId is { } p && map.TryGetValue(p, out var np) ? np : null);
        int added = 0;
        foreach (var bm in b.Bookmarks)
        {
            if (!BookmarkStore.IsValidUrl(bm.Url) || d.Bookmarks.IsBookmarked(bm.Url)) continue;
            d.Bookmarks.Add(bm.Url, bm.Title, bm.FolderId is { } fid && map.TryGetValue(fid, out var nf) ? nf : null);
            added++;
        }
        var haveUrls = d.SpeedDial.List().Select(s => s.Url).ToHashSet();
        foreach (var s in b.SpeedDial.Where(s => !haveUrls.Contains(s.Url) && BookmarkStore.IsValidUrl(s.Url))) d.SpeedDial.Add(s.Title, s.Url);
        foreach (var n in b.Notes) d.Notes.Add(n.Title, n.Body, n.Url);
        int themes = 0;
        foreach (var t in b.Themes) { if (ThemeCatalog.TryValidate(t, out _)) { t.Id = ""; AppHost.Theme.SaveCustom(t); themes++; } }
        return new { bookmarks = added, notes = b.Notes.Count, themes };
    }
}

/// <summary>Measures the browser's own processes (the app plus the WebView2 processes it started).</summary>
public static class ResourceMonitor
{
    private static readonly Dictionary<int, (TimeSpan Cpu, DateTime At)> Last = new();

    public static object Snapshot(IEnumerable<MainWindow> windows, MainWindow current)
    {
        var now = DateTime.UtcNow;
        var pids = new Dictionary<int, string> { [Environment.ProcessId] = "Browser app" };
        foreach (var env in windows.Select(x => x.Environment).Where(e => e is not null).Distinct())
        {
            try { foreach (var p in env!.GetProcessInfos()) pids[p.ProcessId] = p.Kind.ToString(); }
            catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
        }
        long totalMem = 0; double totalCpu = 0;
        var rows = new List<object>();
        foreach (var (pid, kind) in pids)
        {
            try
            {
                using var proc = Process.GetProcessById(pid);
                long mem = proc.WorkingSet64;
                double cpu = 0;
                var cpuTime = proc.TotalProcessorTime;
                if (Last.TryGetValue(pid, out var prev) && now > prev.At)
                    cpu = Math.Max(0, (cpuTime - prev.Cpu).TotalSeconds / (now - prev.At).TotalSeconds / Environment.ProcessorCount * 100);
                Last[pid] = (cpuTime, now);
                totalMem += mem; totalCpu += cpu;
                rows.Add(new { pid, kind, memoryMb = Math.Round(mem / 1048576.0, 1), cpu = Math.Round(cpu, 1) });
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { Last.Remove(pid); }
        }
        var all = windows.SelectMany(x => x.Tabs.AllTabs).ToList();
        return new
        {
            memoryMb = Math.Round(totalMem / 1048576.0, 0), cpu = Math.Round(totalCpu, 1), processes = rows.Count, processList = rows,
            tabs = all.Count, tabsActive = all.Count(t => t.View is not null), tabsSleeping = all.Count(t => t.IsSleeping), windows = windows.Count(),
            downloads = current.Downloads.ActiveCount, adblockTotal = AppHost.AdBlock.Counters.Total,
            mode = current.Data.Settings.Get(SettingKeys.PerfMode), sleepMinutes = current.Data.Settings.GetInt(SettingKeys.SleepMinutes, 30), gaming = current.Data.Settings.GetBool(SettingKeys.GamingMode),
            cores = Environment.ProcessorCount,
        };
    }
}

/// <summary>Reads bookmarks from other browsers' own files. Source files are only read (Firefox's database is read from a temporary copy).</summary>
public static class BookmarkImporter
{
    private sealed record Source(string Id, string Name, string Path, bool Firefox);

    private static IEnumerable<Source> Sources()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        yield return new("chrome", "Google Chrome", Path.Combine(local, @"Google\Chrome\User Data\Default\Bookmarks"), false);
        yield return new("edge", "Microsoft Edge", Path.Combine(local, @"Microsoft\Edge\User Data\Default\Bookmarks"), false);
        yield return new("brave", "Brave", Path.Combine(local, @"BraveSoftware\Brave-Browser\User Data\Default\Bookmarks"), false);
        yield return new("vivaldi", "Vivaldi", Path.Combine(local, @"Vivaldi\User Data\Default\Bookmarks"), false);
        yield return new("opera", "Opera", Path.Combine(roaming, @"Opera Software\Opera Stable\Bookmarks"), false);
        yield return new("operagx", "Opera GX", Path.Combine(roaming, @"Opera Software\Opera GX Stable\Bookmarks"), false);
        var ff = Path.Combine(roaming, @"Mozilla\Firefox\Profiles");
        if (Directory.Exists(ff))
        {
            var db = Directory.GetDirectories(ff).Select(p => Path.Combine(p, "places.sqlite")).Where(File.Exists).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
            if (db is not null) yield return new("firefox", "Mozilla Firefox", db, true);
        }
    }

    public static IEnumerable<object> Detect() =>
        Sources().Where(s => File.Exists(s.Path)).Select(s => new { s.Id, s.Name, bookmarks = true, note = "Bookmarks. History and passwords are not imported." });

    public static (int Added, int Skipped, string Name) Run(string id, BookmarkStore store)
    {
        var src = Sources().FirstOrDefault(s => s.Id == id && File.Exists(s.Path)) ?? throw new InternalApi.ApiException("That browser's data wasn't found.");
        var root = store.AddFolder("Imported from " + src.Name);
        return src.Firefox ? ImportFirefox(src, store, root) : ImportChromium(src, store, root);
    }

    private static (int, int, string) ImportChromium(Source src, BookmarkStore store, long root)
    {
        int added = 0, skipped = 0;
        var tmp = Path.Combine(Path.GetTempPath(), "wiisb-import-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            File.Copy(src.Path, tmp, true);
            using var doc = JsonDocument.Parse(File.ReadAllText(tmp));
            if (!doc.RootElement.TryGetProperty("roots", out var roots)) return (0, 0, src.Name);
            void Walk(JsonElement node, long parent, int depth)
            {
                if (depth > 20 || !node.TryGetProperty("children", out var kids) || kids.ValueKind != JsonValueKind.Array) return;
                foreach (var k in kids.EnumerateArray())
                {
                    var type = k.TryGetProperty("type", out var t) ? t.GetString() : "";
                    var name = k.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                    if (type == "folder") Walk(k, store.AddFolder(string.IsNullOrWhiteSpace(name) ? "Folder" : name, parent), depth + 1);
                    else if (type == "url" && k.TryGetProperty("url", out var u) && Uri.TryCreate(u.GetString(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") { store.Add(uri.AbsoluteUri, name, parent); added++; }
                    else skipped++;
                }
            }
            foreach (var r in roots.EnumerateObject().Where(r => r.Value.ValueKind == JsonValueKind.Object)) Walk(r.Value, root, 0);
        }
        catch (Exception ex) when (ex is JsonException or IOException) { throw new InternalApi.ApiException("Couldn't read that browser's bookmarks: " + ex.Message); }
        finally { try { File.Delete(tmp); } catch (IOException) { } }
        return (added, skipped, src.Name);
    }

    private static (int, int, string) ImportFirefox(Source src, BookmarkStore store, long root)
    {
        int added = 0, skipped = 0;
        var tmp = Path.Combine(Path.GetTempPath(), "wiisb-ff-" + Guid.NewGuid().ToString("N") + ".sqlite");
        try
        {
            File.Copy(src.Path, tmp, true);
            foreach (var ext in new[] { "-wal", "-shm" }) if (File.Exists(src.Path + ext)) File.Copy(src.Path + ext, tmp + ext, true);
            using var conn = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = tmp, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
            conn.Open();
            var nodes = new List<(long Id, long Parent, int Type, string Title, string? Url)>();
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "SELECT b.id, b.parent, b.type, COALESCE(b.title,''), p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position";
                using var r = cmd.ExecuteReader();
                while (r.Read()) nodes.Add((r.GetInt64(0), r.GetInt64(1), r.GetInt32(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)));
            }
            void Walk(long firefoxParent, long ours, int depth)
            {
                if (depth > 20) return;
                foreach (var n in nodes.Where(n => n.Parent == firefoxParent))
                {
                    if (n.Type == 2) Walk(n.Id, store.AddFolder(string.IsNullOrWhiteSpace(n.Title) ? "Folder" : n.Title, ours), depth + 1);
                    else if (n.Type == 1 && Uri.TryCreate(n.Url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") { store.Add(uri.AbsoluteUri, n.Title, ours); added++; }
                    else if (n.Type == 1) skipped++;
                }
            }
            Walk(1, root, 0); // 1 = Firefox's root folder
        }
        catch (Exception ex) when (ex is SqliteException or IOException) { throw new InternalApi.ApiException("Couldn't read Firefox's bookmarks: " + ex.Message); }
        finally { foreach (var f in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(tmp) + "*")) { try { File.Delete(f); } catch (IOException) { } } }
        return (added, skipped, src.Name);
    }
}
