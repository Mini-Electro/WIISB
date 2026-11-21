//! Whole-PC scan commands. The scan runs on its own low-priority thread, reports progress as events,
//! and only *finds* games: nothing is added to the library until the user picks results to add.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::library::{announce_library, start_art_job};
use crate::error::{AppError, AppResult};
use crate::games::deepscan::{self, DeepCandidate, Known, Limits, ScanProgress};
use crate::games::detect::{Detected, DetectedLaunch};
use crate::games::service::{self, DetectedItem};
use crate::platform::sys;
use crate::state::{AppState, DeepState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepStatus {
    pub running: bool,
    pub finished: bool,
    pub cancelled: bool,
    pub hit_limit: bool,
    pub progress: ScanProgress,
    pub candidates: Vec<DeepCandidate>,
}

fn status_of(d: &DeepState) -> DeepStatus {
    DeepStatus {
        running: d.running,
        finished: d.finished,
        cancelled: d.cancelled,
        hit_limit: d.hit_limit,
        progress: d.progress.clone(),
        candidates: d.candidates.clone(),
    }
}

#[tauri::command]
pub fn deep_scan_status(state: State<'_, AppState>) -> DeepStatus {
    status_of(&state.deep.lock().unwrap_or_else(|p| p.into_inner()))
}

/// Start scanning every local drive in the background.
#[tauri::command]
pub fn deep_scan_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    {
        let mut d = state.deep.lock().unwrap_or_else(|p| p.into_inner());
        if d.running {
            return Err(AppError::AlreadyRunning("A whole-PC scan is already running.".into()));
        }
        *d = DeepState { running: true, ..DeepState::default() };
    }
    state.deep_cancel.store(false, Ordering::SeqCst);

    std::thread::Builder::new()
        .name("wiisb-deep-scan".into())
        .spawn(move || {
            // Low CPU *and* disk priority: the scan must never get in the way of a game or anything else.
            sys::enter_background_mode();
            let st = app.state::<AppState>();
            let known = Known::new(
                st.db
                    .list_all_games()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|g| g.installation_path.map(PathBuf::from)),
            );
            let roots = sys::local_drives();
            log::info!("whole-PC scan started over {} drive(s)", roots.len());
            let outcome = deepscan::deep_scan(&roots, &Limits::default(), &known, &st.deep_cancel, &mut |p| {
                st.deep.lock().unwrap_or_else(|e| e.into_inner()).progress = p.clone();
                let _ = app.emit("deep-scan-progress", p);
            });
            log::info!("whole-PC scan finished: {} folders, {} candidates, cancelled={}", outcome.dirs, outcome.candidates.len(), outcome.cancelled);
            let status = {
                let mut d = st.deep.lock().unwrap_or_else(|e| e.into_inner());
                d.running = false;
                d.finished = true;
                d.cancelled = outcome.cancelled;
                d.hit_limit = outcome.hit_limit;
                d.candidates = outcome.candidates;
                status_of(&d)
            };
            let _ = app.emit("deep-scan-done", status);
        })
        .map_err(|e| AppError::Io(format!("Couldn't start the scan: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn deep_scan_cancel(state: State<'_, AppState>) {
    state.deep_cancel.store(true, Ordering::SeqCst);
}

/// Add the chosen results to the library (the only step that changes anything).
#[tauri::command]
pub async fn deep_scan_add(app: AppHandle, ids: Vec<String>) -> AppResult<Vec<DetectedItem>> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let chosen: Vec<DeepCandidate> = {
            let d = st.deep.lock().unwrap_or_else(|p| p.into_inner());
            d.candidates.iter().filter(|c| ids.contains(&c.id)).cloned().collect()
        };
        if chosen.is_empty() {
            return Err(AppError::Invalid("Pick at least one game to add.".into()));
        }
        let found: Vec<Detected> = chosen
            .iter()
            .map(|c| Detected {
                source: "pc",
                external_id: c.title.clone(),
                title: c.title.clone(),
                install_dir: Some(PathBuf::from(&c.root)),
                launch: DetectedLaunch::Exe { path: PathBuf::from(&c.exe), args: String::new() },
                steam_app_id: None,
                icon_exe: Some(PathBuf::from(&c.exe)),
                name_hints: vec![],
            })
            .collect();
        let items = service::apply_detected(&st.db, &found, &|s| st.supervisor.is_active(s))?;
        service::revalidate_all(&st.db)?;
        // Everything the user picked is handled now (added, or already present): take it off the list.
        st.deep.lock().unwrap_or_else(|p| p.into_inner()).candidates.retain(|c| !ids.contains(&c.id));
        announce_library(&app, &st);
        start_art_job(&app, false);
        Ok(items)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}
