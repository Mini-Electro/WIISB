//! WIISB Launcher — native backend.
//!
//! * `games`      discovery, validation, library operations (read-only with respect to game files)
//! * `processes`  native launching, process confirmation, session tracking
//! * `database`   SQLite persistence and migrations
//! * `settings`   user preferences
//! * `platform`   Windows integration: tray, window state, Win32 helpers
//! * `commands`   the (small) IPC surface exposed to the UI

pub mod commands;
pub mod database;
pub mod error;
pub mod events;
pub mod games;
pub mod platform;
pub mod processes;
pub mod settings;
pub mod state;
pub mod updates;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, RwLock};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use database::{now, Db};
use events::TauriSink;
use games::service;
use platform::{tray, window};
use processes::launcher::RealSpawner;
use processes::source::SysinfoSource;
use processes::supervisor::Supervisor;
use settings::{decide_close, CloseAction};
use state::AppState;

const PAGES: [&str; 7] = ["home", "library", "recent", "favourites", "stats", "other", "settings"];

/// Extracts the value of `--page <name>` from command-line arguments (allow-listed).
pub fn requested_page(args: &[String]) -> Option<&'static str> {
    // `--scan-pc` opens the whole-PC scan dialog and starts scanning.
    if args.iter().any(|a| a == "--scan-pc") {
        return Some("deepscan-start");
    }
    let i = args.iter().position(|a| a == "--page")?;
    let want = args.get(i + 1)?.to_ascii_lowercase();
    PAGES.iter().copied().find(|p| *p == want)
}

#[cfg(test)]
mod tests {
    use super::requested_page;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn page_argument_is_allow_listed() {
        assert_eq!(requested_page(&a(&["app.exe", "--page", "Settings"])), Some("settings"));
        assert_eq!(requested_page(&a(&["app.exe", "--page", "stats"])), Some("stats"));
        assert_eq!(requested_page(&a(&["app.exe", "--page", "other"])), Some("other"));
        assert_eq!(requested_page(&a(&["app.exe", "--page", "../../etc"])), None);
        assert_eq!(requested_page(&a(&["app.exe", "--page"])), None);
        assert_eq!(requested_page(&a(&["app.exe"])), None);
        assert_eq!(requested_page(&a(&["app.exe", "--scan-pc"])), Some("deepscan-start"));
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch brings the existing window forward, optionally jumping to a page:
            // `wiisb-launcher.exe --page library`. Only known page names are accepted.
            window::show_main(app);
            if let Some(page) = requested_page(&args) {
                let _ = app.emit("navigate", page);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("wiisb-launcher".into()) }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            updates::start(app.handle(), |app| app.try_state::<AppState>().map_or(true, |s| s.settings().auto_update));
            let handle = app.handle().clone();
            let data_dir = app.path().app_local_data_dir()?;
            let art_dir = data_dir.join("artwork");
            std::fs::create_dir_all(&art_dir)?;

            let (db, recovery) = Db::open(&data_dir.join("wiisb.db"))?;
            if let Some(r) = &recovery {
                log::error!("database was recovered; original kept at {}", r.preserved_at);
            }
            let db = Arc::new(db);
            let settings = settings::load(&db);

            let supervisor = Supervisor::new(
                db.clone(),
                Arc::new(RealSpawner),
                Arc::new(TauriSink { app: handle.clone() }),
                Box::new(SysinfoSource::new()),
                true,
            );
            app.manage(AppState {
                db: db.clone(),
                supervisor,
                settings: RwLock::new(settings.clone()),
                data_dir,
                art_dir,
                exit_requested: AtomicBool::new(false),
                recovery,
                last_detect: AtomicI64::new(0),
                art_running: AtomicBool::new(false),
                deep: std::sync::Mutex::new(state::DeepState::default()),
                deep_cancel: Arc::new(AtomicBool::new(false)),
            });

            // Keep the Windows startup entry in step with the saved preference.
            if app.autolaunch().is_enabled().unwrap_or(false) != settings.launch_on_startup {
                let _ = commands::system::apply_autostart(&handle, settings.launch_on_startup);
            }

            tray::build(&handle)?;

            if let Some(w) = app.get_webview_window("main") {
                let restored = settings.restore_window && window::restore_state(&handle, &w);
                if !restored {
                    // On heavily scaled displays the default size can exceed the screen: fit it first,
                    // then centre now that the window has its final, DPI-scaled size.
                    // The window's reported size is not reliable yet at this point, so work in logical
                    // pixels from the monitor's scale factor instead.
                    let monitor = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
                    if let Some(m) = monitor {
                        let sf = m.scale_factor().max(0.5);
                        let (mw, mh) = (m.size().width as f64 / sf, m.size().height as f64 / sf);
                        let width = 1360f64.min(mw * 0.9).max(980f64.min(mw));
                        let height = 840f64.min(mh * 0.88).max(620f64.min(mh));
                        let _ = w.set_size(tauri::LogicalSize::new(width, height));
                    }
                    let _ = w.center();
                }
                let has_tray_mode = settings.minimize_to_tray || settings.close_to_tray;
                if settings.start_minimized {
                    if has_tray_mode {
                        // Stay hidden in the tray.
                    } else {
                        let _ = w.show();
                        let _ = w.minimize();
                    }
                } else {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            // Background start-up work: validate links, resume/close interrupted sessions,
            // and adopt games that are already running. Never blocks the UI.
            std::thread::spawn(move || {
                let st = handle.state::<AppState>();
                // Pick up games installed (or moved) since last time — quick detectors only, no big folder walks.
                if st.settings().detect_other_games {
                    let root = std::path::PathBuf::from(st.settings().library_root);
                    let found = if root.is_dir() { games::detect::detect_all(Some(&root)) } else { games::detect::detect_quick() };
                    match service::apply_detected(&st.db, &found, &|s| st.supervisor.is_active(s)) {
                        Ok(items) if !items.is_empty() => log::info!("detected {} new/updated games at startup", items.len()),
                        Ok(_) => {}
                        Err(e) => log::warn!("startup detection failed: {e}"),
                    }
                }
                // One-off: earlier builds mistook Electricity's background helpers for the game and recorded
                // sessions that were never real. Remove just those (detected/resumed) for the Roblox entry.
                if st.db.get_setting("roblox_session_cleanup_v1").ok().flatten().is_none() {
                    match st.db.purge_detected_sessions("roblox-player") {
                        Ok(n) => log::info!("removed {n} bogus detected session(s) for the Roblox/Electricity entry"),
                        Err(e) => log::warn!("session cleanup failed: {e}"),
                    }
                    let _ = st.db.set_setting("roblox_session_cleanup_v1", "1");
                }
                // One-off: Lunar Client was replaced by OneClient. Take its old entry out of the library so it
                // doesn't sit there as a "missing" game (hidden, like any removed game; a no-op if it never existed).
                if st.db.get_setting("lunar_removed_v1").ok().flatten().is_none() {
                    match st.db.set_hidden("minecraft-lunar", true) {
                        Ok(()) => {
                            let _ = st.db.set_setting("lunar_removed_v1", "1");
                        }
                        Err(e) => log::warn!("couldn't remove the Lunar Client entry: {e}"),
                    }
                }
                let games = service::revalidate_all(&st.db).unwrap_or_default();
                st.supervisor.recover(&games, now());
                if st.settings().track_external_launches {
                    st.supervisor.detect_running(&games, now());
                }
                let _ = handle.emit("library-changed", &st.db.list_games().unwrap_or_default());
                tray::refresh(&handle);
                // The image fallback list grew in this version: give games that came up empty one more try.
                if st.db.get_setting("art_retry_v2").ok().flatten().is_none() {
                    let _ = st.db.reset_art_attempts();
                    let _ = st.db.set_setting("art_retry_v2", "1");
                }
                commands::library::start_art_job(&handle, false);
            });
            Ok(())
        })
        .on_window_event(|win, event| {
            let app = win.app_handle();
            let Some(st) = app.try_state::<AppState>() else { return };
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let explicit = st.exit_requested.load(Ordering::SeqCst);
                    match decide_close(&st.settings(), explicit) {
                        CloseAction::HideToTray => {
                            api.prevent_close();
                            window::save_state(app);
                            let _ = win.hide();
                        }
                        CloseAction::AskConfirmation => {
                            api.prevent_close();
                            let _ = win.emit("confirm-exit", ());
                        }
                        CloseAction::Exit => window::save_state(app),
                    }
                }
                WindowEvent::Resized(_) => {
                    if st.settings().minimize_to_tray && win.is_minimized().unwrap_or(false) {
                        let _ = win.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates::pending_update,
            updates::install_update,
            updates::check_for_updates,
            commands::system::locate_start_dir,
            commands::others::other_app_start_dir,
            commands::chat::chat_installation,
            commands::chat::launch_wiisb_chat,
            commands::others::other_apps,
            commands::other_updates::check_other_updates,
            commands::other_updates::update_other_app,
            commands::others::launch_other_app,
            commands::others::install_other_app,
            commands::others::locate_other_app,
            commands::others::forget_other_app_path,
            commands::others::reveal_other_app,
            commands::system::bootstrap,
            commands::system::update_settings,
            commands::system::get_app_info,
            commands::system::quit_app,
            commands::system::hide_to_tray,
            commands::system::reveal_path,
            commands::system::emit_navigate,
            commands::library::get_library_status,
            commands::library::scan_library,
            commands::library::set_library_root,
            commands::library::link_game,
            commands::library::unlink_game,
            commands::library::save_launch_settings,
            commands::library::validate_games,
            commands::library::set_favourite,
            commands::library::get_notes,
            commands::library::set_notes,
            commands::library::set_artwork,
            commands::library::clear_artwork,
            commands::library::add_custom_game,
            commands::library::set_game_hidden,
            commands::library::list_hidden_games,
            commands::library::fetch_artwork,
            commands::library::detect_games,
            commands::deepscan::deep_scan_start,
            commands::deepscan::deep_scan_cancel,
            commands::deepscan::deep_scan_status,
            commands::deepscan::deep_scan_add,
            commands::launch::launch_game,
            commands::launch::stop_game,
            commands::launch::get_runtime,
            commands::launch::detect_running_games,
            commands::stats::list_sessions,
            commands::stats::list_launch_history,
            commands::stats::export_sessions_csv,
            commands::stats::reset_statistics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building WIISB Launcher");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            // An implicit exit (last window closed) must not kill a tray-resident launcher.
            let Some(st) = app.try_state::<AppState>() else { return };
            let s = st.settings();
            if code.is_none() && !st.exit_requested.load(Ordering::SeqCst) && (s.close_to_tray || s.minimize_to_tray) {
                api.prevent_exit();
            }
        }
    });
}
