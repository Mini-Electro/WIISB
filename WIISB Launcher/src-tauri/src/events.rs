//! Bridges the supervisor's [`EventSink`] to the UI (Tauri events) and to native Windows
//! notifications, honouring the user's notification settings.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::processes::supervisor::{EventSink, Notice, RuntimeSnapshot};
use crate::state::AppState;

pub struct TauriSink {
    pub app: AppHandle,
}

pub fn format_duration(secs: i64) -> String {
    let (h, m) = (secs / 3600, (secs % 3600) / 60);
    match (h, m) {
        (0, 0) => format!("{secs}s"),
        (0, m) => format!("{m}m"),
        (h, m) => format!("{h}h {m:02}m"),
    }
}

pub fn send_notification(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("could not show notification: {e}");
    }
}

/// An error toast for failures that happen before a process is even started.
pub fn notify_launch_error(app: &AppHandle, game_title: &str, message: &str) {
    let enabled = app.try_state::<AppState>().map(|s| {
        let st = s.settings();
        st.notifications_enabled && st.notify_on_errors
    });
    if enabled.unwrap_or(false) {
        send_notification(app, &format!("{game_title} could not be launched"), message);
    }
}

impl EventSink for TauriSink {
    fn state_changed(&self, snapshot: &RuntimeSnapshot) {
        let _ = self.app.emit("game-state", snapshot);
    }

    fn sessions_changed(&self) {
        let _ = self.app.emit("sessions-changed", ());
    }

    fn notify(&self, notice: Notice) {
        let Some(state) = self.app.try_state::<AppState>() else { return };
        let s = state.settings();
        if !s.notifications_enabled {
            return;
        }
        match notice {
            Notice::Launched { title } if s.notify_on_launch => {
                send_notification(&self.app, "WIISB Launcher", &format!("{title} launched."));
            }
            Notice::LaunchFailed { title, message } if s.notify_on_errors => {
                send_notification(&self.app, &format!("{title} could not be launched"), &format!("Check the installation path. {message}"));
            }
            Notice::Unconfirmed { title } if s.notify_on_errors => {
                send_notification(&self.app, "WIISB Launcher", &format!("{title}: launch requested, but it couldn't be confirmed."));
            }
            // Very short runs are not worth a notification.
            Notice::SessionEnded { title, secs } if s.notify_on_session_end && secs >= 60 => {
                send_notification(&self.app, "Game session completed", &format!("{title} — played for {}.", format_duration(secs)));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::format_duration;

    #[test]
    fn durations_are_readable() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(600), "10m");
        assert_eq!(format_duration(3 * 3600 + 5 * 60), "3h 05m");
    }
}
