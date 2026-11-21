use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex, RwLock};

use crate::database::{Db, Recovery};
use crate::games::deepscan::{DeepCandidate, ScanProgress};
use crate::processes::supervisor::Supervisor;
use crate::settings::AppSettings;

/// Progress and results of the whole-PC scan.
#[derive(Default)]
pub struct DeepState {
    pub running: bool,
    pub finished: bool,
    pub cancelled: bool,
    pub hit_limit: bool,
    pub progress: ScanProgress,
    pub candidates: Vec<DeepCandidate>,
}

pub struct AppState {
    pub db: Arc<Db>,
    pub supervisor: Arc<Supervisor>,
    pub settings: RwLock<AppSettings>,
    pub data_dir: PathBuf,
    pub art_dir: PathBuf,
    /// Set when the app has been explicitly asked to quit (tray "Exit", confirmed dialog).
    pub exit_requested: AtomicBool,
    pub recovery: Option<Recovery>,
    pub last_detect: AtomicI64,
    /// True while the background cover-art job is running (only one at a time).
    pub art_running: AtomicBool,
    pub deep: Mutex<DeepState>,
    pub deep_cancel: Arc<AtomicBool>,
}

impl AppState {
    pub fn settings(&self) -> AppSettings {
        self.settings.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_settings(&self, s: AppSettings) {
        *self.settings.write().unwrap_or_else(|p| p.into_inner()) = s;
    }
}
