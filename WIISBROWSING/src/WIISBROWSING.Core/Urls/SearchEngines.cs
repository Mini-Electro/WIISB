namespace WIISBROWSING.Core.Urls;

/// <summary>A search provider. <c>Template</c> contains the placeholder <c>{query}</c>.</summary>
public sealed record SearchEngine(string Id, string Name, string Template, string? SuggestTemplate = null);

public static class SearchEngines
{
    public const string Placeholder = "{query}";

    public static readonly IReadOnlyList<SearchEngine> BuiltIn = new[]
    {
        new SearchEngine("google", "Google", "https://www.google.com/search?q={query}", "https://suggestqueries.google.com/complete/search?client=firefox&q={query}"),
        new SearchEngine("bing", "Bing", "https://www.bing.com/search?q={query}", "https://api.bing.com/osjson.aspx?query={query}"),
        new SearchEngine("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q={query}", "https://duckduckgo.com/ac/?q={query}&type=list"),
        new SearchEngine("brave", "Brave Search", "https://search.brave.com/search?q={query}", "https://search.brave.com/api/suggest?q={query}"),
        new SearchEngine("startpage", "Startpage", "https://www.startpage.com/do/dsearch?query={query}"),
    };

    public static SearchEngine Default => BuiltIn[0];

    public static SearchEngine ById(string? id) => BuiltIn.FirstOrDefault(e => e.Id == id) ?? Default;

    /// <summary>A custom template must be http(s), contain the placeholder exactly once and produce a valid URL.</summary>
    public static bool TryValidateTemplate(string? template, out string error)
    {
        error = "";
        if (string.IsNullOrWhiteSpace(template)) { error = "Enter a search URL."; return false; }
        template = template.Trim();
        if (template.Length > 512) { error = "The search URL is too long."; return false; }
        if (template.Any(char.IsWhiteSpace) || template.Any(char.IsControl)) { error = "The search URL can't contain spaces."; return false; }
        int first = template.IndexOf(Placeholder, StringComparison.Ordinal);
        if (first < 0) { error = $"The search URL must contain {Placeholder} where the search words go."; return false; }
        if (template.IndexOf(Placeholder, first + 1, StringComparison.Ordinal) >= 0) { error = $"Use {Placeholder} only once."; return false; }
        if (!Uri.TryCreate(template.Replace(Placeholder, "test"), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || string.IsNullOrEmpty(uri.Host))
        { error = "The search URL must start with https:// and name a website."; return false; }
        return true;
    }

    public static string BuildUrl(SearchEngine engine, string query) =>
        engine.Template.Replace(Placeholder, Uri.EscapeDataString(query.Trim()));

    public static string? BuildSuggestUrl(SearchEngine engine, string query) =>
        engine.SuggestTemplate?.Replace(Placeholder, Uri.EscapeDataString(query.Trim()));
}
