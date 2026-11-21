using WIISBROWSING.Core.Data;

namespace WIISBROWSING.UnitTests;

public class HistoryTests
{
    [Fact]
    public void Visits_are_recorded_and_counted()
    {
        using var p = ProfileData.OpenInMemory();
        var h = p.History!;
        h.RecordVisit("https://example.com/", "Example", 1000);
        h.RecordVisit("https://example.com/", "Example 2", 2000);
        h.RecordVisit("https://other.org/", "Other", 3000);
        var all = h.Query();
        Assert.Equal(2, all.Count);
        Assert.Equal("https://other.org/", all[0].Url);
        Assert.Equal(2, all.Single(e => e.Url == "https://example.com/").VisitCount);
        Assert.Equal("Example 2", all.Single(e => e.Url == "https://example.com/").Title);
    }

    [Theory]
    [InlineData("wiisb://newtab")]
    [InlineData("about:blank")]
    [InlineData("data:text/html,x")]
    [InlineData("file:///C:/x.html")]
    public void Internal_and_non_web_pages_are_not_history(string url)
    {
        using var p = ProfileData.OpenInMemory();
        p.History!.RecordVisit(url, "x");
        Assert.Equal(0, p.History.Count());
    }

    [Fact]
    public void Search_filters_by_text_and_range_and_escapes_wildcards()
    {
        using var p = ProfileData.OpenInMemory();
        var h = p.History!;
        h.RecordVisit("https://a.com/100%_sure", "Sure thing", 1000);
        h.RecordVisit("https://b.com/", "Banana", 5000);
        Assert.Single(h.Query("banana"));
        Assert.Single(h.Query("100%"));
        Assert.Empty(h.Query("x%y"));   // % is not a wildcard in the search box
        Assert.Equal(2, h.Query(fromMs: 0, toMs: 6000).Count);
        Assert.Single(h.Query(fromMs: 2000, toMs: 6000));
    }

    [Fact]
    public void Delete_range_really_removes_data_and_fixes_counts()
    {
        using var p = ProfileData.OpenInMemory();
        var h = p.History!;
        h.RecordVisit("https://a.com/", "A", 1000);
        h.RecordVisit("https://a.com/", "A", 9000);
        h.RecordVisit("https://b.com/", "B", 2000);
        h.DeleteRange(0, 5000);
        var left = h.Query();
        Assert.Single(left);
        Assert.Equal(1, left[0].VisitCount);
        Assert.Equal(9000, left[0].LastVisit);
    }

    [Fact]
    public void Clear_removes_everything()
    {
        using var p = ProfileData.OpenInMemory();
        p.History!.RecordVisit("https://a.com/", "A");
        p.History.Clear();
        Assert.Equal(0, p.History.Count());
    }

    [Fact]
    public void Suggestions_prefer_often_visited_pages()
    {
        using var p = ProfileData.OpenInMemory();
        var h = p.History!;
        h.RecordVisit("https://github.com/", "GitHub", 1);
        for (int i = 0; i < 5; i++) h.RecordVisit("https://github.com/", "GitHub", 10 + i);
        h.RecordVisit("https://git-scm.com/", "Git", 99);
        var s = h.Suggest("git");
        Assert.Equal("https://github.com/", s[0].Url);
    }

    [Fact]
    public void Private_profile_has_no_history_and_no_session_store()
    {
        using var normal = ProfileData.OpenInMemory();
        using var priv = ProfileData.OpenPrivate(normal);
        Assert.True(priv.IsPrivate);
        Assert.Null(priv.History);
        Assert.Null(priv.Session);
        // Permissions in a private window must not reach the ordinary database.
        priv.Permissions.Set("https://x.com", "camera", PermissionStore.Allow);
        Assert.Null(normal.Permissions.Get("https://x.com", "camera"));
        Assert.Empty(normal.Permissions.List());
    }
}

public class BookmarkTests
{
    [Fact]
    public void Add_find_update_remove()
    {
        using var p = ProfileData.OpenInMemory();
        var b = p.Bookmarks;
        var id = b.Add("https://example.com/", "Example");
        Assert.True(b.IsBookmarked("https://example.com/"));
        b.Update(id, "https://example.com/x", "Renamed", null);
        Assert.Equal("Renamed", b.FindByUrl("https://example.com/x")!.Title);
        b.Remove(id);
        Assert.False(b.IsBookmarked("https://example.com/x"));
    }

    [Fact]
    public void Only_web_addresses_can_be_bookmarked()
    {
        using var p = ProfileData.OpenInMemory();
        Assert.Throws<ArgumentException>(() => p.Bookmarks.Add("javascript:alert(1)", "x"));
        Assert.Throws<ArgumentException>(() => p.Bookmarks.Add("file:///C:/x", "x"));
    }

    [Fact]
    public void Folders_nest_and_cascade_on_delete()
    {
        using var p = ProfileData.OpenInMemory();
        var b = p.Bookmarks;
        var f1 = b.AddFolder("Dev");
        var f2 = b.AddFolder("Docs", f1);
        b.Add("https://a.com/", "A", f2);
        b.Add("https://b.com/", "B", f1);
        Assert.Single(b.Folders(f1));
        b.RemoveFolder(f1);
        Assert.Empty(b.All());
        Assert.Empty(b.AllFolders());
    }

    [Fact]
    public void Export_then_import_round_trips_with_folders()
    {
        using var src = ProfileData.OpenInMemory();
        var f = src.Bookmarks.AddFolder("Dev & Tools");
        src.Bookmarks.Add("https://a.com/?x=1&y=2", "A <b>", f);
        src.Bookmarks.Add("https://root.com/", "Root");
        var html = src.Bookmarks.ExportHtml();

        using var dst = ProfileData.OpenInMemory();
        var (added, skipped) = dst.Bookmarks.ImportHtml(html);
        Assert.Equal(2, added);
        Assert.Equal(0, skipped);
        var folder = Assert.Single(dst.Bookmarks.AllFolders());
        Assert.Equal("Dev & Tools", folder.Name);
        var inFolder = Assert.Single(dst.Bookmarks.InFolder(folder.Id));
        Assert.Equal("https://a.com/?x=1&y=2", inFolder.Url);
        Assert.Equal("A <b>", inFolder.Title);
        Assert.Single(dst.Bookmarks.InFolder(null));
    }

    [Fact]
    public void Import_skips_scripts_and_garbage()
    {
        using var p = ProfileData.OpenInMemory();
        const string html = """
            <DL><p>
              <DT><A HREF="javascript:alert(1)">bad</A>
              <DT><A HREF="data:text/html,x">bad2</A>
              <DT><A HREF="not a url">bad3</A>
              <DT><A HREF="https://ok.example/">good</A>
              <DT><A>nohref</A>
            </DL><p>
            """;
        var (added, skipped) = p.Bookmarks.ImportHtml(html);
        Assert.Equal(1, added);
        Assert.Equal(4, skipped);
        Assert.Equal("https://ok.example/", Assert.Single(p.Bookmarks.All()).Url);
    }

    [Fact]
    public void Search_finds_by_title_and_url()
    {
        using var p = ProfileData.OpenInMemory();
        p.Bookmarks.Add("https://learn.microsoft.com/dotnet", "Docs");
        p.Bookmarks.Add("https://example.com/", "Banana bread");
        Assert.Single(p.Bookmarks.Search("dotnet"));
        Assert.Single(p.Bookmarks.Search("banana"));
    }
}

public class SessionAndSettingsTests
{
    [Fact]
    public void Session_round_trips_workspaces_clusters_tabs()
    {
        using var p = ProfileData.OpenInMemory();
        var ws = SessionStore.DefaultWorkspaces();
        var snap = new SessionSnapshot(ws,
            new[] { new ClusterRecord("c1", "development", "Docs", "#38BDF8", "📘", true, 0) },
            new[]
            {
                new TabRecord("t1", "development", "c1", "https://github.com/", "GitHub", "", true, "⭐", false, false, 0, 100),
                new TabRecord("t2", "general", null, "https://example.com/", "Example", "", false, "", true, true, 1, 200),
            }, "development", "t1");
        p.Session!.Save(snap);
        var back = p.Session.Load();
        Assert.Equal(5, back.Workspaces.Count);
        Assert.Equal("c1", Assert.Single(back.Clusters).Id);
        Assert.True(back.Clusters[0].Collapsed);
        Assert.Equal(2, back.Tabs.Count);
        Assert.Equal("c1", back.Tabs[0].ClusterId);
        Assert.True(back.Tabs[0].Pinned);
        Assert.Equal("⭐", back.Tabs[0].Marker);
        Assert.True(back.Tabs[1].Muted && back.Tabs[1].SleepExempt);
        Assert.Equal("development", back.ActiveWorkspaceId);
        Assert.Equal("t1", back.ActiveTabId);
    }

    [Fact]
    public void Saving_again_replaces_the_session_atomically()
    {
        using var p = ProfileData.OpenInMemory();
        var ws = SessionStore.DefaultWorkspaces();
        p.Session!.Save(new SessionSnapshot(ws, Array.Empty<ClusterRecord>(), new[] { new TabRecord("a", "general", null, "https://a/", "", "", false, "", false, false, 0, 0) }, "general", "a"));
        p.Session.Save(new SessionSnapshot(ws, Array.Empty<ClusterRecord>(), new[] { new TabRecord("b", "general", null, "https://b/", "", "", false, "", false, false, 0, 0) }, "general", "b"));
        Assert.Equal("b", Assert.Single(p.Session.Load().Tabs).Id);
    }

    [Fact]
    public void Failed_save_leaves_the_previous_session_intact()
    {
        using var p = ProfileData.OpenInMemory();
        var ws = SessionStore.DefaultWorkspaces();
        p.Session!.Save(new SessionSnapshot(ws, Array.Empty<ClusterRecord>(), new[] { new TabRecord("keep", "general", null, "https://keep/", "", "", false, "", false, false, 0, 0) }, "general", "keep"));
        // A tab pointing at a workspace that doesn't exist violates the foreign key → whole save rolls back.
        Assert.ThrowsAny<Exception>(() => p.Session.Save(new SessionSnapshot(ws, Array.Empty<ClusterRecord>(),
            new[] { new TabRecord("bad", "nope", null, "https://bad/", "", "", false, "", false, false, 0, 0) }, "general", "bad")));
        Assert.Equal("keep", Assert.Single(p.Session.Load().Tabs).Id);
    }

    [Fact]
    public void Crash_detection()
    {
        using var p = ProfileData.OpenInMemory();
        Assert.False(p.Session!.PreviousRunCrashed());
        p.Session.MarkRunning();
        Assert.True(p.Session.PreviousRunCrashed());
        p.Session.MarkCleanShutdown();
        Assert.False(p.Session.PreviousRunCrashed());
    }

    [Fact]
    public void Settings_have_defaults_persist_and_notify()
    {
        using var p = ProfileData.OpenInMemory();
        var s = p.Settings;
        Assert.Equal("vertical-left", s.Get(SettingKeys.TabLayout));
        Assert.True(s.GetBool(SettingKeys.AdBlockEnabled));
        string? changed = null;
        s.Changed += k => changed = k;
        s.Set(SettingKeys.TabLayout, "horizontal");
        Assert.Equal(SettingKeys.TabLayout, changed);
        Assert.Equal("horizontal", s.Get(SettingKeys.TabLayout));
        s.SetInt(SettingKeys.SleepMinutes, 5);
        Assert.Equal(5, s.GetInt(SettingKeys.SleepMinutes));
        s.SetJson(SettingKeys.StartupUrls, new[] { "https://a/", "https://b/" });
        Assert.Equal(2, s.GetJson<string[]>(SettingKeys.StartupUrls)!.Length);
    }

    [Fact]
    public void Settings_survive_reopening_the_file()
    {
        var path = Path.Combine(Path.GetTempPath(), "wiisb-test-" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            using (var db = SqliteDb.Open(path, Schema.Profile)) new SettingsStore(db).Set("k", "v");
            using (var db = SqliteDb.Open(path, Schema.Profile)) Assert.Equal("v", new SettingsStore(db).Get("k"));
        }
        finally { foreach (var f in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(path) + "*")) File.Delete(f); }
    }

    [Fact]
    public void Newer_schema_is_refused_instead_of_corrupted()
    {
        var path = Path.Combine(Path.GetTempPath(), "wiisb-test-" + Guid.NewGuid().ToString("N") + ".db");
        try
        {
            using (var db = SqliteDb.Open(path, new[] { "CREATE TABLE a(x)", "CREATE TABLE b(x)" })) { }
            Assert.Throws<InvalidOperationException>(() => SqliteDb.Open(path, new[] { "CREATE TABLE a(x)" }));
        }
        finally { foreach (var f in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(path) + "*")) File.Delete(f); }
    }

    [Fact]
    public void Downloads_track_progress_and_finish()
    {
        using var p = ProfileData.OpenInMemory();
        var id = p.Downloads.Insert("https://x/f.zip", "f.zip", @"C:\d\f.zip", "application/zip", 1000);
        p.Downloads.UpdateProgress(id, 400, 1000);
        Assert.Equal(400, p.Downloads.Get(id)!.ReceivedBytes);
        p.Downloads.SetState(id, DownloadStates.Completed, 1000);
        var d = p.Downloads.Get(id)!;
        Assert.Equal(DownloadStates.Completed, d.State);
        Assert.NotNull(d.EndedAt);
        p.Downloads.ClearFinished();
        Assert.Empty(p.Downloads.List());
    }

    [Fact]
    public void Interrupted_downloads_are_marked_failed_on_start()
    {
        using var p = ProfileData.OpenInMemory();
        var id = p.Downloads.Insert("https://x/f.zip", "f.zip", @"C:\d\f.zip", "", 10);
        p.Downloads.FailInterrupted();
        Assert.Equal(DownloadStates.Failed, p.Downloads.Get(id)!.State);
    }

    [Fact]
    public void Permissions_notes_speeddial_collections()
    {
        using var p = ProfileData.OpenInMemory();
        p.Permissions.Set("https://meet.example", "microphone", PermissionStore.Allow);
        Assert.Equal("allow", p.Permissions.Get("https://meet.example", "microphone"));
        p.Permissions.Set("https://meet.example", "microphone", PermissionStore.Block);
        Assert.Equal("block", p.Permissions.Get("https://meet.example", "microphone"));
        p.Permissions.Revoke("https://meet.example", "microphone");
        Assert.Null(p.Permissions.Get("https://meet.example", "microphone"));

        var n = p.Notes.Add("Title", "Body about bananas");
        Assert.Single(p.Notes.List("banana"));
        p.Notes.Update(n, "T2", "B2", true);
        Assert.True(p.Notes.Get(n)!.Pinned);

        var sd = p.SpeedDial.Add("Ex", "https://example.com/");
        Assert.Throws<ArgumentException>(() => p.SpeedDial.Add("x", "javascript:1"));
        p.SpeedDial.Remove(sd);
        Assert.True(p.SpeedDial.IsEmpty());

        var c = p.Collections.Create("Research");
        p.Collections.AddItem(c, "Doc", "https://example.com/");
        Assert.Equal(1, p.Collections.List()[0].ItemCount);
        p.Collections.Delete(c);
        Assert.Empty(p.Collections.List());
    }

    [Fact]
    public void Profile_registry_creates_isolated_folders()
    {
        var root = Path.Combine(Path.GetTempPath(), "wiisb-prof-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var db = SqliteDb.Open(":memory:", Schema.App);
            var reg = new ProfileRegistry(db, root);
            var a = reg.EnsureDefault();
            var b = reg.Create("Work", "#38BDF8");
            Assert.NotEqual(reg.FolderPath(a), reg.FolderPath(b));
            Assert.NotEqual(reg.WebDataPath(a), reg.WebDataPath(b));
            Assert.Throws<InvalidOperationException>(() => reg.Create("work", "#fff"));
            reg.Delete(b.Id, deleteData: true);
            Assert.False(Directory.Exists(reg.FolderPath(b)));
            Assert.Throws<InvalidOperationException>(() => reg.Delete(a.Id, true)); // last profile stays
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
