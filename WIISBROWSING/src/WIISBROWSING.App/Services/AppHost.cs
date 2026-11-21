using System.IO;
using System.Windows;
using WIISBROWSING.App.Views;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Privacy;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>The composition root: the things that exist once per application, and the list of open windows.</summary>
public static class AppHost
{
    private static readonly Dictionary<string, ProfileData> OpenProfiles = new();

    public static AppPaths Paths { get; private set; } = null!;
    public static SqliteDb AppDb { get; private set; } = null!;
    public static SettingsStore AppSettings { get; private set; } = null!;
    public static ProfileRegistry Profiles { get; private set; } = null!;
    public static ThemeManager Theme { get; private set; } = null!;
    public static WebEnvironments Envs { get; private set; } = null!;
    public static FaviconCache Favicons { get; private set; } = null!;
    public static AdBlockEngine AdBlock { get; } = new();
    public static List<MainWindow> Windows { get; } = new();
    public static string WebView2Version { get; set; } = "";
    /// <summary>Developer end-to-end test: set by the --selftest command-line option.</summary>
    public static string? SelfTestDir { get; set; }

    public static void Init(string? dataRoot)
    {
        Paths = new AppPaths(dataRoot);
        AppLog.Init(Paths.Logs);
        AppLog.Info($"starting WIISBROWSING {typeof(AppHost).Assembly.GetName().Version}");
        AppDb = SqliteDb.Open(Paths.AppDb, Schema.App);
        AppSettings = new SettingsStore(AppDb, "app_settings");
        Profiles = new ProfileRegistry(AppDb, Paths.Profiles);
        Favicons = new FaviconCache(Paths.Favicons);
        Envs = new WebEnvironments(AppSettings);
        Theme = new ThemeManager(AppSettings);
        ReloadAdBlock();
    }

    public static ProfileData OpenProfile(ProfileInfo info)
    {
        lock (OpenProfiles)
        {
            if (!OpenProfiles.TryGetValue(info.Id, out var data))
            {
                data = ProfileData.Open(info, Profiles.DbPath(info));
                OpenProfiles[info.Id] = data;
            }
            return data;
        }
    }

    public static void CloseProfile(string id)
    {
        lock (OpenProfiles)
        {
            if (OpenProfiles.Remove(id, out var data)) data.Dispose();
        }
    }

    public static bool IsProfileInUse(string id) => Windows.Any(w => w.Profile.Id == id);

    /// <summary>Starter rules plus any filter lists the user downloaded into the adblock folder.</summary>
    public static void ReloadAdBlock()
    {
        var lines = new List<string>(AdBlockEngine.StarterRules());
        try
        {
            foreach (var file in Directory.GetFiles(Paths.AdBlockLists, "*.txt"))
                lines.AddRange(File.ReadLines(file));
        }
        catch (IOException ex) { AppLog.Warn("reading filter lists: " + ex.Message); }
        AdBlock.Load(lines);
        AppLog.Info($"ad blocking: {AdBlock.RuleCount} domain rules ({AdBlock.UnsupportedLines} unsupported lines skipped)");
    }

    public static MainWindow OpenWindow(ProfileInfo profile, bool isPrivate, IReadOnlyList<string>? urls = null, bool restoreSession = true)
    {
        var w = new MainWindow(profile, isPrivate, urls, restoreSession);
        Windows.Add(w);
        w.Closed += (_, _) =>
        {
            AppLog.Info($"window closed (private={w.IsPrivate}); {Windows.Count - 1} left");
            Windows.Remove(w);
            if (Windows.Count == 0) Application.Current.Shutdown();
        };
        w.Show();
        return w;
    }

    public static void Shutdown()
    {
        AppLog.Info("host shutdown: disposing profiles");
        foreach (var d in OpenProfiles.Values.ToList()) d.Dispose();
        OpenProfiles.Clear();
        AppDb.Dispose();
    }
}
