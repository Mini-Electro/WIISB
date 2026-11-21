//! Main-window helpers: show/restore, remembered position, quitting.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::settings::{load_window_state, save_window_state, WindowState};
use crate::state::AppState;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Persist the window's position/size (skipped while minimised, when Windows reports junk).
pub fn save_state(app: &AppHandle) {
    let (Some(w), Some(st)) = (app.get_webview_window("main"), app.try_state::<AppState>()) else { return };
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let previous = load_window_state(&st.db);
    let current = match (w.outer_position(), w.outer_size()) {
        (Ok(p), Ok(s)) => Some((p.x, p.y, s.width, s.height)),
        _ => None,
    };
    // While maximised keep the last *normal* geometry so un-maximising restores something sensible.
    let geometry = if maximized { previous.map(|p| (p.x, p.y, p.width, p.height)).or(current) } else { current };
    if let Some((x, y, width, height)) = geometry {
        save_window_state(&st.db, &WindowState { x, y, width, height, maximized });
    }
}

/// Puts the window back where it was. Returns false when there is nothing usable to restore,
/// in which case the caller centres the window (after DPI scaling has been applied).
pub fn restore_state(app: &AppHandle, w: &WebviewWindow) -> bool {
    let Some(st) = app.try_state::<AppState>() else { return false };
    let Some(ws) = load_window_state(&st.db) else { return false };
    // Only restore a position that is still on a connected monitor (multi-monitor setups change).
    let on_screen = w.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        ws.x + 120 > p.x && ws.x < p.x + s.width as i32 - 120 && ws.y >= p.y - 8 && ws.y < p.y + s.height as i32 - 120
    });
    if on_screen {
        let _ = w.set_size(PhysicalSize::new(ws.width.max(980), ws.height.max(620)));
        let _ = w.set_position(PhysicalPosition::new(ws.x, ws.y));
    }
    if ws.maximized {
        let _ = w.maximize();
    }
    on_screen
}

/// Quit for real (bypassing close-to-tray). Running games are left alone.
pub fn quit(app: &AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        st.exit_requested.store(true, Ordering::SeqCst);
    }
    save_state(app);
    app.exit(0);
}
