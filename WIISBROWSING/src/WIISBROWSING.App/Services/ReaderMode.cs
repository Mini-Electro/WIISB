using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WIISBROWSING.App.Services;

public sealed class ReaderBlock
{
    [JsonPropertyName("t")] public string Type { get; set; } = "p";
    [JsonPropertyName("l")] public int Level { get; set; }
    [JsonPropertyName("x")] public string Text { get; set; } = "";
    [JsonPropertyName("src")] public string? Src { get; set; }
    [JsonPropertyName("alt")] public string? Alt { get; set; }
    [JsonPropertyName("items")] public List<string>? Items { get; set; }
}

public sealed class ReaderArticle
{
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("byline")] public string Byline { get; set; } = "";
    [JsonPropertyName("site")] public string Site { get; set; } = "";
    [JsonPropertyName("words")] public int Words { get; set; }
    [JsonPropertyName("blocks")] public List<ReaderBlock> Blocks { get; set; } = new();
    public string SourceUrl { get; set; } = "";
}

/// <summary>
/// Reader mode. A script running in the page pulls out plain content blocks (text, headings, lists, image addresses);
/// the reader page then builds its own elements from that data. Page HTML is never copied into browser UI.
/// </summary>
public static class ReaderMode
{
    private static readonly ConcurrentDictionary<string, ReaderArticle> Articles = new();

    public static void Store(string tabId, ReaderArticle article) => Articles[tabId] = article;
    public static ReaderArticle? Get(string tabId) => Articles.TryGetValue(tabId, out var a) ? a : null;
    public static void Forget(string tabId) => Articles.TryRemove(tabId, out _);

    public static ReaderArticle? Parse(string? scriptResultJson)
    {
        if (string.IsNullOrEmpty(scriptResultJson) || scriptResultJson == "null") return null;
        try
        {
            var inner = JsonSerializer.Deserialize<string>(scriptResultJson);
            if (string.IsNullOrEmpty(inner)) return null;
            var a = JsonSerializer.Deserialize<ReaderArticle>(inner);
            if (a is null || a.Blocks.Count == 0) return null;
            a.Blocks = a.Blocks.Take(1500).Select(Clean).ToList();
            a.Title = Trim(a.Title, 200); a.Byline = Trim(a.Byline, 120); a.Site = Trim(a.Site, 100);
            return a;
        }
        catch (JsonException) { return null; }
    }

    private static ReaderBlock Clean(ReaderBlock b)
    {
        b.Type = b.Type is "h" or "p" or "quote" or "pre" or "ul" or "ol" or "img" ? b.Type : "p";
        b.Text = Trim(b.Text, 20_000);
        b.Level = Math.Clamp(b.Level, 1, 4);
        if (b.Src is not null && !(Uri.TryCreate(b.Src, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))) b.Src = null;
        if (b.Items is not null) b.Items = b.Items.Take(200).Select(i => Trim(i, 2000)).ToList();
        return b;
    }

    private static string Trim(string? s, int n) => string.IsNullOrEmpty(s) ? "" : s.Length <= n ? s : s[..n];

    public const string ExtractScript = """
        (function(){
          try {
            const bad = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,canvas,button,input,select,textarea,[role=navigation],[role=banner],[role=complementary],[aria-hidden=true],.ad,.ads,.advert,.comments,.sidebar,.share,.social';
            let root = document.querySelector('article') || document.querySelector('[role=main]') || document.querySelector('main');
            if (!root) {
              let best = null, bestLen = 0;
              document.querySelectorAll('div,section').forEach(el => {
                let len = 0;
                for (const c of el.children) if (c.tagName === 'P') len += (c.innerText || '').length;
                if (len > bestLen) { best = el; bestLen = len; }
              });
              root = best;
            }
            if (!root) return null;
            const blocks = []; let words = 0;
            const walk = el => {
              for (const n of el.children) {
                if (blocks.length > 1500) return;
                if (n.matches(bad)) continue;
                const tag = n.tagName.toLowerCase();
                if (/^h[1-4]$/.test(tag)) { const t = (n.innerText || '').trim(); if (t) blocks.push({t:'h', l:+tag[1], x:t}); }
                else if (tag === 'p') { const t = (n.innerText || '').trim(); if (t.length > 1) { blocks.push({t:'p', x:t}); words += t.split(/\s+/).length; } }
                else if (tag === 'blockquote') { const t = (n.innerText || '').trim(); if (t) blocks.push({t:'quote', x:t}); }
                else if (tag === 'pre') { const t = n.innerText || ''; if (t.trim()) blocks.push({t:'pre', x:t}); }
                else if (tag === 'ul' || tag === 'ol') { const items = [...n.children].map(li => (li.innerText || '').trim()).filter(Boolean); if (items.length) blocks.push({t:tag, items}); }
                else if (tag === 'img') { const s = n.currentSrc || n.src; if (/^https?:/.test(s) && n.naturalWidth > 240) blocks.push({t:'img', src:s, alt:n.alt || ''}); }
                else if (tag === 'figure') { const im = n.querySelector('img'); if (im) { const s = im.currentSrc || im.src; if (/^https?:/.test(s) && im.naturalWidth > 240) blocks.push({t:'img', src:s, alt:im.alt || ''}); } }
                else walk(n);
              }
            };
            walk(root);
            if (words < 120) return null;
            const h1 = document.querySelector('h1');
            const title = ((h1 && h1.innerText) || document.title || '').trim();
            const by = document.querySelector('[rel=author],.byline,.author,[itemprop=author]');
            return JSON.stringify({ title, byline: ((by && by.innerText) || '').trim().slice(0,120), site: location.hostname, words, blocks });
          } catch (e) { return null; }
        })()
        """;
}
