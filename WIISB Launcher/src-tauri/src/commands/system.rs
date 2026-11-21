use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use super::library::{library_status, LibraryStatus};
use crate::database::models::Game;
use crate::database::Recovery;
use crate::error::{AppError, AppResult};
use crate::games::service;
use crate::platform::window;
use crate::processes::supervisor::RuntimeSnapshot;
use crate::settings::{self, AppSettings};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: String,
    pub build: &'static str,
    pub tauri_version: &'static str,
    pub webview_version: Option<String>,
    pub os: String,
    pub data_dir: String,
    pub log_dir: String,
    pub db_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub games: Vec<Game>,
    pub settings: AppSettings,
    pub runtime: Vec<RuntimeSnapshot>,
    pub library: LibraryStatus,
    pub app: AppInfo,
    pub first_run: bool,
    pub db_recovery: Option<Recovery>,
}

fn app_info(app: &AppHandle, st: &AppState) -> AppInfo {
    AppInfo {
        name: "WIISB Launcher",
        version: app.package_info().version.to_string(),
        build: if cfg!(debug_assertions) { "debug" } else { "release" },
        tauri_version: tauri::VERSION,
        webview_version: tauri::webview_version().ok(),
        os: format!("Windows ({})", std::env::consts::ARCH),
        data_dir: st.data_dir.display().to_string(),
        log_dir: app.path().app_log_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        db_path: st.data_dir.join("wiisb.db").display().to_string(),
    }
}

#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> AppResult<Bootstrap> {
    let games = service::prune_missing_artwork(&state.db, state.db.list_games()?);
    let settings = state.settings();
    Ok(Bootstrap {
        games,
        library: library_status(&settings.library_root),
        runtime: state.supervisor.snapshots(),
        app: app_info(&app, &state),
        first_run: state.db.get_setting("first_scan_done")?.is_none(),
        db_recovery: state.recovery.clone(),
        settings,
    })
}

pub fn apply_autostart(app: &AppHandle, enable: bool) -> AppResult<()> {
    let manager = app.autolaunch();
    let result = if enable { manager.enable() } else { manager.disable() };
    result.map_err(|e| AppError::Io(format!("Couldn't change the Windows startup setting: {e}")))
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, patch: Value) -> AppResult<AppSettings> {
    let current = state.settings();
    let next = settings::apply_patch(&current, &patch)?;
    if next.launch_on_startup != current.launch_on_startup {
        apply_autostart(&app, next.launch_on_startup)?;
    }
    settings::save(&state.db, &next)?;
    state.set_settings(next.clone());
    Ok(next)
}

#[tauri::command]
pub fn get_app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    app_info(&app, &state)
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    window::quit(&app);
}

#[tauri::command]
pub fn hide_to_tray(app: AppHandle) {
    window::save_state(&app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Opens a folder in Windows Explorer. Only folders the launcher itself knows about can be opened.
#[tauri::command]
pub fn reveal_path(app: AppHandle, state: State<'_, AppState>, kind: String, slug: Option<String>) -> AppResult<()> {
    let game = || -> AppResult<Game> {
        state.db.get_game(slug.as_deref().ok_or_else(|| AppError::Invalid("A game is required.".into()))?)
    };
    let exe_parent = |g: &Game| g.launch_target.as_deref().and_then(|t| std::path::Path::new(t).parent().map(PathBuf::from));
    let path: PathBuf = match kind.as_str() {
        "installation" => {
            let g = game()?;
            g.installation_path.as_deref().map(PathBuf::from).or_else(|| exe_parent(&g)).ok_or_else(|| AppError::NotFound("This game isn't linked yet.".into()))?
        }
        "working_dir" => {
            let g = game()?;
            g.working_dir.as_deref().map(PathBuf::from).or_else(|| exe_parent(&g)).ok_or_else(|| AppError::NotFound("This game isn't linked yet.".into()))?
        }
        "library_root" => PathBuf::from(state.settings().library_root),
        "data" => state.data_dir.clone(),
        "logs" => app.path().app_log_dir().map_err(|e| AppError::Io(e.to_string()))?,
        _ => return Err(AppError::Invalid("Unknown location.".into())),
    };
    if !path.is_dir() {
        return Err(AppError::NotFound("That folder doesn't exist (any more).".into()));
    }
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Command::new(root.join("explorer.exe")).arg(&path).spawn()?;
    Ok(())
}

/// The closest folder that still exists: `path` itself, or the nearest parent that does.
fn nearest_existing_dir(path: &std::path::Path) -> Option<PathBuf> {
    path.ancestors().filter(|p| p.parent().is_some()).find(|p| p.is_dir()).map(PathBuf::from)
}

/// Where a "Locate" file/folder picker should open for a game: its linked folder, else its own folder inside the
/// library folder (e.g. `E:bsgames\DELTARUNE`), else the library folder itself.
fn best_start_dir(profile: &crate::games::catalog::GameProfile, installation: Option<&str>, target: Option<&str>, library_root: &str) -> Option<PathBuf> {
    if let Some(dir) = installation.map(PathBuf::from).as_deref().and_then(nearest_existing_dir) {
        return Some(dir);
    }
    if let Some(dir) = target.map(PathBuf::from).as_deref().and_then(std::path::Path::parent).and_then(nearest_existing_dir) {
        return Some(dir);
    }
    let root = PathBuf::from(library_root.trim());
    let mut folders: Vec<(String, PathBuf)> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    folders.sort_by_key(|(name, _)| name.to_lowercase());
    let named = folders.iter().find(|(n, _)| profile.is_title_folder(n)).or_else(|| folders.iter().find(|(n, _)| profile.folder_matches(n)));
    named.map(|(_, p)| p.clone()).or_else(|| root.is_dir().then_some(root))
}

/// The folder the "Locate" picker should start in for this game (None: let Windows choose).
#[tauri::command]
pub fn locate_start_dir(state: State<'_, AppState>, slug: String) -> AppResult<Option<String>> {
    let game = state.db.get_game(&slug)?;
    let profile = crate::games::catalog::profile_for(&game.slug, &game.title);
    let root = state.settings().library_root;
    Ok(best_start_dir(&profile, game.installation_path.as_deref(), game.launch_target.as_deref(), &root).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn emit_navigate(app: AppHandle, page: String) {
    let _ = app.emit("navigate", page);
}

#[cfg(test)]
mod locate_tests {
    use super::*;
    use crate::games::catalog::profile_for;

    #[test]
    fn the_picker_opens_in_the_games_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("games");
        for name in ["Other Thing", "Persona 3 Reload", "DELTARUNE Chapter 1-4"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let root_s = root.to_string_lossy().into_owned();
        let deltarune = profile_for("deltarune", "DELTARUNE");
        assert_eq!(best_start_dir(&deltarune, None, None, &root_s), Some(root.join("DELTARUNE Chapter 1-4")));
        let p3r = profile_for("persona-3-reload", "Persona 3 Reload");
        assert_eq!(best_start_dir(&p3r, None, None, &root_s), Some(root.join("Persona 3 Reload")));
        // No folder for this game: fall back to the library folder.
        let unknown = profile_for("ultrakill", "ULTRAKILL");
        assert_eq!(best_start_dir(&unknown, None, None, &root_s), Some(root.clone()));
        // A linked game opens where it is linked; a vanished folder falls back to the nearest one that exists.
        let linked = root.join("Other Thing");
        assert_eq!(best_start_dir(&deltarune, Some(&linked.to_string_lossy()), None, &root_s), Some(linked.clone()));
        let gone = linked.join("deep").join("gone");
        assert_eq!(best_start_dir(&deltarune, Some(&gone.to_string_lossy()), None, &root_s), Some(linked));
        // Nothing exists at all: let Windows choose.
        assert_eq!(best_start_dir(&deltarune, None, None, &dir.path().join("nope").to_string_lossy()), None);
    }
}
