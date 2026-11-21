using System.Text.RegularExpressions;

namespace WIISBROWSING.Core.Urls;

public enum NavKind
{
    /// <summary>Navigate to <see cref="NavTarget.Url"/>.</summary>
    Url,
    /// <summary>The text is a search; <see cref="NavTarget.Url"/> is the search-engine URL.</summary>
    Search,
    /// <summary>A wiisb:// page.</summary>
    Internal,
    /// <summary>An external application link (mailto:, steam://…). Needs the user's confirmation.</summary>
    External,
    /// <summary>Refused (javascript:, data:, empty…).</summary>
    Blocked,
}

public sealed record NavTarget(NavKind Kind, string Url, string? Reason = null);

/// <summary>Decides what the text typed in the address bar means.</summary>
public static partial class UrlClassifier
{
    public const string InternalScheme = "wiisb";

    public static readonly IReadOnlySet<string> InternalPages = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "newtab", "settings", "history", "downloads", "bookmarks", "extensions", "performance",
        "themes", "profiles", "about", "help", "notes", "error", "privacy", "tools", "reader",
    };

    private static readonly HashSet<string> BlockedSchemes = new(StringComparer.OrdinalIgnoreCase)
        { "javascript", "data", "vbscript", "blob", "filesystem" };

    [GeneratedRegex(@"^[a-zA-Z][a-zA-Z0-9+.\-]*:")]
    private static partial Regex SchemeRegex();

    // host:port, where host is a name, IPv4 or [IPv6]
    [GeneratedRegex(@"^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9\-._]+):\d{1,5}([/?#].*)?$")]
    private static partial Regex HostPortRegex();

    [GeneratedRegex(@"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")]
    private static partial Regex Ipv4Regex();

    public static NavTarget Classify(string? input, SearchEngine engine)
    {
        var text = (input ?? "").Trim();
        if (text.Length == 0) return new NavTarget(NavKind.Blocked, "", "Nothing to open.");
        if (text.Length > 8192) return new NavTarget(NavKind.Blocked, "", "That address is too long.");
        if (text.Any(char.IsControl)) return new NavTarget(NavKind.Blocked, "", "That address contains invalid characters.");

        // Internal pages: wiisb://settings
        if (text.StartsWith("wiisb://", StringComparison.OrdinalIgnoreCase))
        {
            var rest = text[8..];
            var page = rest.Split('/', '?', '#')[0];
            return InternalPages.Contains(page)
                ? new NavTarget(NavKind.Internal, "wiisb://" + page.ToLowerInvariant() + rest[page.Length..])
                : new NavTarget(NavKind.Blocked, "", $"There is no WIISBROWSING page called \"{page}\".");
        }

        if (text.Equals("about:blank", StringComparison.OrdinalIgnoreCase)) return new NavTarget(NavKind.Url, "about:blank");

        bool hasSpace = text.Any(char.IsWhiteSpace);

        // localhost:3000 and 127.0.0.1:8080 look like "scheme:" — check host:port first.
        if (!hasSpace && HostPortRegex().IsMatch(text) && !text.Contains("://"))
        {
            var web = TryWebUrl(text);
            if (web is not null) return new NavTarget(NavKind.Url, web);
        }

        var scheme = SchemeRegex().Match(text);
        if (scheme.Success && (!hasSpace || text.Contains("://")))
        {
            var name = text[..(scheme.Length - 1)];
            if (BlockedSchemes.Contains(name))
                return new NavTarget(NavKind.Blocked, "", "Scripts and data links can't be opened from the address bar.");
            if (name.Equals("http", StringComparison.OrdinalIgnoreCase) || name.Equals("https", StringComparison.OrdinalIgnoreCase) || name.Equals("file", StringComparison.OrdinalIgnoreCase))
            {
                return Uri.TryCreate(text, UriKind.Absolute, out var u) && (u.Scheme is "http" or "https" or "file")
                    ? new NavTarget(NavKind.Url, u.AbsoluteUri.Length == 0 ? text : NormalizeAbsolute(text, u))
                    : Search(text, engine);
            }
            if (name.Equals("view-source", StringComparison.OrdinalIgnoreCase))
            {
                var inner = Classify(text[scheme.Length..], engine);
                return inner.Kind == NavKind.Url ? new NavTarget(NavKind.Url, "view-source:" + inner.Url) : Search(text, engine);
            }
            if (text.Contains("://") || name.Equals("mailto", StringComparison.OrdinalIgnoreCase) || name.Equals("tel", StringComparison.OrdinalIgnoreCase))
                return new NavTarget(NavKind.External, text, "This link opens another app.");
        }

        if (!hasSpace)
        {
            var web = TryWebUrl(text);
            if (web is not null) return new NavTarget(NavKind.Url, web);
        }

        return Search(text, engine);
    }

    private static NavTarget Search(string text, SearchEngine engine) =>
        new(NavKind.Search, SearchEngines.BuildUrl(engine, text));

    private static string NormalizeAbsolute(string original, Uri u) =>
        // Uri.AbsoluteUri adds a trailing slash and escapes; keep the user's text when it is already well formed.
        u.IsFile ? u.AbsoluteUri : u.AbsoluteUri;

    /// <summary>Turns "example.com/a", "localhost:3000", "127.0.0.1" or "[::1]:80" into a full URL; null if it isn't a host.</summary>
    private static string? TryWebUrl(string text)
    {
        int cut = text.IndexOfAny(new[] { '/', '?', '#' });
        var authority = cut < 0 ? text : text[..cut];
        var tail = cut < 0 ? "" : text[cut..];
        if (authority.Contains('@')) return null; // user:pass@host — not typed into an omnibox on purpose

        string host = authority;
        if (authority.StartsWith('['))
        {
            int close = authority.IndexOf(']');
            if (close < 0) return null;
            host = authority[..(close + 1)];
            var after = authority[(close + 1)..];
            if (after.Length > 0 && (!after.StartsWith(':') || !ValidPort(after[1..]))) return null;
            if (!IPAddressLike(host[1..^1])) return null;
            return "http://" + authority + (tail.Length == 0 ? "/" : tail);
        }
        int colon = authority.LastIndexOf(':');
        if (colon >= 0)
        {
            if (!ValidPort(authority[(colon + 1)..])) return null;
            host = authority[..colon];
        }
        if (host.Length == 0 || host.Length > 253) return null;
        host = host.TrimEnd('.');

        bool isLocal = host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
        bool isIp = Ipv4Regex().IsMatch(host) && host.Split('.').All(p => int.TryParse(p, out var n) && n is >= 0 and <= 255);
        if (isLocal || isIp)
            return "http://" + authority + (tail.Length == 0 ? "/" : tail);

        if (Uri.CheckHostName(host) != UriHostNameType.Dns) return null;
        var labels = host.Split('.');
        if (labels.Length < 2 || labels.Any(l => l.Length == 0 || l.Length > 63)) return null;
        var tld = labels[^1];
        bool tldOk = tld.StartsWith("xn--", StringComparison.OrdinalIgnoreCase) || (tld.Length >= 2 && tld.All(char.IsLetter));
        if (!tldOk)
        {
            // A single-label host with a port ("intranet:8080") is a deliberate address; "file.7z" is not.
            return null;
        }
        return "https://" + authority + (tail.Length == 0 ? "/" : tail);
    }

    private static bool ValidPort(string p) => p.Length is >= 1 and <= 5 && p.All(char.IsDigit) && int.Parse(p) is >= 1 and <= 65535;

    private static bool IPAddressLike(string s) => System.Net.IPAddress.TryParse(s, out _);

    public static bool IsLocalAddress(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        return u.IsLoopback || u.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsInternal(string? url) =>
        url is not null && url.StartsWith("wiisb://", StringComparison.OrdinalIgnoreCase);

    /// <summary>The origin shown in prompts: scheme + host (+ port).</summary>
    public static string OriginOf(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return url ?? "";
        return u.IsDefaultPort || u.Port < 0 ? $"{u.Scheme}://{u.Host}" : $"{u.Scheme}://{u.Host}:{u.Port}";
    }

    public static string HostOf(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "";

    public static string RegistrableDomain(string host)
    {
        host = host.ToLowerInvariant().TrimEnd('.');
        if (host.Length == 0 || System.Net.IPAddress.TryParse(host, out _)) return host;
        var parts = host.Split('.');
        if (parts.Length <= 2) return host;
        var twoLevel = new HashSet<string> { "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "co.in", "co.za", "com.mx", "com.cn", "com.tr" };
        var last2 = parts[^2] + "." + parts[^1];
        return twoLevel.Contains(last2) ? string.Join('.', parts[^3..]) : last2;
    }
}
