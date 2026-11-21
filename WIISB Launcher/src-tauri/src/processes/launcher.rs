//! Native process creation. No shell, no string interpolation: the target and every
//! argument are passed to Windows as separate parameters.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use crate::error::friendly_io;

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMethod {
    Direct,
    Platform,
    Shortcut,
}

impl LaunchMethod {
    pub fn parse(s: &str) -> Option<LaunchMethod> {
        match s {
            "direct" => Some(LaunchMethod::Direct),
            "platform" => Some(LaunchMethod::Platform),
            "shortcut" => Some(LaunchMethod::Shortcut),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            LaunchMethod::Direct => "direct",
            LaunchMethod::Platform => "platform",
            LaunchMethod::Shortcut => "shortcut",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub method: LaunchMethod,
    /// Executable path, `.lnk` path, or platform URI depending on `method`.
    pub target: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

/// Lets the supervisor ask "did the process we started already exit, and how?".
pub trait ExitProbe: Send {
    fn exit_code(&mut self) -> Option<i32>;
}

pub struct NoProbe;
impl ExitProbe for NoProbe {
    fn exit_code(&mut self) -> Option<i32> {
        None
    }
}

struct ChildProbe(Child);
impl ExitProbe for ChildProbe {
    fn exit_code(&mut self) -> Option<i32> {
        self.0.try_wait().ok().flatten().map(|s| s.code().unwrap_or(-1))
    }
}

pub struct Spawned {
    pub pid: Option<u32>,
    pub probe: Box<dyn ExitProbe>,
}

pub trait Spawner: Send + Sync {
    /// `Err` carries a user-facing explanation.
    fn spawn(&self, req: &LaunchRequest) -> Result<Spawned, String>;
}

pub struct RealSpawner;

fn explorer() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("explorer.exe")
}

impl Spawner for RealSpawner {
    fn spawn(&self, req: &LaunchRequest) -> Result<Spawned, String> {
        match req.method {
            LaunchMethod::Direct => {
                let mut cmd = Command::new(&req.target);
                cmd.args(&req.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
                if let Some(cwd) = &req.cwd {
                    cmd.current_dir(cwd);
                }
                let child = cmd.spawn().map_err(describe_spawn_error)?;
                Ok(Spawned { pid: Some(child.id()), probe: Box::new(ChildProbe(child)) })
            }
            // Shortcuts and platform URIs are opened by the Windows shell, exactly as a double-click would.
            LaunchMethod::Shortcut | LaunchMethod::Platform => {
                Command::new(explorer())
                    .arg(&req.target)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(describe_spawn_error)?;
                Ok(Spawned { pid: None, probe: Box::new(NoProbe) })
            }
        }
    }
}

pub fn describe_spawn_error(e: std::io::Error) -> String {
    match e.raw_os_error() {
        Some(740) => "This game needs administrator rights. WIISB Launcher never elevates programs on its own — start the game once as administrator, or run WIISB Launcher as administrator.".into(),
        Some(193) => "Windows says the selected file is not a valid program for this PC.".into(),
        Some(5) => "Windows denied access to the game. Antivirus or folder permissions may be blocking it.".into(),
        Some(2) | Some(3) => "The game's executable or its folder could not be found.".into(),
        _ => format!("Windows could not start the game ({}).", friendly_io(&e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_roundtrip() {
        for m in [LaunchMethod::Direct, LaunchMethod::Platform, LaunchMethod::Shortcut] {
            assert_eq!(LaunchMethod::parse(m.as_str()), Some(m));
        }
        assert_eq!(LaunchMethod::parse("powershell"), None);
    }

    #[test]
    fn missing_executable_gives_helpful_error() {
        let r = RealSpawner.spawn(&LaunchRequest {
            method: LaunchMethod::Direct,
            target: r"C:\definitely\not\here\game.exe".into(),
            args: vec![],
            cwd: None,
        });
        match r {
            Err(msg) => assert!(msg.contains("could not be found"), "{msg}"),
            Ok(_) => panic!("must fail"),
        }
    }
}
