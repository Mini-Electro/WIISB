using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Privacy;
using WIISBROWSING.Core.Tabs;
using WIISBROWSING.Core.Updates;
using WIISBROWSING.Core.Themes;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.UnitTests;

public class FuzzyTests
{
    [Fact]
    public void Matches_subsequences_and_rejects_non_matches()
    {
        Assert.NotNull(Fuzzy.Score("nwtb", "New tab"));
        Assert.Null(Fuzzy.Score("xyz", "New tab"));
        Assert.Equal(0, Fuzzy.Score("", "anything"));
    }

    [Fact]
    public void Contiguous_and_prefix_matches_rank_higher()
    {
        Assert.True(Fuzzy.Score("new", "New tab") > Fuzzy.Score("new", "Open a window with news"));
        Assert.True(Fuzzy.Score("tab", "Tab search") > Fuzzy.Score("tab", "Switch to a different tab"));
    }

    [Fact]
    public void Every_word_must_match()
    {
        Assert.NotNull(Fuzzy.Score("close other", "Close other tabs"));
        Assert.Null(Fuzzy.Score("close banana", "Close other tabs"));
    }
}

public class CommandTests
{
    private static CommandRegistry Make(out List<string> log)
    {
        var l = new List<string>();
        log = l;
        var r = new CommandRegistry();
        r.Register(new BrowserCommand { Id = "tab.new", Name = "New tab", Category = "Tabs", DefaultShortcut = "Ctrl+T", Keywords = "open create", Execute = () => l.Add("new") });
        r.Register(new BrowserCommand { Id = "tab.closeOthers", Name = "Close other tabs", Category = "Tabs", Execute = () => l.Add("others") });
        r.Register(new BrowserCommand { Id = "ws.new", Name = "New workspace", Category = "Workspaces", Execute = () => l.Add("ws") });
        r.Register(new BrowserCommand { Id = "x.off", Name = "Not available right now", Category = "Misc", Execute = () => l.Add("off"), IsAvailable = () => false });
        r.Register(new BrowserCommand { Id = "x.none", Name = "No handler", Category = "Misc" });
        return r;
    }

    [Fact]
    public void Search_ranks_and_hides_unavailable_commands()
    {
        var r = Make(out _);
        var hits = r.Search("new");
        Assert.Contains(hits, c => c.Id == "tab.new");
        Assert.Contains(hits, c => c.Id == "ws.new");
        Assert.DoesNotContain(r.Search(""), c => c.Id is "x.off" or "x.none");
        Assert.Equal("tab.closeOthers", r.Search("> close oth")[0].Id);
        Assert.Equal("tab.new", r.Search("create")[0].Id); // keywords count
    }

    [Fact]
    public void Execute_runs_handler_only_when_available()
    {
        var r = Make(out var log);
        Assert.True(r.Execute("tab.new"));
        Assert.False(r.Execute("x.off"));
        Assert.False(r.Execute("x.none"));
        Assert.False(r.Execute("does.not.exist"));
        Assert.Equal(new[] { "new" }, log);
    }

    [Fact]
    public void Duplicate_ids_are_rejected()
    {
        var r = Make(out _);
        Assert.Throws<InvalidOperationException>(() => r.Register(new BrowserCommand { Id = "tab.new", Name = "x", Category = "x" }));
    }
}

public class ShortcutTests
{
    [Theory]
    [InlineData("Ctrl+Shift+T", true, true, false, "T")]
    [InlineData("ctrl+plus", true, false, false, "OemPlus")]
    [InlineData("Alt+Left", false, false, true, "Left")]
    [InlineData("Ctrl+0", true, false, false, "D0")]
    [InlineData("F12", false, false, false, "F12")]
    public void Parses(string text, bool ctrl, bool shift, bool alt, string key)
    {
        Assert.True(KeyChord.TryParse(text, out var c));
        Assert.Equal(new KeyChord(ctrl, shift, alt, key), c);
    }

    [Theory]
    [InlineData("")]
    [InlineData("Ctrl+")]
    [InlineData("Ctrl+A+B")]
    public void Rejects_bad_text(string text) => Assert.False(KeyChord.TryParse(text, out _));

    [Fact]
    public void Round_trips_to_text()
    {
        Assert.True(KeyChord.TryParse("Ctrl+Shift+N", out var c));
        Assert.Equal("Ctrl+Shift+N", c.ToString());
        Assert.True(KeyChord.TryParse("Ctrl+Minus", out var m));
        Assert.Equal("Ctrl+Minus", m.ToString());
        Assert.True(KeyChord.TryParse("Ctrl+1", out var d));
        Assert.Equal("Ctrl+1", d.ToString());
    }

    [Fact]
    public void Maps_defaults_detects_conflicts_and_protects_reserved_keys()
    {
        var cmds = new[]
        {
            new BrowserCommand { Id = "tab.new", Name = "New tab", Category = "Tabs", DefaultShortcut = "Ctrl+T", Execute = () => { } },
            new BrowserCommand { Id = "tab.reopen", Name = "Reopen", Category = "Tabs", DefaultShortcut = "Ctrl+Shift+T", Execute = () => { } },
        };
        var map = ShortcutMap.WithDefaults(cmds);
        Assert.Equal("tab.new", map.CommandFor(new KeyChord(true, false, false, "T")));
        Assert.Equal("tab.reopen", map.FindConflict(new KeyChord(true, true, false, "T")));
        Assert.False(map.TryAssign("tab.new", new KeyChord(true, true, false, "T")), "conflict refused");
        Assert.False(map.TryAssign("tab.new", new KeyChord(false, false, true, "F4")), "Alt+F4 stays with Windows");
        Assert.False(map.TryAssign("tab.new", new KeyChord(true, false, false, "C")), "Ctrl+C stays with the page");
        Assert.True(map.TryAssign("tab.new", new KeyChord(true, false, true, "T")));
        Assert.Null(map.CommandFor(new KeyChord(true, false, false, "T")));
    }

    [Fact]
    public void User_overrides_replace_defaults()
    {
        var cmds = new[] { new BrowserCommand { Id = "tab.new", Name = "New tab", Category = "Tabs", DefaultShortcut = "Ctrl+T", Execute = () => { } } };
        var map = ShortcutMap.WithDefaults(cmds, new Dictionary<string, string> { ["tab.new"] = "Ctrl+Alt+N" });
        Assert.Equal("tab.new", map.CommandFor(new KeyChord(true, false, true, "N")));
        Assert.Null(map.CommandFor(new KeyChord(true, false, false, "T")));
    }
}

public class AdBlockTests
{
    private static AdBlockEngine Make(params string[] rules)
    {
        var e = new AdBlockEngine();
        e.Load(rules);
        return e;
    }

    [Fact]
    public void Blocks_third_party_hosts_and_subdomains_in_the_rule_list()
    {
        var e = Make("||ads.example.net^", "||tracker.io^$third-party");
        Assert.True(e.Evaluate("https://ads.example.net/banner.js", "https://news.site/").Block);
        Assert.True(e.Evaluate("https://x.tracker.io/pixel", "https://news.site/").Block);
        Assert.False(e.Evaluate("https://example.net/", "https://news.site/").Block);
        Assert.False(e.Evaluate("https://news.site/app.js", "https://news.site/").Block);
    }

    [Fact]
    public void Exception_rules_win()
    {
        var e = Make("||cdn.example.com^", "@@||ok.cdn.example.com^");
        Assert.True(e.Evaluate("https://cdn.example.com/a", "https://p.com/").Block);
        Assert.False(e.Evaluate("https://ok.cdn.example.com/a", "https://p.com/").Block);
    }

    [Fact]
    public void A_site_is_never_blocked_from_loading_its_own_hosts()
    {
        var e = Make("||tracker.io^");
        Assert.False(e.Evaluate("https://tracker.io/", "https://www.tracker.io/home").Block);
    }

    [Fact]
    public void Per_site_exemption_and_global_switch()
    {
        var e = Make("||ads.example.net^");
        e.SetSiteException("news.site", true);
        Assert.False(e.Evaluate("https://ads.example.net/x", "https://www.news.site/").Block);
        Assert.True(e.Evaluate("https://ads.example.net/x", "https://other.site/").Block);
        e.SetSiteException("news.site", false);
        Assert.True(e.Evaluate("https://ads.example.net/x", "https://news.site/").Block);
        e.Enabled = false;
        Assert.False(e.Evaluate("https://ads.example.net/x", "https://news.site/").Block);
    }

    [Fact]
    public void Unsupported_syntax_is_counted_not_guessed()
    {
        var e = Make("! comment", "[Adblock Plus 2.0]", "example.com##.banner", "||a.com/ads/*", "/banner\\d+/", "||b.com^$script", "||good.org^");
        Assert.Equal(1, e.RuleCount);
        Assert.Equal(4, e.UnsupportedLines);
    }

    [Fact]
    public void Never_matches_a_bare_tld_or_non_web_urls()
    {
        var e = Make("||com^", "||example.com^");
        Assert.False(e.Evaluate("https://anything.org/", "https://p.com/").Block);
        Assert.False(e.Evaluate("data:text/plain,x", "https://p.com/").Block);
        Assert.False(e.Evaluate("wiisb://settings", "https://p.com/").Block);
    }

    [Fact]
    public void Starter_list_loads_and_blocks_a_known_ad_server()
    {
        var e = new AdBlockEngine();
        e.Load(AdBlockEngine.StarterRules());
        Assert.True(e.RuleCount > 40);
        Assert.True(e.Evaluate("https://securepubads.g.doubleclick.net/gampad/ads", "https://news.example/").Block);
        Assert.False(e.Evaluate("https://www.wikipedia.org/", "https://news.example/").Block);
    }
}

public class ThemeTests
{
    [Fact]
    public void Built_in_themes_are_complete_and_valid()
    {
        Assert.True(ThemeCatalog.BuiltIn.Count >= 14);
        foreach (var t in ThemeCatalog.BuiltIn)
        {
            Assert.True(ThemeCatalog.TryValidate(t, out var err), $"{t.Name}: {err}");
            Assert.Equal(Tokens.All.Count, t.Colors.Count);
        }
        Assert.Equal(ThemeCatalog.BuiltIn.Count, ThemeCatalog.BuiltIn.Select(t => t.Id).Distinct().Count());
    }

    [Fact]
    public void Export_import_round_trip_gets_a_fresh_id()
    {
        var src = ThemeCatalog.BuiltIn[0].Clone();
        src.Name = "My theme";
        Assert.True(ThemeCatalog.TryImport(ThemeCatalog.Export(src), out var imported, out var err), err);
        Assert.Equal("My theme", imported!.Name);
        Assert.StartsWith("custom-", imported.Id);
        Assert.False(imported.BuiltIn);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void Garbage_is_rejected(string json) => Assert.False(ThemeCatalog.TryImport(json, out _, out _));

    [Fact]
    public void Invalid_values_are_rejected()
    {
        ThemeDef Good() { var t = ThemeCatalog.BuiltIn[0].Clone(); t.Name = "T"; return t; }
        var bad = Good(); bad.Colors[Tokens.AccentPrimary] = "red; background:url(x)";
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        bad = Good(); bad.Colors["Evil"] = "#000000";
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        bad = Good(); bad.CornerRadius = 500;
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        bad = Good(); bad.Name = "<script>";
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        bad = Good(); bad.FontFamily = "Arial}</style><script>";
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        bad = Good(); bad.Animated = "javascript";
        Assert.False(ThemeCatalog.TryValidate(bad, out _));
        Assert.False(ThemeCatalog.TryImport(new string(' ', ThemeCatalog.MaxThemeJsonBytes + 1), out _, out _));
    }

    [Fact]
    public void Colors_parse_including_alpha()
    {
        Assert.Equal(((byte)255, (byte)0x8B, (byte)0x5C, (byte)0xF6), ThemeCatalog.ParseColor("#8B5CF6"));
        Assert.Equal(((byte)0x1F, (byte)255, (byte)255, (byte)255), ThemeCatalog.ParseColor("#FFFFFF1F"));
    }
}

public class TabLogicTests
{
    private static TabFacts Tab(string id, string url, string? cluster = null, bool pinned = false, string? opener = null, string title = "") =>
        new(id, url, title, pinned, cluster, opener);

    [Fact]
    public void Suggests_clusters_by_site_but_not_for_pinned_or_already_grouped_tabs()
    {
        var tabs = new[]
        {
            Tab("1", "https://github.com/a/b"), Tab("2", "https://github.com/a/b/issues"), Tab("3", "https://gist.github.com/x"),
            Tab("4", "https://example.com/"), Tab("5", "https://youtube.com/watch?v=1", pinned: true), Tab("6", "https://youtube.com/watch?v=2"),
            Tab("7", "https://reddit.com/a", cluster: "c"), Tab("8", "https://reddit.com/b"),
        };
        var s = ClusterSuggester.Suggest(tabs);
        var gh = Assert.Single(s);
        Assert.Equal("GitHub", gh.Name);
        Assert.Equal(new[] { "1", "2", "3" }, gh.TabIds);
    }

    [Fact]
    public void Excluded_domains_are_never_suggested()
    {
        var tabs = new[] { Tab("1", "https://github.com/a"), Tab("2", "https://github.com/b") };
        Assert.Empty(ClusterSuggester.Suggest(tabs, new HashSet<string> { "github.com" }));
    }

    [Fact]
    public void Suggests_tabs_opened_from_one_another()
    {
        var tabs = new[]
        {
            Tab("r", "https://search.example/?q=x", title: "My research"),
            Tab("a", "https://one.org/", opener: "r"), Tab("b", "https://two.net/", opener: "a"), Tab("z", "https://lonely.dev/"),
        };
        var s = ClusterSuggester.Suggest(tabs);
        var group = Assert.Single(s);
        Assert.Equal("My research", group.Name);
        Assert.Equal(3, group.TabIds.Count);
    }

    [Fact]
    public void Duplicate_detection_ignores_fragments_and_tracking_but_not_real_queries()
    {
        Assert.Equal(DuplicateDetector.Normalize("https://Example.com/a/?utm_source=x#top"), DuplicateDetector.Normalize("https://example.com/a"));
        Assert.NotEqual(DuplicateDetector.Normalize("https://example.com/watch?v=1"), DuplicateDetector.Normalize("https://example.com/watch?v=2"));

        var groups = DuplicateDetector.FindGroups(new[]
        {
            ("1", "https://example.com/a", false), ("2", "https://example.com/a#x", false), ("3", "https://example.com/a?utm_medium=q", false),
            ("4", "https://example.com/watch?v=1", false), ("5", "https://example.com/watch?v=2", false), ("6", "https://example.com/a", true),
        });
        var g = Assert.Single(groups);
        Assert.Equal(new[] { "1", "2", "3" }, g);
    }
}

public class TabTearOffTests
{
    private static readonly ScreenRect Window = new(100, 100, 1100, 800);
    private static readonly ScreenRect Page = new(300, 160, 1100, 800);

    [Fact]
    public void LettingGoOutsideTheWindowMakesANewWindow()
    {
        Assert.True(TabTearOff.ShouldTearOff(1500, 400, Window, Page));
        Assert.True(TabTearOff.ShouldTearOff(50, 400, Window, Page));
        Assert.True(TabTearOff.ShouldTearOff(600, 900, Window, null));
    }

    [Fact]
    public void LettingGoOnThePageMakesANewWindow()
    {
        Assert.True(TabTearOff.ShouldTearOff(700, 500, Window, Page));
    }

    [Fact]
    public void LettingGoOnTheTabListOrToolbarKeepsTheTabHere()
    {
        Assert.False(TabTearOff.ShouldTearOff(180, 400, Window, Page));   // the tab list
        Assert.False(TabTearOff.ShouldTearOff(700, 130, Window, Page));   // the toolbar
        Assert.False(TabTearOff.ShouldTearOff(180, 400, Window, null));   // no page area known: only "outside" counts
    }

    [Fact]
    public void TheWindowEdgeBelongsToTheWindow()
    {
        Assert.True(Window.Contains(100, 100));
        Assert.False(Window.Contains(1100, 800));
    }
}

public class UpdateTests
{
    private const string Repo = "someone/wiisbrowsing";
    private static readonly Version Now = new(0, 1, 0, 0);
    private static string Manifest(string version = "0.1.1", string? url = null, string sig = "AQID") =>
        $$"""{"version":"{{version}}","url":"{{url ?? $"https://github.com/{Repo}/releases/download/v{version}/WIISBROWSING-{version}-setup.exe"}}","signature":"{{sig}}","notes":"Faster tabs"}""";

    [Fact]
    public void ANewerReleaseFromTheRightRepoIsOffered()
    {
        var offer = UpdateManifest.Evaluate(Manifest(), Now, Repo);
        Assert.NotNull(offer);
        Assert.Equal(new Version(0, 1, 1), offer!.Version);
        Assert.Equal("Faster tabs", offer.Notes);
        Assert.Equal(new byte[] { 1, 2, 3 }, offer.Signature);
        Assert.NotNull(UpdateManifest.Evaluate(Manifest("v0.2.0"), Now, Repo));   // a leading "v" is fine
    }

    [Fact]
    public void TheSameOrAnOlderReleaseIsNotOffered()
    {
        Assert.Null(UpdateManifest.Evaluate(Manifest("0.1.0"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest("0.0.9"), Now, Repo));
    }

    [Fact]
    public void ADownloadAddressOutsideTheReleasesOfTheRepoIsRefused()
    {
        Assert.Null(UpdateManifest.Evaluate(Manifest(url: "https://evil.example/setup.exe"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(url: "https://github.com/other/repo/releases/download/v1/setup.exe"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(url: $"http://github.com/{Repo}/releases/download/v1/setup.exe"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(url: $"https://github.com/{Repo}/releases/download/../../x/setup.exe"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(url: $"https://github.com/{Repo}/releases/download/v1/setup.zip"), Now, Repo));
    }

    [Fact]
    public void BrokenManifestsAreIgnored()
    {
        Assert.Null(UpdateManifest.Evaluate("not json", Now, Repo));
        Assert.Null(UpdateManifest.Evaluate("[]", Now, Repo));
        Assert.Null(UpdateManifest.Evaluate("""{"version":"0.2.0"}""", Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(sig: "***not base64***"), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(sig: ""), Now, Repo));
        Assert.Null(UpdateManifest.Evaluate(Manifest(), Now, ""));
        Assert.Null(UpdateManifest.Evaluate(Manifest(), Now, "no-slash"));
    }

    [Fact]
    public void AnInstallerSignedWithTheRightKeyVerifiesAndAnyChangeDoesNot()
    {
        var (priv, pub) = UpdateSigning.NewKeyPair();
        var file = new byte[200_000]; new Random(7).NextBytes(file);
        var sig = UpdateSigning.Sign(new MemoryStream(file), priv);
        Assert.True(UpdateSigning.Verify(new MemoryStream(file), sig, pub));

        var tampered = (byte[])file.Clone(); tampered[1234] ^= 1;
        Assert.False(UpdateSigning.Verify(new MemoryStream(tampered), sig, pub));

        var (_, otherPub) = UpdateSigning.NewKeyPair();
        Assert.False(UpdateSigning.Verify(new MemoryStream(file), sig, otherPub));
        Assert.False(UpdateSigning.Verify(new MemoryStream(file), new byte[] { 1, 2, 3 }, pub));
        Assert.False(UpdateSigning.Verify(new MemoryStream(file), sig, new byte[] { 9, 9 }));
    }
}
