using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace WIISBROWSING.Core.Data;

public sealed record Bookmark(long Id, long? FolderId, string Url, string Title, int Position, long CreatedAt);
public sealed record BookmarkFolder(long Id, long? ParentId, string Name, int Position);

public sealed partial class BookmarkStore
{
    private readonly SqliteDb _db;
    public BookmarkStore(SqliteDb db) => _db = db;

    public event Action? Changed;

    private static Bookmark ReadBookmark(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.IsDBNull(1) ? null : r.GetInt64(1), r.GetString(2), r.GetString(3), r.GetInt32(4), r.GetInt64(5));

    private static BookmarkFolder ReadFolder(Microsoft.Data.Sqlite.SqliteDataReader r) =>
        new(r.GetInt64(0), r.IsDBNull(1) ? null : r.GetInt64(1), r.GetString(2), r.GetInt32(3));

    public static bool IsValidUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "wiisb");

    public long Add(string url, string? title, long? folderId = null)
    {
        if (!IsValidUrl(url)) throw new ArgumentException("Only web addresses can be bookmarked.", nameof(url));
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id IS $f", ("$f", folderId));
        _db.Exec("INSERT INTO bookmarks(folder_id, url, title, position, created_at) VALUES($f, $u, $t, $p, $c)",
            ("$f", folderId), ("$u", url), ("$t", string.IsNullOrWhiteSpace(title) ? url : title.Trim()), ("$p", pos), ("$c", HistoryStore.NowMs()));
        var id = _db.LastInsertId();
        Changed?.Invoke();
        return id;
    }

    public void Update(long id, string url, string title, long? folderId)
    {
        if (!IsValidUrl(url)) throw new ArgumentException("Only web addresses can be bookmarked.", nameof(url));
        _db.Exec("UPDATE bookmarks SET url = $u, title = $t, folder_id = $f WHERE id = $id",
            ("$u", url), ("$t", string.IsNullOrWhiteSpace(title) ? url : title.Trim()), ("$f", folderId), ("$id", id));
        Changed?.Invoke();
    }

    public void Remove(long id) { _db.Exec("DELETE FROM bookmarks WHERE id = $id", ("$id", id)); Changed?.Invoke(); }

    public Bookmark? FindByUrl(string url) =>
        _db.Query("SELECT id, folder_id, url, title, position, created_at FROM bookmarks WHERE url = $u LIMIT 1", ReadBookmark, ("$u", url)).FirstOrDefault();

    public bool IsBookmarked(string url) => FindByUrl(url) is not null;

    public IReadOnlyList<Bookmark> InFolder(long? folderId) =>
        _db.Query("SELECT id, folder_id, url, title, position, created_at FROM bookmarks WHERE folder_id IS $f ORDER BY position, id", ReadBookmark, ("$f", folderId));

    public IReadOnlyList<Bookmark> All() =>
        _db.Query("SELECT id, folder_id, url, title, position, created_at FROM bookmarks ORDER BY folder_id, position, id", ReadBookmark);

    public IReadOnlyList<Bookmark> Search(string text, int limit = 50)
    {
        var like = "%" + text.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
        return _db.Query("SELECT id, folder_id, url, title, position, created_at FROM bookmarks WHERE title LIKE $q ESCAPE '\\' OR url LIKE $q ESCAPE '\\' ORDER BY title LIMIT $n",
            ReadBookmark, ("$q", like), ("$n", limit));
    }

    public long AddFolder(string name, long? parentId = null)
    {
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM bookmark_folders WHERE parent_id IS $p", ("$p", parentId));
        _db.Exec("INSERT INTO bookmark_folders(parent_id, name, position) VALUES($p, $n, $pos)",
            ("$p", parentId), ("$n", string.IsNullOrWhiteSpace(name) ? "New folder" : name.Trim()), ("$pos", pos));
        var id = _db.LastInsertId();
        Changed?.Invoke();
        return id;
    }

    public void RenameFolder(long id, string name) { _db.Exec("UPDATE bookmark_folders SET name = $n WHERE id = $id", ("$n", name.Trim()), ("$id", id)); Changed?.Invoke(); }
    public void RemoveFolder(long id) { _db.Exec("DELETE FROM bookmark_folders WHERE id = $id", ("$id", id)); Changed?.Invoke(); }

    public IReadOnlyList<BookmarkFolder> Folders(long? parentId) =>
        _db.Query("SELECT id, parent_id, name, position FROM bookmark_folders WHERE parent_id IS $p ORDER BY position, id", ReadFolder, ("$p", parentId));

    public IReadOnlyList<BookmarkFolder> AllFolders() =>
        _db.Query("SELECT id, parent_id, name, position FROM bookmark_folders ORDER BY parent_id, position, id", ReadFolder);

    public void MoveBookmark(long id, long? folderId, int position)
    {
        _db.Transaction(tx =>
        {
            tx.Exec("UPDATE bookmarks SET folder_id = $f, position = $p WHERE id = $id", ("$f", folderId), ("$p", position), ("$id", id));
        });
        Changed?.Invoke();
    }

    // ---- Netscape bookmark HTML (the format every browser exports) ------------------------------------

    public string ExportHtml()
    {
        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
        sb.AppendLine("<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">");
        sb.AppendLine("<TITLE>Bookmarks</TITLE>");
        sb.AppendLine("<H1>Bookmarks</H1>");
        var folders = AllFolders();
        var bookmarks = All();
        void Write(long? parent, int depth)
        {
            var pad = new string(' ', depth * 4);
            sb.AppendLine($"{pad}<DL><p>");
            foreach (var f in folders.Where(f => f.ParentId == parent).OrderBy(f => f.Position))
            {
                sb.AppendLine($"{pad}    <DT><H3>{WebUtility.HtmlEncode(f.Name)}</H3>");
                Write(f.Id, depth + 2);
            }
            foreach (var b in bookmarks.Where(b => b.FolderId == parent).OrderBy(b => b.Position))
                sb.AppendLine($"{pad}    <DT><A HREF=\"{WebUtility.HtmlEncode(b.Url)}\" ADD_DATE=\"{b.CreatedAt / 1000}\">{WebUtility.HtmlEncode(b.Title)}</A>");
            sb.AppendLine($"{pad}</DL><p>");
        }
        Write(null, 0);
        return sb.ToString();
    }

    [GeneratedRegex(@"<(/?)(DL|H3|A)\b([^>]*)>(.*?)(?=<(?:/?DL|H3|A|DT)\b|$)", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TokenRegex();

    [GeneratedRegex(@"HREF\s*=\s*""([^""]*)""", RegexOptions.IgnoreCase)]
    private static partial Regex HrefRegex();

    /// <summary>
    /// Imports a Netscape-style file. Only http(s) addresses are accepted: malformed or script-bearing entries are skipped.
    /// Returns how many bookmarks were added and how many entries were skipped.
    /// </summary>
    public (int Added, int Skipped) ImportHtml(string html, long? intoFolder = null)
    {
        if (html.Length > 20_000_000) throw new ArgumentException("That bookmarks file is too large.");
        int added = 0, skipped = 0;
        var stack = new Stack<long?>();
        stack.Push(intoFolder);
        long? pendingFolder = null;
        bool havePending = false;
        foreach (Match m in TokenRegex().Matches(html))
        {
            bool closing = m.Groups[1].Value == "/";
            var tag = m.Groups[2].Value.ToUpperInvariant();
            var text = WebUtility.HtmlDecode(Regex.Replace(m.Groups[4].Value, "<.*?>", "")).Trim();
            if (tag == "H3" && !closing)
            {
                pendingFolder = AddFolderQuiet(text.Length == 0 ? "Imported" : text, stack.Peek());
                havePending = true;
            }
            else if (tag == "DL")
            {
                if (!closing) { stack.Push(havePending ? pendingFolder : stack.Peek()); havePending = false; }
                else if (stack.Count > 1) stack.Pop();
            }
            else if (tag == "A" && !closing)
            {
                var href = HrefRegex().Match(m.Groups[3].Value);
                var url = href.Success ? WebWithoutScripts(WebUtility.HtmlDecode(href.Groups[1].Value)) : null;
                if (url is null) { skipped++; continue; }
                AddQuiet(url, text, stack.Peek());
                added++;
            }
        }
        Changed?.Invoke();
        return (added, skipped);
    }

    private static string? WebWithoutScripts(string url) =>
        Uri.TryCreate(url.Trim(), UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https") ? u.AbsoluteUri : null;

    private long AddFolderQuiet(string name, long? parent)
    {
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM bookmark_folders WHERE parent_id IS $p", ("$p", parent));
        _db.Exec("INSERT INTO bookmark_folders(parent_id, name, position) VALUES($p, $n, $pos)", ("$p", parent), ("$n", name), ("$pos", pos));
        return _db.LastInsertId();
    }

    private void AddQuiet(string url, string title, long? folder)
    {
        var pos = (int)_db.Long("SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id IS $f", ("$f", folder));
        _db.Exec("INSERT INTO bookmarks(folder_id, url, title, position, created_at) VALUES($f, $u, $t, $p, $c)",
            ("$f", folder), ("$u", url), ("$t", string.IsNullOrWhiteSpace(title) ? url : title), ("$p", pos), ("$c", HistoryStore.NowMs()));
    }
}
