//! System tray: open the app, jump to pages, launch linked games through the same validated
//! pipeline as the PLAY button, and exit.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use super::window;
use crate::commands::launch::launch_by_slug;
use crate::state::AppState;

const TRAY_ID: &str = "main";

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let games = app.try_state::<AppState>().and_then(|s| s.db.list_games().ok()).unwrap_or_default();
    let mut play = SubmenuBuilder::new(app, "Play");
    let mut any = false;
    // Favourites first, then the rest; capped so the menu stays usable with a big library.
    let mut ready: Vec<_> = games.iter().filter(|g| g.installed).collect();
    ready.sort_by_key(|g| !g.is_favourite);
    for g in ready.into_iter().take(15) {
        play = play.text(format!("play:{}", g.slug), &g.title);
        any = true;
    }
    if !any {
        play = play.item(&MenuItemBuilder::with_id("none", "No games linked yet").enabled(false).build(app)?);
    }
    let play = play.build()?;
    MenuBuilder::new(app)
        .text("open", "Open WIISB Launcher")
        .text("nav:library", "Open Library")
        .item(&play)
        .text("nav:settings", "Settings")
        .separator()
        .text("exit", "Exit")
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => window::show_main(app),
        "exit" => window::quit(app),
        _ if id.starts_with("nav:") => {
            window::show_main(app);
            let _ = app.emit("navigate", &id[4..]);
        }
        _ if id.starts_with("play:") => {
            let slug = id[5..].to_string();
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = launch_by_slug(&app, &slug) {
                    log::info!("tray launch of {slug} did not start: {e}");
                    let _ = app.emit("notice", serde_json::json!({ "kind": "error", "message": e.to_string() }));
                }
            });
        }
        _ => {}
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("WIISB Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Rebuild the tray menu after the set of linked games changes.
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log::warn!("could not rebuild tray menu: {e}"),
        }
    }
}
