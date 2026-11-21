//! The other WIISB apps (WIISB Chat and WIISBROWSING). A fixed list with fixed program names: nothing else can be
//! started or installed through here, and a path you choose by hand is only accepted if it really is that program.
//! Each app's own installer travels inside the launcher (`apps\` next to it), so installing never needs a download.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::games::validation::is_pe_file;
use crate::state::AppState;

pub(super) struct Def {
    pub(super) id: &'static str,
    pub(super) name: &'static str,
    pub(super) tagline: &'static str,
    pub(super) exe: &'static str,
    /// Name of its key under `Software\Microsoft\Windows\CurrentVersion\Uninstall`.
    pub(super) uninstall_key: &'static str,
    /// Folder inside `%LOCALAPPDATA%` / `%LOCALAPPDATA%\Programs` the installers use.
    pub(super) install_folder: &'static str,
    /// File name of the app's setup program inside the launcher's `apps` folder.
    pub(super) installer: &'static str,
    /// Where the project's own builds end up, relative to the folder that holds all the WIISB projects.
    project_builds: &'static [&'static [&'static str]],
    /// Where the project leaves its setup program (used when the launcher itself was not packaged with one).
    project_installers: &'static [&'static [&'static str]],
}

pub(super) const APPS: [Def; 2] = [
    Def {
        id: "chat",
        name: "WIISB Chat",
        tagline: "Voice, video and text chat for your crew.",
        exe: "WIISB Chat.exe",
        uninstall_key: "WIISB Chat",
        install_folder: "WIISB Chat",
        installer: "WIISB-Chat-setup.exe",
        project_builds: &[
            &["WIISB Chat", "release", "WIISB Chat.exe"],
            &["WIISB Chat", "apps", "desktop", "src-tauri", "target", "release", "WIISB Chat.exe"],
        ],
        project_installers: &[&["WIISB Chat", "release", "WIISB Chat_0.1.0_x64-setup.exe"]],
    },
    Def {
        id: "browser",
        name: "WIISBROWSING",
        tagline: "A fast, beautiful browser with vertical tabs, workspaces and clusters.",
        exe: "WIISBROWSING.exe",
        uninstall_key: "WIISBROWSING",
        install_folder: "WIISBROWSING",
        installer: "WIISBROWSING-setup.exe",
        project_builds: &[
            &["WIISBROWSING", "release", "WIISBROWSING", "WIISBROWSING.exe"],
            &["WIISBROWSING", "publish", "win-x64", "WIISBROWSING.exe"],
            &["WIISBROWSING", "src", "WIISBROWSING.App", "bin", "Release", "net10.0-windows", "win-x64", "WIISBROWSING.exe"],
        ],
        project_installers: &[&["WIISBROWSING", "release", "WIISBROWSING_0.1.0_x64-setup.exe"]],
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherApp {
    pub(super) id: &'static str,
    pub(super) name: &'static str,
    pub(super) tagline: &'static str,
    installed: bool,
    path: Option<String>,
    /// `installed` | `project` | `chosen` — where the program was found.
    source: Option<&'static str>,
    running: bool,
    /// A `data:image/png;base64,…` icon taken from the program itself.
    icon: Option<String>,
    /// The launcher has this app's setup program, so "Install" will work.
    can_install: bool,
    /// The version the app's installer registered (None for a copy that wasn't installed).
    installed_version: Option<String>,
}

pub(super) fn def(id: &str) -> AppResult<&'static Def> {
    APPS.iter().find(|d| d.id == id).ok_or_else(|| AppError::Invalid("Unknown WIISB app.".into()))
}

pub(super) fn saved_paths(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(dir.join("other-apps.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_saved(dir: &Path, map: &BTreeMap<String, String>) -> AppResult<()> {
    std::fs::write(dir.join("other-apps.json"), serde_json::to_string_pretty(map).unwrap_or_default())?;
    Ok(())
}

#[cfg(windows)]
fn uninstall_value(root: windows_sys::Win32::System::Registry::HKEY, key_name: &str, value_name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let key: Vec<u16> = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{key_name}\0").encode_utf16().collect();
    let value: Vec<u16> = format!("{value_name}\0").encode_utf16().collect();
    let mut buf = vec![0u16; 32768];
    let mut bytes = (buf.len() * 2) as u32;
    let status = unsafe { RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut bytes) };
    if status != 0 {
        return None;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    // Some installers (WIISB Chat's) store the folder wrapped in quotes.
    let s = String::from_utf16_lossy(&buf[..end]).trim().trim_matches('"').to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(windows)]
fn install_location(root: windows_sys::Win32::System::Registry::HKEY, key_name: &str) -> Option<String> {
    uninstall_value(root, key_name, "InstallLocation")
}

/// The version the app's installer registered (`DisplayVersion`). Only an installed copy has one.
pub(super) fn installed_version(d: &Def) -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE].into_iter().find_map(|root| uninstall_value(root, d.uninstall_key, "DisplayVersion"))
    }
    #[cfg(not(windows))]
    {
        let _ = d;
        None
    }
}

/// Every place the program may be, best first.
fn candidates(d: &Def, saved: Option<&String>) -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(p) = saved {
        out.push((PathBuf::from(p), "chosen"));
    }
    #[cfg(windows)]
    for root in [windows_sys::Win32::System::Registry::HKEY_CURRENT_USER, windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE] {
        if let Some(folder) = install_location(root, d.uninstall_key) {
            out.push((PathBuf::from(folder).join(d.exe), "installed"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        out.push((local.join(d.install_folder).join(d.exe), "installed"));
        out.push((local.join("Programs").join(d.install_folder).join(d.exe), "installed"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            out.push((parent.join(d.install_folder).join(d.exe), "installed"));
        }
    }
    // The projects live side by side (…\Physical App Development\<project>), so the development builds are found too.
    if let Some(workspace) = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent) {
        for rel in d.project_builds {
            out.push((rel.iter().fold(workspace.to_path_buf(), |p, part| p.join(part)), "project"));
        }
    }
    out
}

fn find(d: &Def, saved: &BTreeMap<String, String>) -> Option<(PathBuf, &'static str)> {
    candidates(d, saved.get(d.id)).into_iter().find(|(p, _)| p.is_file() && is_pe_file(p))
}

/// Every place the app's setup program may be, best first: the launcher's own `apps` folder, then the project's release folder.
fn installer_candidates(d: &Def, resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(r) = resource_dir {
        out.push(r.join("apps").join(d.installer));
    }
    if let Some(parent) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        out.push(parent.join("apps").join(d.installer));
    }
    if let Some(workspace) = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent) {
        for rel in d.project_installers {
            out.push(rel.iter().fold(workspace.to_path_buf(), |p, part| p.join(part)));
        }
    }
    out
}

fn find_installer(d: &Def, resource_dir: Option<&Path>) -> Option<PathBuf> {
    installer_candidates(d, resource_dir).into_iter().find(|p| p.is_file() && is_pe_file(p))
}

fn installer_failure(name: &str, code: Option<i32>) -> String {
    match code {
        Some(1) => format!("The {name} setup was cancelled."),
        Some(c) => format!("The {name} setup stopped (code {c}). If {name} is open, close it and try again."),
        None => format!("The {name} setup was interrupted."),
    }
}

/// Runs the app's own setup program silently (it is per-user, so no administrator prompt) and waits for it to finish.
pub(super) fn run_installer(name: &str, installer: &Path) -> AppResult<()> {
    let mut command = std::process::Command::new(installer);
    command.arg("/S");
    if let Some(parent) = installer.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let status = command.status().map_err(|e| AppError::LaunchFailed(format!("The {name} setup could not start: {}", crate::error::friendly_io(&e))))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::LaunchFailed(installer_failure(name, status.code())))
    }
}

/// Clears the "an install is running" flag however the install ends.
pub(super) struct InstallGuard;
static INSTALLING: AtomicBool = AtomicBool::new(false);

impl InstallGuard {
    pub(super) fn acquire() -> Option<InstallGuard> {
        (!INSTALLING.swap(true, Ordering::SeqCst)).then_some(InstallGuard)
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub(super) fn running_exes() -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let Ok(mut sys) = System::new() else { return Vec::new() };
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).collect()
}

pub(super) fn describe(d: &'static Def, saved: &BTreeMap<String, String>, running: &[String], resource_dir: Option<&Path>) -> OtherApp {
    let found = find(d, saved);
    let icon = found
        .as_ref()
        .and_then(|(p, _)| crate::platform::icon::extract_icon_png(p, 128))
        .map(|png| format!("data:image/png;base64,{}", base64(&png)));
    OtherApp {
        id: d.id,
        name: d.name,
        tagline: d.tagline,
        installed: found.is_some(),
        path: found.as_ref().map(|(p, _)| crate::platform::sys::clean_path(p)),
        source: found.as_ref().map(|(_, s)| *s),
        running: running.iter().any(|n| n.eq_ignore_ascii_case(d.exe)),
        icon,
        can_install: find_installer(d, resource_dir).is_some(),
        installed_version: found.as_ref().filter(|(_, src)| *src == "installed").and_then(|_| installed_version(d)),
    }
}

pub(super) fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub fn other_apps(app: AppHandle, state: State<'_, AppState>) -> Vec<OtherApp> {
    let saved = saved_paths(&state.data_dir);
    let running = running_exes();
    let res = resource_dir(&app);
    APPS.iter().map(|d| describe(d, &saved, &running, res.as_deref())).collect()
}

/// Installs one of the WIISB apps from the setup program that ships inside the launcher.
#[tauri::command]
pub async fn install_other_app(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<OtherApp> {
    let d = def(&id)?;
    let res = resource_dir(&app);
    let installer = find_installer(d, res.as_deref())
        .ok_or_else(|| AppError::NotFound(format!("This copy of the launcher doesn't include the {} setup. Reinstall the launcher, or use “Locate…” if {} is already on this PC.", d.name, d.name)))?;
    let guard = InstallGuard::acquire().ok_or_else(|| AppError::AlreadyRunning("Another WIISB app is being installed right now. Wait for it to finish.".into()))?;
    let name = d.name;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_installer(name, &installer)
    })
    .await
    .map_err(|e| AppError::LaunchFailed(format!("The {name} setup could not be run: {e}")))?;
    outcome?;

    // A program picked by hand would otherwise win over the freshly installed one.
    let dir = state.data_dir.clone();
    let mut map = saved_paths(&dir);
    if map.remove(d.id).is_some() {
        write_saved(&dir, &map)?;
    }
    let info = describe(d, &map, &running_exes(), res.as_deref());
    if !info.installed {
        return Err(AppError::NotFound(format!("The {} setup finished, but {} wasn't found afterwards.", d.name, d.exe)));
    }
    Ok(info)
}

#[tauri::command]
pub fn launch_other_app(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let d = def(&id)?;
    let saved = saved_paths(&state.data_dir);
    let (path, _) = find(d, &saved).ok_or_else(|| {
        AppError::NotFound(format!("{} isn't installed on this PC yet. Run its installer, or use “Locate…” if it's somewhere else.", d.name))
    })?;
    let mut command = std::process::Command::new(&path);
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|e| AppError::LaunchFailed(format!("{} could not start: {}", d.name, crate::error::friendly_io(&e))))?;
    Ok(())
}

/// Show the program in Explorer (never runs anything).
#[tauri::command]
pub fn reveal_other_app(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let d = def(&id)?;
    let (path, _) = find(d, &saved_paths(&state.data_dir)).ok_or_else(|| AppError::NotFound(format!("{} wasn't found.", d.name)))?;
    std::process::Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn().map_err(|e| AppError::LaunchFailed(crate::error::friendly_io(&e)))?;
    Ok(())
}

/// Where the "Locate…" picker should open: the folder the app is in, or the folder it would normally be installed to.
#[tauri::command]
pub fn other_app_start_dir(state: State<'_, AppState>, id: String) -> AppResult<Option<String>> {
    let d = def(&id)?;
    let saved = saved_paths(&state.data_dir);
    let mut places: Vec<PathBuf> = candidates(d, saved.get(d.id)).into_iter().filter_map(|(p, _)| p.parent().map(Path::to_path_buf)).collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        places.push(local); // "WIISB Chat" isn't there yet: open where the per-user installers go
    }
    Ok(places.into_iter().find(|p| p.is_dir()).map(|p| p.to_string_lossy().into_owned()))
}

/// Remember a program you picked by hand. Only accepted if the file has exactly the expected name and is a real Windows program.
#[tauri::command]
pub fn locate_other_app(app: AppHandle, state: State<'_, AppState>, id: String, path: String) -> AppResult<OtherApp> {
    let d = def(&id)?;
    let p = PathBuf::from(path.trim().trim_matches('"'));
    let name_ok = p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(d.exe));
    if !name_ok {
        return Err(AppError::Invalid(format!("Choose the file called “{}”.", d.exe)));
    }
    if !p.is_file() || !is_pe_file(&p) {
        return Err(AppError::Invalid("That isn't a Windows program.".into()));
    }
    let mut map = saved_paths(&state.data_dir);
    map.insert(d.id.to_string(), crate::platform::sys::clean_path(&p));
    write_saved(&state.data_dir, &map)?;
    Ok(describe(d, &map, &running_exes(), resource_dir(&app).as_deref()))
}

#[tauri::command]
pub fn forget_other_app_path(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let d = def(&id)?;
    let mut map = saved_paths(&state.data_dir);
    map.remove(d.id);
    write_saved(&state.data_dir, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_list_is_fixed_and_unknown_ids_are_refused() {
        assert_eq!(APPS.iter().map(|d| d.id).collect::<Vec<_>>(), ["chat", "browser"]);
        assert!(def("chat").is_ok() && def("browser").is_ok());
        assert!(def("cmd").is_err() && def("../x").is_err());
    }

    #[test]
    fn a_chosen_path_is_searched_first_and_each_app_has_its_own_exe_name() {
        let d = def("browser").unwrap();
        let c = candidates(d, Some(&r"C:\Somewhere\WIISBROWSING.exe".to_string()));
        assert_eq!(c[0], (PathBuf::from(r"C:\Somewhere\WIISBROWSING.exe"), "chosen"));
        assert!(c.iter().all(|(p, _)| p.file_name().unwrap() == "WIISBROWSING.exe"));
        let chat = candidates(def("chat").unwrap(), None);
        assert!(chat.iter().all(|(p, _)| p.file_name().unwrap() == "WIISB Chat.exe"));
    }

    #[test]
    fn the_bundled_installer_is_searched_first_and_only_real_programs_count() {
        let dir = tempfile::tempdir().unwrap();
        let d = def("browser").unwrap();
        let c = installer_candidates(d, Some(dir.path()));
        assert_eq!(c[0], dir.path().join("apps").join("WIISBROWSING-setup.exe"));
        // A text file with the right name is not accepted as a setup program.
        std::fs::create_dir_all(dir.path().join("apps")).unwrap();
        std::fs::write(&c[0], "not a program").unwrap();
        assert_ne!(find_installer(d, Some(dir.path())), Some(c[0].clone()));
    }

    #[test]
    fn installer_failures_read_calmly() {
        assert_eq!(installer_failure("WIISB Chat", Some(1)), "The WIISB Chat setup was cancelled.");
        assert!(installer_failure("WIISBROWSING", Some(2)).contains("close it and try again"));
        assert!(installer_failure("WIISBROWSING", None).contains("interrupted"));
    }

    #[test]
    fn only_one_install_runs_at_a_time() {
        let first = InstallGuard::acquire().expect("first install may start");
        assert!(InstallGuard::acquire().is_none());
        drop(first);
        assert!(InstallGuard::acquire().is_some());
    }

    #[test]
    fn a_missing_setup_program_is_reported_not_run() {
        let err = run_installer("WIISB Chat", Path::new(r"C:\definitely\not\here\setup.exe")).unwrap_err();
        assert!(err.to_string().contains("could not start"));
    }

    #[test]
    fn saved_paths_round_trip_and_survive_garbage() {
        let dir = tempfile::tempdir().unwrap();
        assert!(saved_paths(dir.path()).is_empty());
        let mut m = BTreeMap::new();
        m.insert("chat".to_string(), r"D:\x\WIISB Chat.exe".to_string());
        write_saved(dir.path(), &m).unwrap();
        assert_eq!(saved_paths(dir.path()), m);
        std::fs::write(dir.path().join("other-apps.json"), "not json").unwrap();
        assert!(saved_paths(dir.path()).is_empty());
    }
}
