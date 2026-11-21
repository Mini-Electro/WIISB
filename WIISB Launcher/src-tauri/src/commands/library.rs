use std::path::Path;

use serde::Serialize;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::database::models::Game;
use crate::error::{AppError, AppResult};
use crate::games::service::{self, DetectedItem, LaunchSettingsInput, LinkResult, ScanReport};
use crate::games::{art, detect, discovery};
use crate::platform::tray;
use crate::state::AppState;

fn ensure_not_active(st: &AppState, slug: &str) -> AppResult<()> {
    if st.supervisor.is_active(slug) {
        Err(AppError::AlreadyRunning("Close the game before changing its installation.".into()))
    } else {
        Ok(())
    }
}

pub(crate) fn announce_library(app: &AppHandle, st: &AppState) {
    if let Ok(games) = st.db.list_games() {
        let _ = app.emit("library-changed", &games);
    }
    tray::refresh(app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatus {
    pub root: String,
    pub available: bool,
    pub code: Option<&'static str>,
    pub message: Option<String>,
}

pub fn library_status(root: &str) -> LibraryStatus {
    match discovery::check_root(Path::new(root)) {
        Ok(()) => LibraryStatus { root: root.into(), available: true, code: None, message: None },
        Err(e) => {
            let err = service::root_error(e);
            LibraryStatus { root: root.into(), available: false, code: Some(err.code()), message: Some(err.to_string()) }
        }
    }
}

#[tauri::command]
pub fn get_library_status(state: State<'_, AppState>) -> LibraryStatus {
    library_status(&state.settings().library_root)
}

/// Re-detect the four games inside the library root (runs off the UI thread).
#[tauri::command]
pub async fn scan_library(app: AppHandle, force: bool) -> AppResult<ScanReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let settings = st.settings();
        let root = settings.library_root;
        let is_active = |slug: &str| st.supervisor.is_active(slug);
        let scan = service::run_scan(&st.db, Path::new(&root), force, &is_active);
        // Other launchers' games are found even when the library folder itself is unreachable.
        let detected = if settings.detect_other_games {
            let found = if scan.is_ok() { detect::detect_all(Some(Path::new(&root))) } else { detect::detect_quick() };
            let items = service::apply_detected(&st.db, &found, &is_active)?;
            service::revalidate_all(&st.db)?;
            items
        } else {
            vec![]
        };
        st.db.set_setting("first_scan_done", "1")?;
        announce_library(&app, &st);
        start_art_job(&app, false);
        let mut report = scan?;
        report.detected = detected;
        Ok(report)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

/// Change the folder that is scanned for games. The folder must exist; nothing inside it is modified.
#[tauri::command]
pub fn set_library_root(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<LibraryStatus> {
    let p = path.trim().trim_end_matches(['\\', '/']).to_string();
    let p = if p.ends_with(':') { format!("{p}\\") } else { p };
    discovery::check_root(Path::new(&p)).map_err(service::root_error)?;
    let next = crate::settings::apply_patch(&state.settings(), &serde_json::json!({ "libraryRoot": p }))?;
    crate::settings::save(&state.db, &next)?;
    state.set_settings(next);
    let _ = app.emit("settings-changed", state.settings());
    Ok(library_status(&p))
}

#[tauri::command]
pub async fn link_game(
    app: AppHandle,
    slug: String,
    path: String,
    install_dir: Option<String>,
) -> AppResult<LinkResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        ensure_not_active(&st, &slug)?;
        let res = service::link_from_path(&st.db, &slug, &path, install_dir.as_deref())?;
        announce_library(&app, &st);
        Ok(res)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub fn unlink_game(app: AppHandle, state: State<'_, AppState>, slug: String) -> AppResult<Game> {
    ensure_not_active(&state, &slug)?;
    state.db.unlink_game(&slug)?;
    announce_library(&app, &state);
    state.db.get_game(&slug)
}

#[tauri::command]
pub fn save_launch_settings(app: AppHandle, state: State<'_, AppState>, slug: String, input: LaunchSettingsInput) -> AppResult<Game> {
    ensure_not_active(&state, &slug)?;
    let game = service::save_launch_settings(&state.db, &slug, input)?;
    announce_library(&app, &state);
    Ok(game)
}

#[tauri::command]
pub async fn validate_games(app: AppHandle) -> AppResult<Vec<Game>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let games = service::revalidate_all(&st.db)?;
        announce_library(&app, &st);
        Ok(games)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub fn set_favourite(state: State<'_, AppState>, slug: String, favourite: bool) -> AppResult<Game> {
    state.db.set_favourite(&slug, favourite)?;
    state.db.get_game(&slug)
}

#[tauri::command]
pub fn get_notes(state: State<'_, AppState>, slug: String) -> AppResult<String> {
    state.db.get_notes(&slug)
}

#[tauri::command]
pub fn set_notes(state: State<'_, AppState>, slug: String, body: String) -> AppResult<()> {
    if body.chars().count() > 20_000 {
        return Err(AppError::Invalid("Notes are limited to 20,000 characters.".into()));
    }
    state.db.set_notes(&slug, &body)
}

#[tauri::command]
pub fn set_artwork(state: State<'_, AppState>, slug: String, source_path: String) -> AppResult<Game> {
    service::import_artwork(&state.db, &state.art_dir, &slug, Path::new(&source_path))
}

#[tauri::command]
pub fn clear_artwork(state: State<'_, AppState>, slug: String) -> AppResult<Game> {
    service::clear_artwork(&state.db, &state.art_dir, &slug)
}

/// Fills in local icons straight away, then (if allowed) downloads missing covers one game at a time,
/// announcing the library after each so artwork appears progressively. Only one job runs at once; a
/// network failure stops it quietly and the games are retried next time.
pub fn start_art_job(app: &AppHandle, retry_all: bool) {
    let st = app.state::<AppState>();
    if st.art_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let announce = || {
            let _ = app.emit("library-changed", &st.db.list_games().unwrap_or_default());
        };
        // 1. Icons of programs we can read directly (instant, offline).
        let mut changed = false;
        for g in st.db.list_games().unwrap_or_default().into_iter().filter(|g| g.icon_path.is_none()) {
            changed |= art::ensure_icon(&st.db, &st.art_dir, &g, false);
        }
        if changed {
            announce();
        }
        // 2. Covers. One slow or failed download skips that game; several in a row means we're offline.
        if st.settings().fetch_artwork_online {
            if retry_all {
                let _ = st.db.reset_art_attempts();
            }
            let mut failures = 0;
            for g in st.db.games_needing_art().unwrap_or_default() {
                match art::fetch_for_game(&st.db, &st.art_dir, &g) {
                    Ok(_) => {
                        failures = 0;
                        announce();
                    }
                    Err(e) => {
                        failures += 1;
                        log::warn!("cover for {} skipped: {e}", g.title);
                        if failures >= 3 {
                            log::warn!("cover job stopped after repeated failures (offline?)");
                            break;
                        }
                    }
                }
            }
        }
        // 3. Games with no cover and no icon yet: borrow an icon from inside their install folder.
        let mut changed = false;
        for g in st.db.list_games().unwrap_or_default().into_iter().filter(|g| g.artwork_path.is_none() && g.icon_path.is_none()) {
            changed |= art::ensure_icon(&st.db, &st.art_dir, &g, true);
        }
        if changed {
            announce();
        }
        st.art_running.store(false, Ordering::SeqCst);
    });
}

/// Look for covers: for one game now (so you see the result or the error), or for every game missing one.
#[tauri::command]
pub async fn fetch_artwork(app: AppHandle, slug: Option<String>) -> AppResult<Vec<Game>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        match slug {
            Some(slug) => {
                let game = st.db.get_game(&slug)?;
                let r = art::fetch_for_game(&st.db, &st.art_dir, &game)?;
                if !r.cover && !r.hero && game.artwork_path.is_none() {
                    return Err(AppError::NotFound(format!("No cover was found for \"{}\" on Steam.", game.title)));
                }
            }
            None => start_art_job(&app, true),
        }
        st.db.list_games()
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub async fn detect_games(app: AppHandle) -> AppResult<Vec<DetectedItem>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let root = st.settings().library_root;
        let found = detect::detect_all(Some(Path::new(&root)));
        let items = service::apply_detected(&st.db, &found, &|s| st.supervisor.is_active(s))?;
        service::revalidate_all(&st.db)?;
        announce_library(&app, &st);
        start_art_job(&app, false);
        Ok(items)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub fn add_custom_game(app: AppHandle, state: State<'_, AppState>, title: String, exe_path: String) -> AppResult<Game> {
    let game = service::add_custom_game(&state.db, &title, &exe_path)?;
    announce_library(&app, &state);
    start_art_job(&app, false);
    Ok(game)
}

#[tauri::command]
pub fn set_game_hidden(app: AppHandle, state: State<'_, AppState>, slug: String, hidden: bool) -> AppResult<()> {
    ensure_not_active(&state, &slug)?;
    service::set_hidden(&state.db, &slug, hidden)?;
    announce_library(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn list_hidden_games(state: State<'_, AppState>) -> AppResult<Vec<Game>> {
    state.db.list_hidden_games()
}
