//! Validation of launch targets. Paths are untrusted input: we check what they are,
//! never run them.

use std::io::Read;
use std::path::Path;

use crate::platform::sys;

/// File-name fragments that mark an executable as *not* a game (installers, redistributables,
/// crash reporters, updaters…). Such files are never chosen automatically and are refused
/// when picked manually.
const NON_GAME_FRAGMENTS: &[&str] = &[
    "unins", "uninstall", "setup", "install", "redist", "vcredist", "dxsetup", "dxwebsetup", "crash", "prereq",
    "physx", "updater", "dotnet", "windowsdesktop", "webview2", "vc_redist", "report", "helper",
];

/// URI schemes of legitimate game platforms we are willing to hand to Windows.
const ALLOWED_SCHEMES: &[&str] =
    &["steam", "com.epicgames.launcher", "goggalaxy", "uplay", "origin2", "eadesktop", "battlenet"];

pub fn looks_like_non_game(file_stem: &str) -> bool {
    let s = file_stem.to_lowercase();
    NON_GAME_FRAGMENTS.iter().any(|f| s.contains(f))
}

#[derive(Debug, Clone)]
pub struct ExeInfo {
    pub size: u64,
    pub version: sys::VersionInfo,
}

/// True when the file starts with a valid DOS + PE header.
pub fn is_pe_file(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut head = [0u8; 64];
    if f.read_exact(&mut head).is_err() || &head[0..2] != b"MZ" {
        return false;
    }
    let e_lfanew = u32::from_le_bytes([head[60], head[61], head[62], head[63]]) as u64;
    if e_lfanew > 4096 {
        return false;
    }
    use std::io::{Seek, SeekFrom};
    let mut sig = [0u8; 4];
    f.seek(SeekFrom::Start(e_lfanew)).is_ok() && f.read_exact(&mut sig).is_ok() && &sig == b"PE\0\0"
}

/// Validate a direct-executable launch target. `Err` carries a user-facing explanation.
pub fn validate_exe(path: &Path) -> Result<ExeInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "That file no longer exists.".to_string(),
        _ => format!("That file could not be read ({}).", crate::error::friendly_io(&e)),
    })?;
    if !meta.is_file() {
        return Err("That path is not a file.".into());
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "exe" {
        return Err("Only .exe programs can be used as a direct launch target.".into());
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if looks_like_non_game(stem) {
        return Err(format!("\"{stem}.exe\" looks like an installer, updater, or support tool, not a game."));
    }
    if !is_pe_file(path) {
        return Err("That file is not a valid Windows program.".into());
    }
    Ok(ExeInfo { size: meta.len(), version: sys::read_version_info(path) })
}

pub fn validate_shortcut(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|_| "That shortcut no longer exists.".to_string())?;
    if !meta.is_file() {
        return Err("That path is not a file.".into());
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "lnk" {
        return Err("Only Windows shortcuts (.lnk) can be used with this launch method.".into());
    }
    Ok(())
}

/// A platform URI must use an allow-listed scheme and contain nothing a URL handler could misread.
pub fn validate_platform_uri(uri: &str) -> Result<(), String> {
    let uri = uri.trim();
    if uri.is_empty() || uri.len() > 512 {
        return Err("Enter a platform launch link such as steam://rungameid/<id>.".into());
    }
    // `&` is allowed: Epic launch links carry query parameters. The link is handed to Explorer as one
    // argument — it never passes through a shell — and whitespace (needed to chain commands) is refused.
    if uri.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '"' | '<' | '>' | '|' | '^')) {
        return Err("That launch link contains characters that are not allowed.".into());
    }
    if let Some(aumid) = uri.strip_prefix(r"shell:AppsFolder\") {
        return validate_app_id(aumid);
    }
    let Some((scheme, rest)) = uri.split_once("://") else {
        return Err("A platform launch link must look like scheme://…".into());
    };
    if !ALLOWED_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        return Err(format!("\"{scheme}://\" is not a supported platform. Supported: {}.", ALLOWED_SCHEMES.join(", ")));
    }
    if rest.is_empty() {
        return Err("The launch link is incomplete.".into());
    }
    Ok(())
}

/// An installed Microsoft Store / Xbox app, started the way the Start Menu does: `<package family>!<app id>`
/// (e.g. `Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft`). Nothing but that exact shape is accepted.
fn validate_app_id(aumid: &str) -> Result<(), String> {
    let part = |s: &str, ok: fn(char) -> bool| !s.is_empty() && s.len() <= 128 && s.chars().all(ok);
    let valid = aumid.split_once('!').is_some_and(|(family, app)| {
        family.split_once('_').is_some_and(|(name, publisher)| {
            part(name, |c| c.is_ascii_alphanumeric() || c == '.' || c == '-') && publisher.len() == 13 && publisher.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        }) && part(app, |c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    });
    if valid {
        Ok(())
    } else {
        Err("A Store app link must look like shell:AppsFolder\\<package>_<publisher>!<app>.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    pub fn write_fake_exe(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut data = vec![0u8; 256];
        data[0] = b'M';
        data[1] = b'Z';
        data[60] = 128; // e_lfanew
        data[128..132].copy_from_slice(b"PE\0\0");
        std::fs::File::create(path).unwrap().write_all(&data).unwrap();
    }

    #[test]
    fn accepts_real_looking_exe_with_spaces_in_path() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("My Games").join("Some Game").join("Game.exe");
        write_fake_exe(&p);
        assert!(validate_exe(&p).is_ok());
    }

    #[test]
    fn rejects_non_pe_and_wrong_extension_and_installers() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("Game.exe");
        std::fs::write(&fake, b"not an exe").unwrap();
        assert!(validate_exe(&fake).unwrap_err().contains("not a valid Windows program"));

        let txt = dir.path().join("Game.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(validate_exe(&txt).is_err());

        let setup = dir.path().join("vc_redist.x64.exe");
        write_fake_exe(&setup);
        assert!(validate_exe(&setup).unwrap_err().contains("installer"));

        let bat = dir.path().join("Run Me!.bat");
        std::fs::write(&bat, b"@echo off").unwrap();
        assert!(validate_exe(&bat).is_err());

        assert!(validate_exe(&dir.path().join("missing.exe")).is_err());
        assert!(validate_exe(dir.path()).is_err());
    }

    #[test]
    fn platform_uri_allow_list() {
        assert!(validate_platform_uri("steam://rungameid/12345").is_ok());
        assert!(validate_platform_uri("com.epicgames.launcher://apps/x?action=launch").is_ok());
        assert!(validate_platform_uri("http://example.com").is_err());
        assert!(validate_platform_uri("file:///C:/Windows/system32/calc.exe").is_err());
        assert!(validate_platform_uri("steam://run/1 & calc").is_err());
        assert!(validate_platform_uri("steam://").is_err());
        assert!(validate_platform_uri(r"shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft").is_ok());
        assert!(validate_platform_uri(r"shell:AppsFolder\..\..\Windows\System32\calc.exe").is_err());
        assert!(validate_platform_uri(r"shell:AppsFolder\Pkg_8wekyb3d8bbwe!App&calc").is_err());
        assert!(validate_platform_uri(r"shell:AppsFolder\NoPublisher!App").is_err());
        assert!(validate_platform_uri(r"shell:Startup").is_err());
        assert!(validate_platform_uri(r"shell:AppsFolder\").is_err());
        assert!(validate_platform_uri("").is_err());
    }

    #[test]
    fn shortcut_validation() {
        let dir = tempfile::tempdir().unwrap();
        let lnk = dir.path().join("Game.lnk");
        std::fs::write(&lnk, b"x").unwrap();
        assert!(validate_shortcut(&lnk).is_ok());
        assert!(validate_shortcut(&dir.path().join("none.lnk")).is_err());
        let exe = dir.path().join("a.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(validate_shortcut(&exe).is_err());
    }

    pub(crate) use write_fake_exe as fake_exe;
}

#[cfg(test)]
pub(crate) use tests::fake_exe;
