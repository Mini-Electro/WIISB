//! The only four titles this version of WIISB Launcher knows about.
//!
//! The hints below are *scoring hints* used by discovery — they are never treated
//! as guaranteed launch targets. A launch target only exists after a real file has
//! been found on disk and validated (or the user picked it explicitly).

#[derive(Debug)]
pub struct GameDef {
    pub slug: &'static str,
    pub title: &'static str,
    pub sort_order: i64,
    /// Normalised (lowercase alphanumeric) fragments that identify the game's *folder*.
    pub folder_hints: &'static [&'static str],
    /// Normalised fragments that identify a plausible *executable* file stem.
    pub exe_hints: &'static [&'static str],
}

pub const CATALOG: [GameDef; 4] = [
    GameDef {
        slug: "deltarune",
        title: "DELTARUNE",
        sort_order: 0,
        folder_hints: &["deltarune"],
        exe_hints: &["deltarune"],
    },
    GameDef {
        slug: "persona-3-reload",
        title: "Persona 3 Reload",
        sort_order: 1,
        folder_hints: &["persona3reload", "p3r"],
        exe_hints: &["p3r", "persona3reload"],
    },
    GameDef {
        slug: "ultrakill",
        title: "ULTRAKILL",
        sort_order: 2,
        folder_hints: &["ultrakill"],
        exe_hints: &["ultrakill"],
    },
    GameDef {
        slug: "undertale",
        title: "UNDERTALE",
        sort_order: 3,
        folder_hints: &["undertale"],
        exe_hints: &["undertale"],
    },
];

/// What discovery needs to know about *a* game: owned, so it works for any title — the four
/// catalogue games and everything found by detection or added by hand.
#[derive(Debug, Clone)]
pub struct GameProfile {
    pub title: String,
    pub folder_hints: Vec<String>,
    pub exe_hints: Vec<String>,
}

impl GameProfile {
    pub fn from_title(title: &str) -> GameProfile {
        let n = normalize(title);
        GameProfile { title: title.to_string(), folder_hints: vec![n.clone()], exe_hints: vec![n] }
    }

    pub fn title_norm(&self) -> String {
        normalize(&self.title)
    }

    pub fn folder_matches(&self, folder_name: &str) -> bool {
        let n = normalize(folder_name);
        !n.is_empty() && self.folder_hints.iter().any(|h| if h.len() < 5 { n == *h } else { n.contains(h.as_str()) })
    }

    pub fn is_title_folder(&self, folder_name: &str) -> bool {
        let t = self.title_norm();
        !t.is_empty() && normalize(folder_name).contains(&t)
    }
}

/// Profile for any game slug/title: the catalogue entry when it is one of the four, otherwise
/// derived from the title.
pub fn profile_for(slug: &str, title: &str) -> GameProfile {
    find(slug).map(GameDef::profile).unwrap_or_else(|| GameProfile::from_title(title))
}

pub fn find(slug: &str) -> Option<&'static GameDef> {
    CATALOG.iter().find(|g| g.slug == slug)
}

/// Lowercase and keep only alphanumerics: "Persona 3 Reload" -> "persona3reload".
pub fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

impl GameDef {
    pub fn profile(&self) -> GameProfile {
        GameProfile {
            title: self.title.to_string(),
            folder_hints: self.folder_hints.iter().map(|s| s.to_string()).collect(),
            exe_hints: self.exe_hints.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Normalised full title, e.g. "persona3reload".
    pub fn title_norm(&self) -> String {
        normalize(self.title)
    }

    /// Does a folder name plausibly belong to this game?
    /// Short hints ("p3r") must match the whole name; longer ones may be contained in it.
    pub fn folder_matches(&self, folder_name: &str) -> bool {
        let n = normalize(folder_name);
        if n.is_empty() {
            return false;
        }
        self.folder_hints.iter().any(|h| if h.len() < 5 { n == *h } else { n.contains(h) })
    }

    /// Does a folder name contain the game's full title (used to find the true install root)?
    pub fn is_title_folder(&self, folder_name: &str) -> bool {
        normalize(folder_name).contains(&self.title_norm())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_name_variations() {
        assert_eq!(normalize("Persona 3 Reload"), "persona3reload");
        assert_eq!(normalize("Persona3Reload"), "persona3reload");
        assert_eq!(normalize("PERSONA 3 RELOAD"), "persona3reload");
    }

    #[test]
    fn folder_variations_match() {
        let p3r = find("persona-3-reload").unwrap();
        for name in ["Persona 3 Reload", "Persona3Reload", "P3R", "p3r", "PERSONA 3 RELOAD"] {
            assert!(p3r.folder_matches(name), "{name}");
        }
        assert!(!p3r.folder_matches("P3R Mods Pack Extras Big"));
        assert!(find("ultrakill").unwrap().folder_matches("Ultrakill"));
        assert!(find("undertale").unwrap().folder_matches("UNDERTALE"));
        assert!(find("deltarune").unwrap().folder_matches("Deltarune"));
        assert!(!find("deltarune").unwrap().folder_matches("FNAF 2"));
    }

    #[test]
    fn catalog_has_exactly_four_games() {
        assert_eq!(CATALOG.len(), 4);
    }
}
