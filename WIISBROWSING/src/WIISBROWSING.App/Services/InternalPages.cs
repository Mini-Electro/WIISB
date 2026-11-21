using System.IO;
using System.Reflection;
using System.Text;
using Microsoft.Web.WebView2.Core;
using WIISBROWSING.App.Models;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Urls;

namespace WIISBROWSING.App.Services;

/// <summary>
/// Serves the wiisb:// pages (new tab, settings, history…) from files embedded in the app. They are static
/// files — nothing from the internet is ever served under this scheme — and they can't be framed by websites.
/// </summary>
public sealed class InternalPages
{
    private const string Csp = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
                               "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

    private readonly Func<ProfileData> _data;
    private readonly FaviconCache _favicons;
    private static readonly Assembly Asm = typeof(InternalPages).Assembly;

    public InternalPages(Func<ProfileData> data, FaviconCache favicons) { _data = data; _favicons = favicons; }

    public void Serve(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e, BrowserTab tab)
    {
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri) || !uri.Scheme.Equals("wiisb", StringComparison.OrdinalIgnoreCase)) return;
        var page = uri.Host.ToLowerInvariant();
        if (!UrlClassifier.InternalPages.Contains(page)) { e.Response = NotFound(env); return; }

        var path = uri.AbsolutePath.Trim('/').ToLowerInvariant();
        switch (path)
        {
            case "" or "index.html":
                e.Response = FromResource(env, "internal/internal.html", "text/html; charset=utf-8");
                break;
            case "internal.js" or "pages-a.js" or "pages-b.js" or "boot.js":
                e.Response = FromResource(env, "internal/" + path, "text/javascript; charset=utf-8");
                break;
            case "internal.css":
                e.Response = FromResource(env, "internal/internal.css", "text/css; charset=utf-8");
                break;
            case "logo.png":
                e.Response = FromResource(env, "internal/logo.png", "image/png");
                break;
            case "wallpaper":
                e.Response = Wallpaper(env);
                break;
            default:
                if (path.StartsWith("favicon/"))
                {
                    var bytes = _favicons.GetBytes(Uri.UnescapeDataString(path["favicon/".Length..]));
                    e.Response = bytes is null ? NotFound(env) : Make(env, new MemoryStream(bytes), 200, "image/png", cache: true);
                }
                else e.Response = NotFound(env);
                break;
        }
    }

    private CoreWebView2WebResourceResponse Wallpaper(CoreWebView2Environment env)
    {
        var path = _data().Settings.Get(SettingKeys.WallpaperPath);
        try
        {
            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                var ext = Path.GetExtension(path).ToLowerInvariant();
                var type = ext switch { ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".bmp" => "image/bmp", _ => null };
                var info = new FileInfo(path);
                if (type is not null && info.Length <= 30 * 1024 * 1024)
                    return Make(env, new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read), 200, type, cache: false);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return Make(env, new MemoryStream(), 404, "text/plain", cache: false);
    }

    private static CoreWebView2WebResourceResponse FromResource(CoreWebView2Environment env, string name, string contentType)
    {
        var stream = Asm.GetManifestResourceStream(name);
        return stream is null ? NotFound(env) : Make(env, stream, 200, contentType, cache: false);
    }

    private static CoreWebView2WebResourceResponse NotFound(CoreWebView2Environment env) =>
        Make(env, new MemoryStream(Encoding.UTF8.GetBytes("Not found")), 404, "text/plain", cache: false);

    private static CoreWebView2WebResourceResponse Make(CoreWebView2Environment env, Stream body, int status, string contentType, bool cache)
    {
        var headers = new StringBuilder();
        headers.Append("Content-Type: ").Append(contentType).Append("\r\n");
        headers.Append("Content-Security-Policy: ").Append(Csp).Append("\r\n");
        headers.Append("X-Frame-Options: DENY\r\n");
        headers.Append("X-Content-Type-Options: nosniff\r\n");
        headers.Append("Referrer-Policy: no-referrer\r\n");
        headers.Append(cache ? "Cache-Control: max-age=300\r\n" : "Cache-Control: no-store\r\n");
        return env.CreateWebResourceResponse(body, status, status == 200 ? "OK" : "Error", headers.ToString());
    }
}
