-- WIISB Games schema, version 1.
-- Timestamps are Unix epoch seconds in UTC. Derived totals (playtime etc.) are NOT stored:
-- they are always computed from game_sessions.

CREATE TABLE games (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    added_at     INTEGER NOT NULL,
    is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0, 1)),
    artwork_path TEXT
);

CREATE TABLE game_installations (
    game_id            INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    installation_path  TEXT,
    launch_target      TEXT,
    launch_method      TEXT    NOT NULL DEFAULT 'direct' CHECK (launch_method IN ('direct', 'platform', 'shortcut')),
    launch_args        TEXT    NOT NULL DEFAULT '',
    working_dir        TEXT,
    link_source        TEXT    CHECK (link_source IN ('auto', 'manual')),
    linked_at          INTEGER,
    last_validated_at  INTEGER,
    validation_status  TEXT    NOT NULL DEFAULT 'not_linked',
    validation_message TEXT
);

CREATE TABLE game_sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id             INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    duration_secs       INTEGER NOT NULL DEFAULT 0,
    launch_method       TEXT    NOT NULL,
    confirmation_status TEXT    NOT NULL DEFAULT 'confirmed' CHECK (confirmation_status IN ('confirmed', 'resumed', 'detected')),
    completion_status   TEXT    NOT NULL DEFAULT 'active' CHECK (completion_status IN ('active', 'completed', 'recovered')),
    last_heartbeat      INTEGER NOT NULL
);
CREATE INDEX idx_sessions_game    ON game_sessions(game_id, started_at);
CREATE INDEX idx_sessions_started ON game_sessions(started_at);

CREATE TABLE launch_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    attempted_at INTEGER NOT NULL,
    launch_method TEXT   NOT NULL,
    outcome      TEXT    NOT NULL CHECK (outcome IN ('started', 'confirmed', 'unconfirmed', 'failed')),
    error        TEXT,
    session_id   INTEGER REFERENCES game_sessions(id) ON DELETE SET NULL
);
CREATE INDEX idx_launch_game ON launch_history(game_id, attempted_at);

CREATE TABLE game_notes (
    game_id    INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);

CREATE TABLE user_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
