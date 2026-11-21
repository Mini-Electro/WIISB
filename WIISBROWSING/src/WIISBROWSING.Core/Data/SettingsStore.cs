using System.Globalization;
using System.Text.Json;

namespace WIISBROWSING.Core.Data;

public static class SettingKeys
{
    public const string StartupMode = "startup.mode";            // newtab | blank | url | restore
    public const string StartupUrls = "startup.urls";            // JSON string[]
    public const string HomeUrl = "home.url";
    public const string ConfirmCloseMany = "tabs.confirmCloseMany";
    public const string ThemeId = "theme.id";
    public const string CustomThemes = "theme.custom";           // JSON ThemeDef[]
    public const string ReduceMotion = "ui.reduceMotion";
    public const string TabLayout = "tabs.layout";               // vertical-left | vertical-right | horizontal | compact | hidden
    public const string TabPanelWidth = "tabs.width";
    public const string TabPreviews = "tabs.previews";
    public const string HighlightRecent = "tabs.highlightRecent";
    public const string AutoCluster = "tabs.autoCluster";       // off | suggest | auto
    public const string ClusterExclude = "tabs.clusterExclude";  // JSON string[] of domains
    public const string SidebarApps = "sidebar.apps";            // JSON SidebarApp[]
    public const string SidebarExpanded = "sidebar.expanded";
    public const string SidebarPanelWidth = "sidebar.panelWidth";
    public const string SearchEngine = "search.engine";
    public const string SearchCustom = "search.custom";
    public const string SearchSuggest = "search.suggestions";
    public const string BookmarkBar = "bookmarks.bar";           // always | newtab | never
    public const string TrackingMode = "privacy.tracking";       // off | balanced | strict
    public const string AdBlockEnabled = "privacy.adblock";
    public const string DownloadDir = "downloads.dir";
    public const string DownloadAsk = "downloads.ask";
    public const string SleepMinutes = "perf.sleepMinutes";      // 0 = never
    public const string PerfMode = "perf.mode";                  // off | balanced | aggressive
    public const string GamingMode = "perf.gaming";
    public const string MouseGestures = "input.gestures";
    public const string Shortcuts = "input.shortcuts";           // JSON {commandId: chord}
    public const string WallpaperPath = "newtab.wallpaper";
    public const string WallpaperBlur = "newtab.wallpaperBlur";
    public const string WallpaperDim = "newtab.wallpaperDim";
    public const string UserName = "newtab.userName";
    public const string FirstRunDone = "app.firstRunDone";
    public const string CleanShutdown = "session.clean";
    public const string ProxyMode = "net.proxyMode";             // system | none | custom
    public const string ProxyServer = "net.proxyServer";
    public const string UiScale = "ui.scale";
    public const string TabsOnLeftWidthCompact = "tabs.compact";
    public const string AutoUpdate = "updates.auto";             // app-wide: look for and download new versions in the background
}

/// <summary>Key/value settings with defaults. Used for both the app database and each profile database.</summary>
public sealed class SettingsStore
{
    private readonly SqliteDb _db;
    private readonly string _table;
    private readonly Dictionary<string, string> _cache = new();
    private readonly object _gate = new();

    public event Action<string>? Changed;

    public static readonly IReadOnlyDictionary<string, string> Defaults = new Dictionary<string, string>
    {
        [SettingKeys.StartupMode] = "restore",
        [SettingKeys.HomeUrl] = "wiisb://newtab",
        [SettingKeys.ConfirmCloseMany] = "true",
        [SettingKeys.ThemeId] = "midnight",
        [SettingKeys.ReduceMotion] = "false",
        [SettingKeys.TabLayout] = "vertical-left",
        [SettingKeys.TabPanelWidth] = "236",
        [SettingKeys.TabPreviews] = "true",
        [SettingKeys.HighlightRecent] = "true",
        [SettingKeys.AutoCluster] = "suggest",
        [SettingKeys.SidebarExpanded] = "false",
        [SettingKeys.SidebarPanelWidth] = "380",
        [SettingKeys.SearchEngine] = "google",
        [SettingKeys.SearchSuggest] = "false",
        [SettingKeys.BookmarkBar] = "newtab",
        [SettingKeys.TrackingMode] = "balanced",
        [SettingKeys.AdBlockEnabled] = "true",
        [SettingKeys.DownloadAsk] = "false",
        [SettingKeys.SleepMinutes] = "30",
        [SettingKeys.PerfMode] = "balanced",
        [SettingKeys.GamingMode] = "false",
        [SettingKeys.MouseGestures] = "false",
        [SettingKeys.WallpaperBlur] = "0",
        [SettingKeys.WallpaperDim] = "35",
        [SettingKeys.ProxyMode] = "system",
        [SettingKeys.UiScale] = "100",
        [SettingKeys.AutoUpdate] = "true",
    };

    public SettingsStore(SqliteDb db, string table = "settings")
    {
        _db = db;
        _table = table;
        foreach (var (k, v) in db.Query($"SELECT key, value FROM {_table}", r => (r.GetString(0), r.GetString(1))))
            _cache[k] = v;
    }

    public string Get(string key, string? fallback = null)
    {
        lock (_gate)
        {
            if (_cache.TryGetValue(key, out var v)) return v;
        }
        return fallback ?? Defaults.GetValueOrDefault(key) ?? "";
    }

    public bool GetBool(string key, bool? fallback = null) =>
        bool.TryParse(Get(key, fallback?.ToString().ToLowerInvariant()), out var b) && b;

    public int GetInt(string key, int? fallback = null) =>
        int.TryParse(Get(key, fallback?.ToString(CultureInfo.InvariantCulture)), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : fallback ?? 0;

    public T? GetJson<T>(string key)
    {
        var raw = Get(key);
        if (string.IsNullOrWhiteSpace(raw)) return default;
        try { return JsonSerializer.Deserialize<T>(raw); }
        catch (JsonException) { return default; }
    }

    public void Set(string key, string value)
    {
        lock (_gate)
        {
            if (_cache.TryGetValue(key, out var old) && old == value) return;
            _cache[key] = value;
        }
        _db.Exec($"INSERT INTO {_table}(key, value) VALUES($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ("$k", key), ("$v", value));
        Changed?.Invoke(key);
    }

    public void SetBool(string key, bool value) => Set(key, value ? "true" : "false");
    public void SetInt(string key, int value) => Set(key, value.ToString(CultureInfo.InvariantCulture));
    public void SetJson<T>(string key, T value) => Set(key, JsonSerializer.Serialize(value));

    public void Remove(string key)
    {
        lock (_gate) _cache.Remove(key);
        _db.Exec($"DELETE FROM {_table} WHERE key = $k", ("$k", key));
        Changed?.Invoke(key);
    }

    public IReadOnlyDictionary<string, string> Snapshot()
    {
        lock (_gate) return new Dictionary<string, string>(_cache);
    }

    public void ResetAll()
    {
        List<string> keys;
        lock (_gate) { keys = _cache.Keys.ToList(); _cache.Clear(); }
        _db.Exec($"DELETE FROM {_table}");
        foreach (var k in keys) Changed?.Invoke(k);
    }
}
