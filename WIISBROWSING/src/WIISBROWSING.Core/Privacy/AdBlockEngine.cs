using System.Collections.Concurrent;

namespace WIISBROWSING.Core.Privacy;

public sealed record BlockDecision(bool Block, string? Rule);

public sealed record BlockedRequest(DateTime At, string Host, string? Rule);

/// <summary>Real counts of what was blocked, plus the most recent blocked hosts for the diagnostics view.</summary>
public sealed class BlockLog
{
    private readonly object _gate = new();
    private readonly Queue<BlockedRequest> _recent = new();
    private long _total;

    public long Total { get { lock (_gate) return _total; } }

    public void Add(string host, string? rule)
    {
        lock (_gate)
        {
            _total++;
            _recent.Enqueue(new BlockedRequest(DateTime.Now, host, rule));
            while (_recent.Count > 200) _recent.Dequeue();
        }
    }

    public IReadOnlyList<BlockedRequest> Recent(int count = 50)
    {
        lock (_gate) return _recent.Reverse().Take(count).ToList();
    }

    public void Reset() { lock (_gate) { _total = 0; _recent.Clear(); } }
}

/// <summary>
/// Request blocking by domain. Understands the common <c>||example.com^</c> filter syntax (and the
/// <c>@@||example.com^</c> exception form) plus plain domain lists. It does NOT implement cosmetic filters,
/// scriptlets or path/regex rules — those lines are counted as unsupported and ignored, never guessed at.
/// </summary>
public sealed class AdBlockEngine
{
    private volatile HashSet<string> _blocked = new(StringComparer.OrdinalIgnoreCase);
    private volatile HashSet<string> _allowed = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, bool> _siteExceptions = new(StringComparer.OrdinalIgnoreCase);

    public int RuleCount => _blocked.Count;
    public int UnsupportedLines { get; private set; }
    public bool Enabled { get; set; } = true;
    public BlockLog Counters { get; } = new();

    /// <summary>Replaces the rule set. May be called from any thread.</summary>
    public void Load(IEnumerable<string> lines)
    {
        var blocked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int unsupported = 0;
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '!' || line[0] == '[' || line[0] == '#') continue;
            bool exception = line.StartsWith("@@", StringComparison.Ordinal);
            if (exception) line = line[2..];
            if (!TryParseDomainRule(line, out var domain)) { unsupported++; continue; }
            (exception ? allowed : blocked).Add(domain);
        }
        _blocked = blocked;
        _allowed = allowed;
        UnsupportedLines = unsupported;
    }

    /// <summary><c>||example.com^</c>, <c>||example.com^$third-party</c> and bare <c>example.com</c> are domain rules.</summary>
    internal static bool TryParseDomainRule(string line, out string domain)
    {
        domain = "";
        if (line.Contains("##") || line.Contains("#@#") || line.Contains("#?#") || line.Contains("#$#")) return false; // cosmetic
        string rule = line;
        int dollar = rule.IndexOf('$');
        if (dollar >= 0)
        {
            var options = rule[(dollar + 1)..].Split(',');
            // Options that narrow a rule to a request type or party can't be honoured by a domain-only engine.
            if (options.Any(o => o is not ("third-party" or "3p" or "important"))) return false;
            rule = rule[..dollar];
        }
        if (rule.StartsWith("||", StringComparison.Ordinal)) rule = rule[2..];
        else if (rule.StartsWith('|') || rule.StartsWith('/') || rule.Contains('*')) return false;
        rule = rule.TrimEnd('^');
        if (rule.Contains('/') || rule.Contains('^') || rule.Contains('?') || rule.Contains(':') || rule.Contains('|')) return false;
        if (rule.Length < 4 || !rule.Contains('.') || rule.StartsWith('.') || rule.EndsWith('.')) return false;
        foreach (var c in rule)
            if (!(char.IsAsciiLetterOrDigit(c) || c == '.' || c == '-')) return false;
        domain = rule.ToLowerInvariant();
        return true;
    }

    public void SetSiteException(string pageHost, bool exempt)
    {
        if (string.IsNullOrEmpty(pageHost)) return;
        if (exempt) _siteExceptions[pageHost] = true; else _siteExceptions.TryRemove(pageHost, out _);
    }

    public bool IsSiteExempt(string pageHost) =>
        !string.IsNullOrEmpty(pageHost) && WalkUp(pageHost).Any(h => _siteExceptions.ContainsKey(h));

    public IEnumerable<string> SiteExceptions => _siteExceptions.Keys.OrderBy(k => k);

    public BlockDecision Evaluate(string requestUrl, string? pageUrl)
    {
        if (!Enabled) return new BlockDecision(false, null);
        if (!Uri.TryCreate(requestUrl, UriKind.Absolute, out var req) || (req.Scheme != "http" && req.Scheme != "https" && req.Scheme != "ws" && req.Scheme != "wss"))
            return new BlockDecision(false, null);
        string pageHost = Uri.TryCreate(pageUrl, UriKind.Absolute, out var page) ? page.Host : "";
        if (pageHost.Length > 0 && IsSiteExempt(pageHost)) return new BlockDecision(false, null);

        var blocked = _blocked;
        var allowed = _allowed;
        string? hit = null;
        foreach (var h in WalkUp(req.Host))
        {
            if (allowed.Contains(h)) return new BlockDecision(false, null);
            if (hit is null && blocked.Contains(h)) hit = h;
        }
        if (hit is null) return new BlockDecision(false, null);

        // Navigating directly to a tracker's own site is the user's choice; and a site's own subdomains aren't "third party".
        if (pageHost.Length > 0 && SameSite(pageHost, req.Host)) return new BlockDecision(false, null);
        return new BlockDecision(true, "||" + hit + "^");
    }

    private static bool SameSite(string a, string b) =>
        Urls.UrlClassifier.RegistrableDomain(a).Equals(Urls.UrlClassifier.RegistrableDomain(b), StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> WalkUp(string host)
    {
        host = host.TrimEnd('.');
        while (true)
        {
            yield return host;
            int dot = host.IndexOf('.');
            if (dot < 0) yield break;
            var rest = host[(dot + 1)..];
            if (!rest.Contains('.')) yield break; // never match a bare TLD
            host = rest;
        }
    }

    /// <summary>A small built-in starter list of well-known advertising and tracking hosts.</summary>
    public static IEnumerable<string> StarterRules() =>
        StarterDomains.Select(d => "||" + d + "^");

    private static readonly string[] StarterDomains =
    {
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
        "google-analytics.com", "adnxs.com", "adsrvr.org", "taboola.com", "outbrain.com", "criteo.com", "criteo.net",
        "rubiconproject.com", "pubmatic.com", "openx.net", "casalemedia.com", "advertising.com", "adform.net", "bidswitch.net",
        "smartadserver.com", "2mdn.net", "moatads.com", "scorecardresearch.com", "quantserve.com", "amazon-adsystem.com",
        "yieldmo.com", "contextweb.com", "sharethrough.com", "teads.tv", "zedo.com", "adcolony.com", "media.net",
        "hotjar.com", "mouseflow.com", "fullstory.com", "crazyegg.com", "chartbeat.com", "demdex.net", "everesttech.net",
        "krxd.net", "bluekai.com", "exelator.com", "serving-sys.com", "mathtag.com", "revcontent.com", "mgid.com",
        "adroll.com", "lijit.com", "tapad.com", "agkn.com", "rlcdn.com", "3lift.com", "indexww.com", "sonobi.com",
    };
}
