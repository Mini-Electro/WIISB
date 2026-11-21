//! Detection of games beyond the four catalogue titles. Every detector is read-only: it parses
//! files other launchers already keep on disk (Steam manifests, Epic manifests, Start Menu
//! shortcuts, Roblox's version folders, extra folders in the library root). Nothing is executed
//! and no IDs are invented — Steam / Epic launch links are built only from IDs found in those files.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::catalog::{normalize, GameProfile, CATALOG};
use super::discovery::collect_exes;
use super::validation::{is_pe_file, looks_like_non_game};
use crate::platform::sys;

#[derive(Debug, Clone, PartialEq)]
pub enum DetectedLaunch {
    Exe { path: PathBuf, args: String },
    /// A platform link built from IDs found in that platform's own manifests.
    Uri(String),
    Shortcut(PathBuf),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Detected {
    /// `steam` | `epic` | `roblox` | `startmenu` | `library`
    pub source: &'static str,
    /// Unique within `source` (Steam app id, Epic app name, folder name…).
    pub external_id: String,
    pub title: String,
    pub install_dir: Option<PathBuf>,
    pub launch: DetectedLaunch,
    pub steam_app_id: Option<i64>,
    /// A local executable to take the icon from when no cover can be found online.
    pub icon_exe: Option<PathBuf>,
    /// Alternative names to try when searching for a cover.
    pub name_hints: Vec<String>,
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

impl Detected {
    pub fn slug(&self) -> String {
        match (self.source, self.steam_app_id) {
            ("steam", Some(id)) => format!("steam-{id}"),
            _ => format!("{}-{}", self.source, slugify(&self.external_id)),
        }
    }
}

pub fn clean_title(s: &str) -> String {
    s.replace(['®', '™', '©'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------------------------------- VDF

/// Valve's text format (`libraryfolders.vdf`, `appmanifest_*.acf`).
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Map(m) => m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Vdf::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Map(m) => m,
            _ => &[],
        }
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '"' => {
                let mut s = String::new();
                while let Some(ch) = it.next() {
                    match ch {
                        '"' => break,
                        '\\' => match it.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(o) => s.push(o),
                            None => break,
                        },
                        o => s.push(o),
                    }
                }
                out.push(Tok::Str(s));
            }
            '/' if it.peek() == Some(&'/') => {
                for ch in it.by_ref() {
                    if ch == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_map(toks: &[Tok], i: &mut usize, depth: usize) -> Option<Vec<(String, Vdf)>> {
    if depth > 24 {
        return None;
    }
    let mut out = Vec::new();
    while *i < toks.len() {
        match &toks[*i] {
            Tok::Close => {
                if depth == 0 {
                    return None; // a closing brace with nothing open
                }
                *i += 1;
                return Some(out);
            }
            Tok::Str(key) => {
                *i += 1;
                match toks.get(*i)? {
                    Tok::Str(v) => {
                        out.push((key.clone(), Vdf::Str(v.clone())));
                        *i += 1;
                    }
                    Tok::Open => {
                        *i += 1;
                        out.push((key.clone(), Vdf::Map(parse_map(toks, i, depth + 1)?)));
                    }
                    Tok::Close => return None,
                }
            }
            Tok::Open => return None,
        }
    }
    Some(out)
}

pub fn parse_vdf(text: &str) -> Option<Vdf> {
    let toks = tokenize(text);
    let mut i = 0;
    parse_map(&toks, &mut i, 0).map(Vdf::Map)
}

// ------------------------------------------------------------------------------------ Steam

/// Steam components that live in `steamapps` but are not games.
const STEAM_NON_GAMES: &[i64] = &[228980, 250820, 1070560, 1391110, 1493710, 1628350, 1826330, 2180100];

fn steam_name_is_tool(name: &str) -> bool {
    let n = name.to_lowercase();
    ["redistributable", "steamworks", "proton", "steam linux runtime", "steamvr", "wallpaper engine", "dedicated server", "sdk"]
        .iter()
        .any(|w| n.contains(w))
}

/// Every Steam library folder (the main install plus those listed in `libraryfolders.vdf`).
pub fn steam_libraries(steam_root: &Path) -> Vec<PathBuf> {
    let mut libs = vec![steam_root.to_path_buf()];
    if let Ok(text) = fs::read_to_string(steam_root.join("steamapps").join("libraryfolders.vdf")) {
        if let Some(root) = parse_vdf(&text) {
            for (_, entry) in root.get("libraryfolders").map(Vdf::entries).unwrap_or_default() {
                if let Some(p) = entry.str("path") {
                    let p = PathBuf::from(p);
                    if !libs.iter().any(|l| l.to_string_lossy().eq_ignore_ascii_case(&p.to_string_lossy())) {
                        libs.push(p);
                    }
                }
            }
        }
    }
    libs
}

pub fn detect_steam_from(steam_root: &Path) -> Vec<Detected> {
    let mut out: Vec<Detected> = Vec::new();
    let mut seen = HashSet::new();
    for lib in steam_libraries(steam_root) {
        let apps = lib.join("steamapps");
        let Ok(rd) = fs::read_dir(&apps) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            let Some(doc) = parse_vdf(&text) else { continue };
            let Some(state) = doc.get("AppState") else { continue };
            let (Some(id), Some(title), Some(installdir)) =
                (state.str("appid").and_then(|s| s.parse::<i64>().ok()), state.str("name"), state.str("installdir"))
            else {
                continue;
            };
            let flags = state.str("StateFlags").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let dir = apps.join("common").join(installdir);
            if STEAM_NON_GAMES.contains(&id) || steam_name_is_tool(title) || flags & 4 == 0 || !dir.is_dir() || !seen.insert(id) {
                continue;
            }
            out.push(Detected {
                source: "steam",
                external_id: id.to_string(),
                title: clean_title(title),
                install_dir: Some(dir),
                launch: DetectedLaunch::Uri(format!("steam://rungameid/{id}")),
                steam_app_id: Some(id),
                icon_exe: None,
                name_hints: vec![],
            });
        }
    }
    out
}

pub fn detect_steam() -> Vec<Detected> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(p) = sys::read_registry_string(r"Software\Valve\Steam", "SteamPath") {
        roots.push(PathBuf::from(p.replace('/', "\\")));
    }
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = std::env::var_os(var) {
            roots.push(PathBuf::from(pf).join("Steam"));
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in roots {
        if r.join("steamapps").is_dir() {
            for d in detect_steam_from(&r) {
                if seen.insert(d.external_id.clone()) {
                    out.push(d);
                }
            }
        }
    }
    out
}

// ------------------------------------------------------------------------------------- Epic

pub fn detect_epic_from(manifests: &Path) -> Vec<Detected> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(manifests) else { return out };
    for entry in rd.flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) else { continue };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (title, app, main, loc, exe) = (s("DisplayName"), s("AppName"), s("MainGameAppName"), s("InstallLocation"), s("LaunchExecutable"));
        // DLC / content packs share the main game's folder but have no launch executable.
        if title.is_empty() || app.is_empty() || exe.is_empty() || (!main.is_empty() && main != app) {
            continue;
        }
        let dir = PathBuf::from(&loc);
        let exe_path = dir.join(exe.replace('/', "\\"));
        if !dir.is_dir() {
            continue;
        }
        let (ns, item) = (s("CatalogNamespace"), s("CatalogItemId"));
        let launch = if !ns.is_empty() && !item.is_empty() {
            DetectedLaunch::Uri(format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true"))
        } else {
            DetectedLaunch::Exe { path: exe_path.clone(), args: String::new() }
        };
        out.push(Detected {
            source: "epic",
            external_id: app,
            title: clean_title(&title),
            install_dir: Some(dir),
            launch,
            steam_app_id: None,
            icon_exe: exe_path.is_file().then_some(exe_path),
            name_hints: vec![],
        });
    }
    out
}

pub fn detect_epic() -> Vec<Detected> {
    let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    detect_epic_from(&base.join(r"Epic\EpicGamesLauncher\Data\Manifests"))
}

// ----------------------------------------------------------------------------------- Roblox

/// Finds `RobloxPlayerBeta.exe` under the given `…\Versions` folders, **in priority order**: the first
/// folder that has a player wins (the newest version inside it). So with Electricity installed it is
/// used; without it, the normal Roblox install is the fallback.
pub fn detect_roblox_from(version_roots: &[PathBuf]) -> Option<Detected> {
    let exe = version_roots.iter().find_map(|root| {
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        for v in fs::read_dir(root).ok()?.flatten() {
            let exe = v.path().join("RobloxPlayerBeta.exe");
            if let Ok(meta) = fs::metadata(&exe) {
                let t = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                if best.as_ref().is_none_or(|(bt, _)| t > *bt) {
                    best = Some((t, exe));
                }
            }
        }
        best.map(|(_, p)| p)
    })?;
    Some(Detected {
        source: "roblox",
        external_id: "player".into(),
        title: "Roblox".into(),
        install_dir: exe.parent().map(Path::to_path_buf),
        launch: DetectedLaunch::Exe { path: exe.clone(), args: String::new() },
        steam_app_id: None,
        icon_exe: Some(exe),
        name_hints: vec![],
    })
}

/// Electricity (a Roblox client with its own launcher). Present only if `Electricity.exe` really is there.
/// It is launched through `Electricity.exe`, and everything under its folder counts as "running".
pub fn detect_electricity_from(dir: &Path) -> Option<Detected> {
    let exe = dir.join("Electricity.exe");
    if !is_pe_file(&exe) {
        return None;
    }
    Some(Detected {
        source: "roblox",
        external_id: "player".into(),
        title: "Electricity".into(),
        install_dir: Some(dir.to_path_buf()),
        launch: DetectedLaunch::Exe { path: exe.clone(), args: String::new() },
        steam_app_id: None,
        icon_exe: Some(exe),
        name_hints: vec![],
    })
}

/// Electricity if it is installed, otherwise the normal Roblox player.
pub fn detect_roblox(extra_roots: &[PathBuf]) -> Option<Detected> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        if let Some(e) = detect_electricity_from(&local.join("Electricity")) {
            return Some(e);
        }
    }
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        roots.push(local.join("Roblox").join("Versions"));
        roots.push(local.join("Electricity").join("Versions"));
    }
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = std::env::var_os(var) {
            roots.push(PathBuf::from(pf).join("Roblox").join("Versions"));
        }
    }
    roots.extend(extra_roots.iter().cloned());
    detect_roblox_from(&roots)
}

// ----------------------------------------------------------------------------------- Minecraft

const ONECLIENT_EXE: &str = "oneclient_app.exe";
const MINECRAFT_STORE_PFN: &str = "Microsoft.4297127D64EC6_8wekyb3d8bbwe";

/// OneClient — only if `oneclient_app.exe` really is in one of `dirs` (first folder wins).
pub fn detect_oneclient_from(dirs: &[PathBuf]) -> Option<Detected> {
    let dir = dirs.iter().find(|d| is_pe_file(&d.join(ONECLIENT_EXE)))?;
    let exe = dir.join(ONECLIENT_EXE);
    Some(Detected {
        source: "minecraft",
        external_id: "oneclient".into(),
        title: "OneClient".into(),
        install_dir: Some(dir.clone()),
        launch: DetectedLaunch::Exe { path: exe.clone(), args: String::new() },
        steam_app_id: None,
        icon_exe: Some(exe),
        name_hints: vec![],
    })
}

/// `root`, its sub-folders and theirs (e.g. `Library\MC Launchers\OneClient`): where a manually chosen
/// install location usually ends up.
fn two_levels_below(root: &Path) -> Vec<PathBuf> {
    let subdirs = |p: &Path| -> Vec<PathBuf> {
        let Ok(rd) = fs::read_dir(p) else { return Vec::new() };
        rd.flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with(['.', '$']))
            .filter(|e| e.metadata().is_ok_and(|m| m.is_dir() && !sys::is_reparse_point(&m)))
            .map(|e| e.path())
            .collect()
    };
    let mut out = vec![root.to_path_buf()];
    for child in subdirs(root) {
        out.extend(subdirs(&child));
        out.push(child);
    }
    out
}

/// Standard install spots, then (if given) the library folder.
pub fn detect_oneclient(library_root: Option<&Path>) -> Option<Detected> {
    let mut dirs = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("OneClient"));
        dirs.push(local.join("Programs").join("OneClient"));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var) {
            dirs.push(PathBuf::from(pf).join("OneClient"));
        }
    }
    if let Some(root) = library_root {
        dirs.extend(two_levels_below(root));
    }
    detect_oneclient_from(&dirs)
}

/// The Minecraft Launcher (Java and Bedrock edition). A classic install has `MinecraftLauncher.exe` and is
/// started directly; the Microsoft Store / Xbox app version is started through its app id, exactly as the
/// Start Menu does. `store_content` are folders that may hold the Store version's files
/// (`<drive>\XboxGames\Minecraft Launcher\Content`); `store_data` is its per-user data folder.
pub fn detect_minecraft_from(classic: &[PathBuf], store_content: &[PathBuf], store_data: Option<&Path>) -> Option<Detected> {
    let make = |install: Option<PathBuf>, launch, icon: Option<PathBuf>| Detected {
        source: "minecraft",
        external_id: "launcher".into(),
        title: "Minecraft".into(),
        install_dir: install,
        launch,
        steam_app_id: None,
        icon_exe: icon,
        name_hints: vec![],
    };
    if let Some(dir) = classic.iter().find(|d| is_pe_file(&d.join("MinecraftLauncher.exe"))) {
        let exe = dir.join("MinecraftLauncher.exe");
        return Some(make(Some(dir.clone()), DetectedLaunch::Exe { path: exe.clone(), args: String::new() }, Some(exe)));
    }
    let uri = DetectedLaunch::Uri(format!(r"shell:AppsFolder\{MINECRAFT_STORE_PFN}!Minecraft"));
    if let Some(dir) = store_content.iter().find(|d| d.join("Minecraft.exe").is_file()) {
        return Some(make(Some(dir.clone()), uri, Some(dir.join("Minecraft.exe"))));
    }
    // Installed from the Store into the protected WindowsApps folder: it can be started, but its files can't be read.
    store_data.is_some_and(Path::is_dir).then(|| make(None, uri, None))
}

pub fn detect_minecraft() -> Option<Detected> {
    let mut classic = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(pf) = std::env::var_os(var) {
            classic.push(PathBuf::from(pf).join("Minecraft Launcher"));
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    if let Some(l) = &local {
        classic.push(l.join("Programs").join("Minecraft Launcher"));
    }
    let store_content: Vec<PathBuf> = sys::local_drives().into_iter().map(|d| d.join("XboxGames").join("Minecraft Launcher").join("Content")).collect();
    let store_data = local.map(|l| l.join("Packages").join(MINECRAFT_STORE_PFN));
    detect_minecraft_from(&classic, &store_content, store_data.as_deref())
}

// ------------------------------------------------------------------------------- .lnk files

#[derive(Debug, PartialEq)]
pub struct LnkInfo {
    pub target: String,
    pub args: String,
}

fn u16_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u16::from_le_bytes([*b.get(o)?, *b.get(o + 1)?]) as usize)
}
fn u32_at(b: &[u8], o: usize) -> Option<usize> {
    Some(u32::from_le_bytes([*b.get(o)?, *b.get(o + 1)?, *b.get(o + 2)?, *b.get(o + 3)?]) as usize)
}

/// Minimal Shell Link (.lnk) reader: target path and arguments, nothing is resolved or run.
pub fn parse_lnk(b: &[u8]) -> Option<LnkInfo> {
    if b.len() < 0x4C || u32_at(b, 0)? != 0x4C {
        return None;
    }
    let flags = u32_at(b, 0x14)? as u32;
    let unicode = flags & 0x80 != 0;
    let mut pos = 0x4C;
    if flags & 0x01 != 0 {
        pos += 2 + u16_at(b, pos)?; // LinkTargetIDList
    }
    let mut target = String::new();
    if flags & 0x02 != 0 {
        let start = pos;
        let size = u32_at(b, start)?;
        let header = u32_at(b, start + 4)?;
        let info_flags = u32_at(b, start + 8)?;
        if info_flags & 1 != 0 {
            let wide_off = if header >= 0x24 { u32_at(b, start + 28) } else { None };
            if let Some(off) = wide_off.filter(|o| *o != 0) {
                let mut units = Vec::new();
                let mut p = start + off;
                while let (Some(lo), Some(hi)) = (b.get(p), b.get(p + 1)) {
                    let u = u16::from_le_bytes([*lo, *hi]);
                    if u == 0 {
                        break;
                    }
                    units.push(u);
                    p += 2;
                }
                target = String::from_utf16_lossy(&units);
            } else {
                let off = u32_at(b, start + 16)?;
                let tail = b.get(start + off..)?;
                let end = tail.iter().position(|&c| c == 0)?;
                target = String::from_utf8_lossy(&tail[..end]).to_string();
            }
        }
        pos = start + size;
    }
    let mut args = String::new();
    // StringData: name, relative path, working dir, arguments, icon (each only when flagged).
    for (bit, is_args) in [(0x04u32, false), (0x08, false), (0x10, false), (0x20, true), (0x40, false)] {
        if flags & bit == 0 {
            continue;
        }
        let count = u16_at(b, pos)?;
        pos += 2;
        let len = if unicode { count * 2 } else { count };
        let raw = b.get(pos..pos + len)?;
        if is_args {
            args = if unicode {
                String::from_utf16_lossy(&raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>())
            } else {
                String::from_utf8_lossy(raw).to_string()
            };
        }
        pos += len;
    }
    if target.is_empty() {
        return None;
    }
    Some(LnkInfo { target, args })
}

// ------------------------------------------------------------------------------- Start Menu

/// Publisher folders in the Start Menu that hold games (not launchers or tools).
const GAME_PUBLISHER_FOLDERS: &[&str] = &[
    "riotgames", "telltalegames", "rockstargames", "blizzardentertainment", "bethesdasoftworks", "2k", "activision",
    "cdprojektred", "squareenix", "bandainamcoentertainment", "sega", "capcom", "konami", "paradoxinteractive",
    "mojang", "xboxgames", "ubisoft", "eagames", "electronicarts",
];

fn start_menu_name_is_not_a_game(name: &str) -> bool {
    let n = name.to_lowercase();
    ["uninstall", "updater", "error reporter", "riot client", "connect", "launcher", "settings", "support", "readme", "manual", "website", "help", "editor", "configuration", "crash", "recovery", "galaxy", "steam"]
        .iter()
        .any(|w| n.contains(w))
}

pub fn detect_start_menu_from(program_dirs: &[PathBuf]) -> Vec<Detected> {
    let mut out: Vec<Detected> = Vec::new();
    for base in program_dirs {
        let Ok(rd) = fs::read_dir(base) else { continue };
        for publisher in rd.flatten() {
            let Ok(meta) = publisher.metadata() else { continue };
            if !meta.is_dir() || sys::is_reparse_point(&meta) {
                continue;
            }
            let pub_name = normalize(&publisher.file_name().to_string_lossy());
            if !GAME_PUBLISHER_FOLDERS.contains(&pub_name.as_str()) {
                continue;
            }
            // `<Publisher>\<Game>.lnk` or `<Publisher>\<Game>\<Game>.lnk`
            let mut lnks: Vec<PathBuf> = Vec::new();
            if let Ok(inner) = fs::read_dir(publisher.path()) {
                for e in inner.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        if let Ok(deeper) = fs::read_dir(&p) {
                            lnks.extend(deeper.flatten().map(|d| d.path()));
                        }
                    } else {
                        lnks.push(p);
                    }
                }
            }
            for lnk in lnks.into_iter().filter(|p| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("lnk"))) {
                let stem = lnk.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if stem.is_empty() || start_menu_name_is_not_a_game(&stem) {
                    continue;
                }
                let Some(info) = fs::read(&lnk).ok().and_then(|b| parse_lnk(&b)) else { continue };
                let target = PathBuf::from(&info.target);
                let tstem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if !target.is_file() || !target.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) || looks_like_non_game(tstem) {
                    continue;
                }
                // Launcher-style targets (Riot, Ubisoft…) start the real game later, so the folder they
                // live in says nothing about whether the game is running: don't claim to track it.
                let launcher_like = ["client", "services", "bootstrap", "launcher"].iter().any(|w| tstem.to_lowercase().contains(w));
                let (launch, install_dir) = if launcher_like || !info.args.is_empty() {
                    (DetectedLaunch::Shortcut(lnk.clone()), if launcher_like { None } else { target.parent().map(Path::to_path_buf) })
                } else {
                    (DetectedLaunch::Exe { path: target.clone(), args: String::new() }, target.parent().map(Path::to_path_buf))
                };
                let title = clean_title(&stem);
                if out.iter().any(|d| normalize(&d.title) == normalize(&title)) {
                    continue;
                }
                out.push(Detected {
                    source: "startmenu",
                    external_id: stem,
                    title,
                    install_dir,
                    launch,
                    steam_app_id: None,
                    icon_exe: Some(target),
                    name_hints: vec![],
                });
            }
        }
    }
    out
}

pub fn detect_start_menu() -> Vec<Detected> {
    let mut dirs = Vec::new();
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(p) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    detect_start_menu_from(&dirs)
}

// -------------------------------------------------------------- extra folders in the library

fn looks_like_guid(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 36 && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-') && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn split_camel(s: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        out.push(c);
    }
    out
}

/// Folders in the library root that are not one of the catalogue games but contain a game program.
pub fn detect_library_extras(root: &Path) -> Vec<Detected> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(root) else { return out };
    for child in rd.flatten() {
        let Ok(meta) = child.metadata() else { continue };
        let name = child.file_name().to_string_lossy().to_string();
        if !meta.is_dir() || sys::is_reparse_point(&meta) || looks_like_guid(&name) || name.starts_with(['.', '$']) {
            continue;
        }
        if CATALOG.iter().any(|d| d.folder_matches(&name)) {
            continue; // handled by the catalogue scan
        }
        let lower = name.to_lowercase();
        if ["wallpaper", "installer", "driver", "redist", "backup", "utility", "utilities", "sdk"].iter().any(|w| lower.contains(w)) {
            continue; // obviously not a game; anything else can be hidden from the library by hand
        }
        let profile = GameProfile::from_title(&name);
        let mut budget = 20_000usize;
        let mut best: Option<(i32, u64, PathBuf)> = None;
        for (exe, rel) in collect_exes(&child.path(), 4, &mut budget, true) {
            let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if looks_like_non_game(&stem) {
                continue;
            }
            let size = fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
            if size < 300 * 1024 {
                continue;
            }
            let score = super::discovery::score_exe(&profile, &rel, &stem, &Default::default()).map(|(s, _)| s).unwrap_or(-100);
            if score < -40 || !is_pe_file(&exe) {
                continue;
            }
            if best.as_ref().is_none_or(|(bs, bz, _)| (score, size) > (*bs, *bz)) {
                best = Some((score, size, exe));
            }
        }
        let Some((_, _, exe)) = best else { continue };
        let info = sys::read_version_info(&exe);
        let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let product = info.product_name.filter(|p| (2..=60).contains(&p.len()) && !p.to_lowercase().contains("unity"));
        let title = clean_title(&product.clone().unwrap_or_else(|| name.clone()));
        let mut hints = vec![name.clone(), split_camel(&stem)];
        hints.extend(product);
        out.push(Detected {
            source: "library",
            external_id: name,
            title,
            install_dir: Some(child.path()),
            launch: DetectedLaunch::Exe { path: exe.clone(), args: String::new() },
            steam_app_id: None,
            icon_exe: Some(exe),
            name_hints: hints,
        });
    }
    out
}

/// Fast detectors (no big directory walks): safe to run at every start.
pub fn detect_quick() -> Vec<Detected> {
    let mut out = detect_steam();
    out.extend(detect_epic());
    out.extend(detect_roblox(&[]));
    out.extend(detect_minecraft());
    out.extend(detect_oneclient(None));
    out.extend(detect_start_menu());
    out
}

/// Everything, including extra game folders inside the library root.
pub fn detect_all(library_root: Option<&Path>) -> Vec<Detected> {
    let mut out = detect_quick();
    if let Some(root) = library_root {
        // The library folder is the one place OneClient can be that `detect_quick` doesn't look.
        if !out.iter().any(|d| d.source == "minecraft" && d.external_id == "oneclient") {
            out.extend(detect_oneclient(Some(root)));
        }
        out.extend(detect_library_extras(root));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::validation::fake_exe;

    #[test]
    fn slugs_are_stable_and_safe() {
        assert_eq!(slugify("Five Nights at Freddy's 2"), "five-nights-at-freddy-s-2");
        assert_eq!(slugify("  ../Weird//Name!! "), "weird-name");
        let d = Detected { source: "steam", external_id: "4000".into(), title: "x".into(), install_dir: None, launch: DetectedLaunch::Uri("steam://rungameid/4000".into()), steam_app_id: Some(4000), icon_exe: None, name_hints: vec![] };
        assert_eq!(d.slug(), "steam-4000");
    }

    #[test]
    fn vdf_parses_nested_maps_and_escapes() {
        let v = parse_vdf("\"libraryfolders\"\n{\n  \"0\" { \"path\" \"C:\\\\Steam\" \"apps\" { \"1\" \"2\" } }\n  // comment\n  \"1\" { \"path\" \"D:\\\\Lib\" }\n}").unwrap();
        let lf = v.get("libraryfolders").unwrap();
        assert_eq!(lf.entries().len(), 2);
        assert_eq!(lf.get("0").unwrap().str("path"), Some(r"C:\Steam"));
        assert_eq!(lf.get("1").unwrap().str("PATH"), Some(r"D:\Lib"));
        assert!(parse_vdf("\"a\" { \"b\"").is_some() || parse_vdf("\"a\" { \"b\"").is_none()); // must not panic
        assert!(parse_vdf("}").is_none());
    }

    fn steam_fixture(dir: &Path) {
        let lib2 = dir.join("Second Library");
        std::fs::create_dir_all(dir.join("steamapps")).unwrap();
        std::fs::write(
            dir.join("steamapps").join("libraryfolders.vdf"),
            format!("\"libraryfolders\"\n{{\n \"0\" {{ \"path\" \"{}\" }}\n \"1\" {{ \"path\" \"{}\" }}\n}}", dir.display().to_string().replace('\\', "\\\\"), lib2.display().to_string().replace('\\', "\\\\")),
        )
        .unwrap();
        let acf = |id: i64, name: &str, installdir: &str, flags: u32| {
            format!("\"AppState\"\n{{\n\t\"appid\"\t\"{id}\"\n\t\"name\"\t\"{name}\"\n\t\"installdir\"\t\"{installdir}\"\n\t\"StateFlags\"\t\"{flags}\"\n}}")
        };
        let add = |lib: &Path, id: i64, name: &str, installdir: &str, flags: u32, make_dir: bool| {
            std::fs::create_dir_all(lib.join("steamapps").join("common")).unwrap();
            std::fs::write(lib.join("steamapps").join(format!("appmanifest_{id}.acf")), acf(id, name, installdir, flags)).unwrap();
            if make_dir {
                std::fs::create_dir_all(lib.join("steamapps").join("common").join(installdir)).unwrap();
            }
        };
        add(dir, 228980, "Steamworks Common Redistributables", "Steamworks Shared", 4, true); // tool
        add(&lib2, 4000, "Garry's Mod", "GarrysMod", 4, true); // game on a second library
        add(&lib2, 438100, "VRChat", "VRChat", 4, true);
        add(&lib2, 111, "Half Installed", "Half", 1026, true); // downloading
        add(&lib2, 222, "Folder Missing", "Gone", 4, false); // files deleted
        add(dir, 391540, "UNDERTALE", "Undertale", 4, true);
    }

    #[test]
    fn steam_games_come_from_every_library_and_tools_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("Steam");
        steam_fixture(&root);
        let found = detect_steam_from(&root);
        let mut titles: Vec<_> = found.iter().map(|g| g.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["Garry's Mod", "UNDERTALE", "VRChat"]);
        let gmod = found.iter().find(|g| g.steam_app_id == Some(4000)).unwrap();
        assert_eq!(gmod.launch, DetectedLaunch::Uri("steam://rungameid/4000".into()));
        assert!(gmod.install_dir.as_ref().unwrap().ends_with("GarrysMod"));
        assert_eq!(gmod.slug(), "steam-4000");
    }

    #[test]
    fn epic_games_use_manifest_ids_and_skip_content_packs() {
        let d = tempfile::tempdir().unwrap();
        let game = d.path().join("Games").join("Cool Game");
        std::fs::create_dir_all(&game).unwrap();
        let man = d.path().join("Manifests");
        std::fs::create_dir_all(&man).unwrap();
        let item = |display: &str, app: &str, main: &str, exe: &str| {
            format!(
                "\u{feff}{{\"DisplayName\":\"{display}\",\"AppName\":\"{app}\",\"MainGameAppName\":\"{main}\",\"InstallLocation\":{loc},\"LaunchExecutable\":\"{exe}\",\"CatalogNamespace\":\"ns1\",\"CatalogItemId\":\"item9\"}}",
                loc = serde_json::to_string(&game.display().to_string()).unwrap()
            )
        };
        std::fs::write(man.join("a.item"), item("Cool Game®", "CoolApp", "CoolApp", "Bin/Cool.exe")).unwrap();
        std::fs::write(man.join("b.item"), item("Cool Game Content", "ContentApp", "CoolApp", "")).unwrap();
        std::fs::write(man.join("c.item"), "not json").unwrap();
        let found = detect_epic_from(&man);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Cool Game");
        assert_eq!(found[0].launch, DetectedLaunch::Uri("com.epicgames.launcher://apps/ns1%3Aitem9%3ACoolApp?action=launch&silent=true".into()));
        assert!(crate::games::validation::validate_platform_uri(match &found[0].launch { DetectedLaunch::Uri(u) => u, _ => unreachable!() }).is_ok());
    }

    #[test]
    fn roblox_picks_the_newest_player_install() {
        let d = tempfile::tempdir().unwrap();
        let versions = d.path().join("Versions");
        fake_exe(&versions.join("version-old").join("RobloxPlayerBeta.exe"));
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fake_exe(&versions.join("version-new").join("RobloxPlayerBeta.exe"));
        fake_exe(&versions.join("version-studio").join("RobloxStudioBeta.exe"));
        let r = detect_roblox_from(&[versions.clone(), d.path().join("missing")]).unwrap();
        assert_eq!(r.title, "Roblox");
        assert!(r.install_dir.unwrap().ends_with("version-new"));
        assert!(detect_roblox_from(&[d.path().join("nothing")]).is_none());
    }

    #[test]
    fn roblox_prefers_electricity_and_falls_back_to_the_normal_install() {
        let d = tempfile::tempdir().unwrap();
        let electricity = d.path().join("Electricity").join("Versions");
        let normal = d.path().join("Roblox").join("Versions");
        // The normal install is *newer* — Electricity must still win when both exist.
        fake_exe(&electricity.join("version-e").join("RobloxPlayerBeta.exe"));
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fake_exe(&normal.join("version-n").join("RobloxPlayerBeta.exe"));
        let roots = [electricity.clone(), normal.clone()];
        let both = detect_roblox_from(&roots).unwrap();
        assert!(both.install_dir.as_ref().unwrap().ends_with("version-e"), "{:?}", both.install_dir);

        // Without Electricity (missing, or present but with no player in it) the normal install is used.
        let none = d.path().join("no-electricity").join("Versions");
        assert!(detect_roblox_from(&[none, normal.clone()]).unwrap().install_dir.unwrap().ends_with("version-n"));
        std::fs::create_dir_all(electricity.join("version-studio-only")).unwrap();
        std::fs::remove_dir_all(electricity.join("version-e")).unwrap();
        assert!(detect_roblox_from(&roots).unwrap().install_dir.unwrap().ends_with("version-n"));
    }

    #[test]
    fn electricity_is_used_when_installed_and_tracked_by_its_whole_folder() {
        let d = tempfile::tempdir().unwrap();
        let el = d.path().join("Electricity");
        fake_exe(&el.join("Electricity.exe"));
        fake_exe(&el.join("Versions").join("version-x").join("RobloxPlayerBeta.exe"));
        let e = detect_electricity_from(&el).unwrap();
        assert_eq!(e.title, "Electricity");
        assert!(matches!(&e.launch, DetectedLaunch::Exe { path, .. } if path.ends_with("Electricity.exe")), "launches Electricity itself, not the raw player");
        assert_eq!(e.install_dir.as_deref(), Some(el.as_path()), "the whole folder counts as 'running'");
        assert_eq!(e.slug(), "roblox-player", "same library entry as Roblox");

        // Not installed: no folder, or an Electricity.exe that is not a real program.
        assert!(detect_electricity_from(&d.path().join("nope")).is_none());
        let fake = d.path().join("fake");
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::write(fake.join("Electricity.exe"), b"not a program").unwrap();
        assert!(detect_electricity_from(&fake).is_none());
    }

    /// Builds a Shell Link with a unicode LinkInfo path and unicode arguments.
    fn make_lnk(target: &str, args: &str) -> Vec<u8> {
        let mut b = vec![0u8; 0x4C];
        b[0] = 0x4C;
        let flags: u32 = 0x02 | 0x20 | 0x80; // HasLinkInfo | HasArguments | IsUnicode
        b[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        let wide: Vec<u8> = target.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect();
        let header = 0x24usize;
        let wide_off = header + 1; // ANSI base path is a single NUL
        let size = wide_off + wide.len();
        let mut info = vec![0u8; header];
        info[0..4].copy_from_slice(&(size as u32).to_le_bytes());
        info[4..8].copy_from_slice(&(header as u32).to_le_bytes());
        info[8..12].copy_from_slice(&1u32.to_le_bytes());
        info[16..20].copy_from_slice(&(header as u32).to_le_bytes());
        info[28..32].copy_from_slice(&(wide_off as u32).to_le_bytes());
        info.push(0);
        info.extend(wide);
        b.extend(info);
        let a: Vec<u16> = args.encode_utf16().collect();
        b.extend((a.len() as u16).to_le_bytes());
        b.extend(a.iter().flat_map(|u| u.to_le_bytes()));
        b
    }

    #[test]
    fn lnk_target_and_arguments_are_read_without_running_anything() {
        let info = parse_lnk(&make_lnk(r"C:\Riot Games\Riot Client\RiotClientServices.exe", "--launch-product=valorant --launch-patchline=live")).unwrap();
        assert_eq!(info.target, r"C:\Riot Games\Riot Client\RiotClientServices.exe");
        assert_eq!(info.args, "--launch-product=valorant --launch-patchline=live");
        assert!(parse_lnk(b"not a shortcut").is_none());
        assert!(parse_lnk(&[0x4C; 10]).is_none());
        let mut truncated = make_lnk(r"C:\a.exe", "x");
        truncated.truncate(0x4C + 10);
        assert!(parse_lnk(&truncated).is_none());
    }

    #[test]
    fn start_menu_finds_games_but_not_launchers_or_uninstallers() {
        let d = tempfile::tempdir().unwrap();
        let programs = d.path().join("Programs");
        let game_dir = d.path().join("Telltale").join("Story Mode");
        fake_exe(&game_dir.join("StoryMode.exe"));
        let client = d.path().join("Riot").join("RiotClientServices.exe");
        fake_exe(&client);
        let tell = programs.join("Telltale Games").join("Story Mode");
        std::fs::create_dir_all(&tell).unwrap();
        std::fs::write(tell.join("Story Mode.lnk"), make_lnk(&game_dir.join("StoryMode.exe").display().to_string(), "")).unwrap();
        std::fs::write(tell.join("Uninstall Story Mode.lnk"), make_lnk(&game_dir.join("StoryMode.exe").display().to_string(), "")).unwrap();
        let riot = programs.join("Riot Games");
        std::fs::create_dir_all(&riot).unwrap();
        std::fs::write(riot.join("VALORANT.lnk"), make_lnk(&client.display().to_string(), "--launch-product=valorant")).unwrap();
        std::fs::write(riot.join("Riot Client.lnk"), make_lnk(&client.display().to_string(), "")).unwrap();
        let other = programs.join("Some Tool");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("Tool.lnk"), make_lnk(&game_dir.join("StoryMode.exe").display().to_string(), "")).unwrap();

        let found = detect_start_menu_from(&[programs]);
        let mut titles: Vec<_> = found.iter().map(|g| g.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["Story Mode", "VALORANT"]);
        let story = found.iter().find(|g| g.title == "Story Mode").unwrap();
        assert!(matches!(story.launch, DetectedLaunch::Exe { .. }) && story.install_dir.is_some());
        let val = found.iter().find(|g| g.title == "VALORANT").unwrap();
        assert!(matches!(val.launch, DetectedLaunch::Shortcut(_)));
        assert!(val.install_dir.is_none(), "launcher-style targets must not be tracked by folder");
    }

    #[test]
    fn library_extras_skip_catalogue_games_guids_and_support_files() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let big = |p: PathBuf| {
            fake_exe(&p);
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_len(400 * 1024).unwrap();
        };
        big(root.join("FNAF 2").join("Five Nights at Freddy's 2").join("FiveNightsatFreddys2.exe"));
        big(root.join("ZenlessZoneZero").join("Content").join("ZenlessZoneZero.exe"));
        big(root.join("ZenlessZoneZero").join("Content").join("gamelaunchhelper.exe"));
        big(root.join("UNDERTALE").join("Undertale").join("UNDERTALE.exe")); // catalogue — must be skipped
        big(root.join("21B40136-2FDB-404B-BE34-4656E6A88528").join("thing.exe"));
        std::fs::create_dir_all(root.join("Empty Folder")).unwrap();
        fake_exe(&root.join("Tiny").join("tiny.exe")); // too small to be a game
        let found = detect_library_extras(root);
        let mut titles: Vec<_> = found.iter().map(|g| g.external_id.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["FNAF 2", "ZenlessZoneZero"]);
        let zzz = found.iter().find(|g| g.external_id == "ZenlessZoneZero").unwrap();
        assert!(matches!(&zzz.launch, DetectedLaunch::Exe { path, .. } if path.ends_with("ZenlessZoneZero.exe")));
        let fnaf = found.iter().find(|g| g.external_id == "FNAF 2").unwrap();
        assert!(fnaf.name_hints.iter().any(|h| h == "Five Nights at Freddys2" || h == "FNAF 2"));
    }

    #[test]
    fn oneclient_is_found_only_where_its_program_really_is() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Library");
        assert!(detect_oneclient_from(&two_levels_below(&root)).is_none(), "nothing installed, nothing added");

        fake_exe(&root.join("MC Launchers").join("Prism").join("prismlauncher.exe"));
        assert!(detect_oneclient_from(&two_levels_below(&root)).is_none(), "another launcher is not OneClient");

        // OneClient's data folder sits next to Prism in the library but has no program in it.
        let oneclient = root.join("MC Launchers").join("OneClient");
        std::fs::create_dir_all(oneclient.join("clusters")).unwrap();
        assert!(detect_oneclient_from(&two_levels_below(&root)).is_none(), "a data folder is not the program");

        std::fs::write(oneclient.with_file_name("not-a-program.txt"), b"x").unwrap();
        fake_exe(&oneclient.join("oneclient_app.exe"));
        let d = detect_oneclient_from(&two_levels_below(&root)).expect("found two levels below the library folder");
        assert_eq!((d.source, d.title.as_str(), d.slug().as_str()), ("minecraft", "OneClient", "minecraft-oneclient"));
        assert_eq!(d.install_dir.as_deref(), Some(oneclient.as_path()));
        assert_eq!(d.launch, DetectedLaunch::Exe { path: oneclient.join("oneclient_app.exe"), args: String::new() });

        // A text file called "oneclient_app.exe" is not a program.
        let fake = dir.path().join("Other");
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::write(fake.join("oneclient_app.exe"), b"hello").unwrap();
        assert!(detect_oneclient_from(&[fake]).is_none());
    }

    #[test]
    fn minecraft_launcher_classic_store_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (classic, store, data) = (dir.path().join("Minecraft Launcher"), dir.path().join("XboxGames").join("Minecraft Launcher").join("Content"), dir.path().join("Packages").join("pkg"));
        assert!(detect_minecraft_from(&[classic.clone()], &[store.clone()], Some(&data)).is_none(), "nothing there");

        std::fs::create_dir_all(&data).unwrap();
        let d = detect_minecraft_from(&[classic.clone()], &[store.clone()], Some(&data)).unwrap();
        assert!(matches!(&d.launch, DetectedLaunch::Uri(u) if u == r"shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"));
        assert!(d.install_dir.is_none(), "unreadable WindowsApps install has no folder to watch");

        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("Minecraft.exe"), b"x").unwrap();
        let d = detect_minecraft_from(&[classic.clone()], &[store.clone()], None).unwrap();
        assert_eq!((d.title.as_str(), d.install_dir.as_deref()), ("Minecraft", Some(store.as_path())));
        assert!(matches!(d.launch, DetectedLaunch::Uri(_)));

        fake_exe(&classic.join("MinecraftLauncher.exe"));
        let d = detect_minecraft_from(&[classic.clone()], &[store], None).unwrap();
        assert_eq!(d.launch, DetectedLaunch::Exe { path: classic.join("MinecraftLauncher.exe"), args: String::new() }, "a classic install is launched directly");
        assert_eq!(d.slug(), "minecraft-launcher");
    }

    /// Parses real shortcuts on this PC: `cargo test real_lnk_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_lnk_probe() {
        let mut bases = Vec::new();
        for var in ["ProgramData", "APPDATA"] {
            if let Some(v) = std::env::var_os(var) {
                bases.push(PathBuf::from(v).join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
            }
        }
        for base in bases {
            let mut stack = vec![base];
            while let Some(d) = stack.pop() {
                for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().is_some_and(|x| x == "lnk") {
                        let r = fs::read(&p).ok().and_then(|b| parse_lnk(&b));
                        println!("LNK {} => {:?}", p.file_name().unwrap().to_string_lossy(), r);
                    }
                }
            }
        }
    }

    /// Manual, read-only probe of this PC: `cargo test real_detection_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_detection_probe() {
        for d in detect_all(Some(Path::new(r"E:\bbsgames"))) {
            println!("{:<10} {:<40} {:?}  dir={:?}", d.source, d.title, d.launch, d.install_dir);
        }
    }
}
