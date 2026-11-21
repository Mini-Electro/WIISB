//! Process inspection. Reading the process table is the only way to know a game is
//! really running (launchers often hand off to a different process), but it is kept cheap:
//! known PIDs are checked individually and a full enumeration happens only occasionally.

use std::path::{Path, PathBuf};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::games::validation::looks_like_non_game;

#[derive(Debug, Clone, PartialEq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Process creation time, Unix seconds.
    pub start_time: i64,
}

/// A process belongs to a game when its executable is the launch target or lives inside
/// the game's installation folder.
#[derive(Debug, Clone, Default)]
pub struct MatchFilter {
    pub install_dir: Option<PathBuf>,
    pub exe: Option<PathBuf>,
    /// When non-empty, only processes with one of these program names (lowercase, without `.exe`)
    /// count as "the game". Used when a folder also holds launchers or tools that run all day
    /// (e.g. Electricity's folder contains Studio helpers).
    pub only_exe_names: Vec<String>,
}

pub trait ProcessSource: Send {
    /// Full enumeration: every process matching the filter.
    fn scan(&mut self, filter: &MatchFilter) -> Vec<ProcInfo>;
    /// Cheap check: which of these PIDs are still alive?
    fn check(&mut self, known: &[u32]) -> Vec<u32>;
    /// Force-stop these processes. Returns how many Windows agreed to end.
    fn kill(&mut self, pids: &[u32]) -> usize;
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\").to_lowercase();
    s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches('\\').to_string()
}

pub fn path_matches(exe: &Path, filter: &MatchFilter) -> bool {
    if !filter.only_exe_names.is_empty() {
        let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if !filter.only_exe_names.contains(&stem) {
            return false;
        }
    }
    let e = norm(exe);
    if let Some(target) = &filter.exe {
        if norm(target) == e {
            return true;
        }
    }
    if let Some(dir) = &filter.install_dir {
        let d = norm(dir);
        if !d.is_empty() && e.starts_with(&format!("{d}\\")) {
            // Crash reporters, installers and similar helpers don't count as "the game".
            let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            return !looks_like_non_game(stem);
        }
    }
    false
}

pub struct SysinfoSource {
    sys: System,
    own_pid: u32,
}

impl SysinfoSource {
    pub fn new() -> SysinfoSource {
        SysinfoSource { sys: System::new().expect("process information is available on Windows"), own_pid: std::process::id() }
    }
}

impl Default for SysinfoSource {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSource for SysinfoSource {
    fn scan(&mut self, filter: &MatchFilter) -> Vec<ProcInfo> {
        if filter.install_dir.is_none() && filter.exe.is_none() {
            return Vec::new();
        }
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        self.sys
            .processes()
            .iter()
            .filter(|(pid, _)| pid.as_u32() != self.own_pid)
            .filter_map(|(pid, p)| {
                let exe = p.exe()?;
                path_matches(exe, filter).then(|| ProcInfo { pid: pid.as_u32(), start_time: p.start_time() as i64 })
            })
            .collect()
    }

    fn kill(&mut self, pids: &[u32]) -> usize {
        pids.iter().filter(|p| **p != self.own_pid && crate::platform::sys::terminate_process(**p)).count()
    }

    fn check(&mut self, known: &[u32]) -> Vec<u32> {
        if known.is_empty() {
            return Vec::new();
        }
        let pids: Vec<Pid> = known.iter().map(|p| Pid::from_u32(*p)).collect();
        self.sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, ProcessRefreshKind::nothing());
        known.iter().copied().filter(|p| self.sys.process(Pid::from_u32(*p)).is_some()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_by_folder_and_by_exact_exe_case_insensitively() {
        let f = MatchFilter { install_dir: Some(PathBuf::from(r"E:\Big Boy\UNDERTALE\Undertale")), ..Default::default() };
        assert!(path_matches(Path::new(r"e:\big boy\undertale\undertale\UNDERTALE.exe"), &f));
        assert!(!path_matches(Path::new(r"E:\Big Boy\UNDERTALE\Undertale2\x.exe"), &f), "sibling with shared prefix");
        assert!(!path_matches(Path::new(r"E:\Other\UNDERTALE.exe"), &f));
        assert!(!path_matches(Path::new(r"E:\Big Boy\UNDERTALE\Undertale\UnityCrashHandler64.exe"), &f));

        let g = MatchFilter { exe: Some(PathBuf::from(r"\\?\E:\Games\a.exe")), ..Default::default() };
        assert!(path_matches(Path::new(r"E:\Games\A.EXE"), &g));
    }

    #[test]
    fn empty_filter_matches_nothing_and_finds_current_process_only_when_asked() {
        let mut src = SysinfoSource::new();
        assert!(src.scan(&MatchFilter::default()).is_empty());
        // The test runner itself lives in target\debug\deps — scanning there must find it
        // (own pid is excluded, so use `check` for a liveness probe instead).
        let me = std::process::id();
        assert_eq!(src.check(&[me]), vec![me]);
        assert!(src.check(&[u32::MAX - 7]).is_empty());
    }
}
