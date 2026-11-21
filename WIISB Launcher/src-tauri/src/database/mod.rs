//! SQLite persistence: versioned migrations, referential integrity, safe recovery.

pub mod models;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::games::catalog::CATALOG;
use models::*;

pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, sql: include_str!("../../migrations/001_init.sql") },
    Migration { version: 2, sql: include_str!("../../migrations/002_detected_games.sql") },
];

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Applies every migration newer than the database's `user_version`, each in its own
/// transaction. Existing rows are never dropped by this function.
pub fn migrate(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for m in migrations.iter().filter(|m| m.version > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql)?;
        tx.pragma_update(None, "user_version", m.version)?;
        tx.commit()?;
        log::info!("applied database migration v{}", m.version);
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// Where the unreadable database was moved (it is preserved, never deleted).
    pub preserved_at: String,
    pub reason: String,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

fn open_and_migrate(path: &Path) -> Result<Connection, String> {
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    let _: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0)).map_err(|e| e.to_string())?;
    configure(&conn).map_err(|e| e.to_string())?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(|e| e.to_string())?;
    let latest = MIGRATIONS.last().map(|m| m.version).unwrap_or(0);
    if version > latest {
        return Err(format!("database was created by a newer version of WIISB Launcher (schema v{version})"));
    }
    if version > 0 && version < latest {
        // Keep a copy of the pre-migration data before touching the schema.
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let backup = path.with_extension(format!("db.bak-v{version}"));
        if let Err(e) = std::fs::copy(path, &backup) {
            log::warn!("could not back up database before migration: {e}");
        }
    }
    migrate(&mut conn, MIGRATIONS).map_err(|e| e.to_string())?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("integrity check failed: {check}"));
    }
    Ok(conn)
}

impl Db {
    /// Opens (or creates) the database. If it cannot be used it is moved aside — preserved —
    /// and a fresh one is created; the caller gets a [`Recovery`] notice to show the user.
    pub fn open(path: &Path) -> AppResult<(Db, Option<Recovery>)> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut recovery = None;
        let conn = match open_and_migrate(path) {
            Ok(c) => c,
            Err(reason) => {
                log::error!("database unusable ({reason}); preserving it and starting fresh");
                let preserved: PathBuf = path.with_extension(format!("db.corrupt-{}", now()));
                for suffix in ["", "-wal", "-shm"] {
                    let from = PathBuf::from(format!("{}{}", path.display(), suffix));
                    if from.exists() {
                        let to = PathBuf::from(format!("{}{}", preserved.display(), suffix));
                        std::fs::rename(&from, &to).map_err(|e| {
                            AppError::Database(format!("The database could not be opened or safely moved aside: {e}"))
                        })?;
                    }
                }
                recovery = Some(Recovery { preserved_at: preserved.display().to_string(), reason });
                open_and_migrate(path).map_err(AppError::Database)?
            }
        };
        let db = Db { conn: Mutex::new(conn) };
        db.ensure_catalog()?;
        Ok((db, recovery))
    }

    #[cfg(test)]
    pub fn open_memory() -> Db {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        let db = Db { conn: Mutex::new(conn) };
        db.ensure_catalog().unwrap();
        db
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock must not brick the launcher.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Make sure exactly the four supported games exist. Never adds anything else.
    fn ensure_catalog(&self) -> AppResult<()> {
        let conn = self.lock();
        let t = now();
        for def in CATALOG.iter() {
            conn.execute(
                "INSERT INTO games (slug, title, sort_order, added_at) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(slug) DO UPDATE SET title = excluded.title, sort_order = excluded.sort_order",
                params![def.slug, def.title, def.sort_order, t],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO game_installations (game_id) SELECT id FROM games WHERE slug = ?1",
                params![def.slug],
            )?;
        }
        Ok(())
    }

    // ----- games -------------------------------------------------------------------------

    /// Visible games (hidden ones are excluded), in library order.
    pub fn list_games(&self) -> AppResult<Vec<Game>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("{GAME_SELECT} WHERE g.hidden = 0 ORDER BY g.sort_order, g.id"))?;
        let rows = stmt.query_map([], Game::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Every game including hidden ones — used when matching detections against what we already know.
    pub fn list_all_games(&self) -> AppResult<Vec<Game>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("{GAME_SELECT} ORDER BY g.sort_order, g.id"))?;
        let rows = stmt.query_map([], Game::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_hidden_games(&self) -> AppResult<Vec<Game>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("{GAME_SELECT} WHERE g.hidden = 1 ORDER BY g.title"))?;
        let rows = stmt.query_map([], Game::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Visible games whose cover has never been looked up and that have no artwork yet.
    pub fn games_needing_art(&self) -> AppResult<Vec<Game>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "{GAME_SELECT} WHERE g.hidden = 0 AND g.artwork_path IS NULL AND g.art_attempted = 0 ORDER BY g.sort_order, g.id"
        ))?;
        let rows = stmt.query_map([], Game::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Adds a game found by detection (or added by hand). Never used for the four catalogue games.
    pub fn insert_game(&self, slug: &str, title: &str, source: &str, external_id: Option<&str>, steam_app_id: Option<i64>) -> AppResult<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO games (slug, title, sort_order, added_at, source, external_id, steam_app_id) \
             VALUES (?1, ?2, (SELECT MAX(COALESCE(MAX(sort_order), 0) + 1, 100) FROM games), ?3, ?4, ?5, ?6)",
            params![slug, title, now(), source, external_id, steam_app_id],
        )?;
        tx.execute("INSERT INTO game_installations (game_id) SELECT id FROM games WHERE slug = ?1", params![slug])?;
        tx.commit()?;
        Ok(())
    }

    /// Deletes sessions that were only ever *detected* (or resumed), never launched from here, for one game.
    /// Used once to remove sessions created by an earlier version that mistook background helper programs
    /// for the game. Returns how many rows were removed.
    pub fn purge_detected_sessions(&self, slug: &str) -> AppResult<usize> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM game_sessions WHERE game_id = (SELECT id FROM games WHERE slug = ?1) \
             AND confirmation_status IN ('detected', 'resumed')",
            params![slug],
        )?;
        Ok(n)
    }

    pub fn set_title(&self, slug: &str, title: &str) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET title = ?2 WHERE slug = ?1", params![slug, title])?;
        Ok(())
    }

    pub fn set_hidden(&self, slug: &str, hidden: bool) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET hidden = ?2 WHERE slug = ?1", params![slug, hidden as i64])?;
        Ok(())
    }

    pub fn set_hero(&self, slug: &str, path: Option<&str>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET hero_path = ?2 WHERE slug = ?1", params![slug, path])?;
        Ok(())
    }

    pub fn set_icon(&self, slug: &str, path: Option<&str>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET icon_path = ?2 WHERE slug = ?1", params![slug, path])?;
        Ok(())
    }

    pub fn set_art_attempted(&self, slug: &str, attempted: bool) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET art_attempted = ?2 WHERE slug = ?1", params![slug, attempted as i64])?;
        Ok(())
    }

    pub fn set_steam_app_id(&self, slug: &str, id: Option<i64>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET steam_app_id = ?2 WHERE slug = ?1", params![slug, id])?;
        Ok(())
    }

    /// Forget "already tried" for every game that still has no artwork, so a retry looks them up again.
    pub fn reset_art_attempts(&self) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET art_attempted = 0 WHERE artwork_path IS NULL", [])?;
        Ok(())
    }

    pub fn get_game(&self, slug: &str) -> AppResult<Game> {
        let conn = self.lock();
        conn.query_row(&format!("{GAME_SELECT} WHERE g.slug = ?1"), params![slug], Game::from_row)
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Unknown game \"{slug}\".")))
    }

    pub fn link_game(&self, slug: &str, d: &LinkData) -> AppResult<()> {
        let conn = self.lock();
        let t = now();
        let n = conn.execute(
            "UPDATE game_installations SET installation_path = ?2, launch_target = ?3, launch_method = ?4, launch_args = ?5, \
             working_dir = ?6, link_source = ?7, linked_at = COALESCE(linked_at, ?8), last_validated_at = ?8, \
             validation_status = 'ok', validation_message = NULL \
             WHERE game_id = (SELECT id FROM games WHERE slug = ?1)",
            params![slug, d.installation_path, d.launch_target, d.launch_method, d.launch_args, d.working_dir, d.source, t],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("Unknown game \"{slug}\".")));
        }
        Ok(())
    }

    pub fn unlink_game(&self, slug: &str) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE game_installations SET installation_path = NULL, launch_target = NULL, launch_method = 'direct', \
             launch_args = '', working_dir = NULL, link_source = NULL, linked_at = NULL, last_validated_at = ?2, \
             validation_status = 'not_linked', validation_message = NULL \
             WHERE game_id = (SELECT id FROM games WHERE slug = ?1)",
            params![slug, now()],
        )?;
        Ok(())
    }

    pub fn set_validation(&self, slug: &str, status: &str, message: Option<&str>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE game_installations SET validation_status = ?2, validation_message = ?3, last_validated_at = ?4 \
             WHERE game_id = (SELECT id FROM games WHERE slug = ?1)",
            params![slug, status, message, now()],
        )?;
        Ok(())
    }

    pub fn set_favourite(&self, slug: &str, fav: bool) -> AppResult<()> {
        let conn = self.lock();
        let n = conn.execute("UPDATE games SET is_favourite = ?2 WHERE slug = ?1", params![slug, fav as i64])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("Unknown game \"{slug}\".")));
        }
        Ok(())
    }

    pub fn set_artwork(&self, slug: &str, path: Option<&str>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE games SET artwork_path = ?2 WHERE slug = ?1", params![slug, path])?;
        Ok(())
    }

    // ----- notes -------------------------------------------------------------------------

    pub fn get_notes(&self, slug: &str) -> AppResult<String> {
        let conn = self.lock();
        let body: Option<String> = conn
            .query_row(
                "SELECT n.body FROM game_notes n JOIN games g ON g.id = n.game_id WHERE g.slug = ?1",
                params![slug],
                |r| r.get(0),
            )
            .optional()?;
        Ok(body.unwrap_or_default())
    }

    pub fn set_notes(&self, slug: &str, body: &str) -> AppResult<()> {
        let conn = self.lock();
        if body.is_empty() {
            conn.execute("DELETE FROM game_notes WHERE game_id = (SELECT id FROM games WHERE slug = ?1)", params![slug])?;
        } else {
            conn.execute(
                "INSERT INTO game_notes (game_id, body, updated_at) SELECT id, ?2, ?3 FROM games WHERE slug = ?1 \
                 ON CONFLICT(game_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
                params![slug, body, now()],
            )?;
        }
        Ok(())
    }

    // ----- sessions ----------------------------------------------------------------------

    pub fn start_session(&self, game_id: i64, method: &str, confirmation: &str, at: i64) -> AppResult<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO game_sessions (game_id, started_at, launch_method, confirmation_status, completion_status, last_heartbeat) \
             VALUES (?1, ?2, ?3, ?4, 'active', ?2)",
            params![game_id, at, method, confirmation],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn heartbeat(&self, session_id: i64, at: i64) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE game_sessions SET last_heartbeat = MAX(last_heartbeat, ?2) WHERE id = ?1 AND completion_status = 'active'",
            params![session_id, at],
        )?;
        Ok(())
    }

    pub fn mark_resumed(&self, session_id: i64) -> AppResult<()> {
        let conn = self.lock();
        conn.execute("UPDATE game_sessions SET confirmation_status = 'resumed' WHERE id = ?1", params![session_id])?;
        Ok(())
    }

    /// Close a session. `status` is `completed` for a normal exit or `recovered` when the end
    /// time had to be taken from the last heartbeat. No time beyond `ended_at` is ever added.
    pub fn finish_session(&self, session_id: i64, ended_at: i64, status: &str) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE game_sessions SET ended_at = MAX(?2, started_at), duration_secs = MAX(?2 - started_at, 0), \
             completion_status = ?3, last_heartbeat = MAX(last_heartbeat, ?2) WHERE id = ?1 AND completion_status = 'active'",
            params![session_id, ended_at, status],
        )?;
        Ok(())
    }

    pub fn active_sessions(&self) -> AppResult<Vec<Session>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("{SESSION_SELECT} WHERE s.completion_status = 'active' ORDER BY s.started_at"))?;
        let rows = stmt.query_map([], Session::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_session(&self, id: i64) -> AppResult<Option<Session>> {
        let conn = self.lock();
        Ok(conn.query_row(&format!("{SESSION_SELECT} WHERE s.id = ?1"), params![id], Session::from_row).optional()?)
    }

    /// Sessions that started at or after `since` (UTC seconds), oldest first.
    pub fn list_sessions(&self, since: Option<i64>) -> AppResult<Vec<Session>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("{SESSION_SELECT} WHERE s.started_at >= ?1 ORDER BY s.started_at"))?;
        let rows = stmt.query_map(params![since.unwrap_or(0)], Session::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Removes finished sessions and launch history. Sessions that are still running are kept.
    pub fn reset_statistics(&self) -> AppResult<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM launch_history", [])?;
        tx.execute("DELETE FROM game_sessions WHERE completion_status != 'active'", [])?;
        tx.commit()?;
        Ok(())
    }

    // ----- launch history ----------------------------------------------------------------

    pub fn add_launch(&self, game_id: i64, method: &str, outcome: &str, error: Option<&str>, session_id: Option<i64>) -> AppResult<i64> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO launch_history (game_id, attempted_at, launch_method, outcome, error, session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![game_id, now(), method, outcome, error, session_id],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_launch(&self, id: i64, outcome: &str, session_id: Option<i64>, error: Option<&str>) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE launch_history SET outcome = ?2, session_id = COALESCE(?3, session_id), error = COALESCE(?4, error) WHERE id = ?1",
            params![id, outcome, session_id, error],
        )?;
        Ok(())
    }

    pub fn list_launches(&self, limit: i64) -> AppResult<Vec<LaunchEntry>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT h.id, h.game_id, g.slug, h.attempted_at, h.launch_method, h.outcome, h.error, h.session_id \
             FROM launch_history h JOIN games g ON g.id = h.game_id ORDER BY h.attempted_at DESC, h.id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(LaunchEntry {
                    id: r.get(0)?,
                    game_id: r.get(1)?,
                    slug: r.get(2)?,
                    attempted_at: r.get(3)?,
                    launch_method: r.get(4)?,
                    outcome: r.get(5)?,
                    error: r.get(6)?,
                    session_id: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ----- settings ----------------------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.lock();
        Ok(conn.query_row("SELECT value FROM user_settings WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO user_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(db: &Db, slug: &str) {
        db.link_game(
            slug,
            &LinkData {
                installation_path: Some(r"E:\Games\X".into()),
                launch_target: r"E:\Games\X\x.exe".into(),
                launch_method: "direct".into(),
                launch_args: String::new(),
                working_dir: None,
                source: "auto",
            },
        )
        .unwrap();
    }

    #[test]
    fn catalog_is_exactly_four_games_and_idempotent() {
        let db = Db::open_memory();
        db.ensure_catalog().unwrap();
        let games = db.list_games().unwrap();
        let slugs: Vec<_> = games.iter().map(|g| g.slug.as_str()).collect();
        assert_eq!(slugs, ["deltarune", "persona-3-reload", "ultrakill", "undertale"]);
        assert!(games.iter().all(|g| !g.installed && g.validation_status == "not_linked"));
    }

    #[test]
    fn link_unlink_and_favourite_roundtrip() {
        let db = Db::open_memory();
        link(&db, "ultrakill");
        let g = db.get_game("ultrakill").unwrap();
        assert!(g.installed);
        assert_eq!(g.link_source.as_deref(), Some("auto"));
        db.set_favourite("ultrakill", true).unwrap();
        assert!(db.get_game("ultrakill").unwrap().is_favourite);
        db.set_favourite("ultrakill", false).unwrap();
        assert!(!db.get_game("ultrakill").unwrap().is_favourite);
        db.unlink_game("ultrakill").unwrap();
        assert!(!db.get_game("ultrakill").unwrap().installed);
        assert!(db.set_favourite("not-a-game", true).is_err());
    }

    #[test]
    fn session_lifecycle_and_duration() {
        let db = Db::open_memory();
        let g = db.get_game("undertale").unwrap();
        let id = db.start_session(g.id, "direct", "confirmed", 1_000).unwrap();
        assert_eq!(db.active_sessions().unwrap().len(), 1);
        db.heartbeat(id, 1_100).unwrap();
        db.finish_session(id, 1_300, "completed").unwrap();
        let s = db.get_session(id).unwrap().unwrap();
        assert_eq!((s.duration_secs, s.ended_at, s.completion_status.as_str()), (300, Some(1_300), "completed"));
        assert!(db.active_sessions().unwrap().is_empty());
        // Finishing twice must not change a finished session.
        db.finish_session(id, 9_999, "completed").unwrap();
        assert_eq!(db.get_session(id).unwrap().unwrap().duration_secs, 300);
    }

    #[test]
    fn reset_keeps_active_sessions_only() {
        let db = Db::open_memory();
        let g = db.get_game("deltarune").unwrap();
        let done = db.start_session(g.id, "direct", "confirmed", 10).unwrap();
        db.finish_session(done, 20, "completed").unwrap();
        let live = db.start_session(g.id, "direct", "confirmed", 30).unwrap();
        db.add_launch(g.id, "direct", "confirmed", None, Some(done)).unwrap();
        db.reset_statistics().unwrap();
        let left = db.list_sessions(None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, live);
        assert!(db.list_launches(10).unwrap().is_empty());
    }

    #[test]
    fn purging_detected_sessions_keeps_real_launches_and_other_games() {
        let db = Db::open_memory();
        let rb = db.get_game("ultrakill").unwrap();
        let other = db.get_game("undertale").unwrap();
        let launched = db.start_session(rb.id, "direct", "confirmed", 100).unwrap();
        db.finish_session(launched, 160, "completed").unwrap();
        let detected = db.start_session(rb.id, "direct", "detected", 200).unwrap();
        db.finish_session(detected, 205, "completed").unwrap();
        let resumed = db.start_session(rb.id, "direct", "confirmed", 300).unwrap();
        db.mark_resumed(resumed).unwrap();
        let elsewhere = db.start_session(other.id, "direct", "detected", 400).unwrap();
        db.finish_session(elsewhere, 410, "completed").unwrap();

        assert_eq!(db.purge_detected_sessions("ultrakill").unwrap(), 2);
        let left: Vec<i64> = db.list_sessions(None).unwrap().iter().map(|s| s.id).collect();
        assert_eq!(left, vec![launched, elsewhere], "a real launch and another game's session survive");
        assert_eq!(db.purge_detected_sessions("ultrakill").unwrap(), 0, "idempotent");
    }

    #[test]
    fn notes_persist_and_delete() {
        let db = Db::open_memory();
        assert_eq!(db.get_notes("ultrakill").unwrap(), "");
        db.set_notes("ultrakill", "P-rank everything").unwrap();
        assert_eq!(db.get_notes("ultrakill").unwrap(), "P-rank everything");
        db.set_notes("ultrakill", "updated").unwrap();
        assert_eq!(db.get_notes("ultrakill").unwrap(), "updated");
        db.set_notes("ultrakill", "").unwrap();
        assert_eq!(db.get_notes("ultrakill").unwrap(), "");
    }

    #[test]
    fn settings_kv_upsert() {
        let db = Db::open_memory();
        assert_eq!(db.get_setting("a").unwrap(), None);
        db.set_setting("a", "1").unwrap();
        db.set_setting("a", "2").unwrap();
        assert_eq!(db.get_setting("a").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = Db::open_memory();
        assert!(db.start_session(9999, "direct", "confirmed", 1).is_err());
    }

    #[test]
    fn migration_preserves_existing_data() {
        // Simulate an older install: v1 data present, then a newer migration arrives.
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        conn.execute("INSERT INTO games (slug, title, added_at, is_favourite) VALUES ('keepme', 'Keep Me', 5, 1)", []).unwrap();
        let gid: i64 = conn.query_row("SELECT id FROM games WHERE slug='keepme'", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO game_sessions (game_id, started_at, ended_at, duration_secs, launch_method, completion_status, last_heartbeat) \
             VALUES (?1, 1, 61, 60, 'direct', 'completed', 61)",
            params![gid],
        )
        .unwrap();

        // A later release adds v3 on top of the real v1 + v2 schema.
        let v3 = Migration { version: 3, sql: "ALTER TABLE games ADD COLUMN extra TEXT; CREATE INDEX idx_extra ON games(extra);" };
        let mut all: Vec<Migration> = MIGRATIONS.iter().map(|m| Migration { version: m.version, sql: m.sql }).collect();
        all.push(v3);
        migrate(&mut conn, &all).unwrap();

        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, 3);
        let (title, fav): (String, i64) =
            conn.query_row("SELECT title, is_favourite FROM games WHERE slug='keepme'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), fav), ("Keep Me", 1));
        let dur: i64 = conn.query_row("SELECT duration_secs FROM game_sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(dur, 60);
        // Running migrations again is a no-op.
        migrate(&mut conn, &all).unwrap();
    }

    #[test]
    fn corrupt_database_is_preserved_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wiisb.db");
        std::fs::write(&path, b"this is not a sqlite database at all, just text").unwrap();
        let (db, recovery) = Db::open(&path).unwrap();
        let r = recovery.expect("should report recovery");
        assert!(Path::new(&r.preserved_at).exists(), "original must be preserved");
        assert_eq!(db.list_games().unwrap().len(), 4);
    }

    #[test]
    fn real_file_database_reopens_with_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("wiisb.db");
        {
            let (db, rec) = Db::open(&path).unwrap();
            assert!(rec.is_none());
            db.set_favourite("undertale", true).unwrap();
        }
        let (db, rec) = Db::open(&path).unwrap();
        assert!(rec.is_none());
        assert!(db.get_game("undertale").unwrap().is_favourite);
    }
}
