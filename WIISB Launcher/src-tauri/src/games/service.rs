//! Library operations shared by the IPC commands and the tray menu: validation, scanning,
//! linking, launch settings and artwork. Everything here takes a `&Db`, so it is unit-testable
//! without a running application.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::args::parse_args;
use super::catalog::{self, normalize, GameProfile, CATALOG};
use super::detect::{slugify, Detected, DetectedLaunch};
use super::discovery::{self, Candidate, RootError, ScanOutcome};
use super::validation::{validate_exe, validate_platform_uri, validate_shortcut};
use crate::database::models::{Game, LinkData};
use crate::database::{now, Db};
use crate::error::{AppError, AppResult};
use crate::platform::sys;
use crate::processes::launcher::{LaunchMethod, LaunchRequest};

pub const MAX_ARTWORK_BYTES: u64 = 30 * 1024 * 1024;

/// Search hints for any game: the catalogue entry for the four built-ins, otherwise derived from its title.
fn profile_of(db: &Db, slug: &str) -> AppResult<GameProfile> {
    let game = db.get_game(slug)?;
    Ok(catalog::profile_for(slug, &game.title))
}

pub fn root_error(e: RootError) -> AppError {
    match e {
        RootError::DriveUnavailable => AppError::DriveUnavailable,
        RootError::Missing => AppError::NotFound("The library folder doesn't exist. Pick another folder in Settings → Library.".into()),
        RootError::NotADirectory => AppError::Invalid("The library path is a file, not a folder.".into()),
        RootError::Io(m) => AppError::Io(format!("The library folder couldn't be read: {m}.")),
    }
}

// ----- validation ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct Validation {
    pub status: &'static str,
    pub message: Option<String>,
}

fn v(status: &'static str, message: impl Into<Option<String>>) -> Validation {
    Validation { status, message: message.into() }
}

/// Checks that the stored launch target is still usable. Never launches anything.
pub fn validate_installation(game: &Game) -> Validation {
    let Some(target) = game.launch_target.as_deref().filter(|t| !t.is_empty()) else {
        return v("not_linked", None);
    };
    let method = LaunchMethod::parse(&game.launch_method).unwrap_or(LaunchMethod::Direct);
    let missing = |p: &Path, what: &str| {
        if !sys::drive_available(p) {
            v("drive_unavailable", "Your game library drive could not be accessed.".to_string())
        } else {
            v("missing", format!("We couldn't find the {what} for this game."))
        }
    };
    match method {
        LaunchMethod::Direct => {
            let p = Path::new(target);
            if !p.exists() {
                return missing(p, "executable");
            }
            if let Err(m) = validate_exe(p) {
                return v("invalid", m);
            }
        }
        LaunchMethod::Shortcut => {
            let p = Path::new(target);
            if !p.exists() {
                return missing(p, "shortcut");
            }
            if let Err(m) = validate_shortcut(p) {
                return v("invalid", m);
            }
        }
        LaunchMethod::Platform => {
            if let Err(m) = validate_platform_uri(target) {
                return v("invalid", m);
            }
        }
    }
    if let Some(dir) = game.installation_path.as_deref().filter(|d| !d.is_empty()) {
        let p = Path::new(dir);
        if !p.is_dir() {
            return if !sys::drive_available(p) {
                v("drive_unavailable", "Your game library drive could not be accessed.".to_string())
            } else {
                v("missing", "The installation folder no longer exists.".to_string())
            };
        }
    }
    v("ok", None)
}

pub fn revalidate(db: &Db, slug: &str) -> AppResult<Game> {
    let game = db.get_game(slug)?;
    if game.launch_target.is_some() {
        let r = validate_installation(&game);
        db.set_validation(slug, r.status, r.message.as_deref())?;
    }
    db.get_game(slug)
}

pub fn revalidate_all(db: &Db) -> AppResult<Vec<Game>> {
    for g in db.list_games()? {
        if g.launch_target.is_some() {
            let r = validate_installation(&g);
            db.set_validation(&g.slug, r.status, r.message.as_deref())?;
        }
    }
    db.list_games()
}

/// Turns an error status from validation into the error the UI shows on a launch attempt.
pub fn launch_block_reason(game: &Game) -> Option<AppError> {
    match game.validation_status.as_str() {
        "ok" => None,
        "not_linked" => Some(AppError::NotFound("This game isn't linked yet. Use “Locate Installation” first.".into())),
        "drive_unavailable" => Some(AppError::DriveUnavailable),
        "missing" => Some(AppError::NotFound(
            game.validation_message.clone().unwrap_or_else(|| "We couldn't find the executable for this game.".into()),
        )),
        _ => Some(AppError::Invalid(game.validation_message.clone().unwrap_or_else(|| "The launch target is not valid.".into()))),
    }
}

// ----- scanning -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub slug: String,
    pub title: String,
    /// "linked" | "kept" | "ambiguous" | "not_found"
    pub outcome: &'static str,
    pub candidates: Vec<Candidate>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub root: String,
    pub scanned_at: i64,
    pub items: Vec<ScanItem>,
    /// Other games found (Steam, Epic, Roblox, extra folders…) and merged into the library.
    pub detected: Vec<DetectedItem>,
}

fn candidate_link(c: &Candidate, source: &'static str) -> LinkData {
    LinkData {
        installation_path: Some(c.install_dir.clone()),
        launch_target: c.exe_path.clone(),
        launch_method: "direct".into(),
        launch_args: String::new(),
        working_dir: None,
        source,
    }
}

/// Scan the library root and link confident matches.
/// * Manual links are kept unless `force` is set.
/// * `is_active` lets the caller protect games that are currently running.
pub fn run_scan(db: &Db, root: &Path, force: bool, is_active: &dyn Fn(&str) -> bool) -> AppResult<ScanReport> {
    let results = discovery::scan_library(root).map_err(root_error)?;
    let mut items = Vec::new();
    for (def, outcome) in results {
        let game = db.get_game(def.slug)?;
        let keep_existing = game.installed && !force && (game.link_source.as_deref() == Some("manual") || is_active(def.slug));
        let mut item = ScanItem { slug: def.slug.into(), title: def.title.into(), outcome: "not_found", candidates: vec![], message: None };
        if keep_existing || is_active(def.slug) {
            item.outcome = "kept";
            item.message = Some(if is_active(def.slug) { "Running — left untouched.".into() } else { "Your manual link was kept.".into() });
            items.push(item);
            continue;
        }
        match outcome {
            ScanOutcome::Found(c) => {
                db.link_game(def.slug, &candidate_link(&c, "auto"))?;
                item.outcome = "linked";
                item.candidates = vec![c];
            }
            ScanOutcome::Ambiguous(list) => {
                item.outcome = "ambiguous";
                item.message = Some("Several possible launch files were found. Pick the right one.".into());
                item.candidates = list;
            }
            ScanOutcome::NotFound => {
                // A previous link that is still valid on disk is not discarded just because it lies
                // outside the scanned folder — unless the user asked to re-detect everything.
                let still_valid = game.launch_target.is_some() && validate_installation(&game).status == "ok";
                if force || !still_valid {
                    if game.launch_target.is_some() {
                        db.unlink_game(def.slug)?;
                    }
                    item.message = Some("Not found in the library folder.".into());
                } else {
                    item.outcome = "kept";
                    item.message = Some("Existing link kept.".into());
                }
            }
        }
        items.push(item);
    }
    revalidate_all(db)?;
    Ok(ScanReport { root: root.display().to_string(), scanned_at: now(), items, detected: vec![] })
}

// ----- manual linking -------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResult {
    /// "linked" | "ambiguous"
    pub outcome: &'static str,
    pub game: Option<Game>,
    pub candidates: Vec<Candidate>,
}

fn manual_install_dir(def: &GameProfile, exe: &Path) -> PathBuf {
    // Walk a few levels up looking for the folder named after the game.
    let mut cur = exe.parent();
    for _ in 0..6 {
        let Some(dir) = cur else { break };
        if dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| def.is_title_folder(n)) {
            return dir.to_path_buf();
        }
        cur = dir.parent();
    }
    exe.parent().map(Path::to_path_buf).unwrap_or_else(|| exe.to_path_buf())
}

/// Link a game from something the user picked: a `.exe`, or a folder to search.
/// `install_dir` (when given with an exe) comes from a scan candidate.
pub fn link_from_path(db: &Db, slug: &str, picked: &str, install_dir: Option<&str>) -> AppResult<LinkResult> {
    let def = profile_of(db, slug)?;
    if picked.trim().is_empty() || picked.contains('\0') || picked.len() > 1024 {
        return Err(AppError::Invalid("That path is not valid.".into()));
    }
    let path = Path::new(picked);
    let meta = std::fs::metadata(path).map_err(|e| {
        if !sys::drive_available(path) {
            AppError::DriveUnavailable
        } else {
            AppError::NotFound(format!("That location could not be opened ({}).", crate::error::friendly_io(&e)))
        }
    })?;

    let linked = |data: LinkData| -> AppResult<LinkResult> {
        db.link_game(slug, &data)?;
        Ok(LinkResult { outcome: "linked", game: Some(db.get_game(slug)?), candidates: vec![] })
    };

    if meta.is_file() {
        validate_exe(path).map_err(AppError::Invalid)?;
        let install = match install_dir.filter(|d| !d.trim().is_empty()) {
            Some(d) if Path::new(d).is_dir() => PathBuf::from(d),
            Some(_) => return Err(AppError::Invalid("The installation folder doesn't exist.".into())),
            None => manual_install_dir(&def, path),
        };
        return linked(LinkData {
            installation_path: Some(sys::clean_path(&install)),
            launch_target: sys::clean_path(path),
            launch_method: "direct".into(),
            launch_args: db.get_game(slug)?.launch_args,
            working_dir: None,
            source: "manual",
        });
    }

    // A folder: look inside it for the launch executable.
    match discovery::scan_folder(&def, path) {
        ScanOutcome::Found(c) => linked(candidate_link(&c, "manual")),
        ScanOutcome::Ambiguous(list) => Ok(LinkResult { outcome: "ambiguous", game: None, candidates: list }),
        ScanOutcome::NotFound => Err(AppError::NotFound(
            "No game executable was found in that folder. Try selecting the game's .exe file directly.".into(),
        )),
    }
}

// ----- launch settings -------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSettingsInput {
    pub method: String,
    pub target: String,
    pub install_path: Option<String>,
    pub args: String,
    pub working_dir: Option<String>,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn save_launch_settings(db: &Db, slug: &str, input: LaunchSettingsInput) -> AppResult<Game> {
    db.get_game(slug)?;
    let method = LaunchMethod::parse(&input.method).ok_or_else(|| AppError::Invalid("Unknown launch method.".into()))?;
    let target = input.target.trim().trim_matches('"').to_string();
    if target.is_empty() || target.len() > 1024 || target.contains('\0') {
        return Err(AppError::Invalid("Enter a launch target.".into()));
    }
    parse_args(&input.args).map_err(AppError::Invalid)?;
    match method {
        LaunchMethod::Direct => {
            validate_exe(Path::new(&target)).map_err(AppError::Invalid)?;
        }
        LaunchMethod::Shortcut => validate_shortcut(Path::new(&target)).map_err(AppError::Invalid)?,
        LaunchMethod::Platform => validate_platform_uri(&target).map_err(AppError::Invalid)?,
    }
    let install = match non_empty(input.install_path) {
        Some(p) => {
            if !Path::new(&p).is_dir() {
                return Err(AppError::Invalid("The installation folder doesn't exist.".into()));
            }
            Some(p)
        }
        None if method == LaunchMethod::Direct => Path::new(&target).parent().map(sys::clean_path),
        None => None,
    };
    let working_dir = match non_empty(input.working_dir) {
        Some(p) if !Path::new(&p).is_dir() => return Err(AppError::Invalid("The working directory doesn't exist.".into())),
        other => other,
    };
    db.link_game(
        slug,
        &LinkData {
            installation_path: install,
            launch_target: target,
            launch_method: method.as_str().into(),
            launch_args: input.args.trim().to_string(),
            working_dir,
            source: "manual",
        },
    )?;
    db.get_game(slug)
}

/// Builds the native launch request from a stored game. Arguments are parsed into a list;
/// nothing is ever concatenated into a command line.
pub fn build_launch_request(game: &Game) -> AppResult<LaunchRequest> {
    let method = LaunchMethod::parse(&game.launch_method).ok_or_else(|| AppError::Invalid("Unknown launch method.".into()))?;
    let target = game.launch_target.clone().ok_or_else(|| AppError::NotFound("This game isn't linked yet.".into()))?;
    let args = if method == LaunchMethod::Direct { parse_args(&game.launch_args).map_err(AppError::Invalid)? } else { vec![] };
    let cwd = match (&game.working_dir, method) {
        (Some(w), _) if !w.is_empty() => Some(PathBuf::from(w)),
        (_, LaunchMethod::Direct) => Path::new(&target).parent().map(Path::to_path_buf),
        _ => None,
    };
    Ok(LaunchRequest { method, target, args, cwd })
}

// ----- artwork -------------------------------------------------------------------------------------

pub(crate) fn image_extension(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Copies a user-chosen image into the launcher's own data folder after checking it really is
/// a PNG/JPEG/WebP (by content, not just by name).
pub fn import_artwork(db: &Db, art_dir: &Path, slug: &str, source: &Path) -> AppResult<Game> {
    db.get_game(slug)?;
    let meta = std::fs::metadata(source).map_err(|_| AppError::NotFound("That image could not be found.".into()))?;
    if !meta.is_file() {
        return Err(AppError::Invalid("Choose an image file.".into()));
    }
    if meta.len() > MAX_ARTWORK_BYTES {
        return Err(AppError::Invalid("That image is larger than 30 MB.".into()));
    }
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err(AppError::Invalid("Supported image formats are PNG, JPG and WebP.".into()));
    }
    let mut head = [0u8; 16];
    let n = std::fs::File::open(source)?.read(&mut head)?;
    let real_ext = image_extension(&head[..n]).ok_or_else(|| AppError::Invalid("That file isn't a valid PNG, JPG or WebP image.".into()))?;

    std::fs::create_dir_all(art_dir)?;
    let dest = art_dir.join(format!("{slug}-{}.{real_ext}", now()));
    std::fs::copy(source, &dest)?;
    let previous = db.get_game(slug)?.artwork_path;
    db.set_artwork(slug, Some(&sys::clean_path(&dest)))?;
    remove_owned_artwork(art_dir, previous.as_deref());
    db.get_game(slug)
}

pub fn clear_artwork(db: &Db, art_dir: &Path, slug: &str) -> AppResult<Game> {
    let g = db.get_game(slug)?;
    db.set_artwork(slug, None)?;
    db.set_hero(slug, None)?;
    // "Reset" means "show the placeholder": don't quietly re-download a cover next start.
    db.set_art_attempted(slug, true)?;
    remove_owned_artwork(art_dir, g.artwork_path.as_deref());
    remove_owned_artwork(art_dir, g.hero_path.as_deref());
    db.get_game(slug)
}

/// Only ever deletes files that live inside the launcher's own artwork folder.
fn remove_owned_artwork(art_dir: &Path, path: Option<&str>) {
    if let Some(p) = path {
        let p = Path::new(p);
        if p.parent().is_some_and(|d| d == art_dir) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// If a stored artwork file has vanished, forget it so the UI shows the generated placeholder.
pub fn prune_missing_artwork(db: &Db, games: Vec<Game>) -> Vec<Game> {
    let mut changed = false;
    let gone = |p: &Option<String>| p.as_deref().is_some_and(|p| !Path::new(p).is_file());
    for g in &games {
        if gone(&g.artwork_path) {
            log::warn!("artwork for {} is missing on disk; falling back to placeholder", g.slug);
            let _ = db.set_artwork(&g.slug, None);
            changed = true;
        }
        if gone(&g.hero_path) {
            let _ = db.set_hero(&g.slug, None);
            changed = true;
        }
        if gone(&g.icon_path) {
            let _ = db.set_icon(&g.slug, None);
            changed = true;
        }
    }
    if changed {
        db.list_games().unwrap_or(games)
    } else {
        games
    }
}

// ----- detected & custom games -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedItem {
    pub slug: String,
    pub title: String,
    pub source: String,
    /// "added" | "linked" (a built-in game that wasn't found before) | "updated"
    pub outcome: &'static str,
}

fn link_data_for(d: &Detected) -> LinkData {
    let (method, target, args) = match &d.launch {
        DetectedLaunch::Exe { path, args } => ("direct", sys::clean_path(path), args.clone()),
        DetectedLaunch::Uri(u) => ("platform", u.clone(), String::new()),
        DetectedLaunch::Shortcut(p) => ("shortcut", sys::clean_path(p), String::new()),
    };
    LinkData {
        installation_path: d.install_dir.as_deref().map(sys::clean_path),
        launch_target: target,
        launch_method: method.into(),
        launch_args: args,
        working_dir: None,
        source: "auto",
    }
}

/// Merge detection results into the library. Rules:
/// * a detection that is one of the four built-in games links *that* game (if it isn't linked yet);
/// * games you linked by hand, hid, or that are running right now are never touched;
/// * a game already known by title or by its program is not added twice (earlier sources win).
pub fn apply_detected(db: &Db, found: &[Detected], is_active: &dyn Fn(&str) -> bool) -> AppResult<Vec<DetectedItem>> {
    let mut items = Vec::new();
    let all = db.list_all_games()?;
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let item = |slug: &str, d: &Detected, outcome| DetectedItem { slug: slug.into(), title: d.title.clone(), source: d.source.into(), outcome };
    for d in found {
        let title_n = normalize(&d.title);
        let slug = d.slug();
        let data = link_data_for(d);

        if let Some(def) = CATALOG.iter().find(|c| c.title_norm() == title_n) {
            let Some(g) = all.iter().find(|g| g.slug == def.slug) else { continue };
            if let Some(app) = d.steam_app_id {
                if g.steam_app_id.is_none() {
                    db.set_steam_app_id(def.slug, Some(app))?;
                }
            }
            if !g.installed && g.link_source.as_deref() != Some("manual") && !is_active(def.slug) {
                db.link_game(def.slug, &data)?;
                items.push(item(def.slug, d, "linked"));
            }
            continue;
        }

        if let Some(g) = all.iter().find(|g| g.slug == slug) {
            if g.hidden || g.link_source.as_deref() == Some("manual") || is_active(&g.slug) {
                continue;
            }
            let renamed = g.source == d.source && g.title != d.title;
            let changed = renamed || g.launch_target.as_deref() != Some(data.launch_target.as_str()) || g.installation_path != data.installation_path || !g.installed;
            if changed {
                if renamed {
                    // e.g. the Roblox entry becomes "Electricity" when Electricity is installed (and back).
                    db.set_title(&slug, &d.title)?;
                }
                db.link_game(&slug, &data)?;
                items.push(item(&slug, d, "updated"));
            }
            continue;
        }

        let same_program = |g: &Game| g.launch_target.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(&data.launch_target));
        if all.iter().any(|g| normalize(&g.title) == title_n || same_program(g)) || !claimed.insert(title_n) {
            continue;
        }
        db.insert_game(&slug, &d.title, d.source, Some(&d.external_id), d.steam_app_id)?;
        db.link_game(&slug, &data)?;
        items.push(item(&slug, d, "added"));
    }
    Ok(items)
}

/// Add a game by hand: a title and its executable.
pub fn add_custom_game(db: &Db, title: &str, exe: &str) -> AppResult<Game> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err(AppError::Invalid("Enter a game name (up to 80 characters).".into()));
    }
    let path = Path::new(exe.trim());
    validate_exe(path).map_err(AppError::Invalid)?;
    let all = db.list_all_games()?;
    let n = normalize(&title);
    if all.iter().any(|g| normalize(&g.title) == n) {
        return Err(AppError::Invalid(format!("\"{title}\" is already in your library.")));
    }
    let base = format!("custom-{}", slugify(&title));
    let mut slug = base.clone();
    let mut i = 2;
    while all.iter().any(|g| g.slug == slug) {
        slug = format!("{base}-{i}");
        i += 1;
    }
    db.insert_game(&slug, &title, "custom", None, None)?;
    let install = path.parent().map(sys::clean_path);
    db.link_game(
        &slug,
        &LinkData { installation_path: install, launch_target: sys::clean_path(path), launch_method: "direct".into(), launch_args: String::new(), working_dir: None, source: "manual" },
    )?;
    db.get_game(&slug)
}

/// Remove a game from the library view (it can be restored). The four built-in games stay.
pub fn set_hidden(db: &Db, slug: &str, hidden: bool) -> AppResult<()> {
    let g = db.get_game(slug)?;
    if g.source == "catalog" && hidden {
        return Err(AppError::Invalid("The built-in games can't be removed from the library.".into()));
    }
    db.set_hidden(slug, hidden)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::validation::fake_exe;

    fn no_active(_: &str) -> bool {
        false
    }

    #[test]
    fn first_run_scan_links_confident_matches_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Game Library");
        fake_exe(&root.join("UNDERTALE").join("Undertale").join("UNDERTALE.exe"));
        let db = Db::open_memory();
        let report = run_scan(&db, &root, false, &no_active).unwrap();
        let by = |s: &str| report.items.iter().find(|i| i.slug == s).unwrap();
        assert_eq!(by("undertale").outcome, "linked");
        assert_eq!(by("ultrakill").outcome, "not_found");
        let g = db.get_game("undertale").unwrap();
        assert!(g.installed && g.link_source.as_deref() == Some("auto"));
        assert!(!db.get_game("ultrakill").unwrap().installed, "never marked installed without a validated target");
    }

    #[test]
    fn missing_root_gives_clear_error_and_drive_error() {
        let db = Db::open_memory();
        let err = run_scan(&db, Path::new(r"C:\this\does\not\exist"), false, &no_active).unwrap_err();
        assert_eq!(err.code(), "not_found");
        let err = run_scan(&db, Path::new(r"Q:\nope"), false, &no_active);
        // Q: normally doesn't exist; either error is acceptable but it must be an error, not a crash.
        assert!(err.is_err());
    }

    #[test]
    fn manual_links_survive_rescan_unless_forced() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let elsewhere = dir.path().join("Somewhere Else With Spaces").join("ULTRAKILL.exe");
        fake_exe(&elsewhere);
        let db = Db::open_memory();
        let res = link_from_path(&db, "ultrakill", &elsewhere.display().to_string(), None).unwrap();
        assert_eq!(res.outcome, "linked");
        assert_eq!(db.get_game("ultrakill").unwrap().link_source.as_deref(), Some("manual"));

        let rep = run_scan(&db, &root, false, &no_active).unwrap();
        assert_eq!(rep.items.iter().find(|i| i.slug == "ultrakill").unwrap().outcome, "kept");
        assert!(db.get_game("ultrakill").unwrap().installed);

        run_scan(&db, &root, true, &no_active).unwrap();
        assert!(!db.get_game("ultrakill").unwrap().installed, "force re-detect drops links not found in the root");
    }

    #[test]
    fn running_games_are_never_relinked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        fake_exe(&root.join("DELTARUNE").join("DELTARUNE").join("DELTARUNE.exe"));
        let db = Db::open_memory();
        let rep = run_scan(&db, &root, true, &|s| s == "deltarune").unwrap();
        assert_eq!(rep.items.iter().find(|i| i.slug == "deltarune").unwrap().outcome, "kept");
        assert!(!db.get_game("deltarune").unwrap().installed);
    }

    #[test]
    fn manual_exe_selection_and_invalid_selection() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        let good = dir.path().join("My Games").join("Persona 3 Reload").join("P3R").join("Binaries").join("Win64").join("P3R.exe");
        fake_exe(&good);
        let r = link_from_path(&db, "persona-3-reload", &good.display().to_string(), None).unwrap();
        let g = r.game.unwrap();
        assert!(g.installation_path.unwrap().ends_with("Persona 3 Reload"));

        let bad = dir.path().join("notes.txt");
        std::fs::write(&bad, "hi").unwrap();
        assert_eq!(link_from_path(&db, "ultrakill", &bad.display().to_string(), None).unwrap_err().code(), "invalid");
        let fake = dir.path().join("fake.exe");
        std::fs::write(&fake, "MZ but not really").unwrap();
        assert_eq!(link_from_path(&db, "ultrakill", &fake.display().to_string(), None).unwrap_err().code(), "invalid");
        let setup = dir.path().join("setup.exe");
        fake_exe(&setup);
        assert_eq!(link_from_path(&db, "ultrakill", &setup.display().to_string(), None).unwrap_err().code(), "invalid");
        assert_eq!(link_from_path(&db, "ultrakill", r"C:\nope\nothing.exe", None).unwrap_err().code(), "not_found");
        assert!(link_from_path(&db, "not-a-game", &good.display().to_string(), None).is_err());
        assert!(!db.get_game("ultrakill").unwrap().installed, "failed selections must not link anything");
    }

    #[test]
    fn folder_selection_with_two_candidates_asks_for_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        let folder = dir.path().join("UNDERTALE");
        fake_exe(&folder.join("v1").join("UNDERTALE.exe"));
        fake_exe(&folder.join("v2").join("UNDERTALE.exe"));
        let r = link_from_path(&db, "undertale", &folder.display().to_string(), None).unwrap();
        assert_eq!(r.outcome, "ambiguous");
        assert_eq!(r.candidates.len(), 2);
        // The user picks one explicitly.
        let pick = &r.candidates[0];
        let r2 = link_from_path(&db, "undertale", &pick.exe_path, Some(&folder.display().to_string())).unwrap();
        assert_eq!(r2.outcome, "linked");
        assert!(db.get_game("undertale").unwrap().installed);
    }

    #[test]
    fn validation_reports_missing_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        let exe = dir.path().join("Game Folder").join("ULTRAKILL.exe");
        fake_exe(&exe);
        link_from_path(&db, "ultrakill", &exe.display().to_string(), None).unwrap();
        assert_eq!(revalidate(&db, "ultrakill").unwrap().validation_status, "ok");
        std::fs::remove_file(&exe).unwrap();
        let g = revalidate(&db, "ultrakill").unwrap();
        assert_eq!(g.validation_status, "missing");
        assert!(!g.installed);
        assert!(g.validation_message.unwrap().contains("couldn't find the executable"));
        assert_eq!(launch_block_reason(&db.get_game("ultrakill").unwrap()).unwrap().code(), "not_found");
        fake_exe(&exe);
        assert_eq!(revalidate(&db, "ultrakill").unwrap().validation_status, "ok");
    }

    #[test]
    fn launch_settings_are_validated_and_args_stay_separate() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        let exe = dir.path().join("Game Dir").join("DELTARUNE.exe");
        fake_exe(&exe);
        let input = |method: &str, target: &str, args: &str| LaunchSettingsInput {
            method: method.into(),
            target: target.into(),
            install_path: None,
            args: args.into(),
            working_dir: None,
        };
        let g = save_launch_settings(&db, "deltarune", input("direct", &exe.display().to_string(), "-windowed -w \"1 2\"")).unwrap();
        let req = build_launch_request(&g).unwrap();
        assert_eq!(req.args, vec!["-windowed", "-w", "1 2"]);
        assert_eq!(req.cwd.unwrap(), exe.parent().unwrap());

        assert!(save_launch_settings(&db, "deltarune", input("direct", &exe.display().to_string(), "\"oops")).is_err());
        assert!(save_launch_settings(&db, "deltarune", input("platform", "https://evil.example", "")).is_err());
        assert!(save_launch_settings(&db, "deltarune", input("cmd", "x", "")).is_err());
        let p = save_launch_settings(&db, "deltarune", input("platform", "steam://rungameid/1", "")).unwrap();
        assert_eq!(p.launch_method, "platform");
        assert!(build_launch_request(&p).unwrap().args.is_empty());
    }

    #[test]
    fn artwork_import_validates_content_and_survives_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let art = dir.path().join("artwork");
        let db = Db::open_memory();

        let png = dir.path().join("cover.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).unwrap();
        let g = import_artwork(&db, &art, "ultrakill", &png).unwrap();
        let stored = g.artwork_path.clone().unwrap();
        assert!(Path::new(&stored).is_file() && stored.contains("artwork"));

        let disguised = dir.path().join("evil.png");
        std::fs::write(&disguised, b"MZ this is not a png").unwrap();
        assert_eq!(import_artwork(&db, &art, "ultrakill", &disguised).unwrap_err().code(), "invalid");
        let gif = dir.path().join("a.gif");
        std::fs::write(&gif, b"GIF89a").unwrap();
        assert!(import_artwork(&db, &art, "ultrakill", &gif).is_err());
        assert!(import_artwork(&db, &art, "ultrakill", &dir.path().join("nope.png")).is_err());

        // Replacing removes the old managed copy.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let jpg = dir.path().join("b.jpg");
        std::fs::write(&jpg, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]).unwrap();
        let g2 = import_artwork(&db, &art, "ultrakill", &jpg).unwrap();
        assert!(!Path::new(&stored).exists());
        assert!(g2.artwork_path.unwrap().ends_with(".jpg"));

        // Missing file on disk -> forgotten gracefully.
        std::fs::remove_file(db.get_game("ultrakill").unwrap().artwork_path.unwrap()).unwrap();
        let games = prune_missing_artwork(&db, db.list_games().unwrap());
        assert!(games.iter().all(|g| g.artwork_path.is_none()));
        assert!(clear_artwork(&db, &art, "ultrakill").unwrap().artwork_path.is_none());
    }

    fn detected(source: &'static str, id: &str, title: &str, launch: DetectedLaunch, app: Option<i64>) -> Detected {
        Detected { source, external_id: id.into(), title: title.into(), install_dir: Some(PathBuf::from(r"C:\Games\X")), launch, steam_app_id: app, icon_exe: None, name_hints: vec![] }
    }

    #[test]
    fn detected_games_are_added_once_and_never_duplicated() {
        let db = Db::open_memory();
        let steam = detected("steam", "4000", "Garry's Mod", DetectedLaunch::Uri("steam://rungameid/4000".into()), Some(4000));
        let same_title_elsewhere = detected("library", "GMod", "Garry's Mod", DetectedLaunch::Exe { path: PathBuf::from(r"C:\Other\gmod.exe"), args: String::new() }, None);
        let items = apply_detected(&db, &[steam.clone(), same_title_elsewhere], &|_| false).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].outcome, items[0].source.as_str()), ("added", "steam"));
        let games = db.list_games().unwrap();
        assert_eq!(games.len(), 5, "four built-ins + one detected");
        let g = games.iter().find(|g| g.slug == "steam-4000").unwrap();
        assert_eq!((g.source.as_str(), g.launch_method.as_str(), g.steam_app_id), ("steam", "platform", Some(4000)));
        assert_eq!(g.launch_target.as_deref(), Some("steam://rungameid/4000"));

        // Running detection again changes nothing.
        assert!(apply_detected(&db, &[steam.clone()], &|_| false).unwrap().is_empty());
        assert_eq!(db.list_games().unwrap().len(), 5);

        // A hidden game stays hidden and is not re-added.
        set_hidden(&db, "steam-4000", true).unwrap();
        assert!(apply_detected(&db, &[steam.clone()], &|_| false).unwrap().is_empty());
        assert_eq!(db.list_games().unwrap().len(), 4);
        assert_eq!(db.list_hidden_games().unwrap().len(), 1);
        set_hidden(&db, "steam-4000", false).unwrap();
        assert_eq!(db.list_games().unwrap().len(), 5);
    }

    #[test]
    fn a_moved_game_is_updated_but_manual_links_and_running_games_are_left_alone() {
        let db = Db::open_memory();
        let v1 = detected("roblox", "player", "Roblox", DetectedLaunch::Exe { path: PathBuf::from(r"C:\Rv1\RobloxPlayerBeta.exe"), args: String::new() }, None);
        apply_detected(&db, &[v1], &|_| false).unwrap();
        let v2 = detected("roblox", "player", "Roblox", DetectedLaunch::Exe { path: PathBuf::from(r"C:\Rv2\RobloxPlayerBeta.exe"), args: String::new() }, None);
        let items = apply_detected(&db, &[v2.clone()], &|slug| slug == "roblox-player").unwrap();
        assert!(items.is_empty(), "running game untouched");
        let items = apply_detected(&db, &[v2.clone()], &|_| false).unwrap();
        assert_eq!(items[0].outcome, "updated");
        assert!(db.get_game("roblox-player").unwrap().launch_target.unwrap().contains("v2"));

        db.link_game("roblox-player", &LinkData { installation_path: None, launch_target: r"C:\Mine.exe".into(), launch_method: "direct".into(), launch_args: String::new(), working_dir: None, source: "manual" }).unwrap();
        let v3 = detected("roblox", "player", "Roblox", DetectedLaunch::Exe { path: PathBuf::from(r"C:\Rv3\RobloxPlayerBeta.exe"), args: String::new() }, None);
        assert!(apply_detected(&db, &[v3], &|_| false).unwrap().is_empty());
        assert_eq!(db.get_game("roblox-player").unwrap().launch_target.as_deref(), Some(r"C:\Mine.exe"));
    }

    #[test]
    fn steam_copy_of_a_builtin_game_links_it_and_records_the_app_id_for_covers() {
        let db = Db::open_memory();
        let d = detected("steam", "391540", "UNDERTALE", DetectedLaunch::Uri("steam://rungameid/391540".into()), Some(391540));
        let items = apply_detected(&db, &[d.clone()], &|_| false).unwrap();
        assert_eq!((items[0].slug.as_str(), items[0].outcome), ("undertale", "linked"));
        let g = db.get_game("undertale").unwrap();
        assert_eq!((g.launch_method.as_str(), g.steam_app_id), ("platform", Some(391540)));
        assert_eq!(db.list_games().unwrap().len(), 4, "no duplicate UNDERTALE");

        // Already linked by hand -> untouched, but the app id is still remembered.
        let db2 = Db::open_memory();
        let exe = tempfile::tempdir().unwrap();
        let p = exe.path().join("UNDERTALE.exe");
        fake_exe(&p);
        link_from_path(&db2, "undertale", &p.display().to_string(), None).unwrap();
        assert!(apply_detected(&db2, &[d], &|_| false).unwrap().is_empty());
        let g2 = db2.get_game("undertale").unwrap();
        assert_eq!((g2.launch_method.as_str(), g2.steam_app_id), ("direct", Some(391540)));
    }

    #[test]
    fn custom_games_can_be_added_and_removed_but_builtins_stay() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        let exe = dir.path().join("My Folder").join("cool.exe");
        fake_exe(&exe);
        let g = add_custom_game(&db, "  Cool   Game ", &exe.display().to_string()).unwrap();
        assert_eq!((g.title.as_str(), g.source.as_str(), g.slug.as_str()), ("Cool Game", "custom", "custom-cool-game"));
        assert!(g.installed && g.link_source.as_deref() == Some("manual"));
        assert!(add_custom_game(&db, "cool game", &exe.display().to_string()).is_err(), "duplicate title");
        assert!(add_custom_game(&db, "UNDERTALE", &exe.display().to_string()).is_err(), "built-in title");
        assert!(add_custom_game(&db, "", &exe.display().to_string()).is_err());
        let bad = dir.path().join("setup.exe");
        fake_exe(&bad);
        assert!(add_custom_game(&db, "Other", &bad.display().to_string()).is_err(), "installer refused");
        assert!(set_hidden(&db, "undertale", true).is_err());
        set_hidden(&db, &g.slug, true).unwrap();
        assert_eq!(db.list_games().unwrap().len(), 4);
    }

    #[test]
    fn the_roblox_entry_launches_electricity_when_installed_and_reverts_when_not() {
        let db = Db::open_memory();
        let roblox = detected("roblox", "player", "Roblox", DetectedLaunch::Exe { path: PathBuf::from(r"C:\R\v1\RobloxPlayerBeta.exe"), args: String::new() }, None);
        apply_detected(&db, &[roblox.clone()], &|_| false).unwrap();
        assert_eq!(db.get_game("roblox-player").unwrap().title, "Roblox");

        // Electricity gets installed: the same entry now launches Electricity.
        let electricity = detected("roblox", "player", "Electricity", DetectedLaunch::Exe { path: PathBuf::from(r"C:\E\Electricity.exe"), args: String::new() }, None);
        let items = apply_detected(&db, &[electricity], &|_| false).unwrap();
        assert_eq!(items[0].outcome, "updated");
        let g = db.get_game("roblox-player").unwrap();
        assert_eq!(g.title, "Electricity");
        assert!(g.launch_target.unwrap().ends_with("Electricity.exe"));
        assert_eq!(db.list_games().unwrap().len(), 5, "still one entry, not two");

        // Electricity is uninstalled: back to the normal Roblox player.
        apply_detected(&db, &[roblox], &|_| false).unwrap();
        let g = db.get_game("roblox-player").unwrap();
        assert_eq!(g.title, "Roblox");
        assert!(g.launch_target.unwrap().ends_with("RobloxPlayerBeta.exe"));
    }
}
