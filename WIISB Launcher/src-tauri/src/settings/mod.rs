//! User preferences, stored as one JSON document in `user_settings`.
//! Updates arrive as partial JSON patches from the UI and are validated before saving.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::Db;
use crate::error::{AppError, AppResult};

pub const DEFAULT_LIBRARY_ROOT: &str = r"E:\bbsgames";
/// The library folder's previous name (renamed on 2026-11-14).
const OLD_LIBRARY_ROOT: &str = r"E:\BIG BOY STORAGE GAMES";
const KEY: &str = "app_settings";
const WINDOW_KEY: &str = "window_state";

pub const THEMES: &[&str] = &[
    "midnight-purple",
    "dark-blue",
    "oled-black",
    "crimson",
    "emerald",
    "light",
    "light-sky",
    "light-rose",
    "light-mint",
    "light-sunset",
    "light-graphite",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    // Library
    pub library_root: String,
    // General
    pub launch_on_startup: bool,
    pub start_minimized: bool,
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
    /// Look for new versions in the background and download them (the person still chooses when to restart).
    pub auto_update: bool,
    pub confirm_exit: bool,
    pub restore_window: bool,
    // Appearance
    pub theme: String,
    pub accent_color: Option<String>,
    pub background_color: Option<String>,
    pub panel_color: Option<String>,
    pub corner_radius: u8,
    /// "none" | "low" | "normal" | "high"
    pub animation_intensity: String,
    pub reduce_motion: bool,
    /// "compact" | "comfortable" | "spacious"
    pub density: String,
    pub card_size: u16,
    /// "poster" | "landscape" | "square"
    pub artwork_style: String,
    pub sidebar_collapsed: bool,
    /// "grid" | "list"
    pub view_mode: String,
    /// "name" | "lastPlayed" | "playtime" | "added"
    pub sort_by: String,
    // Launching
    pub confirm_before_launch: bool,
    pub minimize_on_launch: bool,
    pub track_external_launches: bool,
    /// Look for games from Steam, Epic, Roblox, the Start Menu and extra folders in the library folder.
    pub detect_other_games: bool,
    /// Look up cover art for games on Steam's public store (only the game's title is sent).
    pub fetch_artwork_online: bool,
    // Notifications
    pub notifications_enabled: bool,
    pub notify_on_launch: bool,
    pub notify_on_errors: bool,
    pub notify_on_session_end: bool,
    // Statistics
    /// "7d" | "30d" | "90d" | "all"
    pub stats_range: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            library_root: DEFAULT_LIBRARY_ROOT.into(),
            launch_on_startup: false,
            start_minimized: false,
            minimize_to_tray: false,
            close_to_tray: false,
            auto_update: true,
            confirm_exit: false,
            restore_window: true,
            theme: "midnight-purple".into(),
            accent_color: None,
            background_color: None,
            panel_color: None,
            corner_radius: 14,
            animation_intensity: "normal".into(),
            reduce_motion: false,
            density: "comfortable".into(),
            card_size: 220,
            artwork_style: "poster".into(),
            sidebar_collapsed: false,
            view_mode: "grid".into(),
            sort_by: "name".into(),
            confirm_before_launch: false,
            minimize_on_launch: false,
            track_external_launches: true,
            detect_other_games: true,
            fetch_artwork_online: true,
            notifications_enabled: true,
            notify_on_launch: true,
            notify_on_errors: true,
            notify_on_session_end: true,
            stats_range: "30d".into(),
        }
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn one_of(field: &str, v: &str, allowed: &[&str]) -> AppResult<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Invalid value for {field}.")))
    }
}

impl AppSettings {
    pub fn validate(&self) -> AppResult<()> {
        one_of("theme", &self.theme, THEMES)?;
        one_of("animationIntensity", &self.animation_intensity, &["none", "low", "normal", "high"])?;
        one_of("density", &self.density, &["compact", "comfortable", "spacious"])?;
        one_of("artworkStyle", &self.artwork_style, &["poster", "landscape", "square"])?;
        one_of("viewMode", &self.view_mode, &["grid", "list"])?;
        one_of("sortBy", &self.sort_by, &["name", "lastPlayed", "playtime", "added"])?;
        one_of("statsRange", &self.stats_range, &["7d", "30d", "90d", "all"])?;
        for (name, c) in [("accentColor", &self.accent_color), ("backgroundColor", &self.background_color), ("panelColor", &self.panel_color)] {
            if let Some(c) = c {
                if !is_hex_color(c) {
                    return Err(AppError::Invalid(format!("{name} must be a #RRGGBB colour.")));
                }
            }
        }
        if !(4..=32).contains(&self.corner_radius) {
            return Err(AppError::Invalid("Corner radius must be between 4 and 32.".into()));
        }
        if !(160..=320).contains(&self.card_size) {
            return Err(AppError::Invalid("Card size must be between 160 and 320.".into()));
        }
        let root = &self.library_root;
        if root.trim().is_empty() || root.len() > 1024 || root.contains('\0') {
            return Err(AppError::Invalid("The library folder path is not valid.".into()));
        }
        Ok(())
    }
}

/// Merge `patch` over `current`; unknown keys and bad values are rejected.
pub fn apply_patch(current: &AppSettings, patch: &Value) -> AppResult<AppSettings> {
    let Value::Object(patch_map) = patch else {
        return Err(AppError::Invalid("Settings update must be an object.".into()));
    };
    let mut merged = serde_json::to_value(current).map_err(|e| AppError::Invalid(e.to_string()))?;
    let base = merged.as_object_mut().expect("settings serialise to an object");
    for (k, v) in patch_map {
        if !base.contains_key(k) {
            return Err(AppError::Invalid(format!("Unknown setting \"{k}\".")));
        }
        base.insert(k.clone(), v.clone());
    }
    let next: AppSettings = serde_json::from_value(merged).map_err(|e| AppError::Invalid(format!("Invalid setting value: {e}")))?;
    next.validate()?;
    Ok(next)
}

/// A saved library folder that points at `old` follows the folder to `new` — but only once `old` is really
/// gone and `new` exists, so a user who still has both folders keeps what they chose.
fn moved_library_root(saved: &str, old: &Path, new: &Path) -> Option<String> {
    (saved.eq_ignore_ascii_case(&old.to_string_lossy()) && !old.exists() && new.is_dir()).then(|| new.to_string_lossy().into_owned())
}

pub fn load(db: &Db) -> AppSettings {
    match db.get_setting(KEY) {
        Ok(Some(raw)) => match serde_json::from_str::<AppSettings>(&raw) {
            Ok(mut s) if s.validate().is_ok() => {
                if let Some(root) = moved_library_root(&s.library_root, Path::new(OLD_LIBRARY_ROOT), Path::new(DEFAULT_LIBRARY_ROOT)) {
                    log::info!("library folder was renamed; now using {root}");
                    s.library_root = root;
                    let _ = save(db, &s);
                }
                s
            }
            _ => {
                log::warn!("stored settings were invalid; using defaults");
                AppSettings::default()
            }
        },
        _ => AppSettings::default(),
    }
}

pub fn save(db: &Db, settings: &AppSettings) -> AppResult<()> {
    let raw = serde_json::to_string(settings).map_err(|e| AppError::Invalid(e.to_string()))?;
    db.set_setting(KEY, &raw)
}

// ----- window state ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

pub fn load_window_state(db: &Db) -> Option<WindowState> {
    db.get_setting(WINDOW_KEY).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok())
}

pub fn save_window_state(db: &Db, state: &WindowState) {
    if let Ok(raw) = serde_json::to_string(state) {
        let _ = db.set_setting(WINDOW_KEY, &raw);
    }
}

// ----- window close behaviour (pure, so it can be unit tested) ---------------------------

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CloseAction {
    HideToTray,
    AskConfirmation,
    Exit,
}

/// What should happen when the user closes the main window?
/// `explicit_exit` is true when the app was asked to quit (tray "Exit", confirmed dialog).
pub fn decide_close(s: &AppSettings, explicit_exit: bool) -> CloseAction {
    if explicit_exit {
        CloseAction::Exit
    } else if s.close_to_tray {
        CloseAction::HideToTray
    } else if s.confirm_exit {
        CloseAction::AskConfirmation
    } else {
        CloseAction::Exit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_valid_and_point_at_the_game_library() {
        let s = AppSettings::default();
        s.validate().unwrap();
        assert_eq!(s.library_root, r"E:\bbsgames");
    }

    #[test]
    fn a_renamed_library_folder_is_followed_only_when_the_old_one_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("BIG BOY STORAGE GAMES"), dir.path().join("bbsgames"));
        let saved = old.to_string_lossy().into_owned();
        assert_eq!(moved_library_root(&saved, &old, &new), None, "new folder doesn't exist yet");

        std::fs::create_dir_all(&new).unwrap();
        assert_eq!(moved_library_root(&saved.to_uppercase(), &old, &new), Some(new.to_string_lossy().into_owned()));
        assert_eq!(moved_library_root(r"D:\My Games", &old, &new), None, "another folder is left alone");

        std::fs::create_dir_all(&old).unwrap();
        assert_eq!(moved_library_root(&saved, &old, &new), None, "both folders exist: keep the user's choice");
    }

    #[test]
    fn every_theme_the_ui_offers_is_accepted_and_unknown_ones_are_not() {
        let s = AppSettings::default();
        for id in ["midnight-purple", "dark-blue", "oled-black", "crimson", "emerald", "light", "light-sky", "light-rose", "light-mint", "light-sunset", "light-graphite"] {
            assert_eq!(apply_patch(&s, &json!({ "theme": id })).unwrap().theme, id);
        }
        assert!(apply_patch(&s, &json!({ "theme": "light-neon" })).is_err());
    }

    #[test]
    fn patch_merges_and_rejects_bad_input() {
        let s = AppSettings::default();
        let n = apply_patch(&s, &json!({ "theme": "emerald", "cardSize": 260, "libraryRoot": r"D:\My Games" })).unwrap();
        assert_eq!((n.theme.as_str(), n.card_size, n.library_root.as_str()), ("emerald", 260, r"D:\My Games"));
        assert!(n.confirm_exit == s.confirm_exit);

        assert!(apply_patch(&s, &json!({ "theme": "hot-pink" })).is_err());
        assert!(apply_patch(&s, &json!({ "cardSize": 5 })).is_err());
        assert!(apply_patch(&s, &json!({ "accentColor": "red" })).is_err());
        assert!(apply_patch(&s, &json!({ "mystery": 1 })).is_err());
        assert!(apply_patch(&s, &json!({ "closeToTray": "yes" })).is_err());
        assert!(apply_patch(&s, &json!({ "libraryRoot": "  " })).is_err());
        assert!(apply_patch(&s, &json!([1, 2])).is_err());
        assert!(apply_patch(&s, &json!({ "accentColor": "#A78BFA" })).is_ok());
    }

    #[test]
    fn settings_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wiisb.db");
        {
            let (db, _) = Db::open(&path).unwrap();
            let s = apply_patch(&load(&db), &json!({ "theme": "crimson", "closeToTray": true, "libraryRoot": r"F:\Games" })).unwrap();
            save(&db, &s).unwrap();
            save_window_state(&db, &WindowState { x: 10, y: 20, width: 1000, height: 700, maximized: false });
        }
        let (db, _) = Db::open(&path).unwrap();
        let s = load(&db);
        assert_eq!((s.theme.as_str(), s.close_to_tray, s.library_root.as_str()), ("crimson", true, r"F:\Games"));
        assert_eq!(load_window_state(&db).unwrap().width, 1000);
    }

    #[test]
    fn corrupt_stored_settings_fall_back_to_defaults() {
        let (db, _) = Db::open(&tempfile::tempdir().unwrap().path().join("a.db")).unwrap();
        db.set_setting(KEY, "{ not json").unwrap();
        assert_eq!(load(&db), AppSettings::default());
    }

    #[test]
    fn close_behaviour() {
        let mut s = AppSettings::default();
        assert_eq!(decide_close(&s, false), CloseAction::Exit);
        s.confirm_exit = true;
        assert_eq!(decide_close(&s, false), CloseAction::AskConfirmation);
        s.close_to_tray = true;
        assert_eq!(decide_close(&s, false), CloseAction::HideToTray);
        // An explicit quit (tray "Exit" or a confirmed dialog) always exits.
        assert_eq!(decide_close(&s, true), CloseAction::Exit);
    }
}
