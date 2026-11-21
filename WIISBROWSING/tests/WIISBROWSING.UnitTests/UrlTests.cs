using WIISBROWSING.Core.Urls;

namespace WIISBROWSING.UnitTests;

public class UrlTests
{
    private static readonly SearchEngine Google = SearchEngines.ById("google");

    [Theory]
    [InlineData("https://example.com", "https://example.com/")]
    [InlineData("http://example.com/a?b=1", "http://example.com/a?b=1")]
    [InlineData("example.com", "https://example.com/")]
    [InlineData("example.com/docs/page?x=1#top", "https://example.com/docs/page?x=1#top")]
    [InlineData("sub.example.co.uk", "https://sub.example.co.uk/")]
    [InlineData("localhost:3000", "http://localhost:3000/")]
    [InlineData("localhost", "http://localhost/")]
    [InlineData("127.0.0.1:8080", "http://127.0.0.1:8080/")]
    [InlineData("127.0.0.1", "http://127.0.0.1/")]
    [InlineData("[::1]:5000", "http://[::1]:5000/")]
    [InlineData("app.localhost:8443/x", "http://app.localhost:8443/x")]
    [InlineData("example.com:8080/path", "https://example.com:8080/path")]
    public void Addresses_become_urls(string input, string expected)
    {
        var t = UrlClassifier.Classify(input, Google);
        Assert.Equal(NavKind.Url, t.Kind);
        Assert.Equal(expected, t.Url);
    }

    [Theory]
    [InlineData("how to learn C#")]
    [InlineData("cats")]
    [InlineData("what is 2.5 + 3")]
    [InlineData("e.g.")]
    [InlineData("file.7z")]
    [InlineData("hello world.com")]
    [InlineData("intranet")]
    public void Plain_text_is_a_search(string input)
    {
        var t = UrlClassifier.Classify(input, Google);
        Assert.Equal(NavKind.Search, t.Kind);
        Assert.StartsWith("https://www.google.com/search?q=", t.Url);
    }

    [Fact]
    public void Search_text_is_escaped()
    {
        var t = UrlClassifier.Classify("a&b=c d", Google);
        Assert.Equal("https://www.google.com/search?q=a%26b%3Dc%20d", t.Url);
    }

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("JaVaScRiPt:alert(1)")]
    [InlineData("data:text/html,<script>1</script>")]
    [InlineData("vbscript:msgbox(1)")]
    [InlineData("")]
    [InlineData("   ")]
    public void Dangerous_or_empty_input_is_blocked(string input) =>
        Assert.Equal(NavKind.Blocked, UrlClassifier.Classify(input, Google).Kind);

    [Theory]
    [InlineData("mailto:someone@example.com")]
    [InlineData("steam://rungameid/4000")]
    public void External_protocols_need_confirmation(string input) =>
        Assert.Equal(NavKind.External, UrlClassifier.Classify(input, Google).Kind);

    [Fact]
    public void Internal_pages()
    {
        Assert.Equal("wiisb://settings", UrlClassifier.Classify("wiisb://settings", Google).Url);
        Assert.Equal(NavKind.Internal, UrlClassifier.Classify("WIISB://History", Google).Kind);
        Assert.Equal(NavKind.Blocked, UrlClassifier.Classify("wiisb://nope", Google).Kind);
    }

    [Fact]
    public void View_source_wraps_a_web_url() =>
        Assert.Equal("view-source:https://example.com/", UrlClassifier.Classify("view-source:example.com", Google).Url);

    [Fact]
    public void Credentials_in_the_authority_are_not_treated_as_a_host() =>
        Assert.Equal(NavKind.Search, UrlClassifier.Classify("user@example.com", Google).Kind);

    [Fact]
    public void Origin_and_domain_helpers()
    {
        Assert.Equal("https://example.com", UrlClassifier.OriginOf("https://example.com/a/b"));
        Assert.Equal("http://localhost:3000", UrlClassifier.OriginOf("http://localhost:3000/x"));
        Assert.Equal("example.co.uk", UrlClassifier.RegistrableDomain("www.sub.example.co.uk"));
        Assert.Equal("github.com", UrlClassifier.RegistrableDomain("gist.github.com"));
        Assert.True(UrlClassifier.IsLocalAddress("http://127.0.0.1:8080"));
        Assert.True(UrlClassifier.IsLocalAddress("http://[::1]/"));
        Assert.False(UrlClassifier.IsLocalAddress("https://example.com"));
    }

    [Theory]
    [InlineData("https://search.example/?q={query}", true)]
    [InlineData("https://search.example/{query}/x", true)]
    [InlineData("https://search.example/?q=", false)]
    [InlineData("https://search.example/?q={query}&r={query}", false)]
    [InlineData("javascript:{query}", false)]
    [InlineData("ftp://x/{query}", false)]
    [InlineData("https://sea rch.example/{query}", false)]
    [InlineData("", false)]
    public void Custom_search_templates_are_validated(string template, bool ok) =>
        Assert.Equal(ok, SearchEngines.TryValidateTemplate(template, out _));
}
