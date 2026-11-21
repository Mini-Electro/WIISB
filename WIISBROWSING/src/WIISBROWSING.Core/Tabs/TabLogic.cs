using WIISBROWSING.Core.Urls;

namespace WIISBROWSING.Core.Tabs;

/// <summary>The minimal tab facts the grouping heuristics need.</summary>
public sealed record TabFacts(string Id, string Url, string Title, bool Pinned, string? ClusterId, string? OpenerId);

public sealed record ClusterSuggestion(string Name, string Reason, IReadOnlyList<string> TabIds);

/// <summary>
/// Deterministic, local grouping logic ("WIISB Clusters"). Nothing here talks to a network or a model:
/// the signals are the site a tab belongs to and which tab opened which.
/// </summary>
public static class ClusterSuggester
{
    private static readonly Dictionary<string, string> Friendly = new(StringComparer.OrdinalIgnoreCase)
    {
        ["github.com"] = "GitHub", ["youtube.com"] = "Videos", ["youtu.be"] = "Videos", ["twitch.tv"] = "Streams", ["reddit.com"] = "Reddit",
        ["stackoverflow.com"] = "Development", ["learn.microsoft.com"] = "Docs", ["developer.mozilla.org"] = "Docs", ["wikipedia.org"] = "Reading",
        ["docs.google.com"] = "Google Docs", ["netflix.com"] = "Watch", ["spotify.com"] = "Music",
    };

    public static string NameFor(string domain)
    {
        if (Friendly.TryGetValue(domain, out var n)) return n;
        var label = domain.Split('.')[0];
        return label.Length == 0 ? domain : char.ToUpperInvariant(label[0]) + label[1..];
    }

    /// <param name="excludedDomains">Websites the user never wants grouped automatically.</param>
    public static IReadOnlyList<ClusterSuggestion> Suggest(IEnumerable<TabFacts> tabs, IReadOnlySet<string>? excludedDomains = null, int minTabs = 2)
    {
        var candidates = tabs.Where(t => !t.Pinned && t.ClusterId is null && Uri.TryCreate(t.Url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https")).ToList();
        var result = new List<ClusterSuggestion>();
        var used = new HashSet<string>();

        foreach (var g in candidates.GroupBy(t => UrlClassifier.RegistrableDomain(UrlClassifier.HostOf(t.Url)), StringComparer.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(g.Key) || (excludedDomains?.Contains(g.Key) ?? false)) continue;
            var ids = g.Select(t => t.Id).ToList();
            if (ids.Count < minTabs) continue;
            result.Add(new ClusterSuggestion(NameFor(g.Key), $"{ids.Count} tabs from {g.Key}", ids));
            foreach (var id in ids) used.Add(id);
        }

        // Tabs opened from one another (for example a search result and the pages opened from it).
        var byId = candidates.Where(t => !used.Contains(t.Id)).ToDictionary(t => t.Id);
        foreach (var root in byId.Values.Where(t => t.OpenerId is null || !byId.ContainsKey(t.OpenerId)))
        {
            var family = byId.Values.Where(t => t.Id == root.Id || Descends(t, root.Id, byId)).Select(t => t.Id).ToList();
            if (family.Count >= Math.Max(3, minTabs))
                result.Add(new ClusterSuggestion(string.IsNullOrWhiteSpace(root.Title) ? "Related tabs" : Truncate(root.Title, 24), $"{family.Count} tabs opened from one another", family));
        }
        return result;
    }

    private static bool Descends(TabFacts t, string rootId, IReadOnlyDictionary<string, TabFacts> byId)
    {
        int guard = 0;
        var cur = t;
        while (cur.OpenerId is not null && guard++ < 64)
        {
            if (cur.OpenerId == rootId) return true;
            if (!byId.TryGetValue(cur.OpenerId, out var next)) return false;
            cur = next;
        }
        return false;
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..(n - 1)] + "…";
}

public static class DuplicateDetector
{
    private static readonly HashSet<string> TrackingParams = new(StringComparer.OrdinalIgnoreCase)
        { "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "mc_cid", "mc_eid", "igshid" };

    /// <summary>Same page for our purposes: ignores the fragment, a trailing slash, host case and tracking parameters — but not real query parameters.</summary>
    public static string Normalize(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return url.Trim();
        var path = u.AbsolutePath.Length > 1 ? u.AbsolutePath.TrimEnd('/') : u.AbsolutePath;
        var query = "";
        if (!string.IsNullOrEmpty(u.Query))
        {
            var kept = u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Where(p => !TrackingParams.Contains(p.Split('=')[0])).ToList();
            if (kept.Count > 0) query = "?" + string.Join('&', kept);
        }
        return $"{u.Scheme}://{u.Host.ToLowerInvariant()}{(u.IsDefaultPort ? "" : ":" + u.Port)}{path}{query}";
    }

    /// <summary>Groups of tabs showing the same page. Each group has at least two members, in input order.</summary>
    public static IReadOnlyList<IReadOnlyList<string>> FindGroups(IEnumerable<(string Id, string Url, bool Exempt)> tabs) =>
        tabs.Where(t => !t.Exempt && Uri.TryCreate(t.Url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
            .GroupBy(t => Normalize(t.Url))
            .Where(g => g.Count() > 1)
            .Select(g => (IReadOnlyList<string>)g.Select(t => t.Id).ToList())
            .ToList();
}

/// <summary>A rectangle in screen pixels.</summary>
public readonly record struct ScreenRect(double Left, double Top, double Right, double Bottom)
{
    public bool Contains(double x, double y) => x >= Left && x < Right && y >= Top && y < Bottom;
}

/// <summary>Where a dragged tab has to be let go for it to become a window of its own.</summary>
public static class TabTearOff
{
    /// <summary>
    /// True when the pointer is outside the browser window, or over the page itself (anywhere that is not the tab list
    /// or the toolbar). Letting go on the tab list only reorders; letting go on the toolbar does nothing.
    /// </summary>
    public static bool ShouldTearOff(double x, double y, ScreenRect window, ScreenRect? page) =>
        !window.Contains(x, y) || (page is { } p && p.Contains(x, y));
}
