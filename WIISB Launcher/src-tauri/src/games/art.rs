//! Cover art. Covers are looked up on Steam's public store by game title (or by the Steam app id we
//! already know) and cached in the launcher's own data folder. Only HTTPS requests to Steam's
//! hosts are made, responses are size-capped and checked by content, and nothing is sent except the
//! game's title.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::catalog::{normalize, GameProfile};
use super::discovery::{collect_exes, score_exe};
use super::validation::looks_like_non_game;
use super::service::image_extension;
use crate::database::models::Game;
use crate::database::Db;
use crate::error::{AppError, AppResult};
use crate::platform::{icon, sys};

const ALLOWED_HOSTS: &[&str] = &["store.steampowered.com", "cdn.cloudflare.steamstatic.com", "shared.akamai.steamstatic.com", "cdn.akamai.steamstatic.com"];
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 512 * 1024;

fn host_allowed(url: &str) -> bool {
    url.strip_prefix("https://").map(|rest| rest.split('/').next().unwrap_or("")).is_some_and(|h| ALLOWED_HOSTS.contains(&h))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .max_redirects(0) // a redirect could leave the allow-list
        .user_agent("WIISB-Games/1.0 (local game launcher)")
        .build()
        .into()
}

/// `Ok(None)` for 404 (not available), `Err` for network/other failures.
fn fetch(url: &str, max: u64) -> Result<Option<Vec<u8>>, String> {
    if !host_allowed(url) {
        return Err("blocked: host is not on the allow-list".into());
    }
    let mut resp = agent().get(url).call().map_err(|e| e.to_string())?;
    match resp.status().as_u16() {
        200 => {}
        404 | 403 => return Ok(None),
        s => return Err(format!("HTTP {s}")),
    }
    resp.body_mut().with_config().limit(max).read_to_vec().map(Some).map_err(|e| e.to_string())
}

pub fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Choose the store result that really is this game: an exact title match, or one title containing the
/// other with similar length. Anything vaguer is rejected — a wrong cover is worse than none.
pub fn pick_best(term: &str, items: &[(i64, String)]) -> Option<(i64, String)> {
    let t = normalize(term);
    if t.len() < 3 {
        return None;
    }
    if let Some(hit) = items.iter().find(|(_, n)| normalize(n) == t) {
        return Some(hit.clone());
    }
    items
        .iter()
        .find(|(_, n)| {
            let n = normalize(n);
            let (long, short) = if n.len() >= t.len() { (&n, &t) } else { (&t, &n) };
            short.len() >= 5 && long.starts_with(short.as_str()) && long.len() - short.len() <= 6
        })
        .cloned()
}

pub fn steam_search(term: &str) -> Result<Option<(i64, String)>, String> {
    let url = format!("https://store.steampowered.com/api/storesearch/?term={}&cc=us&l=en", url_encode(term));
    let Some(bytes) = fetch(&url, MAX_JSON_BYTES)? else { return Ok(None) };
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let items: Vec<(i64, String)> = v
        .get("items")
        .and_then(|i| i.as_array())
        .map(|a| {
            a.iter()
                .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("app"))
                .filter_map(|i| Some((i.get("id")?.as_i64()?, i.get("name")?.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(pick_best(term, &items))
}

fn cdn(app: i64, file: &str) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/{file}")
}

fn first_image(urls: &[String]) -> Result<Option<(Vec<u8>, &'static str)>, String> {
    for u in urls {
        if let Some(bytes) = fetch(u, MAX_IMAGE_BYTES)? {
            if let Some(ext) = image_extension(&bytes[..bytes.len().min(16)]) {
                return Ok(Some((bytes, ext)));
            }
        }
    }
    Ok(None)
}

/// Delete an old managed file (only inside the launcher's artwork folder).
fn remove_owned(art_dir: &Path, path: Option<&str>) {
    if let Some(p) = path.map(Path::new) {
        if p.parent() == Some(art_dir) {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn camel_split(s: &str) -> String {
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

/// Alternative names to search: the title plus the executable's name split into words.
fn search_terms(game: &Game) -> Vec<String> {
    let mut v = vec![game.title.clone()];
    if let Some(stem) = game.launch_target.as_deref().map(Path::new).and_then(|p| p.file_stem()).and_then(|s| s.to_str()) {
        if game.launch_method == "direct" {
            let t = camel_split(stem);
            if t.len() > 4 && !v.iter().any(|x| normalize(x) == normalize(&t)) {
                v.push(t);
            }
        }
    }
    v
}

#[derive(Debug, Default, PartialEq)]
pub struct ArtResult {
    pub cover: bool,
    pub hero: bool,
    pub icon: bool,
}

/// Fill in artwork for one game: Steam cover + hero banner, then a local exe icon as a fallback.
/// Never overwrites artwork the user chose themselves. A network failure leaves the game "not yet tried".
pub fn fetch_for_game(db: &Db, art_dir: &Path, game: &Game) -> AppResult<ArtResult> {
    std::fs::create_dir_all(art_dir)?;
    let mut result = ArtResult::default();

    // Local icon first: it works offline and is the fallback when no cover exists.
    if game.icon_path.is_none() {
        result.icon = ensure_icon(db, art_dir, game, false);
    }

    // Roblox / Electricity / OneClient / Minecraft are not Steam games: a title search could only ever pick a wrong cover.
    if matches!(game.source.as_str(), "roblox" | "minecraft") {
        db.set_art_attempted(&game.slug, true)?;
        return Ok(result);
    }

    let app = match game.steam_app_id {
        Some(id) => Some(id),
        None => {
            let mut found = None;
            for term in search_terms(game) {
                match steam_search(&term) {
                    Ok(Some((id, name))) => {
                        log::info!("cover lookup: \"{term}\" -> Steam app {id} ({name})");
                        found = Some(id);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => return Err(AppError::Io(format!("cover lookup failed: {e}"))),
                }
            }
            if let Some(id) = found {
                db.set_steam_app_id(&game.slug, Some(id))?;
            }
            found
        }
    };
    let Some(app) = app else {
        db.set_art_attempted(&game.slug, true)?;
        return Ok(result);
    };

    if game.artwork_path.is_none() {
        let urls = [
            cdn(app, "library_600x900_2x.jpg"),
            cdn(app, "library_600x900.jpg"),
            cdn(app, "header.jpg"),
            cdn(app, "capsule_616x353.jpg"),
            cdn(app, "capsule_467x181.jpg"),
        ];
        if let Some((bytes, ext)) = first_image(&urls).map_err(|e| AppError::Io(format!("cover download failed: {e}")))? {
            let dest = art_dir.join(format!("{}-cover-{app}.{ext}", game.slug));
            std::fs::write(&dest, bytes)?;
            db.set_artwork(&game.slug, Some(&sys::clean_path(&dest)))?;
            result.cover = true;
        }
    }
    if game.hero_path.is_none() {
        let urls = [cdn(app, "library_hero.jpg"), cdn(app, "page_bg_generated_v6b.jpg")];
        if let Some((bytes, ext)) = first_image(&urls).map_err(|e| AppError::Io(format!("banner download failed: {e}")))? {
            let dest = art_dir.join(format!("{}-hero-{app}.{ext}", game.slug));
            std::fs::write(&dest, bytes)?;
            db.set_hero(&game.slug, Some(&sys::clean_path(&dest)))?;
            result.hero = true;
        }
    }
    db.set_art_attempted(&game.slug, true)?;
    Ok(result)
}

/// The program whose icon represents this game: its own executable when it launches one directly;
/// otherwise (with `allow_scan`) the most plausible program inside its installation folder.
fn icon_source(game: &Game, allow_scan: bool) -> Option<PathBuf> {
    if let Some(t) = game.launch_target.as_deref() {
        if game.launch_method == "direct" && t.to_ascii_lowercase().ends_with(".exe") {
            return Some(PathBuf::from(t));
        }
    }
    let dir = Path::new(game.installation_path.as_deref()?);
    if !allow_scan || !dir.is_dir() {
        return None;
    }
    let profile = GameProfile::from_title(&game.title);
    let mut budget = 4_000usize;
    let mut best: Option<(i32, u64, PathBuf)> = None;
    for (exe, rel) in collect_exes(dir, 3, &mut budget, true) {
        let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if looks_like_non_game(stem) {
            continue;
        }
        let size = std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
        let score = score_exe(&profile, &rel, stem, &Default::default()).map(|(s, _)| s).unwrap_or(-100);
        if size >= 300 * 1024 && score > -40 && best.as_ref().is_none_or(|(bs, bz, _)| (score, size) > (*bs, *bz)) {
            best = Some((score, size, exe));
        }
    }
    best.map(|(_, _, p)| p)
}

/// Microsoft Store / Xbox app packages keep their programs unreadable but ship the app's own logo next to them
/// (e.g. the Minecraft Launcher's creeper). Used when no icon can be taken from a program.
fn package_logo(game: &Game) -> Option<Vec<u8>> {
    let dir = Path::new(game.installation_path.as_deref()?);
    ["SmallLogo.altform-unplated_targetsize-256.png", "SmallLogo.scale-400.png", "StoreLogo.scale-400.png", "SmallLogo.png"].iter().find_map(|name| {
        let bytes = std::fs::read(dir.join(name)).ok()?;
        (bytes.len() <= 512 * 1024 && image_extension(&bytes[..bytes.len().min(16)]) == Some("png")).then_some(bytes)
    })
}

pub fn ensure_icon(db: &Db, art_dir: &Path, game: &Game, allow_scan: bool) -> bool {
    let from_program = icon_source(game, allow_scan).and_then(|exe| icon::extract_icon_png(&exe, 256));
    let Some(png) = from_program.or_else(|| package_logo(game)) else { return false };
    let dest = art_dir.join(format!("{}-icon.png", game.slug));
    if std::fs::write(&dest, png).is_err() {
        return false;
    }
    remove_owned(art_dir, game.icon_path.as_deref().filter(|p| Path::new(p) != dest));
    db.set_icon(&game.slug, Some(&sys::clean_path(&dest))).is_ok()
}

/// Remove covers/banners we downloaded for a game (used when the user resets artwork).
pub fn forget_downloaded(art_dir: &Path, game: &Game) {
    remove_owned(art_dir, game.hero_path.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_steam_hosts_are_allowed() {
        assert!(host_allowed("https://store.steampowered.com/api/storesearch/?term=x"));
        assert!(host_allowed("https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg"));
        assert!(!host_allowed("http://store.steampowered.com/"));
        assert!(!host_allowed("https://evil.example/steam.jpg"));
        assert!(!host_allowed("https://store.steampowered.com.evil.example/x"));
        assert!(!host_allowed("https://cdn.cloudflare.steamstatic.com@evil.example/x"));
        assert!(!host_allowed("file:///C:/secret.txt"));
        assert!(fetch("https://example.com/x.png", 10).is_err(), "must refuse before any request");
    }

    #[test]
    fn url_encoding_is_safe() {
        assert_eq!(url_encode("Garry's Mod & more"), "Garry%27s%20Mod%20%26%20more");
        assert_eq!(url_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(url_encode("é"), "%C3%A9");
    }

    #[test]
    fn best_match_is_exact_or_a_close_variant_and_never_a_stranger() {
        let items = vec![(1, "Five Nights at Freddy's 2 Soundtrack".to_string()), (2, "Five Nights at Freddy's 2".to_string()), (3, "Five Nights at Freddy's".to_string())];
        assert_eq!(pick_best("Five Nights at Freddy's 2", &items).unwrap().0, 2);
        assert_eq!(pick_best("five nights at freddys", &items).unwrap().0, 3);
        let vague = vec![(9, "Counter-Strike 2".to_string())];
        assert!(pick_best("Roblox", &vague).is_none());
        assert!(pick_best("ZZ", &items).is_none());
        let longer = vec![(7, "Persona 3 Reload Expansion Pass Deluxe Edition".to_string())];
        assert!(pick_best("Persona 3 Reload", &longer).is_none(), "too different in length");
        let edition = vec![(8, "PEAK".to_string()), (10, "Catto Pew Pew! OG EDITION".to_string())];
        assert_eq!(pick_best("Catto Pew Pew! OG EDITION", &edition).unwrap().0, 10);
    }

    #[test]
    fn exe_names_become_search_terms() {
        assert_eq!(camel_split("FiveNightsatFreddys2"), "Five Nightsat Freddys2");
        assert_eq!(camel_split("ULTRAKILL"), "ULTRAKILL");
    }

    #[test]
    fn store_packages_with_unreadable_programs_use_their_own_logo() {
        let dir = tempfile::tempdir().unwrap();
        let (install, art) = (dir.path().join("XboxGames").join("Minecraft Launcher").join("Content"), dir.path().join("art"));
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&art).unwrap();
        let db = Db::open_memory();
        db.insert_game("minecraft-launcher", "Minecraft", "minecraft", Some("launcher"), None).unwrap();
        db.link_game(
            "minecraft-launcher",
            &crate::database::models::LinkData {
                installation_path: Some(sys::clean_path(&install)),
                launch_target: r"shell:AppsFolder\Pkg!App".into(),
                launch_method: "platform".into(),
                launch_args: String::new(),
                working_dir: None,
                source: "auto",
            },
        )
        .unwrap();
        let game = db.get_game("minecraft-launcher").unwrap();
        assert!(!ensure_icon(&db, &art, &game, true), "no logo and no readable program: no icon");

        std::fs::write(install.join("SmallLogo.scale-400.png"), b"not an image at all").unwrap();
        assert!(!ensure_icon(&db, &art, &game, true), "a file that is not a PNG is never used");

        let png = [&[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], &[0u8; 32][..]].concat();
        std::fs::write(install.join("SmallLogo.scale-400.png"), &png).unwrap();
        assert!(ensure_icon(&db, &art, &game, true));
        let icon = db.get_game("minecraft-launcher").unwrap().icon_path.expect("icon recorded");
        assert_eq!(std::fs::read(&icon).unwrap(), png);
        assert!(Path::new(&icon).starts_with(&art), "copied into the launcher's own folder");
    }

    /// Hits the real Steam store for the four built-in games and writes into a temp folder:
    /// `cargo test real_art_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_art_probe() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_memory();
        for g in db.list_games().unwrap() {
            let r = fetch_for_game(&db, &dir.path().join("art"), &g);
            let after = db.get_game(&g.slug).unwrap();
            println!("ART {:<18} {:?} app={:?} cover={:?}", g.title, r.map(|x| (x.cover, x.hero, x.icon)), after.steam_app_id, after.artwork_path.as_deref().map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
        }
    }
}
