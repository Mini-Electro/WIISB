use rusqlite::Row;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub sort_order: i64,
    pub added_at: i64,
    pub is_favourite: bool,
    pub artwork_path: Option<String>,
    pub installation_path: Option<String>,
    pub launch_target: Option<String>,
    pub launch_method: String,
    pub launch_args: String,
    pub working_dir: Option<String>,
    pub link_source: Option<String>,
    pub linked_at: Option<i64>,
    pub last_validated_at: Option<i64>,
    pub validation_status: String,
    pub validation_message: Option<String>,
    /// True only when the last validation confirmed a usable launch target.
    pub installed: bool,
    /// Where the game came from: `catalog` (the original four), `steam`, `epic`, `roblox`, `minecraft`,
    /// `startmenu`, `library` (extra folder in the library root) or `custom` (added by hand).
    pub source: String,
    pub external_id: Option<String>,
    pub steam_app_id: Option<i64>,
    pub hidden: bool,
    pub hero_path: Option<String>,
    pub icon_path: Option<String>,
    pub art_attempted: bool,
}

pub const GAME_SELECT: &str = "SELECT g.id, g.slug, g.title, g.sort_order, g.added_at, g.is_favourite, g.artwork_path, \
     i.installation_path, i.launch_target, i.launch_method, i.launch_args, i.working_dir, i.link_source, i.linked_at, \
     i.last_validated_at, i.validation_status, i.validation_message, \
     g.source, g.external_id, g.steam_app_id, g.hidden, g.hero_path, g.icon_path, g.art_attempted \
     FROM games g JOIN game_installations i ON i.game_id = g.id";

impl Game {
    pub fn from_row(r: &Row) -> rusqlite::Result<Game> {
        let status: String = r.get(15)?;
        Ok(Game {
            id: r.get(0)?,
            slug: r.get(1)?,
            title: r.get(2)?,
            sort_order: r.get(3)?,
            added_at: r.get(4)?,
            is_favourite: r.get::<_, i64>(5)? != 0,
            artwork_path: r.get(6)?,
            installation_path: r.get(7)?,
            launch_target: r.get(8)?,
            launch_method: r.get(9)?,
            launch_args: r.get(10)?,
            working_dir: r.get(11)?,
            link_source: r.get(12)?,
            linked_at: r.get(13)?,
            last_validated_at: r.get(14)?,
            installed: status == "ok",
            validation_status: status,
            validation_message: r.get(16)?,
            source: r.get(17)?,
            external_id: r.get(18)?,
            steam_app_id: r.get(19)?,
            hidden: r.get::<_, i64>(20)? != 0,
            hero_path: r.get(21)?,
            icon_path: r.get(22)?,
            art_attempted: r.get::<_, i64>(23)? != 0,
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: i64,
    pub game_id: i64,
    pub slug: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_secs: i64,
    pub launch_method: String,
    pub confirmation_status: String,
    pub completion_status: String,
    pub last_heartbeat: i64,
}

pub const SESSION_SELECT: &str = "SELECT s.id, s.game_id, g.slug, s.started_at, s.ended_at, s.duration_secs, s.launch_method, \
     s.confirmation_status, s.completion_status, s.last_heartbeat FROM game_sessions s JOIN games g ON g.id = s.game_id";

impl Session {
    pub fn from_row(r: &Row) -> rusqlite::Result<Session> {
        Ok(Session {
            id: r.get(0)?,
            game_id: r.get(1)?,
            slug: r.get(2)?,
            started_at: r.get(3)?,
            ended_at: r.get(4)?,
            duration_secs: r.get(5)?,
            launch_method: r.get(6)?,
            confirmation_status: r.get(7)?,
            completion_status: r.get(8)?,
            last_heartbeat: r.get(9)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEntry {
    pub id: i64,
    pub game_id: i64,
    pub slug: String,
    pub attempted_at: i64,
    pub launch_method: String,
    pub outcome: String,
    pub error: Option<String>,
    pub session_id: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct LinkData {
    pub installation_path: Option<String>,
    pub launch_target: String,
    pub launch_method: String,
    pub launch_args: String,
    pub working_dir: Option<String>,
    pub source: &'static str,
}
