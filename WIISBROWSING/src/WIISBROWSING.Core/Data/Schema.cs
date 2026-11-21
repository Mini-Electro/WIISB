namespace WIISBROWSING.Core.Data;

/// <summary>Versioned migrations. Append new scripts to the end; never edit an old one.</summary>
public static class Schema
{
    /// <summary>Global data (one file for the whole app): profiles and app-wide settings.</summary>
    public static readonly IReadOnlyList<string> App = new[]
    {
        """
        CREATE TABLE profiles (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            color       TEXT NOT NULL DEFAULT '#8B5CF6',
            folder      TEXT NOT NULL UNIQUE,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """,
    };

    /// <summary>Per-profile data: everything that must not leak between profiles.</summary>
    public static readonly IReadOnlyList<string> Profile = new[]
    {
        """
        CREATE TABLE settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE history (
            id          INTEGER PRIMARY KEY,
            url         TEXT NOT NULL UNIQUE,
            title       TEXT NOT NULL DEFAULT '',
            visit_count INTEGER NOT NULL DEFAULT 0,
            first_visit INTEGER NOT NULL,
            last_visit  INTEGER NOT NULL
        );
        CREATE INDEX idx_history_last ON history(last_visit DESC);
        CREATE INDEX idx_history_count ON history(visit_count DESC);
        CREATE TABLE history_visits (
            id         INTEGER PRIMARY KEY,
            history_id INTEGER NOT NULL REFERENCES history(id) ON DELETE CASCADE,
            visited_at INTEGER NOT NULL,
            transition TEXT NOT NULL DEFAULT 'link'
        );
        CREATE INDEX idx_visits_time ON history_visits(visited_at);
        CREATE INDEX idx_visits_hist ON history_visits(history_id);

        CREATE TABLE bookmark_folders (
            id        INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES bookmark_folders(id) ON DELETE CASCADE,
            name      TEXT NOT NULL,
            position  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE bookmarks (
            id         INTEGER PRIMARY KEY,
            folder_id  INTEGER REFERENCES bookmark_folders(id) ON DELETE CASCADE,
            url        TEXT NOT NULL,
            title      TEXT NOT NULL,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_bookmarks_url ON bookmarks(url);
        CREATE INDEX idx_bookmarks_folder ON bookmarks(folder_id, position);

        CREATE TABLE downloads (
            id             INTEGER PRIMARY KEY,
            url            TEXT NOT NULL,
            file_name      TEXT NOT NULL,
            path           TEXT NOT NULL,
            mime           TEXT NOT NULL DEFAULT '',
            total_bytes    INTEGER NOT NULL DEFAULT 0,
            received_bytes INTEGER NOT NULL DEFAULT 0,
            state          TEXT NOT NULL,
            started_at     INTEGER NOT NULL,
            ended_at       INTEGER
        );

        CREATE TABLE workspaces (
            id       TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            icon     TEXT NOT NULL DEFAULT '●',
            color    TEXT NOT NULL DEFAULT '#8B5CF6',
            position INTEGER NOT NULL DEFAULT 0,
            hidden   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE clusters (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            color        TEXT NOT NULL DEFAULT '#8B5CF6',
            emoji        TEXT NOT NULL DEFAULT '',
            collapsed    INTEGER NOT NULL DEFAULT 0,
            position     INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE tabs (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            cluster_id   TEXT REFERENCES clusters(id) ON DELETE SET NULL,
            url          TEXT NOT NULL,
            title        TEXT NOT NULL DEFAULT '',
            favicon      TEXT NOT NULL DEFAULT '',
            pinned       INTEGER NOT NULL DEFAULT 0,
            marker       TEXT NOT NULL DEFAULT '',
            muted        INTEGER NOT NULL DEFAULT 0,
            sleep_exempt INTEGER NOT NULL DEFAULT 0,
            position     INTEGER NOT NULL DEFAULT 0,
            last_active  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_tabs_ws ON tabs(workspace_id, position);

        CREATE TABLE speed_dial (
            id       INTEGER PRIMARY KEY,
            title    TEXT NOT NULL,
            url      TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE notes (
            id           INTEGER PRIMARY KEY,
            title        TEXT NOT NULL DEFAULT '',
            body         TEXT NOT NULL DEFAULT '',
            url          TEXT NOT NULL DEFAULT '',
            workspace_id TEXT NOT NULL DEFAULT '',
            pinned       INTEGER NOT NULL DEFAULT 0,
            updated_at   INTEGER NOT NULL
        );

        CREATE TABLE site_permissions (
            origin     TEXT NOT NULL,
            permission TEXT NOT NULL,
            state      TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (origin, permission)
        );

        CREATE TABLE adblock_exceptions (
            host TEXT PRIMARY KEY
        );

        CREATE TABLE collections (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE collection_items (
            id            INTEGER PRIMARY KEY,
            collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            title         TEXT NOT NULL,
            url           TEXT NOT NULL,
            note          TEXT NOT NULL DEFAULT '',
            position      INTEGER NOT NULL DEFAULT 0
        );
        """,
    };
}
