namespace WIISBROWSING.Core.Data;

/// <summary>
/// The data of one profile. A private window gets a view of its parent that has NO history and NO session
/// store, and temporary (in-memory) permissions and downloads — so nothing it does can reach the ordinary database.
/// </summary>
public sealed class ProfileData : IDisposable
{
    private readonly SqliteDb _db;
    private readonly bool _ownsDb;

    public ProfileInfo Info { get; }
    public bool IsPrivate { get; }
    public SettingsStore Settings { get; }
    /// <summary>Null in private windows: private visits are never written anywhere.</summary>
    public HistoryStore? History { get; }
    public BookmarkStore Bookmarks { get; }
    public DownloadStore Downloads { get; }
    public SpeedDialStore SpeedDial { get; }
    public NoteStore Notes { get; }
    public PermissionStore Permissions { get; }
    public AdBlockExceptionStore AdBlockExceptions { get; }
    public CollectionStore Collections { get; }
    /// <summary>Null in private windows: private tabs are never saved for restoring.</summary>
    public SessionStore? Session { get; }

    private ProfileData(ProfileInfo info, SqliteDb db, bool ownsDb, bool isPrivate, SettingsStore settings, HistoryStore? history, BookmarkStore bookmarks,
        DownloadStore downloads, SpeedDialStore speedDial, NoteStore notes, PermissionStore permissions, AdBlockExceptionStore adblock, CollectionStore collections, SessionStore? session)
    {
        Info = info; _db = db; _ownsDb = ownsDb; IsPrivate = isPrivate; Settings = settings; History = history; Bookmarks = bookmarks; Downloads = downloads;
        SpeedDial = speedDial; Notes = notes; Permissions = permissions; AdBlockExceptions = adblock; Collections = collections; Session = session;
    }

    public static ProfileData Open(ProfileInfo info, string dbPath)
    {
        var db = SqliteDb.Open(dbPath, Schema.Profile);
        var settings = new SettingsStore(db);
        return new ProfileData(info, db, true, false, settings, new HistoryStore(db), new BookmarkStore(db), new DownloadStore(db), new SpeedDialStore(db),
            new NoteStore(db), new PermissionStore(db), new AdBlockExceptionStore(db), new CollectionStore(db), new SessionStore(db, settings));
    }

    public static ProfileData OpenPrivate(ProfileData parent)
    {
        var temp = SqliteDb.Open(":memory:", Schema.Profile);
        return new ProfileData(parent.Info, temp, true, true, parent.Settings, null, parent.Bookmarks, new DownloadStore(temp), parent.SpeedDial,
            parent.Notes, new PermissionStore(temp), parent.AdBlockExceptions, parent.Collections, null);
    }

    public static ProfileData OpenInMemory(string name = "Test")
    {
        var info = new ProfileInfo("test", name, "#8B5CF6", "test", 0);
        var db = SqliteDb.Open(":memory:", Schema.Profile);
        var settings = new SettingsStore(db);
        return new ProfileData(info, db, true, false, settings, new HistoryStore(db), new BookmarkStore(db), new DownloadStore(db), new SpeedDialStore(db),
            new NoteStore(db), new PermissionStore(db), new AdBlockExceptionStore(db), new CollectionStore(db), new SessionStore(db, settings));
    }

    public void Dispose()
    {
        if (_ownsDb) _db.Dispose();
    }
}
