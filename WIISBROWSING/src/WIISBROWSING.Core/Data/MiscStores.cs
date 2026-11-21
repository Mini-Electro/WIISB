namespace WIISBROWSING.Core.Data;

// ---- Downloads -------------------------------------------------------------------------------------------

public sealed record DownloadRecord(long Id, string Url, string FileName, string Path, string Mime, long TotalBytes, long ReceivedBytes, string State, long StartedAt, long? EndedAt);

public static class DownloadStates
{
    public const string InProgress = "in_progress";
    public const string Paused = "paused";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public sealed class DownloadStore
{
    private readonly SqliteDb _db;
    public DownloadStore(SqliteDb db) => _db = db;

    private static DownloadRecord Read(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt64(5), r.GetInt64(6), r.GetString(7), r.GetInt64(8), r.IsDBNull(9) ? null : r.GetInt64(9));

    private const string Cols = "id, url, file_name, path, mime, total_bytes, received_bytes, state, started_at, ended_at";

    public long Insert(string url, string fileName, string path, string mime, long total)
    {
        _db.Exec("INSERT INTO downloads(url, file_name, path, mime, total_bytes, received_bytes, state, started_at) VALUES($u,$f,$p,$m,$t,0,$s,$at)",
            ("$u", url), ("$f", fileName), ("$p", path), ("$m", mime), ("$t", total), ("$s", DownloadStates.InProgress), ("$at", HistoryStore.NowMs()));
        return _db.LastInsertId();
    }

    public void UpdateProgress(long id, long received, long total) =>
        _db.Exec("UPDATE downloads SET received_bytes = $r, total_bytes = $t WHERE id = $id", ("$r", received), ("$t", total), ("$id", id));

    public void SetState(long id, string state, long? received = null)
    {
        bool done = state is DownloadStates.Completed or DownloadStates.Failed or DownloadStates.Cancelled;
        _db.Exec("UPDATE downloads SET state = $s, ended_at = $e, received_bytes = COALESCE($r, received_bytes) WHERE id = $id",
            ("$s", state), ("$e", done ? HistoryStore.NowMs() : null), ("$r", received), ("$id", id));
    }

    public IReadOnlyList<DownloadRecord> List(int limit = 200) =>
        _db.Query($"SELECT {Cols} FROM downloads ORDER BY started_at DESC LIMIT $n", Read, ("$n", limit));

    public DownloadRecord? Get(long id) => _db.Query($"SELECT {Cols} FROM downloads WHERE id = $id", Read, ("$id", id)).FirstOrDefault();

    public void Remove(long id) => _db.Exec("DELETE FROM downloads WHERE id = $id", ("$id", id));

    /// <summary>Clears finished entries from the list. Files on disk are never touched.</summary>
    public void ClearFinished() =>
        _db.Exec("DELETE FROM downloads WHERE state IN ($a, $b, $c)", ("$a", DownloadStates.Completed), ("$b", DownloadStates.Failed), ("$c", DownloadStates.Cancelled));

    /// <summary>Downloads that were running when the browser closed can't continue; mark them failed.</summary>
    public void FailInterrupted() =>
        _db.Exec("UPDATE downloads SET state = $f, ended_at = $e WHERE state IN ($a, $b)",
            ("$f", DownloadStates.Failed), ("$e", HistoryStore.NowMs()), ("$a", DownloadStates.InProgress), ("$b", DownloadStates.Paused));
}

// ---- Speed Dial ------------------------------------------------------------------------------------------

public sealed record SpeedDialEntry(long Id, string Title, string Url, int Position);

public sealed class SpeedDialStore
{
    private readonly SqliteDb _db;
    public SpeedDialStore(SqliteDb db) => _db = db;

    public IReadOnlyList<SpeedDialEntry> List() =>
        _db.Query("SELECT id, title, url, position FROM speed_dial ORDER BY position, id", r => new SpeedDialEntry(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3)));

    public long Add(string title, string url)
    {
        if (!BookmarkStore.IsValidUrl(url)) throw new ArgumentException("Enter a web address.", nameof(url));
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM speed_dial");
        _db.Exec("INSERT INTO speed_dial(title, url, position) VALUES($t, $u, $p)", ("$t", string.IsNullOrWhiteSpace(title) ? url : title.Trim()), ("$u", url), ("$p", pos));
        return _db.LastInsertId();
    }

    public void Update(long id, string title, string url)
    {
        if (!BookmarkStore.IsValidUrl(url)) throw new ArgumentException("Enter a web address.", nameof(url));
        _db.Exec("UPDATE speed_dial SET title = $t, url = $u WHERE id = $id", ("$t", title.Trim()), ("$u", url), ("$id", id));
    }

    public void Remove(long id) => _db.Exec("DELETE FROM speed_dial WHERE id = $id", ("$id", id));

    public void Reorder(IReadOnlyList<long> idsInOrder) =>
        _db.Transaction(tx => { for (int i = 0; i < idsInOrder.Count; i++) tx.Exec("UPDATE speed_dial SET position = $p WHERE id = $id", ("$p", i), ("$id", idsInOrder[i])); });

    public bool IsEmpty() => _db.Long("SELECT COUNT(*) FROM speed_dial") == 0;
}

// ---- Notes -----------------------------------------------------------------------------------------------

public sealed record Note(long Id, string Title, string Body, string Url, string WorkspaceId, bool Pinned, long UpdatedAt);

public sealed class NoteStore
{
    private readonly SqliteDb _db;
    public NoteStore(SqliteDb db) => _db = db;

    private static Note Read(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt32(5) != 0, r.GetInt64(6));

    private const string Cols = "id, title, body, url, workspace_id, pinned, updated_at";

    public long Add(string title, string body, string url = "", string workspaceId = "")
    {
        _db.Exec("INSERT INTO notes(title, body, url, workspace_id, pinned, updated_at) VALUES($t,$b,$u,$w,0,$at)",
            ("$t", title), ("$b", body), ("$u", url), ("$w", workspaceId), ("$at", HistoryStore.NowMs()));
        return _db.LastInsertId();
    }

    public void Update(long id, string title, string body, bool pinned) =>
        _db.Exec("UPDATE notes SET title = $t, body = $b, pinned = $p, updated_at = $at WHERE id = $id",
            ("$t", title), ("$b", body), ("$p", pinned ? 1 : 0), ("$at", HistoryStore.NowMs()), ("$id", id));

    public void Remove(long id) => _db.Exec("DELETE FROM notes WHERE id = $id", ("$id", id));

    public IReadOnlyList<Note> List(string? search = null)
    {
        if (string.IsNullOrWhiteSpace(search))
            return _db.Query($"SELECT {Cols} FROM notes ORDER BY pinned DESC, updated_at DESC", Read);
        var like = "%" + search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
        return _db.Query($"SELECT {Cols} FROM notes WHERE title LIKE $q ESCAPE '\\' OR body LIKE $q ESCAPE '\\' ORDER BY pinned DESC, updated_at DESC", Read, ("$q", like));
    }

    public Note? Get(long id) => _db.Query($"SELECT {Cols} FROM notes WHERE id = $id", Read, ("$id", id)).FirstOrDefault();
}

// ---- Site permissions ------------------------------------------------------------------------------------

public sealed record SitePermission(string Origin, string Permission, string State, long UpdatedAt);

public sealed class PermissionStore
{
    public const string Allow = "allow";
    public const string Block = "block";

    private readonly SqliteDb _db;
    public PermissionStore(SqliteDb db) => _db = db;

    public string? Get(string origin, string permission) =>
        _db.String("SELECT state FROM site_permissions WHERE origin = $o AND permission = $p", ("$o", origin), ("$p", permission));

    public void Set(string origin, string permission, string state) =>
        _db.Exec("INSERT INTO site_permissions(origin, permission, state, updated_at) VALUES($o,$p,$s,$at) ON CONFLICT(origin, permission) DO UPDATE SET state = $s, updated_at = $at",
            ("$o", origin), ("$p", permission), ("$s", state), ("$at", HistoryStore.NowMs()));

    public void Revoke(string origin, string permission) =>
        _db.Exec("DELETE FROM site_permissions WHERE origin = $o AND permission = $p", ("$o", origin), ("$p", permission));

    public void RevokeAll() => _db.Exec("DELETE FROM site_permissions");

    public IReadOnlyList<SitePermission> List() =>
        _db.Query("SELECT origin, permission, state, updated_at FROM site_permissions ORDER BY origin, permission",
            r => new SitePermission(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3)));
}

// ---- Ad-block exceptions ---------------------------------------------------------------------------------

public sealed class AdBlockExceptionStore
{
    private readonly SqliteDb _db;
    public AdBlockExceptionStore(SqliteDb db) => _db = db;

    public IReadOnlyList<string> List() => _db.Query("SELECT host FROM adblock_exceptions ORDER BY host", r => r.GetString(0));
    public void Add(string host) => _db.Exec("INSERT OR IGNORE INTO adblock_exceptions(host) VALUES($h)", ("$h", host.ToLowerInvariant()));
    public void Remove(string host) => _db.Exec("DELETE FROM adblock_exceptions WHERE host = $h", ("$h", host.ToLowerInvariant()));
}

// ---- Collections (research boards) -----------------------------------------------------------------------

public sealed record CollectionInfo(long Id, string Name, string Description, long CreatedAt, int ItemCount);
public sealed record CollectionItem(long Id, long CollectionId, string Title, string Url, string Note, int Position);

public sealed class CollectionStore
{
    private readonly SqliteDb _db;
    public CollectionStore(SqliteDb db) => _db = db;

    public long Create(string name, string description = "")
    {
        _db.Exec("INSERT INTO collections(name, description, created_at) VALUES($n,$d,$c)", ("$n", string.IsNullOrWhiteSpace(name) ? "New collection" : name.Trim()), ("$d", description), ("$c", HistoryStore.NowMs()));
        return _db.LastInsertId();
    }

    public void Rename(long id, string name, string description) =>
        _db.Exec("UPDATE collections SET name = $n, description = $d WHERE id = $id", ("$n", name.Trim()), ("$d", description), ("$id", id));

    public void Delete(long id) => _db.Exec("DELETE FROM collections WHERE id = $id", ("$id", id));

    public IReadOnlyList<CollectionInfo> List() =>
        _db.Query("SELECT c.id, c.name, c.description, c.created_at, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) FROM collections c ORDER BY c.created_at DESC",
            r => new CollectionInfo(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt64(3), r.GetInt32(4)));

    public long AddItem(long collectionId, string title, string url, string note = "")
    {
        if (!BookmarkStore.IsValidUrl(url)) throw new ArgumentException("Only web addresses can be saved.", nameof(url));
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM collection_items WHERE collection_id = $c", ("$c", collectionId));
        _db.Exec("INSERT INTO collection_items(collection_id, title, url, note, position) VALUES($c,$t,$u,$n,$p)",
            ("$c", collectionId), ("$t", string.IsNullOrWhiteSpace(title) ? url : title.Trim()), ("$u", url), ("$n", note), ("$p", pos));
        return _db.LastInsertId();
    }

    public IReadOnlyList<CollectionItem> Items(long collectionId) =>
        _db.Query("SELECT id, collection_id, title, url, note, position FROM collection_items WHERE collection_id = $c ORDER BY position, id",
            r => new CollectionItem(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt32(5)), ("$c", collectionId));

    public void RemoveItem(long id) => _db.Exec("DELETE FROM collection_items WHERE id = $id", ("$id", id));
}
