namespace WIISBROWSING.Core.Data;

public sealed record HistoryEntry(long Id, string Url, string Title, int VisitCount, long LastVisit);

public sealed class HistoryStore
{
    private readonly SqliteDb _db;
    public HistoryStore(SqliteDb db) => _db = db;

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>Only real web pages are history; internal pages, blank pages and data URLs are not.</summary>
    public static bool IsRecordable(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);

    public void RecordVisit(string url, string? title, long? atMs = null, string transition = "link")
    {
        if (!IsRecordable(url)) return;
        long at = atMs ?? NowMs();
        _db.Transaction(tx =>
        {
            tx.Exec("""
                INSERT INTO history(url, title, visit_count, first_visit, last_visit) VALUES($u, $t, 1, $at, $at)
                ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1, last_visit = $at,
                    title = CASE WHEN $t <> '' THEN $t ELSE title END
                """, ("$u", url), ("$t", title ?? ""), ("$at", at));
            tx.Exec("INSERT INTO history_visits(history_id, visited_at, transition) SELECT id, $at, $tr FROM history WHERE url = $u",
                ("$u", url), ("$at", at), ("$tr", transition));
        });
    }

    public void UpdateTitle(string url, string? title)
    {
        if (string.IsNullOrWhiteSpace(title) || !IsRecordable(url)) return;
        _db.Exec("UPDATE history SET title = $t WHERE url = $u", ("$t", title), ("$u", url));
    }

    private static string Like(string text) =>
        "%" + text.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    public IReadOnlyList<HistoryEntry> Query(string? text = null, long? fromMs = null, long? toMs = null, int limit = 200, int offset = 0)
    {
        var where = new List<string>();
        var args = new List<(string, object?)>();
        if (!string.IsNullOrWhiteSpace(text))
        {
            where.Add("(url LIKE $q ESCAPE '\\' OR title LIKE $q ESCAPE '\\')");
            args.Add(("$q", Like(text.Trim())));
        }
        if (fromMs is not null) { where.Add("last_visit >= $from"); args.Add(("$from", fromMs)); }
        if (toMs is not null) { where.Add("last_visit < $to"); args.Add(("$to", toMs)); }
        args.Add(("$limit", Math.Clamp(limit, 1, 1000)));
        args.Add(("$offset", Math.Max(0, offset)));
        var sql = "SELECT id, url, title, visit_count, last_visit FROM history"
                  + (where.Count > 0 ? " WHERE " + string.Join(" AND ", where) : "")
                  + " ORDER BY last_visit DESC LIMIT $limit OFFSET $offset";
        return _db.Query(sql, r => new HistoryEntry(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetInt64(4)), args.ToArray());
    }

    /// <summary>Address-bar suggestions: frequently and recently visited pages that contain the text.</summary>
    public IReadOnlyList<HistoryEntry> Suggest(string text, int limit = 6)
    {
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<HistoryEntry>();
        return _db.Query("""
            SELECT id, url, title, visit_count, last_visit FROM history
            WHERE url LIKE $q ESCAPE '\' OR title LIKE $q ESCAPE '\'
            ORDER BY (visit_count * 2 + CASE WHEN url LIKE $p ESCAPE '\' THEN 40 ELSE 0 END) DESC, last_visit DESC
            LIMIT $n
            """, r => new HistoryEntry(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetInt64(4)),
            ("$q", Like(text.Trim())), ("$p", "%://" + Like(text.Trim()).TrimStart('%')), ("$n", limit));
    }

    public IReadOnlyList<HistoryEntry> TopSites(int count = 8) =>
        _db.Query("SELECT id, url, title, visit_count, last_visit FROM history ORDER BY visit_count DESC, last_visit DESC LIMIT $n",
            r => new HistoryEntry(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetInt64(4)), ("$n", count));

    public long Count() => _db.Long("SELECT COUNT(*) FROM history");

    public void Delete(IEnumerable<long> ids)
    {
        var list = ids.ToList();
        if (list.Count == 0) return;
        _db.Transaction(tx => { foreach (var id in list) tx.Exec("DELETE FROM history WHERE id = $id", ("$id", id)); });
    }

    /// <summary>Removes every visit in the range; pages left without visits disappear completely.</summary>
    public void DeleteRange(long fromMs, long toMs)
    {
        _db.Transaction(tx =>
        {
            tx.Exec("DELETE FROM history_visits WHERE visited_at >= $a AND visited_at < $b", ("$a", fromMs), ("$b", toMs));
            tx.Exec("DELETE FROM history WHERE id NOT IN (SELECT DISTINCT history_id FROM history_visits)");
            tx.Exec("""
                UPDATE history SET
                    visit_count = (SELECT COUNT(*) FROM history_visits v WHERE v.history_id = history.id),
                    last_visit  = (SELECT MAX(visited_at) FROM history_visits v WHERE v.history_id = history.id)
                """);
        });
    }

    /// <summary>Deletes all history and compacts the file so the data is not left behind in free pages.</summary>
    public void Clear()
    {
        _db.Transaction(tx => { tx.Exec("DELETE FROM history_visits"); tx.Exec("DELETE FROM history"); });
        _db.Vacuum();
    }
}
