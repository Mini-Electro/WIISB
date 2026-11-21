namespace WIISBROWSING.Core.Data;

public sealed record ProfileInfo(string Id, string Name, string Color, string Folder, long CreatedAt);

/// <summary>The list of profiles. Each profile has its own folder holding its WebView2 data and its own SQLite file.</summary>
public sealed class ProfileRegistry
{
    private readonly SqliteDb _db;
    private readonly string _profilesRoot;

    public ProfileRegistry(SqliteDb db, string profilesRoot) { _db = db; _profilesRoot = profilesRoot; }

    public string FolderPath(ProfileInfo p) => Path.Combine(_profilesRoot, p.Folder);
    public string WebDataPath(ProfileInfo p) => Path.Combine(FolderPath(p), "web");
    public string DbPath(ProfileInfo p) => Path.Combine(FolderPath(p), "browser.db");

    public IReadOnlyList<ProfileInfo> List() =>
        _db.Query("SELECT id, name, color, folder, created_at FROM profiles ORDER BY created_at, name",
            r => new ProfileInfo(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4)));

    public ProfileInfo? Get(string id) => List().FirstOrDefault(p => p.Id == id);

    public ProfileInfo EnsureDefault()
    {
        var existing = List();
        return existing.Count > 0 ? existing[0] : Create("Personal", "#8B5CF6");
    }

    public ProfileInfo Create(string name, string color)
    {
        name = name.Trim();
        if (name.Length == 0 || name.Length > 40 || name.Any(char.IsControl)) throw new ArgumentException("Give the profile a name (up to 40 characters).");
        if (List().Any(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException($"A profile called \"{name}\" already exists.");
        var id = Guid.NewGuid().ToString("N")[..12];
        var info = new ProfileInfo(id, name, color, "p-" + id, HistoryStore.NowMs());
        _db.Exec("INSERT INTO profiles(id, name, color, folder, created_at) VALUES($id,$n,$c,$f,$t)",
            ("$id", info.Id), ("$n", info.Name), ("$c", info.Color), ("$f", info.Folder), ("$t", info.CreatedAt));
        Directory.CreateDirectory(FolderPath(info));
        return info;
    }

    public void Rename(string id, string name)
    {
        name = name.Trim();
        if (name.Length == 0 || name.Length > 40) throw new ArgumentException("Give the profile a name (up to 40 characters).");
        _db.Exec("UPDATE profiles SET name = $n WHERE id = $id", ("$n", name), ("$id", id));
    }

    /// <summary>Removes the profile and, when asked, its data folder (cookies, history, bookmarks).</summary>
    public void Delete(string id, bool deleteData)
    {
        var p = Get(id);
        if (p is null) return;
        if (List().Count <= 1) throw new InvalidOperationException("You can't delete your only profile.");
        _db.Exec("DELETE FROM profiles WHERE id = $id", ("$id", id));
        if (deleteData)
        {
            var path = FolderPath(p);
            // Only ever delete inside our own profiles folder.
            if (Path.GetFullPath(path).StartsWith(Path.GetFullPath(_profilesRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && Directory.Exists(path))
                Directory.Delete(path, true);
        }
    }
}
