//! Read-only discovery of the four supported games inside the configured library root.
//!
//! Guarantees:
//! * nothing is executed, written, renamed or deleted;
//! * only the configured root is searched (symlinks / junctions are never followed);
//! * traversal is bounded by depth and by a total entry budget.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::catalog::{normalize, GameDef, GameProfile, CATALOG};
use super::validation::{is_pe_file, looks_like_non_game};
use crate::platform::sys::{self, VersionInfo};

pub const MAX_DEPTH: usize = 6;
pub const MAX_ENTRIES_PER_GAME: usize = 60_000;
/// Best candidate at or above this score is accepted without asking.
pub const ACCEPT_SCORE: i32 = 40;
/// Candidates below this score are not even offered to the user.
pub const LIST_SCORE: i32 = 15;
/// The winner must beat the runner-up by at least this much to be accepted automatically.
pub const AMBIGUITY_MARGIN: i32 = 15;
const MAX_LISTED: usize = 8;

/// Folders that never contain a game's launch target; skipping them keeps scans fast.
const PRUNE_DIRS: &[&str] = &[
    "redist", "commonredist", "directx", "vcredist", "engine", "content", "paks", "movies", "streamingassets",
    "mono", "monobleedingedge", "d3d12", "artbook", "soundtrack", "saves", "logs", "crashes", "recyclebin",
    "systemvolumeinformation", "tools", "support", "prerequisites", "prereq", "dotnet",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub exe_path: String,
    pub install_dir: String,
    pub score: i32,
    pub reasons: Vec<String>,
    pub size: u64,
    pub product_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScanOutcome {
    /// One confident match.
    Found(Candidate),
    /// Several plausible executables — the user must choose.
    Ambiguous(Vec<Candidate>),
    NotFound,
}

#[derive(Debug, PartialEq)]
pub enum RootError {
    /// The drive itself is not reachable (unplugged / not mounted).
    DriveUnavailable,
    Missing,
    NotADirectory,
    Io(String),
}

pub fn check_root(root: &Path) -> Result<(), RootError> {
    match fs::metadata(root) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(RootError::NotADirectory),
        Err(e) => {
            if !sys::drive_available(root) {
                Err(RootError::DriveUnavailable)
            } else if e.kind() == std::io::ErrorKind::NotFound {
                Err(RootError::Missing)
            } else {
                Err(RootError::Io(crate::error::friendly_io(&e)))
            }
        }
    }
}

fn should_prune(dir_name: &str, allow_content: bool) -> bool {
    // Unity ships `<Game>_Data` folders full of assets; they never hold a launch target.
    let n = normalize(dir_name);
    // Unreal games keep their launch file in `Content`/`Engine` only for a few titles; the catalogue scan
    // skips them for speed, while manual and generic detection look inside.
    if allow_content && matches!(n.as_str(), "content" | "engine") {
        return false;
    }
    dir_name.to_lowercase().ends_with("_data") || PRUNE_DIRS.contains(&n.as_str())
}

/// Bounded, symlink-safe walk collecting `.exe` files with the directory names between
/// `base` and the file.
pub(crate) fn collect_exes(base: &Path, max_depth: usize, budget: &mut usize, allow_content: bool) -> Vec<(PathBuf, Vec<String>)> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(base.to_path_buf(), Vec::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if *budget == 0 {
                return out;
            }
            *budget -= 1;
            let Ok(meta) = entry.metadata() else { continue };
            if sys::is_reparse_point(&meta) {
                continue; // never follow symlinks or junctions
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if meta.is_dir() {
                if rel.len() < max_depth && !should_prune(&name, allow_content) {
                    let mut next = rel.clone();
                    next.push(name);
                    stack.push((entry.path(), next));
                }
            } else if meta.is_file() {
                let is_exe = entry.path().extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe"));
                if is_exe {
                    out.push((entry.path(), rel.clone()));
                }
            }
        }
    }
    out
}

/// Pure scoring: how likely is this executable to be the game's launch target?
/// `rel_dirs` are the folder names between the game's top folder and the file.
pub fn score_exe(def: &GameProfile, rel_dirs: &[String], file_stem: &str, version: &VersionInfo) -> Option<(i32, Vec<String>)> {
    if looks_like_non_game(file_stem) {
        return None;
    }
    let mut score = 0i32;
    let mut reasons = Vec::new();
    let stem = normalize(file_stem);

    if def.exe_hints.iter().any(|h| *h == stem) {
        score += 60;
        reasons.push("File name matches the game".to_string());
    } else if def.exe_hints.iter().any(|h| h.len() >= 4 && (stem.contains(h.as_str()) || (stem.len() >= 4 && h.contains(stem.as_str())))) {
        score += 25;
        reasons.push("File name resembles the game".to_string());
    }

    let blob = normalize(&format!(
        "{} {}",
        version.product_name.as_deref().unwrap_or(""),
        version.file_description.as_deref().unwrap_or("")
    ));
    if !blob.is_empty() {
        if def.exe_hints.iter().any(|h| blob.contains(h.as_str())) || blob.contains(&def.title_norm()) {
            score += 20;
            reasons.push("Executable metadata names the game".to_string());
        }
        if ["setup", "installer", "redistributable", "crashreport", "updater"].iter().any(|w| blob.contains(w)) {
            score -= 60;
            reasons.push("Metadata suggests a support tool".to_string());
        }
    }

    if rel_dirs.iter().any(|d| def.is_title_folder(d)) {
        score += 25;
        reasons.push("Located inside a folder named after the game".to_string());
    }
    if rel_dirs.iter().any(|d| PRUNE_DIRS.contains(&normalize(d).as_str())) {
        score -= 80;
        reasons.push("Located inside a support/redistributable folder".to_string());
    }
    score -= 2 * rel_dirs.len() as i32;
    Some((score, reasons))
}

/// The folder that should be treated as the installation: the deepest ancestor of the
/// executable (within `top`) named after the game, otherwise the executable's own folder.
pub fn derive_install_dir(def: &GameProfile, exe: &Path, top: &Path) -> PathBuf {
    let mut cur = exe.parent();
    while let Some(dir) = cur {
        if !dir.starts_with(top) {
            break;
        }
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if def.is_title_folder(name) {
                return dir.to_path_buf();
            }
        }
        if dir == top {
            break;
        }
        cur = dir.parent();
    }
    exe.parent().unwrap_or(top).to_path_buf()
}

fn build_candidates(def: &GameProfile, top: &Path, install_override: Option<&Path>, budget: &mut usize, allow_content: bool) -> Vec<Candidate> {
    let mut found = Vec::new();
    for (exe, rel) in collect_exes(top, MAX_DEPTH, budget, allow_content) {
        let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if looks_like_non_game(&stem) {
            continue;
        }
        let version = sys::read_version_info(&exe);
        let Some((score, reasons)) = score_exe(def, &rel, &stem, &version) else { continue };
        if score < LIST_SCORE {
            continue;
        }
        if !is_pe_file(&exe) {
            continue; // looks like an exe by name only
        }
        let size = fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
        let install = install_override.map(Path::to_path_buf).unwrap_or_else(|| derive_install_dir(def, &exe, top));
        found.push(Candidate {
            exe_path: sys::clean_path(&exe),
            install_dir: sys::clean_path(&install),
            score,
            reasons,
            size,
            product_name: version.product_name,
        });
    }
    found
}

/// Rank candidates and decide whether one is a confident pick.
pub fn decide(mut cands: Vec<Candidate>, accept_min: i32) -> ScanOutcome {
    cands.sort_by(|a, b| b.score.cmp(&a.score).then(b.size.cmp(&a.size)));
    cands.dedup_by(|a, b| a.exe_path.eq_ignore_ascii_case(&b.exe_path));
    match cands.len() {
        0 => ScanOutcome::NotFound,
        1 if cands[0].score >= accept_min => ScanOutcome::Found(cands.remove(0)),
        _ if cands[0].score >= accept_min && cands[0].score - cands[1].score >= AMBIGUITY_MARGIN => {
            ScanOutcome::Found(cands.remove(0))
        }
        _ => {
            cands.truncate(MAX_LISTED);
            ScanOutcome::Ambiguous(cands)
        }
    }
}

/// Scan the library root for all four games. Only immediate child folders are considered as
/// game folders; deeper levels are searched (bounded) for the executable.
pub fn scan_library(root: &Path) -> Result<Vec<(&'static GameDef, ScanOutcome)>, RootError> {
    check_root(root)?;
    let mut children: Vec<(String, PathBuf)> = Vec::new();
    let rd = fs::read_dir(root).map_err(|e| RootError::Io(crate::error::friendly_io(&e)))?;
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() && !sys::is_reparse_point(&meta) {
            children.push((entry.file_name().to_string_lossy().to_string(), entry.path()));
        }
    }

    let mut results = Vec::new();
    for def in CATALOG.iter() {
        let mut budget = MAX_ENTRIES_PER_GAME;
        let mut cands = Vec::new();
        for (name, path) in children.iter().filter(|(n, _)| def.folder_matches(n)) {
            log::debug!("scan: candidate folder for {} -> {}", def.slug, name);
            cands.extend(build_candidates(&def.profile(), path, None, &mut budget, false));
        }
        results.push((def, decide(cands, ACCEPT_SCORE)));
    }
    Ok(results)
}

/// Examine a folder the user picked manually. The chosen folder is recorded as the
/// installation directory; we only look for the executable inside it.
pub fn scan_folder(def: &GameProfile, folder: &Path) -> ScanOutcome {
    let mut budget = MAX_ENTRIES_PER_GAME;
    let cands = build_candidates(def, folder, Some(folder), &mut budget, true);
    decide(cands, 20)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::catalog::find;
    use crate::games::validation::fake_exe;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn missing_root_is_reported() {
        let d = tmp();
        let missing = d.path().join("nope");
        assert_eq!(scan_library(&missing).unwrap_err(), RootError::Missing);
    }

    #[test]
    fn file_as_root_is_rejected() {
        let d = tmp();
        let f = d.path().join("file.txt");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(scan_library(&f).unwrap_err(), RootError::NotADirectory);
    }

    #[test]
    fn empty_root_finds_nothing() {
        let d = tmp();
        let res = scan_library(d.path()).unwrap();
        assert_eq!(res.len(), 4);
        assert!(res.iter().all(|(_, o)| *o == ScanOutcome::NotFound));
    }

    #[test]
    fn finds_games_with_case_variations_and_spaces() {
        let d = tmp();
        let root = d.path().join("BIG BOY STORAGE GAMES");
        fake_exe(&root.join("deltarune").join("Deltarune").join("DELTARUNE.exe"));
        fake_exe(&root.join("Persona3Reload").join("Persona 3 Reload").join("P3R").join("Binaries").join("Win64").join("P3R.exe"));
        fake_exe(&root.join("Ultrakill").join("ULTRAKILL").join("ULTRAKILL.exe"));
        fake_exe(&root.join("UNDERTALE").join("Undertale").join("UNDERTALE.exe"));
        fake_exe(&root.join("FNAF 2").join("FNaF2.exe")); // must be ignored
        let res = scan_library(&root).unwrap();
        for (def, outcome) in &res {
            match outcome {
                ScanOutcome::Found(c) => assert!(c.exe_path.to_lowercase().contains(&def.exe_hints[0]), "{}", c.exe_path),
                other => panic!("{} -> {other:?}", def.slug),
            }
        }
        // Install dir is the folder named after the game, not the Win64 folder.
        let p3r = res.iter().find(|(d, _)| d.slug == "persona-3-reload").unwrap();
        if let ScanOutcome::Found(c) = &p3r.1 {
            assert!(c.install_dir.ends_with("Persona 3 Reload"), "{}", c.install_dir);
        }
    }

    #[test]
    fn installers_redists_and_crash_tools_are_never_chosen() {
        let d = tmp();
        let root = d.path();
        fake_exe(&root.join("ULTRAKILL").join("Redist").join("vc_redist.x64.exe"));
        fake_exe(&root.join("ULTRAKILL").join("ULTRAKILL").join("UnityCrashHandler64.exe"));
        fake_exe(&root.join("ULTRAKILL").join("ULTRAKILL").join("unins000.exe"));
        let res = scan_library(root).unwrap();
        let uk = res.iter().find(|(d, _)| d.slug == "ultrakill").unwrap();
        assert_eq!(uk.1, ScanOutcome::NotFound);
    }

    #[test]
    fn duplicate_trees_prefer_the_game_named_folder() {
        let d = tmp();
        let root = d.path();
        fake_exe(&root.join("PERSONA 3 RELOAD").join("Persona 3 Reload").join("P3R").join("Binaries").join("Win64").join("P3R.exe"));
        fake_exe(&root.join("PERSONA 3 RELOAD").join("voices38").join("P3R").join("Binaries").join("Win64").join("P3R.exe"));
        let res = scan_library(root).unwrap();
        let p = res.iter().find(|(d, _)| d.slug == "persona-3-reload").unwrap();
        match &p.1 {
            ScanOutcome::Found(c) => assert!(c.exe_path.contains("Persona 3 Reload"), "{}", c.exe_path),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn several_equally_plausible_executables_need_confirmation() {
        let d = tmp();
        let root = d.path();
        fake_exe(&root.join("Undertale").join("a").join("UNDERTALE.exe"));
        fake_exe(&root.join("Undertale").join("b").join("UNDERTALE.exe"));
        let res = scan_library(root).unwrap();
        let u = res.iter().find(|(d, _)| d.slug == "undertale").unwrap();
        match &u.1 {
            ScanOutcome::Ambiguous(list) => assert_eq!(list.len(), 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn non_pe_files_named_like_games_are_ignored() {
        let d = tmp();
        let p = d.path().join("UNDERTALE").join("UNDERTALE.exe");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"definitely not a program").unwrap();
        let res = scan_library(d.path()).unwrap();
        let u = res.iter().find(|(d, _)| d.slug == "undertale").unwrap();
        assert_eq!(u.1, ScanOutcome::NotFound);
    }

    #[test]
    fn manual_folder_is_scanned_and_recorded_as_install_dir() {
        let d = tmp();
        let folder = d.path().join("Somewhere Else").join("My Undertale");
        fake_exe(&folder.join("UNDERTALE.exe"));
        let def = find("undertale").unwrap();
        match scan_folder(&def.profile(), &folder) {
            ScanOutcome::Found(c) => {
                assert_eq!(c.install_dir, sys::clean_path(&folder));
                assert!(c.exe_path.ends_with("UNDERTALE.exe"));
            }
            other => panic!("{other:?}"),
        }
        let empty = d.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(scan_folder(&def.profile(), &empty), ScanOutcome::NotFound);
    }

    #[test]
    fn scanner_does_not_modify_the_library() {
        let d = tmp();
        let root = d.path();
        fake_exe(&root.join("DELTARUNE").join("DELTARUNE").join("DELTARUNE.exe"));
        let snapshot = |p: &Path| {
            let mut v: Vec<(PathBuf, u64)> = Vec::new();
            fn walk(p: &Path, v: &mut Vec<(PathBuf, u64)>) {
                for e in std::fs::read_dir(p).unwrap().flatten() {
                    let m = e.metadata().unwrap();
                    v.push((e.path(), m.len()));
                    if m.is_dir() {
                        walk(&e.path(), v);
                    }
                }
            }
            walk(p, &mut v);
            v.sort();
            v
        };
        let before = snapshot(root);
        let _ = scan_library(root).unwrap();
        assert_eq!(before, snapshot(root));
    }

    /// Manual, read-only probe of the real library:
    /// `cargo test real_library_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_library_probe() {
        let root = Path::new(r"E:\bbsgames");
        for (def, outcome) in scan_library(root).expect("library root should be readable") {
            match outcome {
                ScanOutcome::Found(c) => println!("{:<18} FOUND   score={:>3}  exe={}  install={}  {:?}", def.title, c.score, c.exe_path, c.install_dir, c.reasons),
                ScanOutcome::Ambiguous(list) => {
                    println!("{:<18} AMBIGUOUS", def.title);
                    for c in list {
                        println!("    score={:>3} {}", c.score, c.exe_path);
                    }
                }
                ScanOutcome::NotFound => println!("{:<18} NOT FOUND", def.title),
            }
        }
    }

    #[test]
    fn scoring_penalises_support_folders() {
        let def = find("ultrakill").unwrap();
        let v = VersionInfo::default();
        let good = score_exe(&def.profile(), &["ULTRAKILL".into()], "ULTRAKILL", &v).unwrap().0;
        let bad = score_exe(&def.profile(), &["Redist".into()], "ULTRAKILL", &v).unwrap().0;
        assert!(good > ACCEPT_SCORE && bad < LIST_SCORE + 40 && good - bad > 80);
        assert!(score_exe(&def.profile(), &[], "UnityCrashHandler64", &v).is_none());
    }
}
