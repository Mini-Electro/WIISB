//! Background updates from GitHub Releases.
//!
//! A new version is looked for shortly after start and then every few hours (unless the person turned automatic updates
//! off; "Check for updates" in Settings looks on demand either way). When one is found it is downloaded and its
//! signature is checked against the public key in `tauri.conf.json` (a release that isn't signed with the WIISB key is
//! refused), then the app tells the window "an update is ready". Nothing is installed or closed until the person
//! chooses "Restart to update" — see `install_update`.
//!
//! The release script compiles the repository name in (`WIISB_UPDATE_REPO=owner/repo@release-tag`). A build without it, such as a
//! development build, never looks for updates at all.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPO: Option<&str> = option_env!("WIISB_UPDATE_REPO");
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
/// How often the background thread looks at the clock and the "automatic updates" preference.
const TICK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(30 * 60);

/// A downloaded, verified update waiting for the person to restart.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Set while a check or download is running, so a manual check never overlaps the background one.
#[derive(Default)]
pub struct Checking(AtomicBool);

/// What "Check for updates" tells the window. `status` is `upToDate`, `ready`, `busy`, `unavailable` or `error`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub status: &'static str,
    pub version: Option<String>,
    pub message: String,
}

enum Outcome {
    UpToDate,
    Ready(String),
    Busy,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub version: String,
    pub notes: Option<String>,
}

/// Where the latest release's manifest lives. Development builds (`debug_assertions`) may point at a test server with
/// `WIISB_UPDATE_URL`; release builds only ever use the compiled-in GitHub repository.
fn endpoint() -> Option<Url> {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("WIISB_UPDATE_URL") {
        return url.parse().ok();
    }
    manifest_url(REPO?)
}

/// "owner/repo@tag": the release called `tag` always holds this app's newest installer and latest.json.
fn manifest_url(spec: &str) -> Option<Url> {
    let spec = spec.trim();
    let (repo, tag) = spec.split_once('@').unwrap_or((spec, ""));
    let plain = |part: &str| !part.is_empty() && part != "." && part != ".." && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if repo.split('/').count() != 2 || !repo.split('/').all(plain) {
        return None;
    }
    if tag.is_empty() {
        format!("https://github.com/{repo}/releases/latest/download/latest.json").parse().ok()
    } else if plain(tag) {
        format!("https://github.com/{repo}/releases/download/{tag}/latest.json").parse().ok()
    } else {
        None
    }
}

fn note(app: &AppHandle, message: &str) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("updates.log")) {
        let _ = writeln!(f, "{} {message}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    }
}

async fn check(app: &AppHandle, url: &Url) -> Result<Outcome, String> {
    {
        let waiting = app.state::<Pending>();
        let pending = waiting.0.lock().map_err(|e| e.to_string())?;
        if let Some((update, _)) = pending.as_ref() {
            return Ok(Outcome::Ready(update.version.clone())); // one is already waiting for a restart
        }
    }
    if app.state::<Checking>().0.swap(true, Ordering::SeqCst) {
        return Ok(Outcome::Busy);
    }
    let result = look_and_download(app, url).await;
    app.state::<Checking>().0.store(false, Ordering::SeqCst);
    result
}

async fn look_and_download(app: &AppHandle, url: &Url) -> Result<Outcome, String> {
    let mut builder = app.updater_builder().endpoints(vec![url.clone()]).map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    {
        builder = builder.timeout(Duration::from_secs(30));
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        note(app, "up to date");
        return Ok(Outcome::UpToDate);
    };
    note(app, &format!("update {} found; downloading", update.version));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?; // verifies the signature
    let ready = Ready { version: update.version.clone(), notes: update.body.clone() };
    *app.state::<Pending>().0.lock().map_err(|e| e.to_string())? = Some((update, bytes));
    note(app, &format!("update {} downloaded and verified", ready.version));
    let version = ready.version.clone();
    let _ = app.emit("update-ready", ready);
    Ok(Outcome::Ready(version))
}

/// Registers the state and starts the background checker. Does nothing if no update source is compiled in.
/// `auto_enabled` says whether the person still wants automatic checks; it is asked again before every check, so the
/// preference takes effect without a restart.
pub fn start(app: &AppHandle, auto_enabled: fn(&AppHandle) -> bool) {
    app.manage(Pending::default());
    app.manage(Checking::default());
    let Some(url) = endpoint() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        let mut next = Instant::now();
        loop {
            if Instant::now() >= next && auto_enabled(&app) {
                next = Instant::now()
                    + match tauri::async_runtime::block_on(check(&app, &url)) {
                        Ok(_) => CHECK_EVERY,
                        Err(e) => {
                            note(&app, &format!("update check failed: {e}"));
                            RETRY_AFTER_ERROR
                        }
                    };
            }
            std::thread::sleep(TICK);
        }
    });
}

/// "Check for updates": looks right now, whatever the automatic-updates preference says. A new version is downloaded and
/// the usual "Restart to update" bar appears; nothing installs until the person chooses.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> CheckResult {
    let result = |status: &'static str, version: Option<String>, message: &str| CheckResult { status, version, message: message.to_string() };
    let Some(url) = endpoint() else {
        return result("unavailable", None, "This copy of the app has no update source built in, so it can't look for updates.");
    };
    match check(&app, &url).await {
        Ok(Outcome::UpToDate) => result("upToDate", None, "You're on the latest version."),
        Ok(Outcome::Ready(v)) => result("ready", Some(v.clone()), &format!("Version {v} is downloaded. Restart to update.")),
        Ok(Outcome::Busy) => result("busy", None, "An update check is already running."),
        Err(e) => {
            note(&app, &format!("manual update check failed: {e}"));
            result("error", None, "Couldn't check for updates. Check your internet connection and try again.")
        }
    }
}

/// The update that is ready, if any (the window asks when it opens, in case the event came first).
#[tauri::command]
pub fn pending_update(state: State<Pending>) -> Option<Ready> {
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|(u, _)| Ready { version: u.version.clone(), notes: u.body.clone() })
}

/// Installs the downloaded update and restarts the app. On Windows the installer takes over and relaunches it.
#[tauri::command]
pub fn install_update(app: AppHandle, state: State<Pending>) -> Result<(), String> {
    let taken = state.0.lock().map_err(|e| e.to_string())?.take();
    let Some((update, bytes)) = taken else { return Err("There is no update ready.".into()) };
    note(&app, &format!("installing {}", update.version));
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::manifest_url;

    #[test]
    fn manifest_lives_in_the_apps_release() {
        assert_eq!(manifest_url("Mini-Electro/WIISB@chat-latest").unwrap().as_str(), "https://github.com/Mini-Electro/WIISB/releases/download/chat-latest/latest.json");
        assert_eq!(manifest_url("a/b").unwrap().as_str(), "https://github.com/a/b/releases/latest/download/latest.json");
    }

    #[test]
    fn rejects_odd_specs() {
        for bad in ["", "owner", "a/b/c", "a/b@x y", "a/b@../x", "a/b@..", "../b", "a b/c", "a/b@x/y", "@t"] {
            assert!(manifest_url(bad).is_none(), "{bad}");
        }
    }
}
