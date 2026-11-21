//! Whole-PC game scan.
//!
//! A breadth-first, read-only walk over local drives that recognises games by how they are *built*
//! (engine folders and files), not by what they are called:
//! Unity (`<name>_Data`), Unreal (`Binaries\Win64` next to `Content`), GameMaker (`data.win`),
//! Godot (`*.pck`), RPG Maker, Ren'Py, GOG (`goggame-*.info`), Steamworks / EOS libraries and
//! anti-cheat folders. Nothing is executed. Symlinks and junctions are never followed, system areas
//! (Windows, AppData, caches, `node_modules`, …) are never entered, and the walk is bounded by
//! depth, directory count and time, and can be cancelled at any moment.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::catalog::{normalize, GameProfile};
use super::discovery::score_exe;
use super::validation::{is_pe_file, looks_like_non_game};
use crate::platform::sys;

pub const MIN_CONFIDENCE: u8 = 55;
const MIN_EXE_BYTES: u64 = 100 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeepCandidate {
    pub id: String,
    pub title: String,
    /// The game's folder (used as its installation folder).
    pub root: String,
    pub exe: String,
    pub engine: String,
    /// 0–100. Higher means more certain this really is a game.
    pub confidence: u8,
    pub reasons: Vec<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub dirs: u64,
    pub found: usize,
    pub current: String,
    pub elapsed_secs: u64,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_dirs: u64,
    pub max_depth: usize,
    pub max_duration: Duration,
    pub max_entries_per_dir: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_dirs: 800_000, max_depth: 7, max_duration: Duration::from_secs(20 * 60), max_entries_per_dir: 4_000 }
    }
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub candidates: Vec<DeepCandidate>,
    pub dirs: u64,
    pub cancelled: bool,
    /// True when a limit (directory count or time) stopped the scan before it finished.
    pub hit_limit: bool,
}

/// Install folders of games already in the library, so they are not reported again.
#[derive(Debug, Default, Clone)]
pub struct Known {
    dirs: Vec<String>,
}

fn norm_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\").to_lowercase();
    s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches('\\').to_string()
}

impl Known {
    pub fn new(dirs: impl IntoIterator<Item = PathBuf>) -> Known {
        Known { dirs: dirs.into_iter().map(|d| norm_path(&d)).filter(|d| !d.is_empty()).collect() }
    }
    /// `path` is a known game folder or lies inside one.
    pub fn covers(&self, path: &Path) -> bool {
        let p = norm_path(path);
        self.dirs.iter().any(|k| p == *k || p.starts_with(&format!("{k}\\")))
    }
    /// A known game folder lies inside `path` (so `path` is a parent of something we already have).
    pub fn contains_known(&self, path: &Path) -> bool {
        let p = norm_path(path);
        self.dirs.iter().any(|k| k.starts_with(&format!("{p}\\")))
    }
}

/// Folders that are never entered: operating system, caches, package stores, other launchers' internals.
const SKIP_DIRS: &[&str] = &[
    "windows", "$recycle.bin", "system volume information", "recovery", "config.msi", "windowsapps", "winsxs", "appdata",
    "programdata", "node_modules", "__pycache__", "site-packages", "windows kits", "microsoft visual studio", "dotnet",
    "common files", "windows defender", "windows nt", "windowspowershell", "msbuild", "reference assemblies",
    "internet explorer", "microsoft.net", "perflogs", "msocache", "temp", "tmp", "cache", "caches", "logs", "crashes",
    "crash", "backup", "backups", "redist", "_commonredist", "directx", "vcredist", "installer", "installers",
    "nvidia corporation", "nvidia", "intel", "amd", "adobe", "microsoft", "google", "mozilla firefox", "obs-studio",
    "vmware", "oracle", "virtualbox", "libreoffice", "python", "nodejs", "steamapps\\downloading", "shadercache",
    "mods", "plugins", "saves", "savegames", "screenshots",
];

fn should_skip(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('$') || n.starts_with('.') || SKIP_DIRS.contains(&n.as_str())
}

struct FileEntry {
    lower: String,
    stem: String,
    size: u64,
    path: PathBuf,
}

struct Listing {
    files: Vec<FileEntry>,
    /// Sub-folder names (original case) — reparse points already removed.
    dirs: Vec<String>,
}

fn list_dir(path: &Path, max_entries: usize) -> Option<Listing> {
    let rd = fs::read_dir(path).ok()?;
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for (i, e) in rd.flatten().enumerate() {
        if i >= max_entries {
            break;
        }
        let Ok(meta) = e.metadata() else { continue };
        if sys::is_reparse_point(&meta) {
            continue; // never follow symlinks / junctions / OneDrive placeholders
        }
        let name = e.file_name().to_string_lossy().to_string();
        if meta.is_dir() {
            dirs.push(name);
        } else if meta.is_file() {
            let p = e.path();
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            files.push(FileEntry { lower: name.to_lowercase(), stem, size: meta.len(), path: p });
        }
    }
    Some(Listing { files, dirs })
}

struct Hit {
    engine: &'static str,
    confidence: u8,
    reasons: Vec<String>,
    /// Folder to treat as the game's installation (usually the folder being examined).
    root: PathBuf,
    /// Preferred executable stem (lowercase), if the fingerprint names one.
    exe_hint: Option<String>,
    /// Explicit executable (Unreal root launcher), when known.
    exe: Option<PathBuf>,
}

fn game_exes(l: &Listing) -> Vec<&FileEntry> {
    l.files.iter().filter(|f| f.lower.ends_with(".exe") && f.size >= MIN_EXE_BYTES && !looks_like_non_game(&f.stem)).collect()
}

fn has_file(l: &Listing, name: &str) -> bool {
    l.files.iter().any(|f| f.lower == name)
}

fn has_dir(l: &Listing, name: &str) -> bool {
    l.dirs.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Work out whether `dir` is the root of a game, and how sure we are.
fn fingerprint(dir: &Path, l: &Listing) -> Option<Hit> {
    let exes = game_exes(l);
    if exes.is_empty() {
        return None;
    }
    let mut best: Option<Hit> = None;
    let mut consider = |h: Hit| {
        if best.as_ref().is_none_or(|b| h.confidence > b.confidence) {
            best = Some(h);
        }
    };
    let mk = |engine: &'static str, confidence: u8, why: &str, hint: Option<String>| Hit {
        engine,
        confidence,
        reasons: vec![why.to_string()],
        root: dir.to_path_buf(),
        exe_hint: hint,
        exe: None,
    };

    // Unity: `<exe name>_Data` beside the executable.
    if let Some(e) = exes.iter().find(|e| has_dir(l, &format!("{}_data", e.stem))) {
        consider(mk("Unity", 92, "Unity game folder (<name>_Data)", Some(e.stem.to_lowercase())));
    } else if has_file(l, "unityplayer.dll") && l.dirs.iter().any(|d| d.to_lowercase().ends_with("_data")) {
        consider(mk("Unity", 85, "Unity player files", None));
    }
    // GameMaker
    if has_file(l, "data.win") {
        consider(mk("GameMaker", 88, "GameMaker data file (data.win)", None));
    }
    // Godot
    if let Some(pck) = l.files.iter().find(|f| f.lower.ends_with(".pck")) {
        consider(mk("Godot", 82, "Godot game package (.pck)", Some(pck.stem.to_lowercase())));
    }
    // Unreal: …\<Project>\Binaries\Win64 beside a Content folder, not the engine's own.
    let parts: Vec<String> = dir.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    if parts.len() >= 3 && parts[parts.len() - 1] == "win64" && parts[parts.len() - 2] == "binaries" {
        if let Some(project) = dir.parent().and_then(Path::parent) {
            let project_name = project.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !project_name.eq_ignore_ascii_case("engine") && project.join("Content").is_dir() {
                // The real launch file is often a stub in the folder above the project.
                let root = project.parent().filter(|p| p.join("Engine").is_dir()).unwrap_or(project);
                let stub = root.join(format!("{project_name}.exe"));
                let mut h = mk("Unreal", 92, "Unreal Engine game (Binaries\\Win64 beside Content)", None);
                h.root = root.to_path_buf();
                if stub.is_file() && stub != dir.join(format!("{project_name}.exe")) {
                    h.exe = Some(stub);
                }
                consider(h);
            }
        }
    }
    // RPG Maker / Ren'Py
    if l.files.iter().any(|f| f.lower.ends_with(".rgss3a") || f.lower.ends_with(".rgss2a") || f.lower.ends_with(".rgssad")) {
        consider(mk("RPG Maker", 82, "RPG Maker data archive", Some("game".into())));
    } else if has_dir(l, "www") && has_file(l, "package.json") && exes.iter().any(|e| e.lower == "game.exe") {
        consider(mk("RPG Maker", 74, "RPG Maker MV/MZ layout", Some("game".into())));
    }
    if has_dir(l, "renpy") && has_dir(l, "game") {
        consider(mk("Ren'Py", 82, "Ren'Py visual novel", None));
    }
    // Store / SDK fingerprints
    if l.files.iter().any(|f| f.lower.starts_with("goggame-") && f.lower.ends_with(".info")) {
        consider(mk("GOG", 88, "GOG game (goggame-*.info)", None));
    }
    if has_file(l, "steam_api64.dll") || has_file(l, "steam_api.dll") || has_file(l, "steam_appid.txt") {
        consider(mk("Steamworks", 72, "Uses the Steamworks library", None));
    }
    if has_file(l, "eossdk-win64-shipping.dll") {
        consider(mk("Epic Online Services", 66, "Uses Epic Online Services", None));
    }
    if ["easyanticheat", "battleye", "eac_launcher", "easyanticheat_eos_setup.exe"].iter().any(|n| has_dir(l, n) || has_file(l, n)) {
        consider(mk("Anti-cheat", 76, "Has game anti-cheat software", None));
    }

    // Several independent signals make us more certain.
    let signals = [
        has_file(l, "steam_api64.dll") || has_file(l, "steam_api.dll"),
        has_file(l, "unityplayer.dll"),
        has_dir(l, "easyanticheat") || has_dir(l, "battleye"),
        has_file(l, "data.win") || l.files.iter().any(|f| f.lower.ends_with(".pck")),
    ]
    .iter()
    .filter(|s| **s)
    .count();
    best.map(|mut b| {
        if signals >= 2 {
            b.confidence = (b.confidence + 5).min(99);
            b.reasons.push("Several game signals together".into());
        }
        b
    })
}

fn is_noise_token(t: &str) -> bool {
    let l = t.to_lowercase();
    let versionish = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '.') && s.chars().any(|c| c.is_ascii_digit());
    matches!(l.as_str(), "windows" | "win" | "win32" | "win64" | "pc" | "x64" | "x86" | "build" | "release" | "final" | "portable" | "setup")
        // `v2`, `v1.2.3` and `1.1` are versions — but a bare number ("Half-Life 2", "FNAF 4") is part of the title.
        || (l.starts_with('v') && versionish(&l[1..]))
        || (l.contains('.') && versionish(&l))
}

/// Turn a folder name into a readable title: `my_cool.game` → `my cool game`,
/// `baldisbasicscr-1.1-windows` → `baldisbasicscr` (trailing platform/version tokens dropped).
fn clean_folder_title(s: &str) -> String {
    // Hyphens are word separators only when the name has no spaces ("Half-Life 2" keeps its hyphen).
    let hyphen_splits = !s.contains(' ');
    let mut tokens: Vec<&str> = s.split(|c: char| c.is_whitespace() || c == '_' || (hyphen_splits && c == '-')).filter(|t| !t.is_empty()).collect();
    // Drop trailing platform/version tokens first (so "1.1" is still a version, not "1" and "1")…
    while tokens.len() > 1 && tokens.last().is_some_and(|t| is_noise_token(t)) {
        tokens.pop();
    }
    // …then turn the remaining dots into spaces ("my_cool.game" -> "my cool game").
    tokens.join(" ").replace('.', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Launchers, stores, editors and bundled viewers are programs, not games.
const NOT_GAME_PHRASES: &[&str] = &[
    "launcher", "wallpaper", "ea desktop", "ubisoft connect", "riot client", "artbook", "art book", "soundtrack",
    "unity hub", "installer", "uninstall", "benchmark", "editor", "battle.net", "gog galaxy", "xbox app",
];

/// Well-known programs whose bundled content (sample projects, viewers) can sit many folders deep.
const NOT_GAME_ANYWHERE_IN_PATH: &[&str] = &["wallpaper engine", "wallpaper_engine", "epic games\\launcher", "ea desktop", "ubisoft game launcher", "riot client", "unity\\hub"];

fn looks_like_an_app(title: &str, root: &Path) -> bool {
    let whole = root.to_string_lossy().replace('/', "\\").to_lowercase();
    if NOT_GAME_ANYWHERE_IN_PATH.iter().any(|p| whole.contains(p)) {
        return true;
    }
    let mut haystack = title.to_lowercase();
    // The folder name and its two parents say a lot ("…\Epic Games\Launcher", "…\Wallpaper Engine\…").
    for c in root.components().rev().take(3) {
        haystack.push(' ');
        haystack.push_str(&c.as_os_str().to_string_lossy().to_lowercase());
    }
    NOT_GAME_PHRASES.iter().any(|p| haystack.contains(p))
}

fn generic_folder(name: &str) -> bool {
    matches!(normalize(name).as_str(), "bin" | "game" | "win64" | "win32" | "x64" | "x86" | "windows" | "release" | "build" | "binaries" | "app" | "program" | "data" | "content" | "client" | "")
}

fn short_id(path: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn candidate_from(dir: &Path, listing: &Listing, hit: Hit) -> Option<DeepCandidate> {
    let root = hit.root.clone();
    let folder = root.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let folder_for_title = if generic_folder(&folder) {
        root.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or(&folder).to_string()
    } else {
        folder
    };
    let profile = GameProfile::from_title(&folder_for_title);

    let exe: PathBuf = match &hit.exe {
        Some(p) => p.clone(),
        None => {
            let mut best: Option<(i64, &FileEntry)> = None;
            for e in game_exes(listing) {
                let mut score = score_exe(&profile, &[], &e.stem, &Default::default()).map(|(s, _)| s as i64).unwrap_or(-100);
                if hit.exe_hint.as_deref().is_some_and(|h| h == e.stem.to_lowercase()) {
                    score += 100;
                }
                // Larger programs are more likely to be the game than a helper.
                let rank = score * 1_000_000_000 + e.size as i64;
                if best.as_ref().is_none_or(|(b, _)| rank > *b) {
                    best = Some((rank, e));
                }
            }
            best?.1.path.clone()
        }
    };
    if !is_pe_file(&exe) {
        return None;
    }
    let info = sys::read_version_info(&exe);
    let product = info.product_name.filter(|p| (2..=60).contains(&p.len()) && !p.to_lowercase().contains("unity") && !p.to_lowercase().contains("unreal"));
    let title = product.unwrap_or_else(|| clean_folder_title(&folder_for_title));
    if title.is_empty() || looks_like_an_app(&title, &root) {
        return None;
    }
    let root_s = sys::clean_path(&root);
    let _ = dir;
    Some(DeepCandidate {
        id: short_id(&root_s),
        title: super::detect::clean_title(&title),
        root: root_s,
        exe: sys::clean_path(&exe),
        engine: hit.engine.to_string(),
        confidence: hit.confidence,
        reasons: hit.reasons,
        size: fs::metadata(&exe).map(|m| m.len()).unwrap_or(0),
    })
}

/// Walk `roots` breadth-first and return the games found.
/// `on_progress` is called regularly with the current state. `cancel` can be set from another thread.
pub fn deep_scan(roots: &[PathBuf], limits: &Limits, known: &Known, cancel: &AtomicBool, on_progress: &mut dyn FnMut(&ScanProgress)) -> Outcome {
    let started = Instant::now();
    let mut out = Outcome::default();
    let mut queue: VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut seen_roots: HashSet<String> = HashSet::new();
    let mut last_report = Instant::now();

    while let Some((dir, depth)) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            out.cancelled = true;
            break;
        }
        if out.dirs >= limits.max_dirs || started.elapsed() > limits.max_duration {
            out.hit_limit = true;
            break;
        }
        if known.covers(&dir) {
            continue;
        }
        out.dirs += 1;
        if last_report.elapsed() >= Duration::from_millis(300) {
            last_report = Instant::now();
            on_progress(&ScanProgress { dirs: out.dirs, found: out.candidates.len(), current: sys::clean_path(&dir), elapsed_secs: started.elapsed().as_secs() });
        }
        let Some(listing) = list_dir(&dir, limits.max_entries_per_dir) else { continue };

        let mut is_game_root = false;
        if let Some(hit) = fingerprint(&dir, &listing) {
            if hit.confidence >= MIN_CONFIDENCE && !known.covers(&hit.root) && !known.contains_known(&hit.root) && seen_roots.insert(norm_path(&hit.root)) {
                if let Some(c) = candidate_from(&dir, &listing, hit) {
                    out.candidates.push(c);
                    is_game_root = true;
                }
            }
        }
        // A game's own sub-folders are not searched for more games.
        if is_game_root || depth >= limits.max_depth {
            continue;
        }
        for d in &listing.dirs {
            if !should_skip(d) {
                queue.push_back((dir.join(d), depth + 1));
            }
        }
    }
    out.candidates.sort_by(|a, b| b.confidence.cmp(&a.confidence).then(a.title.to_lowercase().cmp(&b.title.to_lowercase())));
    on_progress(&ScanProgress { dirs: out.dirs, found: out.candidates.len(), current: String::new(), elapsed_secs: started.elapsed().as_secs() });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::validation::fake_exe;

    /// A believable game executable (valid PE header, bigger than the minimum size).
    fn game_exe(p: &Path) {
        fake_exe(p);
        fs::OpenOptions::new().write(true).open(p).unwrap().set_len(400 * 1024).unwrap();
    }
    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }
    fn scan(root: &Path) -> Outcome {
        deep_scan(&[root.to_path_buf()], &Limits::default(), &Known::default(), &AtomicBool::new(false), &mut |_| {})
    }
    fn titles(o: &Outcome) -> Vec<String> {
        let mut t: Vec<_> = o.candidates.iter().map(|c| c.title.clone()).collect();
        t.sort();
        t
    }

    #[test]
    fn recognises_engines_by_structure_not_by_name() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        // Unity
        game_exe(&r.join("Stuff").join("Cool Platformer").join("CoolPlat.exe"));
        fs::create_dir_all(r.join("Stuff").join("Cool Platformer").join("CoolPlat_Data")).unwrap();
        // GameMaker
        game_exe(&r.join("Games").join("Pixel Quest").join("runner.exe"));
        touch(&r.join("Games").join("Pixel Quest").join("data.win"));
        // Godot
        game_exe(&r.join("Games").join("Godot Thing").join("gt.exe"));
        touch(&r.join("Games").join("Godot Thing").join("gt.pck"));
        // Unreal, with a root launcher stub and an Engine folder
        let ue = r.join("Big Games").join("Shooter Deluxe");
        game_exe(&ue.join("Shooter.exe"));
        game_exe(&ue.join("Shooter").join("Binaries").join("Win64").join("Shooter-Win64-Shipping.exe"));
        fs::create_dir_all(ue.join("Shooter").join("Content")).unwrap();
        fs::create_dir_all(ue.join("Engine").join("Binaries").join("Win64")).unwrap();
        fs::create_dir_all(ue.join("Engine").join("Content")).unwrap();
        game_exe(&ue.join("Engine").join("Binaries").join("Win64").join("UnrealEditorThing.exe"));
        // GOG
        game_exe(&r.join("GOG Games").join("Old Classic").join("classic.exe"));
        touch(&r.join("GOG Games").join("Old Classic").join("goggame-123456.info"));

        let out = scan(r);
        let by = |t: &str| out.candidates.iter().find(|c| c.title == t).unwrap_or_else(|| panic!("missing {t}: {:?}", titles(&out)));
        assert_eq!(by("Cool Platformer").engine, "Unity");
        assert!(by("Cool Platformer").exe.ends_with("CoolPlat.exe"));
        assert_eq!(by("Pixel Quest").engine, "GameMaker");
        assert_eq!(by("Godot Thing").engine, "Godot");
        assert_eq!(by("Old Classic").engine, "GOG");
        let ue_hit = by("Shooter Deluxe");
        assert_eq!(ue_hit.engine, "Unreal");
        assert!(ue_hit.exe.ends_with("Shooter.exe") && !ue_hit.exe.contains("Win64"), "prefers the root launcher: {}", ue_hit.exe);
        assert!(ue_hit.root.ends_with("Shooter Deluxe"));
        assert_eq!(out.candidates.len(), 5, "the engine's own folders are not games: {:?}", titles(&out));
    }

    #[test]
    fn ordinary_programs_and_installers_are_not_games() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        game_exe(&r.join("Program Files").join("Some Editor").join("editor.exe"));
        touch(&r.join("Program Files").join("Some Editor").join("lib.dll"));
        game_exe(&r.join("Downloads").join("setup.exe"));
        game_exe(&r.join("Tools").join("vcredist_x64.exe"));
        fs::create_dir_all(r.join("Tools").join("SomeApp_Data")).unwrap(); // looks Unity-ish but its exe is a redist
        let out = scan(r);
        assert!(out.candidates.is_empty(), "{:?}", titles(&out));
    }

    #[test]
    fn system_cache_and_package_folders_are_never_entered() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for skipped in ["Windows", "$Recycle.Bin", "node_modules", "AppData", "ProgramData", ".git", "Temp"] {
            let g = r.join(skipped).join("Hidden Game");
            game_exe(&g.join("hg.exe"));
            touch(&g.join("data.win"));
        }
        game_exe(&r.join("Visible").join("v.exe"));
        touch(&r.join("Visible").join("data.win"));
        let out = scan(r);
        assert_eq!(titles(&out), ["Visible"]);
    }

    #[test]
    fn games_already_in_the_library_are_not_reported_twice() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        let known_dir = r.join("Lib").join("Known Game");
        game_exe(&known_dir.join("k.exe"));
        touch(&known_dir.join("data.win"));
        game_exe(&r.join("Lib").join("New Game").join("n.exe"));
        touch(&r.join("Lib").join("New Game").join("data.win"));
        let known = Known::new([known_dir.clone()]);
        let out = deep_scan(&[r.to_path_buf()], &Limits::default(), &known, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(titles(&out), ["New Game"]);
        assert!(known.covers(&known_dir.join("sub")) && !known.covers(&r.join("Lib")));
        assert!(known.contains_known(&r.join("Lib")) && !known.contains_known(&r.join("Lib").join("New Game")));
    }

    #[test]
    fn a_game_folder_is_reported_once_and_its_insides_are_not_rescanned() {
        let d = tempfile::tempdir().unwrap();
        let g = d.path().join("Big Game");
        game_exe(&g.join("big.exe"));
        touch(&g.join("data.win"));
        // A nested "mod" folder that also looks like a game must not produce a second entry.
        game_exe(&g.join("Mods").join("Inner").join("inner.exe"));
        touch(&g.join("Mods").join("Inner").join("data.win"));
        assert_eq!(titles(&scan(d.path())), ["Big Game"]);
    }

    #[test]
    fn depth_entry_and_cancel_limits_are_respected() {
        let d = tempfile::tempdir().unwrap();
        let deep = d.path().join("a").join("b").join("c").join("d").join("e").join("Deep Game");
        game_exe(&deep.join("dg.exe"));
        touch(&deep.join("data.win"));
        let shallow = Limits { max_depth: 3, ..Limits::default() };
        let out = deep_scan(&[d.path().to_path_buf()], &shallow, &Known::default(), &AtomicBool::new(false), &mut |_| {});
        assert!(out.candidates.is_empty(), "too deep for the limit");
        assert!(scan(d.path()).candidates.len() == 1, "found with the default depth");

        let tiny = Limits { max_dirs: 2, ..Limits::default() };
        let out = deep_scan(&[d.path().to_path_buf()], &tiny, &Known::default(), &AtomicBool::new(false), &mut |_| {});
        assert!(out.hit_limit && out.dirs <= 2);

        let cancel = AtomicBool::new(true);
        let out = deep_scan(&[d.path().to_path_buf()], &Limits::default(), &Known::default(), &cancel, &mut |_| {});
        assert!(out.cancelled && out.dirs == 0);
    }

    #[test]
    fn progress_is_reported_and_the_scan_changes_nothing() {
        let d = tempfile::tempdir().unwrap();
        game_exe(&d.path().join("G").join("g.exe"));
        touch(&d.path().join("G").join("data.win"));
        let snapshot = |p: &Path| {
            let mut v = Vec::new();
            fn walk(p: &Path, v: &mut Vec<(PathBuf, u64)>) {
                for e in fs::read_dir(p).unwrap().flatten() {
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
        let before = snapshot(d.path());
        let mut last = ScanProgress::default();
        let out = deep_scan(&[d.path().to_path_buf()], &Limits::default(), &Known::default(), &AtomicBool::new(false), &mut |p| last = p.clone());
        assert_eq!(last.found, out.candidates.len());
        assert_eq!(last.dirs, out.dirs);
        assert_eq!(before, snapshot(d.path()), "read-only");
    }

    #[test]
    fn launchers_tools_and_bundled_viewers_are_not_reported() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        // An Unreal-built launcher, a Unity wallpaper project, and an art-book viewer: all game-shaped, none a game.
        let ue = r.join("Epic Games").join("Launcher");
        game_exe(&ue.join("Portal").join("Binaries").join("Win64").join("Portal.exe"));
        fs::create_dir_all(ue.join("Portal").join("Content")).unwrap();
        let wp = r.join("Wallpaper Engine").join("projects").join("sheep");
        game_exe(&wp.join("sheep.exe"));
        fs::create_dir_all(wp.join("sheep_Data")).unwrap();
        let ab = r.join("Cool Game").join("Artbook");
        game_exe(&ab.join("viewer.exe"));
        fs::create_dir_all(ab.join("viewer_Data")).unwrap();
        // …and one real game.
        game_exe(&r.join("Real Game").join("real.exe"));
        touch(&r.join("Real Game").join("data.win"));
        let out = scan(r);
        assert_eq!(titles(&out), ["Real Game"]);
        assert!(looks_like_an_app("EA Desktop", Path::new("C:\\x")) && !looks_like_an_app("Hades II", Path::new("C:\\Games\\Hades II")));
        // Deeply nested sample content of a known tool is still excluded.
        assert!(looks_like_an_app("sheep", Path::new("E:\\Stuff\\Wallpaper Engine\\wallpaper_engine\\projects\\defaultprojects\\sheep")));
    }

    #[test]
    fn messy_folder_names_become_tidy_titles() {
        assert_eq!(clean_folder_title("baldisbasicscr-1.1-windows"), "baldisbasicscr");
        assert_eq!(clean_folder_title("Cool_Game_v1.2.3_win64"), "Cool Game");
        assert_eq!(clean_folder_title("raldis crackhouse"), "raldis crackhouse");
        assert_eq!(clean_folder_title("2048"), "2048", "a title that is only a number is kept");
        assert_eq!(clean_folder_title("Hades II"), "Hades II");
        assert_eq!(clean_folder_title("Half-Life 2"), "Half-Life 2", "hyphens are kept when the name already has spaces");
    }

    #[test]
    fn titles_come_from_folder_names_with_generic_folders_skipped() {
        assert_eq!(clean_folder_title("my_cool.game"), "my cool game");
        assert!(generic_folder("Win64") && generic_folder("bin") && !generic_folder("Hades"));
        let d = tempfile::tempdir().unwrap();
        let g = d.path().join("Hades II").join("x64");
        game_exe(&g.join("h.exe"));
        touch(&g.join("steam_api64.dll"));
        let out = scan(d.path());
        assert_eq!(titles(&out), ["Hades II"], "uses the parent folder, not 'x64'");
    }

    /// Real, read-only scan of this PC's fixed drives, capped at 3 minutes:
    /// `cargo test real_deep_scan_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_deep_scan_probe() {
        let roots = sys::local_drives();
        println!("drives: {roots:?}");
        let limits = Limits { max_duration: Duration::from_secs(180), ..Limits::default() };
        let out = deep_scan(&roots, &limits, &Known::default(), &AtomicBool::new(false), &mut |p| println!("  .. {} dirs, {} found, in {}", p.dirs, p.found, p.current));
        println!("DONE dirs={} hit_limit={} found={}", out.dirs, out.hit_limit, out.candidates.len());
        for c in &out.candidates {
            println!("DEEP {:>3} {:<10} {:<40} {}", c.confidence, c.engine, c.title, c.root);
        }
    }
}
