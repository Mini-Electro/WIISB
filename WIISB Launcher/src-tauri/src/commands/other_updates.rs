//! Updating the other WIISB apps (WIISB Chat, WIISBROWSING) from the launcher.
//!
//! Each app publishes its newest installer and a `latest.json` in its own GitHub release (see UPDATES.md). The launcher
//! reads that manifest, and if it is newer than the installed copy it downloads the installer, checks the signature
//! with the same public keys the apps themselves carry, and runs it silently. An installer that isn't signed by WIISB
//! is never run. The release repository is the one compiled into this launcher (`WIISB_UPDATE_REPO`); a build without
//! it, such as a development build, can't look for updates.

use std::io::Write;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, State};

use super::others::{def, describe, installed_version, resource_dir, run_installer, running_exes, saved_paths, Def, InstallGuard, OtherApp};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const REPO_SPEC: Option<&str> = option_env!("WIISB_UPDATE_REPO");
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_INSTALLER: u64 = 400 * 1024 * 1024;

/// The public half of the Tauri release key (WIISB Chat and this launcher share it).
const TAURI_CONF: &str = include_str!("../../tauri.conf.json");
/// The public half of WIISBROWSING's release key (ECDSA P-256, SubjectPublicKeyInfo, base64).
const BROWSER_PUBLIC_KEY: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEE6wPiFSBCawWAfh6Wimg2oMgVDRzGAInrwXWwBkc0OVvI2zlFGCnlb/a5Q25L4tl0PQKektVaUAOhVa4/aaP3g==";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Scheme {
    /// Tauri's own format: `platforms.windows-x86_64.{url,signature}`, minisign signatures.
    Minisign,
    /// WIISBROWSING's format: `{url, signature}`, ECDSA P-256 over the installer.
    Ecdsa,
}

fn scheme(id: &str) -> (&'static str, Scheme) {
    match id {
        "browser" => ("browser-latest", Scheme::Ecdsa),
        _ => ("chat-latest", Scheme::Minisign),
    }
}

/// "owner/repo" from the compiled-in `owner/repo@tag`, only if it is made of plain characters.
fn repo() -> Option<String> {
    let spec = REPO_SPEC?.trim();
    let repo = spec.split_once('@').map_or(spec, |(r, _)| r);
    let plain = |p: &str| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (repo.split('/').count() == 2 && repo.split('/').all(plain)).then(|| repo.to_string())
}

/// `1.2.3` -> (1,2,3); anything after a `-` or `+` is ignored.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut it = core.split('.');
    let n = |s: Option<&str>| s.map_or(Some(0), |s| s.parse::<u64>().ok());
    let (a, b, c) = (n(it.next())?, n(it.next())?, n(it.next())?);
    it.next().is_none().then_some((a, b, c))
}

pub fn is_newer(candidate: &str, installed: &str) -> bool {
    matches!((parse_version(candidate), parse_version(installed)), (Some(c), Some(i)) if c > i)
}

#[derive(Debug, PartialEq)]
struct Offer {
    version: String,
    url: String,
    signature: String,
    notes: String,
}

/// Reads a manifest and checks that its installer lives in this repository's own releases.
fn parse_manifest(json: &str, scheme: Scheme, repo: &str, tag: &str) -> Result<Offer, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "The update information isn't valid.".to_string())?;
    let s = |x: &serde_json::Value| x.as_str().map(str::to_string);
    let (url, signature) = match scheme {
        Scheme::Minisign => {
            let p = &v["platforms"]["windows-x86_64"];
            (s(&p["url"]), s(&p["signature"]))
        }
        Scheme::Ecdsa => (s(&v["url"]), s(&v["signature"])),
    };
    let (version, url, signature) = (s(&v["version"]), url, signature);
    let (Some(version), Some(url), Some(signature)) = (version, url, signature) else { return Err("The update information is incomplete.".into()) };
    let prefix = format!("https://github.com/{repo}/releases/download/{tag}/");
    if !url.starts_with(&prefix) || url.contains("..") || !url.to_ascii_lowercase().ends_with(".exe") || parse_version(&version).is_none() {
        return Err("The update information points somewhere unexpected, so it was ignored.".into());
    }
    Ok(Offer { version, url, signature, notes: s(&v["notes"]).unwrap_or_default() })
}

fn verify(scheme: Scheme, data: &[u8], signature: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    match scheme {
        Scheme::Minisign => {
            let conf: serde_json::Value = match serde_json::from_str(TAURI_CONF) {
                Ok(c) => c,
                Err(_) => return false,
            };
            let Some(pubkey_b64) = conf["plugins"]["updater"]["pubkey"].as_str() else { return false };
            let (Ok(key_text), Ok(sig_text)) = (b64.decode(pubkey_b64), b64.decode(signature.trim())) else { return false };
            let (Ok(key_text), Ok(sig_text)) = (String::from_utf8(key_text), String::from_utf8(sig_text)) else { return false };
            let (Ok(key), Ok(sig)) = (minisign_verify::PublicKey::decode(&key_text), minisign_verify::Signature::decode(&sig_text)) else { return false };
            key.verify(data, &sig, false).is_ok()
        }
        Scheme::Ecdsa => {
            use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
            use p256::pkcs8::DecodePublicKey;
            let (Ok(spki), Ok(sig)) = (b64.decode(BROWSER_PUBLIC_KEY), b64.decode(signature.trim())) else { return false };
            let (Ok(key), Ok(sig)) = (VerifyingKey::from_public_key_der(&spki), Signature::from_slice(&sig)) else { return false };
            key.verify(data, &sig).is_ok()
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent("WIISB-Launcher-updater")
        .build()
        .into()
}

fn get(url: &str, max: u64) -> Result<Vec<u8>, String> {
    let mut resp = agent().get(url).call().map_err(|e| e.to_string())?;
    resp.body_mut().with_config().limit(max).read_to_vec().map_err(|e| e.to_string())
}

fn latest(d: &Def, repo: &str) -> Result<Offer, String> {
    let (tag, scheme) = scheme(d.id);
    let url = format!("https://github.com/{repo}/releases/download/{tag}/latest.json");
    let body = get(&url, MAX_MANIFEST).map_err(|_| "Couldn't reach GitHub. Check your internet connection.".to_string())?;
    parse_manifest(&String::from_utf8_lossy(&body), scheme, repo, tag)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherUpdate {
    id: &'static str,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    notes: Option<String>,
    /// Why nothing is offered (no internet, not installed…); None when the answer is simply "up to date" or "update".
    message: Option<String>,
}

fn check_one(d: &'static Def, repo: Option<&str>) -> OtherUpdate {
    let installed = installed_version(d);
    let mut out = OtherUpdate { id: d.id, installed_version: installed.clone(), latest_version: None, update_available: false, notes: None, message: None };
    let Some(repo) = repo else {
        out.message = Some("This copy of the launcher has no update source built in.".into());
        return out;
    };
    match latest(d, repo) {
        Ok(offer) => {
            out.update_available = installed.as_deref().is_some_and(|i| is_newer(&offer.version, i));
            out.latest_version = Some(offer.version);
            out.notes = Some(offer.notes).filter(|n| !n.is_empty());
        }
        Err(e) => out.message = Some(e),
    }
    out
}

/// Looks at GitHub for newer versions of the installed WIISB apps.
#[tauri::command]
pub async fn check_other_updates() -> Vec<OtherUpdate> {
    tauri::async_runtime::spawn_blocking(|| {
        let repo = repo();
        super::others::APPS.iter().map(|d| check_one(d, repo.as_deref())).collect()
    })
    .await
    .unwrap_or_default()
}

fn temp_installer(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join("WIISB-launcher-updates").join(name)
}

/// Downloads the newest installer of one app, checks that WIISB signed it, runs it silently and reports the result.
#[tauri::command]
pub async fn update_other_app(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<OtherApp> {
    let d = def(&id)?;
    let name = d.name;
    let repo = repo().ok_or_else(|| AppError::Invalid("This copy of the launcher has no update source built in.".into()))?;
    if running_exes().iter().any(|n| n.eq_ignore_ascii_case(d.exe)) {
        return Err(AppError::AlreadyRunning(format!("{name} is open. Close it, then press Update again.")));
    }
    let guard = InstallGuard::acquire().ok_or_else(|| AppError::AlreadyRunning("Another WIISB app is being installed right now. Wait for it to finish.".into()))?;
    let installed = installed_version(d);
    let (_, scheme) = scheme(d.id);
    let result = tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let _guard = guard;
        let offer = latest(d, &repo).map_err(AppError::NotFound)?;
        if installed.as_deref().is_some_and(|i| !is_newer(&offer.version, i)) {
            return Err(AppError::Invalid(format!("{name} is already up to date.")));
        }
        let bytes = get(&offer.url, MAX_INSTALLER).map_err(|e| AppError::LaunchFailed(format!("Couldn't download the {name} update: {e}")))?;
        if !verify(scheme, &bytes, &offer.signature) {
            log::warn!("update for {name} {} failed its signature check; not run", offer.version);
            return Err(AppError::Invalid(format!("The {name} update isn't signed by WIISB, so it was not installed.")));
        }
        let file_name = offer.url.rsplit('/').next().unwrap_or("setup.exe").to_string();
        let path = temp_installer(&file_name);
        std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")))?;
        std::fs::File::create(&path)?.write_all(&bytes)?;
        let outcome = run_installer(name, &path);
        let _ = std::fs::remove_file(&path);
        outcome
    })
    .await
    .map_err(|e| AppError::LaunchFailed(format!("The {name} update could not be run: {e}")))?;
    result?;
    let saved = saved_paths(&state.data_dir);
    Ok(describe(d, &saved, &running_exes(), resource_dir(&app).as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.1.2", "0.1.1"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.1", "0.1.1"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert!(!is_newer("garbage", "0.1.1"));
        assert!(!is_newer("0.1.2", "garbage"));
    }

    #[test]
    fn manifests_must_point_into_the_apps_own_release() {
        let repo = "Mini-Electro/WIISB";
        let ok = r#"{"version":"0.1.2","notes":"n","platforms":{"windows-x86_64":{"signature":"c2ln","url":"https://github.com/Mini-Electro/WIISB/releases/download/chat-latest/WIISB-Chat_0.1.2_x64-setup.exe"}}}"#;
        assert_eq!(parse_manifest(ok, Scheme::Minisign, repo, "chat-latest").unwrap().version, "0.1.2");
        for bad in [
            ok.replace("Mini-Electro/WIISB", "evil/repo"),
            ok.replace("chat-latest/", "browser-latest/"),
            ok.replace("setup.exe", "setup.zip"),
            ok.replace("releases/download", "releases/../download"),
            ok.replace("\"0.1.2\"", "\"x\""),
            "{}".to_string(),
            "not json".to_string(),
        ] {
            assert!(parse_manifest(&bad, Scheme::Minisign, repo, "chat-latest").is_err(), "{bad}");
        }
        let browser = r#"{"version":"0.1.2","url":"https://github.com/Mini-Electro/WIISB/releases/download/browser-latest/WIISBROWSING_0.1.2_x64-setup.exe","signature":"c2ln"}"#;
        assert!(parse_manifest(browser, Scheme::Ecdsa, repo, "browser-latest").is_ok());
        assert!(parse_manifest(browser, Scheme::Minisign, repo, "browser-latest").is_err());
    }

    #[test]
    fn garbage_signatures_are_refused() {
        for s in [Scheme::Minisign, Scheme::Ecdsa] {
            assert!(!verify(s, b"installer bytes", ""));
            assert!(!verify(s, b"installer bytes", "c2lnbmF0dXJl"));
        }
    }

    /// Against the real published releases (needs internet): the real signatures must verify, a flipped byte must not.
    #[test]
    #[ignore]
    fn real_releases_verify() {
        for (id, tag) in [("chat", "chat-latest"), ("browser", "browser-latest")] {
            let d = def(id).unwrap();
            let (_, sch) = scheme(id);
            let offer = latest(d, "Mini-Electro/WIISB").unwrap();
            assert_eq!(offer.url.contains(tag), true);
            let mut bytes = get(&offer.url, MAX_INSTALLER).unwrap();
            assert!(verify(sch, &bytes, &offer.signature), "{id} genuine release must verify");
            bytes[1000] ^= 0xFF;
            assert!(!verify(sch, &bytes, &offer.signature), "{id} tampered release must be refused");
        }
    }
}
