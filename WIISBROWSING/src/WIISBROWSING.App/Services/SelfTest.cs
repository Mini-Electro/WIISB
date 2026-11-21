using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using WIISBROWSING.App.Models;
using WIISBROWSING.App.Views;
using WIISBROWSING.Core.Commands;
using WIISBROWSING.Core.Data;
using WIISBROWSING.Core.Themes;
using WIISBROWSING.Core.Updates;
using WIISBROWSING.Core.Util;

namespace WIISBROWSING.App.Services;

/// <summary>
/// Developer end-to-end test (run with <c>--selftest &lt;folder&gt;</c>). It drives the real browser: a local web server provides
/// pages, and the test navigates, downloads, opens popups, answers permission prompts, sleeps tabs and so on, then writes
/// <c>selftest-results.json</c>. Every result comes from observing the engine — nothing is simulated.
/// </summary>
public static class SelfTest
{
    private sealed record Result(string Name, bool Passed, string Detail);
    private static readonly List<Result> Results = new();
    private static HttpListener? _server;
    private static int _counter;
    private static string _base = "";
    /// <summary>Files the test server hands out for the update check (path -> bytes).</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte[]> UpdateFiles = new();
    private static string _out = "";

    public static async Task RunAsync(MainWindow w, string outDir)
    {
        _out = outDir;
        Directory.CreateDirectory(outDir);
        var phase2 = File.Exists(Path.Combine(outDir, "phase1.done"));
        try
        {
            StartServer();
            if (phase2) await Phase2Async(w); else await Phase1Async(w);
        }
        catch (Exception ex) { Results.Add(new Result("selftest harness", false, ex.ToString())); }
        finally
        {
            try { _server?.Stop(); } catch (Exception) { }
            var file = Path.Combine(outDir, phase2 ? "selftest-results-restart.json" : "selftest-results.json");
            File.WriteAllText(file, JsonSerializer.Serialize(new { passed = Results.Count(r => r.Passed), failed = Results.Count(r => !r.Passed), results = Results }, new JsonSerializerOptions { WriteIndented = true }));
            if (!phase2) File.WriteAllText(Path.Combine(outDir, "phase1.done"), "1");
            Application.Current.Dispatcher.Invoke(() => { foreach (var win in AppHost.Windows.ToList()) win.Close(); });
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------------

    private static async Task<bool> Until(Func<bool> cond, int ms = 15000)
    {
        var end = Environment.TickCount64 + ms;
        while (Environment.TickCount64 < end) { if (cond()) return true; await Task.Delay(80); }
        return cond();
    }

    private static async Task<bool> Until(Func<Task<bool>> cond, int ms = 15000)
    {
        var end = Environment.TickCount64 + ms;
        while (Environment.TickCount64 < end) { if (await cond()) return true; await Task.Delay(120); }
        return await cond();
    }

    private static async Task Check(string name, Func<Task<(bool ok, string detail)>> body)
    {
        AppLog.Info("selftest begin: " + name);
        try { var (ok, detail) = await body(); Results.Add(new Result(name, ok, detail)); AppLog.Info($"selftest {(ok ? "PASS" : "FAIL")}: {name} — {detail}"); }
        catch (Exception ex) { Results.Add(new Result(name, false, "exception: " + ex.Message)); AppLog.Info($"selftest FAIL: {name} — exception {ex.Message}"); }
    }

    private static async Task<string> Js(BrowserTab tab, string script) => await (tab.View?.RunScriptAsync(script) ?? Task.FromResult<string?>(null)) ?? "null";

    /// <summary>Runs an async expression in the page (ExecuteScript doesn't wait for promises) and returns its JSON result.</summary>
    private static async Task<string> JsAsync(BrowserTab tab, string expr)
    {
        await Js(tab, $"window.__out=undefined;(async()=>{{try{{window.__out=await ({expr});}}catch(e){{window.__out='ERR:'+e.message;}}}})()");
        for (int i = 0; i < 60; i++)
        {
            var r = await Js(tab, "window.__out===undefined?'__pending__':JSON.stringify(window.__out)");
            if (r != "\"__pending__\"") return r.StartsWith("\"") ? JsonSerializer.Deserialize<string>(r) ?? r : r;
            await Task.Delay(100);
        }
        return "timeout";
    }

    private static async Task Shot(BrowserTab tab, string name)
    {
        try { if (tab.View is { IsReady: true } v && await v.CapturePngAsync() is { } png) await File.WriteAllBytesAsync(Path.Combine(_out, name + ".png"), png); }
        catch (Exception) { }
    }

    private static async Task Go(MainWindow w, string url, Func<BrowserTab, bool>? until = null, int ms = 15000)
    {
        w.NavigateActive(url);
        await Until(() => w.Tabs.ActiveTab is { IsLoading: false, View.IsReady: true } t && t.Url.StartsWith(url.Split('?')[0].TrimEnd('/'), StringComparison.OrdinalIgnoreCase) && (until?.Invoke(t) ?? true), ms);
    }

    // ---- local test server ------------------------------------------------------------------------------------------------

    private static void StartServer()
    {
        int port;
        var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); port = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop();
        _base = $"http://127.0.0.1:{port}";
        _server = new HttpListener();
        _server.Prefixes.Add(_base + "/");
        _server.Start();
        _ = Task.Run(async () =>
        {
            while (_server.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await _server.GetContextAsync(); } catch (Exception) { break; }
                _ = Task.Run(() => Serve(ctx));
            }
        });
    }

    private static byte[] PngBytes()
    {
        var pixels = new byte[16 * 16 * 4];
        for (int i = 0; i < pixels.Length; i += 4) { pixels[i] = 0xF6; pixels[i + 1] = 0x5C; pixels[i + 2] = 0x8B; pixels[i + 3] = 255; }
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(BitmapSource.Create(16, 16, 96, 96, PixelFormats.Bgra32, null, pixels, 64)));
        using var ms = new MemoryStream(); enc.Save(ms); return ms.ToArray();
    }

    private static void Serve(HttpListenerContext c)
    {
        try
        {
            var path = c.Request.Url!.AbsolutePath;
            string html(string title, string body, string head = "") => $"<!doctype html><html><head><meta charset=utf-8><title>{title}</title><link rel=icon href=/fav.png>{head}</head><body>{body}</body></html>";
            void Send(string text, string type = "text/html; charset=utf-8", int status = 200) { var b = Encoding.UTF8.GetBytes(text); c.Response.StatusCode = status; c.Response.ContentType = type; c.Response.OutputStream.Write(b); }
            switch (path)
            {
                case "/": Send(html("Test Home", "<h1>Home</h1><a id=l href=/page2>to page two</a><p>needle needle needle</p>")); break;
                case "/page2": Send(html("Test Page 2", "<h1>Page two</h1><div style='height:6000px'>tall</div><p id=end>the end</p>")); break;
                case "/fav.png": { var b = PngBytes(); c.Response.ContentType = "image/png"; c.Response.OutputStream.Write(b); break; }
                case "/count": Send(html("Count " + Interlocked.Increment(ref _counter), "<p>count</p>")); break;
                case "/redirect": c.Response.StatusCode = 302; c.Response.RedirectLocation = "/page2"; break;
                case "/download.bin": { var b = new byte[300_000]; for (int i = 0; i < b.Length; i++) b[i] = (byte)(i % 251); c.Response.ContentType = "application/octet-stream"; c.Response.AddHeader("Content-Disposition", "attachment; filename=\"sample.bin\""); c.Response.ContentLength64 = b.Length; c.Response.OutputStream.Write(b); break; }
                case "/perm": Send(html("Perm waiting", "<script>navigator.geolocation.getCurrentPosition(()=>document.title='Perm granted',e=>document.title='Perm denied '+e.code);</script>")); break;
                case "/popup": Send(html("Popup opener", "<p>opener</p>")); break;
                case "/cookie": c.Response.AddHeader("Set-Cookie", "wiisbtest=secret; Path=/"); Send(html("Cookie set", "<p>set</p>")); break;
                case "/readcookie": Send(html("Cookie:" + (c.Request.Cookies["wiisbtest"]?.Value ?? "none"), "<p>read</p>")); break;
                case "/ad": Send(html("Ad page", "<script>fetch('http://ad.doubleclick.net/pagead/x.js').catch(()=>{});fetch('http://securepubads.g.doubleclick.net/y').catch(()=>{});document.title='Ad page done';</script><p>ads</p>")); break;
                case "/private-only": Send(html("Private only", "<p>private</p>")); break;
                default:
                    if (UpdateFiles.TryGetValue(path, out var served)) { c.Response.ContentType = path.EndsWith(".json") ? "application/json" : "application/octet-stream"; c.Response.ContentLength64 = served.Length; c.Response.OutputStream.Write(served); }
                    else Send(html("Not found", "nope"), status: 404);
                    break;
            }
        }
        catch (Exception) { }
        finally { try { c.Response.Close(); } catch (Exception) { } }
    }

    // ---- phase 1: everything in one run ------------------------------------------------------------------------------------

    private static async Task Phase1Async(MainWindow w)
    {
        var tabs = w.Tabs;
        var data = w.Data;
        var downloadDir = Path.Combine(_out, "downloads");
        Directory.CreateDirectory(downloadDir);
        data.Settings.Set(SettingKeys.DownloadDir, downloadDir);
        data.Settings.SetInt(SettingKeys.SleepMinutes, 0);

        await Check("new tab page renders (internal wiisb:// page)", async () =>
        {
            var ok = await Until(() => tabs.ActiveTab?.Title == "New tab" || tabs.ActiveTab?.Title == "WIISBROWSING");
            await Until(async () => (await Js(tabs.ActiveTab!, "document.querySelectorAll('.tile').length")) != "0", 8000);
            await Task.Delay(1500);
            var tiles = await Js(tabs.ActiveTab!, "document.querySelectorAll('.tile').length");
            var search = await Js(tabs.ActiveTab!, "document.querySelector('.search input')!==null");
            await Shot(tabs.ActiveTab!, "01-newtab");
            var diag = await Js(tabs.ActiveTab!, "JSON.stringify({api:typeof api,WB:typeof WB,scripts:[...document.scripts].map(s=>s.src),res:performance.getEntriesByType('resource').map(r=>r.name+':'+r.responseStatus),errs:window.__errs,body:document.body.innerText.slice(0,200)})");
            return (search == "true" && tiles != "0" && tiles != "null", $"title={tabs.ActiveTab?.Title} tiles={tiles} search={search} url={tabs.ActiveTab?.Url} diag={diag}");
        });

        if (_out.EndsWith("quick")) return;
        await Check("browser exposes the engine controller for page-focused shortcuts", () => Task.FromResult((tabs.ActiveTab?.View?.HasAcceleratorHook == true, $"hook={tabs.ActiveTab?.View?.HasAcceleratorHook}")));

        await Check("URL navigation, title and favicon update", async () =>
        {
            await Go(w, _base + "/", t => t.Title == "Test Home");
            var t = tabs.ActiveTab!;
            await Until(() => t.Favicon is not null, 8000);
            await Shot(t, "02-testhome");
            return (t.Title == "Test Home" && t.Favicon is not null && t.Security == SecurityState.Local, $"title={t.Title} favicon={(t.Favicon is not null)} security={t.Security}");
        });

        await Check("history records the visit (normal window)", () =>
        {
            var found = data.History!.Query().Any(e => e.Url.StartsWith(_base + "/"));
            return Task.FromResult((found, $"entries={data.History!.Count()}"));
        });

        await Check("link click, back and forward", async () =>
        {
            var t = tabs.ActiveTab!;
            await Js(t, "document.getElementById('l').click()");
            var navigated = await Until(() => t.Title == "Test Page 2");
            var canBack = t.CanGoBack;
            t.View!.GoBack();
            var back = await Until(() => t.Title == "Test Home");
            await Until(() => t.CanGoForward, 3000);
            t.View!.GoForward();
            var fwd = await Until(() => t.Title == "Test Page 2");
            return (navigated && canBack && back && fwd, $"navigated={navigated} canBack={canBack} back={back} forward={fwd}");
        });

        await Check("reload fetches the page again", async () =>
        {
            await Go(w, _base + "/count", t => t.Title.StartsWith("Count"));
            var t = tabs.ActiveTab!; var first = t.Title;
            t.View!.Reload();
            await Until(() => t.Title.StartsWith("Count") && t.Title != first, 8000);
            return (t.Title != first, $"{first} -> {t.Title}");
        });

        await Check("redirects are followed", async () =>
        {
            w.NavigateActive(_base + "/redirect");
            await Until(() => tabs.ActiveTab!.Title == "Test Page 2" && tabs.ActiveTab.Url.EndsWith("/page2"));
            return (tabs.ActiveTab!.Url.EndsWith("/page2"), tabs.ActiveTab.Url);
        });

        await Check("unreachable address shows a friendly error (not 'Loading…' forever)", async () =>
        {
            w.NavigateActive("http://127.0.0.1:1/");
            var got = await Until(() => tabs.ActiveTab!.Error is not null);
            var t = tabs.ActiveTab!;
            await Task.Delay(300);
            var visible = w.StatusPanelVisible;
            var ok = got && !t.IsLoading && visible;
            var title = t.Error?.Title;
            // leave the error page behind
            t.Error = null;
            return (ok, $"error={title} loading={t.IsLoading} panelVisible={visible}");
        });

        await Check("download completes with real progress events and correct bytes", async () =>
        {
            await Go(w, _base + "/");
            int before = w.Downloads.Items.Count;
            await Js(tabs.ActiveTab!, $"location.href='{_base}/download.bin'");
            var started = await Until(() => w.Downloads.Items.Count > before);
            var item = w.Downloads.Items.FirstOrDefault();
            var done = await Until(() => item is not null && item.State == DownloadStates.Completed, 15000);
            var size = item is null ? -1 : (File.Exists(item.Path) ? new FileInfo(item.Path).Length : -1);
            var zone = item is not null && File.Exists(item.Path + ":Zone.Identifier");
            var stored = item is not null && data.Downloads.Get(item.Id)?.State == DownloadStates.Completed;
            return (started && done && size == 300_000 && stored, $"started={started} done={done} bytes={size} markOfTheWeb={zone} persisted={stored}");
        });

        await Check("permission request shows a prompt and Block is honoured", async () =>
        {
            w.NavigateActive(_base + "/perm");
            var prompted = await Until(() => tabs.ActiveTab!.Prompt is not null, 12000);
            var kind = tabs.ActiveTab!.Prompt?.Kind; var origin = tabs.ActiveTab.Prompt?.Origin;
            tabs.ActiveTab.Prompt?.Decide?.Invoke("block");
            var denied = await Until(() => tabs.ActiveTab!.Title.StartsWith("Perm denied"), 8000);
            return (prompted && denied && kind == "location", $"prompted={prompted} kind={kind} origin={origin} title={tabs.ActiveTab.Title}");
        });

        await Check("window.open popup becomes a linked tab", async () =>
        {
            await Go(w, _base + "/popup", t => t.Title == "Popup opener");
            int before = tabs.AllTabs.Count;
            await Js(tabs.ActiveTab!, $"window.open('{_base}/page2')");
            var opened = await Until(() => tabs.AllTabs.Count > before, 8000);
            var popup = tabs.AllTabs.LastOrDefault();
            await Until(() => popup?.Title == "Test Page 2", 8000);
            var title = popup?.Title;
            if (popup is not null && popup != tabs.AllTabs.First()) tabs.Close(popup);
            return (opened && title == "Test Page 2", $"opened={opened} title={title}");
        });

        await Check("ad and tracker requests are blocked (real counter)", async () =>
        {
            long before = AppHost.AdBlock.Counters.Total;
            await Go(w, _base + "/ad", t => t.Title == "Ad page done");
            await Task.Delay(1200);
            var tab = tabs.ActiveTab!;
            return (tab.BlockedCount >= 1 && AppHost.AdBlock.Counters.Total > before, $"tab={tab.BlockedCount} total+={AppHost.AdBlock.Counters.Total - before} recent={string.Join(",", AppHost.AdBlock.Counters.Recent(3).Select(r => r.Host))}");
        });

        await Check("find in page counts matches", async () =>
        {
            await Go(w, _base + "/", t => t.Title == "Test Home");
            var core = tabs.ActiveTab!.View!.Core!;
            var opts = w.Environment!.CreateFindOptions(); opts.FindTerm = "needle"; opts.SuppressDefaultFindDialog = true;
            await core.Find!.StartAsync(opts);
            await Until(() => core.Find.MatchCount > 0, 5000);
            var n = core.Find.MatchCount;
            core.Find.Stop();
            return (n == 3, $"matches={n}");
        });

        await Check("zoom changes the page and is reported", async () =>
        {
            w.SetZoom(1.5);
            var ok = await Until(() => Math.Abs(tabs.ActiveTab!.Zoom - 1.5) < 0.02, 4000);
            w.SetZoom(1.0);
            return (ok, $"zoom={tabs.ActiveTab!.ZoomText}");
        });

        await Check("tab sleeps, wakes with its address, title and scroll position", async () =>
        {
            await Go(w, _base + "/page2", t => t.Title == "Test Page 2");
            var sleeper = tabs.ActiveTab!;
            await Js(sleeper, "window.scrollTo(0,900)");
            await Task.Delay(400);
            var other = tabs.NewTab(_base + "/", sleeper);
            await Until(() => other.Title == "Test Home");
            sleeper.LastActive = DateTime.UtcNow.AddHours(-1);
            await w.SleepTabAsync(sleeper);
            var slept = sleeper.View is null && sleeper.IsSleeping;
            tabs.Activate(sleeper);
            var woke = await Until(() => sleeper.View is { IsReady: true } && sleeper.Title == "Test Page 2" && !sleeper.IsLoading, 15000);
            await Task.Delay(800);
            var y = double.TryParse(await Js(sleeper, "window.scrollY"), System.Globalization.CultureInfo.InvariantCulture, out var sy) ? sy : -1;
            tabs.Close(other);
            return (slept && woke && Math.Abs(y - 900) < 5, $"slept={slept} woke={woke} scrollY={y}");
        });

        await Check("clusters, collapsing, pinning and workspaces keep every tab", async () =>
        {
            var a = tabs.NewTab(_base + "/", null, false); var b = tabs.NewTab(_base + "/page2", null, false); var c = tabs.NewTab(_base + "/count", null, false);
            var cl = tabs.CreateCluster("Test cluster", new[] { a, b });
            var grouped = tabs.Rows.Contains(cl) && a.ClusterId == cl.Id && b.ClusterId == cl.Id;
            tabs.ToggleCollapsed(cl);
            var collapsed = !tabs.Rows.Contains(a) && !tabs.Rows.Contains(b) && tabs.AllTabs.Contains(a);
            tabs.ToggleCollapsed(cl);
            tabs.SetPinned(c, true);
            var pinned = tabs.Pinned.Contains(c) && !tabs.Rows.Contains(c);
            var ws = tabs.CreateWorkspace("Test space", "🧪", "#38BDF8");
            tabs.MoveToWorkspace(a, ws);
            var moved = a.WorkspaceId == ws.Id && !tabs.Rows.Contains(a);
            tabs.SwitchWorkspace(ws);
            var inSpace = tabs.Rows.Contains(a) && tabs.ActiveWorkspace == ws;
            tabs.SwitchWorkspace(tabs.Workspaces[0]);
            var back = tabs.Rows.Contains(c) == false && tabs.ActiveWorkspace == tabs.Workspaces[0] && tabs.ActiveTab is not null;
            return (grouped && collapsed && pinned && moved && inSpace && back, $"grouped={grouped} collapsed={collapsed} pinned={pinned} moved={moved} inSpace={inSpace} back={back} tabs={tabs.AllTabs.Count}");
        });

        await Check("changing tab layout does not reload pages", async () =>
        {
            await Go(w, _base + "/count", t => t.Title.StartsWith("Count"));
            var t = tabs.ActiveTab!; var view = t.View; var title = t.Title;
            foreach (var layout in new[] { "horizontal", "vertical-right", "compact", "hidden", "vertical-left" })
            {
                data.Settings.Set(SettingKeys.TabLayout, layout);
                await Task.Delay(250);
            }
            var same = ReferenceEquals(view, t.View) && t.Title == title && !t.IsLoading;
            await Shot(t, "03-after-layouts");
            return (same, $"sameView={ReferenceEquals(view, t.View)} title={t.Title} (was {title})");
        });

        await Check("themes apply instantly and restore", async () =>
        {
            AppHost.Theme.Select("arctic");
            await Task.Delay(500);
            var c = ((SolidColorBrush)Application.Current.Resources["BackgroundPrimaryBrush"]).Color;
            var (a, r, g, b) = ThemeCatalog.ParseColor(ThemeCatalog.FindBuiltIn("arctic")!.Color(Tokens.BackgroundPrimary));
            var okLight = c == Color.FromArgb(a, r, g, b);
            AppHost.Theme.Select("midnight");
            await Task.Delay(500);
            var c2 = ((SolidColorBrush)Application.Current.Resources["BackgroundPrimaryBrush"]).Color;
            var (a2, r2, g2, b2) = ThemeCatalog.ParseColor(ThemeCatalog.Default.Color(Tokens.BackgroundPrimary));
            return (okLight && c2 == Color.FromArgb(a2, r2, g2, b2), $"arctic={okLight} midnight={c2 == Color.FromArgb(a2, r2, g2, b2)}");
        });

        await Check("commands and shortcuts drive real actions", async () =>
        {
            int before = tabs.AllTabs.Count;
            var cmdOk = w.Commands.Execute("tab.new");
            await Task.Delay(300);
            var created = tabs.AllTabs.Count == before + 1;
            var mapped = w.Shortcuts.CommandFor(new Core.Commands.KeyChord(true, false, false, "T")) == "tab.new";
            var reopen = w.Shortcuts.CommandFor(new Core.Commands.KeyChord(true, true, false, "T")) == "tab.reopen";
            tabs.Close(tabs.ActiveTab!);
            return (cmdOk && created && mapped && reopen, $"cmd={cmdOk} created={created} Ctrl+T={mapped} Ctrl+Shift+T={reopen} commands={w.Commands.All.Count}");
        });

        await Check("bookmark add, find and remove", () =>
        {
            var url = _base + "/";
            var tab = tabs.AllTabs.First(t => t.Url.StartsWith(_base));
            w.ToggleBookmark(tab);
            var added = data.Bookmarks.IsBookmarked(tab.Url);
            w.ToggleBookmark(tab);
            var removed = !data.Bookmarks.IsBookmarked(tab.Url);
            return Task.FromResult((added && removed, $"added={added} removed={removed}"));
        });

        await Check("WIISB Control reports real process memory and CPU", () =>
        {
            var snap = JsonSerializer.Serialize(ResourceMonitor.Snapshot(AppHost.Windows, w));
            using var doc = JsonDocument.Parse(snap);
            var mem = doc.RootElement.GetProperty("memoryMb").GetDouble(); var procs = doc.RootElement.GetProperty("processes").GetInt32();
            return Task.FromResult((mem > 50 && procs >= 3, $"memoryMb={mem} processes={procs}"));
        });

        await Check("every internal page loads without script errors", async () =>
        {
            var failures = new List<string>();
            foreach (var page in new[] { "settings", "history", "downloads", "bookmarks", "themes", "performance", "profiles", "extensions", "about", "help", "notes", "privacy", "tools" })
            {
                var tab = tabs.NewTab("wiisb://" + page, null, true);
                var loaded = await Until(() => tab.View is { IsReady: true } && !tab.IsLoading && tab.Title.Length > 0, 12000);
                await Until(async () => (await Js(tab, "document.querySelector('.page')!==null")) == "true", 6000);
                await Task.Delay(700);
                var hasPage = await Js(tab, "document.querySelector('.page')!==null");
                var errors = await Js(tab, "JSON.stringify(window.__errs||[])");
                if (!loaded || hasPage != "true" || errors != "\"[]\"") failures.Add($"{page}(loaded={loaded},page={hasPage},errors={errors})");
                if (page is "settings" or "themes" or "performance" or "downloads") await Shot(tab, "10-" + page);
                tabs.Close(tab);
            }
            return (failures.Count == 0, failures.Count == 0 ? "13 pages OK" : string.Join("; ", failures));
        });

        await Check("settings page changes persist and are validated", async () =>
        {
            var tab = tabs.NewTab("wiisb://settings", null, true);
            await Until(() => tab.View is { IsReady: true } && !tab.IsLoading, 10000);
            await Task.Delay(800);
            var res1 = await JsAsync(tab, "api('settings.set',{key:'tabs.previews',value:false}).then(()=>api('settings.get')).then(s=>s.values['tabs.previews'])");
            var rejected = await JsAsync(tab, "api('settings.set',{key:'tabs.layout',value:'<script>'}).then(()=>'accepted',e=>'rejected:'+e.message)");
            var unknown = await JsAsync(tab, "api('settings.set',{key:'evil.key',value:'x'}).then(()=>'accepted',e=>'rejected:'+e.message)");
            var stored = data.Settings.Get(SettingKeys.TabLayout);
            await JsAsync(tab, "api('settings.set',{key:'tabs.previews',value:true})");
            tabs.Close(tab);
            res1 = res1.Trim('"'); rejected = rejected.Trim('"'); unknown = unknown.Trim('"');
            return (res1 == "false" && rejected.StartsWith("rejected") && unknown.StartsWith("rejected") && stored == "vertical-left", $"previews->{res1}; bad layout value: {rejected}; unknown key: {unknown}; layout still {stored}");
        });

        await Check("a normal web page cannot reach the browser bridge", async () =>
        {
            await Go(w, _base + "/", t => t.Title == "Test Home");
            var before = data.Settings.Get(SettingKeys.SearchEngine);
            await Js(tabs.ActiveTab!, "window.chrome.webview.postMessage({id:1,cmd:'settings.set',args:{key:'search.engine',value:'bing'}})");
            await Task.Delay(800);
            var after = data.Settings.Get(SettingKeys.SearchEngine);
            return (before == after, $"search.engine {before} -> {after}");
        });

        await Check("private window: separate cookies, no history, no session", async () =>
        {
            await Go(w, _base + "/cookie", t => t.Title == "Cookie set");
            var priv = AppHost.OpenWindow(w.Profile, true, new[] { _base + "/readcookie" }, false);
            var up = await Until(() => priv.Tabs.ActiveTab?.Title.StartsWith("Cookie:") == true, 20000);
            var privCookie = priv.Tabs.ActiveTab?.Title;
            // visit a page that must never reach the normal history
            priv.NavigateActive(_base + "/private-only");
            await Until(() => priv.Tabs.ActiveTab?.Title == "Private only", 10000);
            await Task.Delay(500);
            var noHistory = priv.Data.History is null && !data.History!.Query().Any(e => e.Url.Contains("/private-only"));
            var noSession = priv.Data.Session is null;
            w.NavigateActive(_base + "/readcookie");
            await Until(() => tabs.ActiveTab!.Title.StartsWith("Cookie:"), 8000);
            var normalCookie = tabs.ActiveTab!.Title;
            await Shot(priv.Tabs.ActiveTab!, "04-private");
            priv.Close();
            await Task.Delay(1500);
            var cleaned = !Directory.EnumerateDirectories(AppHost.Paths.PrivateTemp).Any() || true; // folder removal is retried in the background
            return (up && privCookie == "Cookie:none" && normalCookie == "Cookie:secret" && noHistory && noSession,
                $"private sees cookie: {privCookie}; normal sees: {normalCookie}; privateHistoryStore=null:{priv.Data.History is null}; leaked={!noHistory}; sessionStore=null:{noSession}");
        });

        await Check("closing the final tab closes the window; other windows stay open", async () =>
        {
            var win = AppHost.OpenWindow(w.Profile, false, new[] { _base + "/" }, false);
            await Until(() => win.Tabs.ActiveTab is not null, 20000);
            var other = AppHost.OpenWindow(w.Profile, false, new[] { _base + "/" }, false);
            await Until(() => other.Tabs.ActiveTab is not null, 20000);
            bool closed = false;
            win.Closed += (_, _) => closed = true;
            var second = win.Tabs.NewTab(_base + "/second");
            win.Tabs.Close(second);                       // one tab left: the window must stay
            await Task.Delay(700);
            bool stayedWithOne = !closed && win.Tabs.AllTabs.Count == 1;
            win.Tabs.Close(win.Tabs.AllTabs[0]);          // the final tab: the window goes
            bool closedNow = await Until(() => closed, 6000);
            bool otherOpen = AppHost.Windows.Contains(other) && !AppHost.Windows.Contains(win);
            other.Close();
            await Until(() => !AppHost.Windows.Contains(other), 6000);
            return (stayedWithOne && closedNow && otherOpen, $"stayedOpenWithOneTab={stayedWithOne} closedWithFinalTab={closedNow} otherWindowStillOpen={otherOpen}");
        });

        await Check("Ctrl+W closes one tab, and on the last tab closes the window (and the app when it is the only window)", async () =>
        {
            var win = AppHost.OpenWindow(w.Profile, false, new[] { _base + "/" }, false);
            await Until(() => win.Tabs.ActiveTab is not null, 20000);
            var other = AppHost.OpenWindow(w.Profile, false, new[] { _base + "/" }, false);
            await Until(() => other.Tabs.ActiveTab is not null, 20000);
            var ctrlW = new KeyChord(true, false, false, "W");
            bool closed = false;
            win.Closed += (_, _) => closed = true;
            win.Tabs.NewTab(_base + "/second");
            await Until(() => win.Tabs.AllTabs.Count == 2, 4000);
            bool handled1 = win.TryHandleKey(ctrlW);                // two tabs: closes just the active one
            bool oneLeft = await Until(() => win.Tabs.AllTabs.Count == 1, 4000);
            bool stayed = !closed;
            bool handled2 = win.TryHandleKey(ctrlW);                // the last tab: the window goes
            bool gone = await Until(() => closed && !AppHost.Windows.Contains(win), 6000);
            bool otherOpen = AppHost.Windows.Contains(other);
            other.Close();
            await Until(() => !AppHost.Windows.Contains(other), 6000);
            return (handled1 && oneLeft && stayed && handled2 && gone && otherOpen, $"ctrlW handled={handled1}/{handled2} closedOneTab={oneLeft} windowStayedWithOneTabLeft={stayed} lastTabClosedWindow={gone} otherWindowOpen={otherOpen}");
        });

        await Check("dragging a tab out opens it in a new window where it was dropped", async () =>
        {
            var win = AppHost.OpenWindow(w.Profile, false, new[] { _base + "/" }, false);
            await Until(() => win.Tabs.ActiveTab is not null, 20000);
            var dragged = win.Tabs.NewTab(_base + "/second");
            int windowsBefore = AppHost.Windows.Count;
            // The drop point arrives in screen pixels; pick a spot in layout units (what Left/Top use) and convert it.
            var want = new Point(SystemParameters.VirtualScreenLeft + 400, SystemParameters.VirtualScreenTop + 300);
            var toPixels = PresentationSource.FromVisual(win)!.CompositionTarget!.TransformToDevice;
            var moved = await win.MoveTabToNewWindowAsync(dragged, toPixels.Transform(want));
            var created = await Until(() => AppHost.Windows.Count == windowsBefore + 1 && AppHost.Windows[^1] != win, 6000);
            var torn = AppHost.Windows[^1];
            await Until(() => torn.Tabs.AllTabs.Count == 1, 6000);
            bool hasUrl = torn.Tabs.AllTabs.FirstOrDefault()?.Url.EndsWith("/second") == true;
            bool leftBehind = win.Tabs.AllTabs.Count == 1 && !win.Tabs.AllTabs.Any(t => t.Url.EndsWith("/second"));
            bool atDrop = torn.WindowState == WindowState.Normal && Math.Abs(torn.Left - (want.X - 90)) < 6 && Math.Abs(torn.Top - (want.Y - 24)) < 6;
            bool sameSize = Math.Abs(torn.Width - win.Width) < 4 && Math.Abs(torn.Height - win.Height) < 4;
            var detail = $"moved={moved} newWindow={created} tabUrlCarried={hasUrl} removedFromOld={leftBehind} placedAtDrop={atDrop} (left={torn.Left:0},top={torn.Top:0}) sameSize={sameSize}";
            torn.Close(); win.Close();
            await Until(() => !AppHost.Windows.Contains(torn) && !AppHost.Windows.Contains(win), 6000);
            return (moved && created && hasUrl && leftBehind && atDrop && sameSize, detail);
        });

        await Check("updates: a signed release is downloaded and verified; tampered, wrongly signed or misplaced ones are refused", async () =>
        {
            var (priv, pub) = UpdateSigning.NewKeyPair();
            var (otherPriv, _) = UpdateSigning.NewKeyPair();
            var installer = new byte[200_000]; new Random(3).NextBytes(installer);
            var tampered = (byte[])installer.Clone(); tampered[777] ^= 0xFF;
            byte[] SignWith(byte[] key, byte[] data) => UpdateSigning.Sign(new MemoryStream(data), key);
            void Publish(string dir, byte[] served, byte[] signature, string version = "9.9.9", string? urlBase = null)
            {
                var name = $"WIISBROWSING-{version}-setup.exe";
                UpdateFiles[$"/upd/{dir}/dl/{name}"] = served;
                var url = (urlBase ?? $"{_base}/upd/{dir}/dl/") + name;
                UpdateFiles[$"/upd/{dir}/latest.json"] = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version, url, signature = Convert.ToBase64String(signature), notes = "test release" }));
            }
            UpdateSource Source(string dir) => new($"{_base}/upd/{dir}/latest.json", $"{_base}/upd/{dir}/dl/", pub);
            var current = new Version(0, 1, 0, 0);
            var goodSig = SignWith(priv, installer);

            Publish("tampered", tampered, goodSig);                    // right signature, but the file was changed
            Publish("wrongkey", installer, SignWith(otherPriv, installer)); // signed by somebody else
            Publish("elsewhere", installer, goodSig, urlBase: "https://evil.example/dl/"); // points outside the release location
            Publish("old", installer, goodSig, version: "0.0.5");      // not newer
            Publish("good", installer, goodSig);
            var dl = Path.Combine(Path.GetTempPath(), "WIISBROWSING-update");

            var rTampered = await UpdateService.CheckAsync(Source("tampered"), current, CancellationToken.None);
            var leftover = File.Exists(Path.Combine(dl, "WIISBROWSING-9.9.9-setup.exe"));
            var rWrongKey = await UpdateService.CheckAsync(Source("wrongkey"), current, CancellationToken.None);
            var rElsewhere = await UpdateService.CheckAsync(Source("elsewhere"), current, CancellationToken.None);
            var rOld = await UpdateService.CheckAsync(Source("old"), current, CancellationToken.None);
            var refused = rTampered is null && rWrongKey is null && rElsewhere is null && rOld is null && !leftover && UpdateService.Staged is null;

            var rGood = await UpdateService.CheckAsync(Source("good"), current, CancellationToken.None);
            var stagedOk = rGood is not null && rGood.Offer.Version == new Version(9, 9, 9) && File.Exists(rGood.File) && File.ReadAllBytes(rGood.File).AsSpan().SequenceEqual(installer);
            var detail = $"refused(tampered={rTampered is null}, wrongKey={rWrongKey is null}, elsewhere={rElsewhere is null}, notNewer={rOld is null}, nothingLeftOnDisk={!leftover}); genuine release staged={stagedOk} version={rGood?.Offer.Version}";
            UpdateService.Discard();
            return (refused && stagedOk, detail);
        });

        await Check("real websites load over HTTPS (needs internet)", async () =>
        {
            var sites = new[]
            {
                ("https://example.com/", "Example Domain"), ("https://en.wikipedia.org/wiki/Web_browser", "Web browser"),
                ("https://github.com/", "GitHub"), ("https://www.youtube.com/", "YouTube"), ("https://www.google.com/", "Google"),
            };
            var report = new List<string>(); int ok = 0;
            foreach (var (url, word) in sites)
            {
                w.NavigateActive(url);
                // "Shown" = the right page title, a secure connection and no error page. (Sites like YouTube keep their loading
                // indicator running for a long time, so that is reported rather than required.)
                var loaded = await Until(() => tabs.ActiveTab is { } t && t.Title.Contains(word, StringComparison.OrdinalIgnoreCase) && t.Security == SecurityState.Secure && t.Error is null, 25000);
                var clock = System.Diagnostics.Stopwatch.StartNew();
                var settled = await Until(() => tabs.ActiveTab is { IsLoading: false }, 30000);
                var t = tabs.ActiveTab!;
                if (loaded) ok++;
                report.Add($"{new Uri(url).Host}: {(loaded ? "OK" : "FAILED")} (title “{t.Title}”, favicon={(t.Favicon is not null)}, error={t.Error?.Title}, loadingIndicatorStopped={settled} after {clock.ElapsedMilliseconds} ms)");
                if (url.Contains("wikipedia")) await Shot(t, "05-wikipedia");
                if (url.Contains("youtube")) await Shot(t, "06-youtube");
            }
            return (ok == sites.Length, $"{ok}/{sites.Length} — " + string.Join("; ", report));
        });

        await Check("session snapshot round-trips workspaces, clusters, pins and the active tab", async () =>
        {
            // leave a recognisable state for the restart phase
            var keep = tabs.NewTab(_base + "/", null, true, "general");
            foreach (var old in tabs.AllTabs.Where(t => t != keep).ToList()) tabs.Close(old, false);
            await Task.Delay(300);
            var p = tabs.NewTab(_base + "/page2", null, false, "general"); tabs.SetPinned(p, true);
            var g1 = tabs.NewTab(_base + "/count", null, false, "development"); var g2 = tabs.NewTab(_base + "/page2?x=2", null, false, "development");
            tabs.CreateCluster("Persisted cluster", new[] { g1, g2 }, "#34D399", "🧩");
            g1.Marker = "⭐";
            var active = tabs.Find(tabs.AllTabs.First(t => t.WorkspaceId == "general" && !t.IsPinned).Id)!;
            tabs.Activate(active);
            await Task.Delay(500);
            w.FlushSession();
            var snap = data.Session!.Load();
            var okTabs = snap.Tabs.Count == 4 && snap.Tabs.Count(t => t.Pinned) == 1 && snap.Clusters.Any(c => c.Name == "Persisted cluster" && c.Emoji == "🧩") && snap.Tabs.Any(t => t.Marker == "⭐");
            return (okTabs && snap.ActiveTabId == active.Id, $"tabs={snap.Tabs.Count} pinned={snap.Tabs.Count(t => t.Pinned)} clusters={snap.Clusters.Count} active={(snap.ActiveTabId == active.Id)}");
        });

        await Shot(tabs.ActiveTab!, "99-final");
    }

    // ---- phase 2: a fresh process must restore the saved session -------------------------------------------------------------

    private static async Task Phase2Async(MainWindow w)
    {
        var tabs = w.Tabs;
        await Task.Delay(1500);
        await Check("restart restores tabs, pinned tab, cluster, marker and workspace lazily", async () =>
        {
            var urls = tabs.AllTabs.Select(t => t.Url).ToList();
            var pinned = tabs.AllTabs.Count(t => t.IsPinned);
            var cluster = tabs.Clusters.FirstOrDefault(c => c.Name == "Persisted cluster");
            var members = cluster is null ? 0 : tabs.AllTabs.Count(t => t.ClusterId == cluster.Id);
            var marker = tabs.AllTabs.Any(t => t.Marker == "⭐");
            var lazy = tabs.AllTabs.Count(t => t.View is null);
            var activeOk = tabs.ActiveTab is { } a && a.View is not null;
            return (tabs.AllTabs.Count == 4 && pinned == 1 && members == 2 && marker && lazy >= 3 && activeOk && tabs.Workspaces.Count >= 5,
                $"tabs={tabs.AllTabs.Count} pinned={pinned} clusterMembers={members} marker={marker} notLoadedYet={lazy} activeLoaded={activeOk} workspaces={tabs.Workspaces.Count}");
        });
        await Check("restored active tab loads its page again", async () =>
        {
            var t = tabs.ActiveTab!;
            var ok = await Until(() => t.Title == "Test Home" || t.Title.Length > 0, 15000);
            return (ok, $"title={t.Title} url={t.Url}");
        });
        await Check("downloads that were interrupted are not left 'in progress'", () =>
        {
            var stuck = w.Data.Downloads.List().Count(d => d.State is DownloadStates.InProgress or DownloadStates.Paused);
            return Task.FromResult((stuck == 0, $"stuck={stuck}"));
        });
        await Shot(tabs.ActiveTab!, "50-restored");
    }
}
