use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::events::notify_launch_error;
use crate::games::service;
use crate::processes::supervisor::RuntimeSnapshot;
use crate::state::AppState;

fn launch_inner(st: &AppState, slug: &str) -> AppResult<RuntimeSnapshot> {
    // Always re-validate right before launching: the drive may have been unplugged since startup.
    let game = service::revalidate(&st.db, slug)?;
    if let Some(block) = service::launch_block_reason(&game) {
        return Err(block);
    }
    let req = service::build_launch_request(&game)?;
    st.supervisor.launch(&game, req)
}

/// The single launch pipeline, used by the PLAY button and the tray menu alike:
/// validate → duplicate check → native launch → confirmation → session tracking.
pub fn launch_by_slug(app: &AppHandle, slug: &str) -> AppResult<RuntimeSnapshot> {
    let st = app.state::<AppState>();
    let title = st.db.get_game(slug).map(|g| g.title).unwrap_or_else(|_| slug.to_string());
    let result = launch_inner(&st, slug);
    match &result {
        Ok(_) => {
            if st.settings().minimize_on_launch {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.minimize();
                }
            }
        }
        // Spawn failures are announced by the supervisor and duplicates by the UI.
        Err(e) if !matches!(e.code(), "launch_failed" | "already_running") => {
            notify_launch_error(app, &title, &e.to_string());
        }
        Err(_) => {}
    }
    result
}

#[tauri::command]
pub async fn launch_game(app: AppHandle, slug: String) -> AppResult<RuntimeSnapshot> {
    tauri::async_runtime::spawn_blocking(move || launch_by_slug(&app, &slug))
        .await
        .map_err(|e| AppError::LaunchFailed(format!("The launch task failed unexpectedly: {e}")))?
}

/// Force-stop a game that is launching or running.
#[tauri::command]
pub async fn stop_game(app: AppHandle, slug: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        st.supervisor.stop(&slug, crate::database::now())
    })
    .await
    .map_err(|e| AppError::LaunchFailed(format!("The stop task failed unexpectedly: {e}")))?
}

#[tauri::command]
pub fn get_runtime(state: State<'_, AppState>) -> Vec<RuntimeSnapshot> {
    state.supervisor.snapshots()
}

/// Looks for games that are already running (started outside WIISB Launcher). Throttled, since it
/// enumerates processes; the UI calls it when the window regains focus.
#[tauri::command]
pub async fn detect_running_games(app: AppHandle) -> AppResult<Vec<RuntimeSnapshot>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let now = crate::database::now();
        let last = st.last_detect.swap(now, std::sync::atomic::Ordering::SeqCst);
        if now - last >= 15 && st.settings().track_external_launches {
            let games = st.db.list_games()?;
            st.supervisor.detect_running(&games, now);
        }
        Ok(st.supervisor.snapshots())
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}
