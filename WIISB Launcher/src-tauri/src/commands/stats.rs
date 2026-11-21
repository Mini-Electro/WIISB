use std::path::Path;

use tauri::State;

use crate::database::models::{LaunchEntry, Session};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, since: Option<i64>) -> AppResult<Vec<Session>> {
    state.db.list_sessions(since)
}

#[tauri::command]
pub fn list_launch_history(state: State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<LaunchEntry>> {
    state.db.list_launches(limit.unwrap_or(50).clamp(1, 500))
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn iso_utc(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn sessions_to_csv(sessions: &[Session], title_of: &dyn Fn(&str) -> String) -> String {
    let mut out = String::from("session_id,game,started_at_utc,ended_at_utc,duration_seconds,launch_method,confirmation,completion\r\n");
    for s in sessions {
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{}\r\n",
            s.id,
            csv_field(&title_of(&s.slug)),
            iso_utc(s.started_at),
            s.ended_at.map(iso_utc).unwrap_or_default(),
            s.duration_secs,
            s.launch_method,
            s.confirmation_status,
            s.completion_status
        ));
    }
    out
}

#[tauri::command]
pub fn export_sessions_csv(state: State<'_, AppState>, path: String) -> AppResult<usize> {
    let p = Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("csv")).unwrap_or(true) {
        return Err(AppError::Invalid("Export files must end in .csv.".into()));
    }
    if !p.parent().is_some_and(|d| d.is_dir()) {
        return Err(AppError::Invalid("The destination folder doesn't exist.".into()));
    }
    let sessions = state.db.list_sessions(None)?;
    let games = state.db.list_games()?;
    let title = |slug: &str| games.iter().find(|g| g.slug == slug).map(|g| g.title.clone()).unwrap_or_else(|| slug.to_string());
    std::fs::write(p, sessions_to_csv(&sessions, &title))?;
    Ok(sessions.len())
}

/// Removes finished sessions and launch history. Requires the literal confirmation word.
#[tauri::command]
pub fn reset_statistics(app: tauri::AppHandle, state: State<'_, AppState>, confirm: String) -> AppResult<()> {
    if confirm != "RESET" {
        return Err(AppError::Invalid("Type RESET to confirm.".into()));
    }
    state.db.reset_statistics()?;
    tauri::Emitter::emit(&app, "sessions-changed", ()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates_are_correct_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z"); // leap day
        assert_eq!(iso_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso_utc(1_793_000_000), "2026-10-26T07:33:20Z");
    }

    #[test]
    fn csv_export_escapes_and_formats() {
        let s = Session {
            id: 7,
            game_id: 1,
            slug: "x".into(),
            started_at: 1_700_000_000,
            ended_at: Some(1_700_000_060),
            duration_secs: 60,
            launch_method: "direct".into(),
            confirmation_status: "confirmed".into(),
            completion_status: "completed".into(),
            last_heartbeat: 0,
        };
        let csv = sessions_to_csv(&[s], &|_| "Game, \"Quoted\"".into());
        let lines: Vec<_> = csv.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "7,\"Game, \"\"Quoted\"\"\",2023-11-14T22:13:20Z,2023-11-14T22:14:20Z,60,direct,confirmed,completed");
    }
}
