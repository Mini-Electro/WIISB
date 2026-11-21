namespace WIISBROWSING.Core.Data;

public sealed record WorkspaceRecord(string Id, string Name, string Icon, string Color, int Position, bool Hidden);
public sealed record ClusterRecord(string Id, string WorkspaceId, string Name, string Color, string Emoji, bool Collapsed, int Position);
public sealed record TabRecord(string Id, string WorkspaceId, string? ClusterId, string Url, string Title, string Favicon, bool Pinned, string Marker, bool Muted, bool SleepExempt, int Position, long LastActive);

/// <summary>Everything needed to bring a window back exactly as it was.</summary>
public sealed record SessionSnapshot(
    IReadOnlyList<WorkspaceRecord> Workspaces,
    IReadOnlyList<ClusterRecord> Clusters,
    IReadOnlyList<TabRecord> Tabs,
    string? ActiveWorkspaceId,
    string? ActiveTabId);

/// <summary>
/// Saves and loads workspaces, clusters and tabs. A save replaces the whole snapshot inside one transaction,
/// so a crash can never leave half a session on disk.
/// </summary>
public sealed class SessionStore
{
    private readonly SqliteDb _db;
    private readonly SettingsStore _settings;

    public SessionStore(SqliteDb db, SettingsStore settings) { _db = db; _settings = settings; }

    public static IReadOnlyList<WorkspaceRecord> DefaultWorkspaces() => new[]
    {
        new WorkspaceRecord("general", "General", "🏠", "#8B5CF6", 0, false),
        new WorkspaceRecord("gaming", "Gaming", "🎮", "#F43F5E", 1, false),
        new WorkspaceRecord("development", "Development", "💻", "#38BDF8", 2, false),
        new WorkspaceRecord("study", "Study", "📚", "#34D399", 3, false),
        new WorkspaceRecord("entertainment", "Entertainment", "🍿", "#FBBF24", 4, false),
    };

    public bool HasSession() => _db.Long("SELECT COUNT(*) FROM workspaces") > 0;

    public void Save(SessionSnapshot s)
    {
        _db.Transaction(tx =>
        {
            tx.Exec("DELETE FROM tabs");
            tx.Exec("DELETE FROM clusters");
            tx.Exec("DELETE FROM workspaces");
            foreach (var w in s.Workspaces)
                tx.Exec("INSERT INTO workspaces(id, name, icon, color, position, hidden) VALUES($id,$n,$i,$c,$p,$h)",
                    ("$id", w.Id), ("$n", w.Name), ("$i", w.Icon), ("$c", w.Color), ("$p", w.Position), ("$h", w.Hidden ? 1 : 0));
            foreach (var c in s.Clusters)
                tx.Exec("INSERT INTO clusters(id, workspace_id, name, color, emoji, collapsed, position) VALUES($id,$w,$n,$c,$e,$col,$p)",
                    ("$id", c.Id), ("$w", c.WorkspaceId), ("$n", c.Name), ("$c", c.Color), ("$e", c.Emoji), ("$col", c.Collapsed ? 1 : 0), ("$p", c.Position));
            foreach (var t in s.Tabs)
                tx.Exec("INSERT INTO tabs(id, workspace_id, cluster_id, url, title, favicon, pinned, marker, muted, sleep_exempt, position, last_active) VALUES($id,$w,$c,$u,$t,$f,$p,$m,$mu,$se,$pos,$la)",
                    ("$id", t.Id), ("$w", t.WorkspaceId), ("$c", t.ClusterId), ("$u", t.Url), ("$t", t.Title), ("$f", t.Favicon), ("$p", t.Pinned ? 1 : 0),
                    ("$m", t.Marker), ("$mu", t.Muted ? 1 : 0), ("$se", t.SleepExempt ? 1 : 0), ("$pos", t.Position), ("$la", t.LastActive));
            tx.Exec("INSERT INTO settings(key, value) VALUES('session.activeWorkspace', $v) ON CONFLICT(key) DO UPDATE SET value = $v", ("$v", s.ActiveWorkspaceId ?? ""));
            tx.Exec("INSERT INTO settings(key, value) VALUES('session.activeTab', $v) ON CONFLICT(key) DO UPDATE SET value = $v", ("$v", s.ActiveTabId ?? ""));
        });
    }

    public SessionSnapshot Load()
    {
        var workspaces = _db.Query("SELECT id, name, icon, color, position, hidden FROM workspaces ORDER BY position",
            r => new WorkspaceRecord(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetInt32(5) != 0));
        var clusters = _db.Query("SELECT id, workspace_id, name, color, emoji, collapsed, position FROM clusters ORDER BY position",
            r => new ClusterRecord(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt32(5) != 0, r.GetInt32(6)));
        var tabs = _db.Query("SELECT id, workspace_id, cluster_id, url, title, favicon, pinned, marker, muted, sleep_exempt, position, last_active FROM tabs ORDER BY position",
            r => new TabRecord(r.GetString(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5),
                r.GetInt32(6) != 0, r.GetString(7), r.GetInt32(8) != 0, r.GetInt32(9) != 0, r.GetInt32(10), r.GetInt64(11)));
        // Fresh settings reads: the snapshot keys are written inside Save's transaction.
        string? aw = _db.String("SELECT value FROM settings WHERE key = 'session.activeWorkspace'");
        string? at = _db.String("SELECT value FROM settings WHERE key = 'session.activeTab'");
        return new SessionSnapshot(workspaces, clusters, tabs, string.IsNullOrEmpty(aw) ? null : aw, string.IsNullOrEmpty(at) ? null : at);
    }

    /// <summary>True if the previous run did not shut down cleanly (crash, power loss, killed process).</summary>
    public bool PreviousRunCrashed() => _settings.Get(SettingKeys.CleanShutdown, "true") == "false";

    public void MarkRunning() => _settings.Set(SettingKeys.CleanShutdown, "false");
    public void MarkCleanShutdown() => _settings.Set(SettingKeys.CleanShutdown, "true");
}
