//! The supervisor owns every "launching / running" game: it starts processes through a
//! [`Spawner`], confirms them through a [`ProcessSource`], records sessions in SQLite and
//! tells the UI about every state change through an [`EventSink`].
//!
//! Only real, observed processes ever create session time. Everything OS-facing sits behind
//! a trait so the whole flow is exercised in tests with mocks (no real game is ever started).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;

use super::launcher::{ExitProbe, LaunchMethod, LaunchRequest, NoProbe, Spawner};
use super::source::{MatchFilter, ProcInfo, ProcessSource};
use super::tracker::{Decision, Phase, Tracker, TrackerConfig};
use crate::database::models::Game;
use crate::database::{now, Db};
use crate::error::{AppError, AppResult};

/// How often (seconds) a running session's heartbeat is persisted. After a crash or Windows
/// shutdown the session is closed at the last heartbeat — no unverified time is added.
const HEARTBEAT_EVERY: i64 = 10;
/// How often a full process enumeration is repeated while the known PIDs are healthy.
const FULL_SCAN_EVERY: i64 = 20;
/// If the launched program exited with an error code and nothing else appeared, fail fast.
const FAST_FAIL_AFTER: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Idle,
    Launching,
    Running,
    /// The launch was requested but no game process could be confirmed.
    LaunchRequested,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub slug: String,
    pub state: RuntimeState,
    pub pid: Option<u32>,
    pub session_id: Option<i64>,
    pub started_at: Option<i64>,
    pub message: Option<String>,
}

impl RuntimeSnapshot {
    pub fn idle(slug: &str, message: Option<String>) -> Self {
        RuntimeSnapshot { slug: slug.into(), state: RuntimeState::Idle, pid: None, session_id: None, started_at: None, message }
    }
}

#[derive(Debug, Clone)]
pub enum Notice {
    Launched { title: String },
    LaunchFailed { title: String, message: String },
    Unconfirmed { title: String },
    SessionEnded { title: String, secs: i64 },
}

pub trait EventSink: Send + Sync {
    fn state_changed(&self, snapshot: &RuntimeSnapshot);
    fn sessions_changed(&self);
    fn notify(&self, notice: Notice);
}

struct Entry {
    game_id: i64,
    slug: String,
    title: String,
    method: LaunchMethod,
    filter: MatchFilter,
    tracker: Tracker,
    session_id: Option<i64>,
    launch_id: Option<i64>,
    pids: Vec<u32>,
    probe: Box<dyn ExitProbe>,
    launched_at: i64,
    started_at: Option<i64>,
    last_full_scan: i64,
    last_heartbeat: i64,
    spawn_exit: Option<i32>,
    /// Detected running rather than launched by us.
    external: bool,
}

impl Entry {
    fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            slug: self.slug.clone(),
            state: match self.tracker.phase {
                Phase::Launching => RuntimeState::Launching,
                Phase::Running => RuntimeState::Running,
            },
            pid: self.pids.first().copied(),
            session_id: self.session_id,
            started_at: self.started_at,
            message: None,
        }
    }
}

pub fn tracker_config(method: LaunchMethod) -> TrackerConfig {
    match method {
        // The OS creates the process immediately, so a short wait is enough.
        LaunchMethod::Direct => TrackerConfig { confirm_timeout: 90, exit_grace: 8 },
        // Platform launchers may update, authenticate, then start the game minutes later.
        _ => TrackerConfig { confirm_timeout: 240, exit_grace: 8 },
    }
}

pub fn filter_for(game: &Game) -> MatchFilter {
    let install_dir = game.installation_path.as_ref().filter(|p| !p.is_empty()).map(PathBuf::from);
    // Roblox is started through a launcher (Electricity.exe) that exits again, and its folder also holds Studio
    // and helper programs that run all day. Only the player window means "playing".
    let roblox = game.source == "roblox";
    let exe = (game.launch_method == "direct" && !roblox).then(|| game.launch_target.as_ref().map(PathBuf::from)).flatten();
    MatchFilter { install_dir, exe, only_exe_names: if roblox { vec!["robloxplayerbeta".to_string()] } else { Vec::new() } }
}

pub struct Supervisor {
    db: Arc<Db>,
    spawner: Arc<dyn Spawner>,
    sink: Arc<dyn EventSink>,
    source: Mutex<Box<dyn ProcessSource>>,
    entries: Mutex<HashMap<String, Entry>>,
    thread_active: AtomicBool,
    use_thread: bool,
}

impl Supervisor {
    pub fn new(
        db: Arc<Db>,
        spawner: Arc<dyn Spawner>,
        sink: Arc<dyn EventSink>,
        source: Box<dyn ProcessSource>,
        use_thread: bool,
    ) -> Arc<Supervisor> {
        Arc::new(Supervisor {
            db,
            spawner,
            sink,
            source: Mutex::new(source),
            entries: Mutex::new(HashMap::new()),
            thread_active: AtomicBool::new(false),
            use_thread,
        })
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn source(&self) -> MutexGuard<'_, Box<dyn ProcessSource>> {
        self.source.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn snapshots(&self) -> Vec<RuntimeSnapshot> {
        self.entries().values().map(Entry::snapshot).collect()
    }

    pub fn is_active(&self, slug: &str) -> bool {
        self.entries().contains_key(slug)
    }

    fn new_entry(game: &Game, method: LaunchMethod, tracker: Tracker, now: i64, external: bool) -> Entry {
        Entry {
            game_id: game.id,
            slug: game.slug.clone(),
            title: game.title.clone(),
            method,
            filter: filter_for(game),
            tracker,
            session_id: None,
            launch_id: None,
            pids: Vec::new(),
            probe: Box::new(NoProbe),
            launched_at: now,
            started_at: None,
            last_full_scan: now,
            last_heartbeat: now,
            spawn_exit: None,
            external,
        }
    }

    /// Start a game. Fails if it is already launching/running, or if a matching process
    /// is already alive (in which case that process is adopted instead of starting a second copy).
    pub fn launch(self: &Arc<Self>, game: &Game, req: LaunchRequest) -> AppResult<RuntimeSnapshot> {
        self.launch_at(game, req, now())
    }

    pub fn launch_at(self: &Arc<Self>, game: &Game, req: LaunchRequest, at: i64) -> AppResult<RuntimeSnapshot> {
        let method = req.method;
        {
            let mut entries = self.entries();
            if let Some(e) = entries.get(&game.slug) {
                let what = if e.tracker.phase == Phase::Running { "running" } else { "launching" };
                return Err(AppError::AlreadyRunning(format!("{} is already {what}.", game.title)));
            }
            let filter = filter_for(game);
            let existing = self.source().scan(&filter);
            if !existing.is_empty() {
                let snap = self.adopt_locked(&mut entries, game, &existing, at, "detected");
                drop(entries);
                self.sink.state_changed(&snap);
                self.sink.sessions_changed();
                return Err(AppError::AlreadyRunning(format!("{} is already running.", game.title)));
            }
            // Reserve the slot *before* spawning so rapid double-clicks cannot start two copies.
            entries.insert(game.slug.clone(), Self::new_entry(game, method, Tracker::launching(at, tracker_config(method)), at, false));
        }

        match self.spawner.spawn(&req) {
            Err(message) => {
                self.entries().remove(&game.slug);
                let _ = self.db.add_launch(game.id, method.as_str(), "failed", Some(&message), None);
                self.sink.state_changed(&RuntimeSnapshot::idle(&game.slug, Some(message.clone())));
                self.sink.notify(Notice::LaunchFailed { title: game.title.clone(), message: message.clone() });
                Err(AppError::LaunchFailed(message))
            }
            Ok(spawned) => {
                let launch_id = self.db.add_launch(game.id, method.as_str(), "started", None, None).ok();
                let snap = {
                    let mut entries = self.entries();
                    match entries.get_mut(&game.slug) {
                        Some(e) => {
                            e.probe = spawned.probe;
                            // A launcher that only starts the game (and exits) must not be mistaken for the game.
                            e.pids = if e.filter.only_exe_names.is_empty() { spawned.pid.into_iter().collect() } else { Vec::new() };
                            e.launch_id = launch_id;
                            e.snapshot()
                        }
                        None => RuntimeSnapshot::idle(&game.slug, None),
                    }
                };
                self.sink.state_changed(&snap);
                self.ensure_thread();
                Ok(snap)
            }
        }
    }

    /// Create a Running entry (with a fresh session) for processes we found already running.
    fn adopt_locked(
        &self,
        entries: &mut HashMap<String, Entry>,
        game: &Game,
        found: &[ProcInfo],
        at: i64,
        confirmation: &str,
    ) -> RuntimeSnapshot {
        let method = LaunchMethod::parse(&game.launch_method).unwrap_or(LaunchMethod::Direct);
        let mut e = Self::new_entry(game, method, Tracker::running(at, tracker_config(method)), at, true);
        e.pids = found.iter().map(|p| p.pid).collect();
        e.started_at = Some(at);
        e.session_id = self.db.start_session(game.id, method.as_str(), confirmation, at).ok();
        let snap = e.snapshot();
        entries.insert(game.slug.clone(), e);
        snap
    }

    /// Advance every tracked game. Called by the monitor thread; tests call it directly.
    pub fn poll(&self, at: i64) {
        let mut finished: Vec<(String, RuntimeSnapshot)> = Vec::new();
        let mut changed: Vec<RuntimeSnapshot> = Vec::new();
        let mut notices: Vec<Notice> = Vec::new();
        let mut sessions_changed = false;
        {
            let mut entries = self.entries();
            let mut source = self.source();
            for (slug, e) in entries.iter_mut() {
                // 1. Is the game alive? Cheap PID check first; full enumeration only when needed.
                let mut alive: Vec<u32> = if e.pids.is_empty() { Vec::new() } else { source.check(&e.pids) };
                if alive.is_empty() || at - e.last_full_scan >= FULL_SCAN_EVERY {
                    e.last_full_scan = at;
                    for p in source.scan(&e.filter) {
                        if !alive.contains(&p.pid) {
                            alive.push(p.pid);
                        }
                    }
                }
                e.pids = alive.clone();
                if let Some(code) = e.probe.exit_code() {
                    e.spawn_exit.get_or_insert(code);
                }
                let is_alive = !alive.is_empty();

                // 2. Fail fast if the program we started crashed straight away.
                if e.tracker.phase == Phase::Launching
                    && !is_alive
                    && matches!(e.spawn_exit, Some(c) if c != 0)
                    && at - e.launched_at >= FAST_FAIL_AFTER
                {
                    let msg = format!("The game closed right after starting (exit code {}).", e.spawn_exit.unwrap_or(-1));
                    if let Some(l) = e.launch_id {
                        let _ = self.db.update_launch(l, "failed", None, Some(&msg));
                    }
                    notices.push(Notice::LaunchFailed { title: e.title.clone(), message: msg.clone() });
                    finished.push((slug.clone(), RuntimeSnapshot::idle(slug, Some(msg))));
                    continue;
                }

                // 3. Let the state machine decide.
                match e.tracker.tick(at, is_alive) {
                    Decision::Nothing => {
                        if e.tracker.phase == Phase::Running && at - e.last_heartbeat >= HEARTBEAT_EVERY {
                            if let Some(s) = e.session_id {
                                let _ = self.db.heartbeat(s, e.tracker.last_seen());
                            }
                            e.last_heartbeat = at;
                        }
                    }
                    Decision::Confirmed => {
                        let confirmation = if e.external { "detected" } else { "confirmed" };
                        let session = self.db.start_session(e.game_id, e.method.as_str(), confirmation, at).ok();
                        e.session_id = session;
                        e.started_at = Some(at);
                        e.last_heartbeat = at;
                        if let (Some(l), Some(s)) = (e.launch_id, session) {
                            let _ = self.db.update_launch(l, "confirmed", Some(s), None);
                        }
                        changed.push(e.snapshot());
                        sessions_changed = true;
                        notices.push(Notice::Launched { title: e.title.clone() });
                    }
                    Decision::Ended { ended_at } => {
                        let mut secs = 0;
                        if let Some(s) = e.session_id {
                            let _ = self.db.finish_session(s, ended_at, "completed");
                            secs = (ended_at - e.started_at.unwrap_or(ended_at)).max(0);
                        }
                        sessions_changed = true;
                        notices.push(Notice::SessionEnded { title: e.title.clone(), secs });
                        finished.push((slug.clone(), RuntimeSnapshot::idle(slug, None)));
                    }
                    Decision::GaveUp => {
                        let msg = "The launch was requested, but WIISB Launcher couldn't confirm the game started. \
                                   If it opens, playtime won't be recorded for this run."
                            .to_string();
                        if let Some(l) = e.launch_id {
                            let _ = self.db.update_launch(l, "unconfirmed", None, Some("no game process was detected"));
                        }
                        notices.push(Notice::Unconfirmed { title: e.title.clone() });
                        let mut snap = RuntimeSnapshot::idle(slug, Some(msg));
                        snap.state = RuntimeState::LaunchRequested;
                        finished.push((slug.clone(), snap));
                    }
                }
            }
            for (slug, _) in &finished {
                entries.remove(slug);
            }
        }
        for s in changed.iter().chain(finished.iter().map(|(_, s)| s)) {
            self.sink.state_changed(s);
        }
        if sessions_changed {
            self.sink.sessions_changed();
        }
        for n in notices {
            self.sink.notify(n);
        }
    }

    /// Called once at startup. Open sessions left by a previous run are either resumed (the very
    /// same process is still alive) or closed at their last heartbeat.
    pub fn recover(self: &Arc<Self>, games: &[Game], at: i64) {
        let Ok(active) = self.db.active_sessions() else { return };
        let mut snaps = Vec::new();
        {
            let mut entries = self.entries();
            for s in active {
                let game = games.iter().find(|g| g.id == s.game_id);
                let found = game.map(|g| self.source().scan(&filter_for(g))).unwrap_or_default();
                // Same process instance == it started no later than when the session began.
                let same_instance = found.iter().any(|p| p.start_time <= s.started_at + 10);
                match game {
                    Some(g) if same_instance && !entries.contains_key(&g.slug) => {
                        let method = LaunchMethod::parse(&g.launch_method).unwrap_or(LaunchMethod::Direct);
                        let mut e = Self::new_entry(g, method, Tracker::running(at, tracker_config(method)), at, true);
                        e.pids = found.iter().map(|p| p.pid).collect();
                        e.session_id = Some(s.id);
                        e.started_at = Some(s.started_at);
                        let _ = self.db.mark_resumed(s.id);
                        snaps.push(e.snapshot());
                        entries.insert(g.slug.clone(), e);
                    }
                    _ => {
                        let _ = self.db.finish_session(s.id, s.last_heartbeat, "recovered");
                    }
                }
            }
        }
        for s in &snaps {
            self.sink.state_changed(s);
        }
        self.sink.sessions_changed();
        if !snaps.is_empty() {
            self.ensure_thread();
        }
    }

    /// Adopt games that are already running (started outside the launcher).
    pub fn detect_running(self: &Arc<Self>, games: &[Game], at: i64) {
        let mut snaps = Vec::new();
        {
            let mut entries = self.entries();
            for g in games.iter().filter(|g| g.installed) {
                if entries.contains_key(&g.slug) {
                    continue;
                }
                let filter = filter_for(g);
                if filter.install_dir.is_none() && filter.exe.is_none() {
                    continue;
                }
                let found = self.source().scan(&filter);
                if !found.is_empty() {
                    snaps.push(self.adopt_locked(&mut entries, g, &found, at, "detected"));
                }
            }
        }
        if !snaps.is_empty() {
            for s in &snaps {
                self.sink.state_changed(s);
            }
            self.sink.sessions_changed();
            self.ensure_thread();
        }
    }

    /// Force-stop a game that is launching or running: its own processes (everything found in its
    /// installation folder, plus the program we started) are ended, and the session is closed right away.
    /// Only the game's processes are touched - the caller supplies a game, never a process id.
    pub fn stop(&self, slug: &str, at: i64) -> AppResult<()> {
        let mut entries = self.entries();
        let (filter, mut pids) = match entries.get(slug) {
            Some(e) => (e.filter.clone(), e.pids.clone()),
            None => return Err(AppError::NotFound("That game isn't running.".into())),
        };
        let mut source = self.source();
        for p in source.scan(&filter) {
            if !pids.contains(&p.pid) {
                pids.push(p.pid);
            }
        }
        if !pids.is_empty() {
            source.kill(&pids);
            // Give Windows a moment to tear the processes down, then make sure they are really gone.
            let mut alive = pids.clone();
            for _ in 0..25 {
                alive = source.check(&alive);
                if alive.is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !alive.is_empty() {
                if let Some(e) = entries.get_mut(slug) {
                    e.pids = alive;
                }
                return Err(AppError::LaunchFailed(
                    "Windows wouldn't let WIISB Launcher stop it. If the game is running as administrator, close it from the game itself or Task Manager.".into(),
                ));
            }
        }
        drop(source);
        let Some(e) = entries.remove(slug) else { return Ok(()) };
        drop(entries);
        match (e.session_id, e.launch_id) {
            (Some(session), _) => {
                let _ = self.db.finish_session(session, at, "completed");
            }
            (None, Some(launch)) => {
                let _ = self.db.update_launch(launch, "failed", None, Some("stopped by the user before the game was confirmed running"));
            }
            _ => {}
        }
        self.sink.state_changed(&RuntimeSnapshot::idle(slug, None));
        self.sink.sessions_changed();
        Ok(())
    }

    fn ensure_thread(self: &Arc<Self>) {
        if !self.use_thread || self.thread_active.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new().name("wiisb-monitor".into()).spawn(move || loop {
            let (any, launching) = {
                let e = me.entries();
                (!e.is_empty(), e.values().any(|x| x.tracker.phase == Phase::Launching))
            };
            if !any {
                me.thread_active.store(false, Ordering::SeqCst);
                // A launch may have slipped in between the check and the store.
                if me.entries().is_empty() || me.thread_active.swap(true, Ordering::SeqCst) {
                    break;
                }
                continue;
            }
            std::thread::sleep(Duration::from_millis(if launching { 1500 } else { 3000 }));
            me.poll(now());
        });
        if let Err(e) = spawned {
            log::error!("could not start the process monitor thread: {e}");
            self.thread_active.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::models::LinkData;
    use crate::processes::launcher::Spawned;

    #[derive(Default)]
    struct FakeSpawner {
        fail: Mutex<Option<String>>,
        calls: Mutex<Vec<LaunchRequest>>,
    }
    impl Spawner for FakeSpawner {
        fn spawn(&self, req: &LaunchRequest) -> Result<Spawned, String> {
            self.calls.lock().unwrap().push(req.clone());
            match self.fail.lock().unwrap().clone() {
                Some(m) => Err(m),
                None => Ok(Spawned { pid: Some(100), probe: Box::new(NoProbe) }),
            }
        }
    }

    #[derive(Clone, Default)]
    struct FakeSource(Arc<Mutex<Vec<ProcInfo>>>, Arc<AtomicBool>);
    impl ProcessSource for FakeSource {
        fn scan(&mut self, _f: &MatchFilter) -> Vec<ProcInfo> {
            self.0.lock().unwrap().clone()
        }
        fn check(&mut self, known: &[u32]) -> Vec<u32> {
            let procs = self.0.lock().unwrap();
            known.iter().copied().filter(|k| procs.iter().any(|p| p.pid == *k)).collect()
        }
        fn kill(&mut self, pids: &[u32]) -> usize {
            if self.1.load(Ordering::SeqCst) {
                return 0; // Windows refuses (e.g. an elevated process)
            }
            let mut procs = self.0.lock().unwrap();
            let before = procs.len();
            procs.retain(|p| !pids.contains(&p.pid));
            before - procs.len()
        }
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);
    impl EventSink for Recorder {
        fn state_changed(&self, s: &RuntimeSnapshot) {
            self.0.lock().unwrap().push(format!("{:?}", s.state));
        }
        fn sessions_changed(&self) {
            self.0.lock().unwrap().push("sessions".into());
        }
        fn notify(&self, n: Notice) {
            self.0.lock().unwrap().push(format!("notice:{}", match n {
                Notice::Launched { .. } => "launched",
                Notice::LaunchFailed { .. } => "failed",
                Notice::Unconfirmed { .. } => "unconfirmed",
                Notice::SessionEnded { .. } => "ended",
            }));
        }
    }

    struct Rig {
        sup: Arc<Supervisor>,
        db: Arc<Db>,
        spawner: Arc<FakeSpawner>,
        procs: Arc<Mutex<Vec<ProcInfo>>>,
        refuse_kill: Arc<AtomicBool>,
        events: Arc<Recorder>,
        game: Game,
    }

    fn rig() -> Rig {
        let db = Arc::new(Db::open_memory());
        db.link_game(
            "ultrakill",
            &LinkData {
                installation_path: Some(r"E:\Games\My Games\ULTRAKILL".into()),
                launch_target: r"E:\Games\My Games\ULTRAKILL\ULTRAKILL.exe".into(),
                launch_method: "direct".into(),
                launch_args: String::new(),
                working_dir: None,
                source: "auto",
            },
        )
        .unwrap();
        let game = db.get_game("ultrakill").unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let source = FakeSource::default();
        let procs = source.0.clone();
        let refuse_kill = source.1.clone();
        let events = Arc::new(Recorder::default());
        let sup = Supervisor::new(db.clone(), spawner.clone(), events.clone(), Box::new(source), false);
        Rig { sup, db, spawner, procs, refuse_kill, events, game }
    }

    fn req() -> LaunchRequest {
        LaunchRequest { method: LaunchMethod::Direct, target: r"E:\Games\My Games\ULTRAKILL\ULTRAKILL.exe".into(), args: vec![], cwd: None }
    }

    #[test]
    fn full_session_lifecycle_creates_and_finalises_a_real_session() {
        let r = rig();
        let snap = r.sup.launch_at(&r.game, req(), 1_000).unwrap();
        assert_eq!(snap.state, RuntimeState::Launching);
        assert!(r.db.list_sessions(None).unwrap().is_empty(), "no session before a process is confirmed");

        r.sup.poll(1_002); // nothing alive yet
        assert!(r.db.list_sessions(None).unwrap().is_empty());

        r.procs.lock().unwrap().push(ProcInfo { pid: 100, start_time: 1_002 });
        r.sup.poll(1_004);
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Running);
        let sessions = r.db.list_sessions(None).unwrap();
        assert_eq!((sessions.len(), sessions[0].started_at), (1, 1_004));

        r.sup.poll(1_064); // still running a minute later
        r.procs.lock().unwrap().clear(); // game exits
        for t in [1_067, 1_070, 1_073] {
            r.sup.poll(t);
            assert_eq!(r.sup.snapshots().len(), 1, "still inside the 8s exit grace at t={t}");
        }
        r.sup.poll(1_076);
        assert!(r.sup.snapshots().is_empty(), "back to idle");
        let s = &r.db.list_sessions(None).unwrap()[0];
        assert_eq!(s.completion_status, "completed");
        assert_eq!(s.ended_at, Some(1_064), "ends when last seen alive, not when noticed missing");
        assert_eq!(s.duration_secs, 60);
        let l = &r.db.list_launches(5).unwrap()[0];
        assert_eq!((l.outcome.as_str(), l.session_id), ("confirmed", Some(s.id)));
        let ev = r.events.0.lock().unwrap().join(",");
        assert!(ev.contains("Launching") && ev.contains("Running") && ev.contains("Idle") && ev.contains("notice:launched") && ev.contains("notice:ended"), "{ev}");
    }

    #[test]
    fn duplicate_launch_is_refused_and_spawns_once() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 10).unwrap();
        let err = r.sup.launch_at(&r.game, req(), 11).unwrap_err();
        assert_eq!(err.code(), "already_running");
        assert_eq!(r.spawner.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn spawn_failure_is_recorded_without_a_session_and_allows_retry() {
        let r = rig();
        *r.spawner.fail.lock().unwrap() = Some("Windows denied access".into());
        let err = r.sup.launch_at(&r.game, req(), 10).unwrap_err();
        assert_eq!(err.code(), "launch_failed");
        assert!(!r.sup.is_active("ultrakill"));
        let l = &r.db.list_launches(5).unwrap()[0];
        assert_eq!(l.outcome, "failed");
        assert!(l.error.as_deref().unwrap().contains("denied"));
        assert!(r.db.list_sessions(None).unwrap().is_empty());
        *r.spawner.fail.lock().unwrap() = None;
        assert!(r.sup.launch_at(&r.game, req(), 20).is_ok());
    }

    #[test]
    fn unconfirmed_launch_is_reported_honestly_and_creates_no_session() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 0).unwrap();
        r.sup.poll(30);
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Launching);
        r.sup.poll(95);
        assert!(r.sup.snapshots().is_empty());
        assert!(r.db.list_sessions(None).unwrap().is_empty());
        assert_eq!(r.db.list_launches(5).unwrap()[0].outcome, "unconfirmed");
        assert!(r.events.0.lock().unwrap().iter().any(|e| e == "LaunchRequested"));
    }

    #[test]
    fn launcher_handoff_confirms_when_the_real_game_appears_later() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 0).unwrap(); // stub pid 100 is not in the process list
        for t in (2..40).step_by(3) {
            r.sup.poll(t);
        }
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Launching);
        r.procs.lock().unwrap().push(ProcInfo { pid: 777, start_time: 40 });
        r.sup.poll(41);
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Running);
        assert_eq!(r.db.list_sessions(None).unwrap().len(), 1);
    }

    #[test]
    fn crash_ends_session_and_second_launch_makes_a_second_session() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 0).unwrap();
        r.procs.lock().unwrap().push(ProcInfo { pid: 100, start_time: 0 });
        r.sup.poll(2);
        r.sup.poll(12);
        r.procs.lock().unwrap().clear(); // crash
        r.sup.poll(14);
        r.sup.poll(23);
        assert!(r.sup.snapshots().is_empty());
        r.sup.launch_at(&r.game, req(), 100).unwrap();
        r.procs.lock().unwrap().push(ProcInfo { pid: 100, start_time: 100 });
        r.sup.poll(102);
        assert_eq!(r.db.list_sessions(None).unwrap().len(), 2);
    }

    #[test]
    fn already_running_game_is_adopted_not_launched_twice() {
        let r = rig();
        r.procs.lock().unwrap().push(ProcInfo { pid: 55, start_time: 5 });
        let err = r.sup.launch_at(&r.game, req(), 100).unwrap_err();
        assert_eq!(err.code(), "already_running");
        assert!(r.spawner.calls.lock().unwrap().is_empty(), "must not start a second copy");
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Running);
        assert_eq!(r.db.list_sessions(None).unwrap()[0].confirmation_status, "detected");
    }

    #[test]
    fn recovery_resumes_same_process_and_closes_stale_sessions_at_heartbeat() {
        let r = rig();
        let id = r.db.start_session(r.game.id, "direct", "confirmed", 1_000).unwrap();
        r.db.heartbeat(id, 1_500).unwrap();

        // Case 1: the very same process (started before the session) is still alive -> resume.
        r.procs.lock().unwrap().push(ProcInfo { pid: 9, start_time: 995 });
        r.sup.recover(&[r.game.clone()], 5_000);
        assert_eq!(r.sup.snapshots()[0].session_id, Some(id));
        let s = r.db.get_session(id).unwrap().unwrap();
        assert_eq!((s.completion_status.as_str(), s.confirmation_status.as_str()), ("active", "resumed"));
        assert_eq!(r.db.list_sessions(None).unwrap().len(), 1, "no second session, no double counting");

        // Case 2: nothing is running any more (launcher crash / Windows shutdown).
        let r2 = rig();
        let id2 = r2.db.start_session(r2.game.id, "direct", "confirmed", 1_000).unwrap();
        r2.db.heartbeat(id2, 1_500).unwrap();
        r2.sup.recover(&[r2.game.clone()], 9_000);
        let s2 = r2.db.get_session(id2).unwrap().unwrap();
        assert_eq!((s2.completion_status.as_str(), s2.ended_at, s2.duration_secs), ("recovered", Some(1_500), 500));
        assert!(r2.sup.snapshots().is_empty());

        // Case 3: a *different* (newer) process is running -> old session closed, not extended.
        let r3 = rig();
        let id3 = r3.db.start_session(r3.game.id, "direct", "confirmed", 1_000).unwrap();
        r3.procs.lock().unwrap().push(ProcInfo { pid: 9, start_time: 4_000 });
        r3.sup.recover(&[r3.game.clone()], 5_000);
        assert_eq!(r3.db.get_session(id3).unwrap().unwrap().completion_status, "recovered");
        assert!(r3.sup.snapshots().is_empty());
    }

    /// End-to-end with the *real* spawner and process inspector — but a harmless program:
    /// a copy of `ping.exe` named like a game, in a folder with spaces. No installed game is touched.
    #[test]
    fn real_process_is_spawned_confirmed_tracked_and_finalised() {
        use crate::processes::launcher::RealSpawner;
        use crate::processes::source::SysinfoSource;

        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join("Fake Game Folder");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("FakeGame.exe");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        std::fs::copy(format!(r"{system}\System32\PING.EXE"), &exe).unwrap();

        let db = Arc::new(Db::open_memory());
        db.link_game(
            "undertale",
            &LinkData {
                installation_path: Some(game_dir.display().to_string()),
                launch_target: exe.display().to_string(),
                launch_method: "direct".into(),
                launch_args: String::new(),
                working_dir: None,
                source: "manual",
            },
        )
        .unwrap();
        let game = db.get_game("undertale").unwrap();
        let events = Arc::new(Recorder::default());
        let sup = Supervisor::new(db.clone(), Arc::new(RealSpawner), events, Box::new(SysinfoSource::new()), false);

        // ping -n 6 ≈ 5 seconds of life. Arguments are passed separately.
        let req = LaunchRequest { method: LaunchMethod::Direct, target: exe.display().to_string(), args: vec!["-n".into(), "6".into(), "127.0.0.1".into()], cwd: Some(game_dir.clone()) };
        sup.launch(&game, req).expect("real launch");
        assert!(matches!(sup.launch(&game, LaunchRequest { method: LaunchMethod::Direct, target: exe.display().to_string(), args: vec![], cwd: None }), Err(AppError::AlreadyRunning(_))));

        let start = std::time::Instant::now();
        let mut confirmed = false;
        while start.elapsed().as_secs() < 40 {
            sup.poll(now());
            let snaps = sup.snapshots();
            if snaps.first().map(|s| s.state) == Some(RuntimeState::Running) {
                confirmed = true;
            }
            if confirmed && snaps.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(confirmed, "process in the install folder must be confirmed as running");
        assert!(sup.snapshots().is_empty(), "session must be finalised after the process exits");
        let sessions = db.list_sessions(None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].completion_status, "completed");
        assert!((3..=15).contains(&sessions[0].duration_secs), "duration was {}", sessions[0].duration_secs);
    }

    #[test]
    fn roblox_only_counts_the_player_not_launchers_or_studio_helpers() {
        use crate::processes::source::path_matches;
        use std::path::Path;
        let db = Db::open_memory();
        db.insert_game("roblox-player", "Electricity", "roblox", Some("player"), None).unwrap();
        db.link_game(
            "roblox-player",
            &LinkData {
                installation_path: Some(r"C:\Users\U\AppData\Local\Electricity".into()),
                launch_target: r"C:\Users\U\AppData\Local\Electricity\Electricity.exe".into(),
                launch_method: "direct".into(),
                launch_args: String::new(),
                working_dir: None,
                source: "auto",
            },
        )
        .unwrap();
        let g = db.get_game("roblox-player").unwrap();
        let f = filter_for(&g);
        let el = |rel: &str| PathBuf::from(format!(r"C:\Users\U\AppData\Local\Electricity\{rel}"));
        assert!(path_matches(&el(r"Versions\version-1\RobloxPlayerBeta.exe"), &f), "the player is the game");
        assert!(!path_matches(&el(r"Versions\version-1\StudioMCP.exe"), &f), "a helper that runs all day is not");
        assert!(!path_matches(&el(r"Versions\version-1\RobloxStudioBeta.exe"), &f));
        assert!(!path_matches(&el("Electricity.exe"), &f), "the launcher itself is not");
        assert!(!path_matches(Path::new(r"C:\Other\RobloxPlayerBeta.exe"), &f), "and it must still be inside the install folder");
    }

    #[test]
    fn a_launcher_stub_we_start_does_not_count_as_the_game_running() {
        let r = rig();
        r.db.insert_game("roblox-player", "Electricity", "roblox", Some("player"), None).unwrap();
        r.db.link_game(
            "roblox-player",
            &LinkData { installation_path: Some(r"E:\Games\Electricity".into()), launch_target: r"E:\Games\Electricity\Electricity.exe".into(), launch_method: "direct".into(), launch_args: String::new(), working_dir: None, source: "auto" },
        )
        .unwrap();
        let g = r.db.get_game("roblox-player").unwrap();
        // The stub we spawn (pid 100) is alive for a few seconds after the launch...
        r.sup.launch_at(&g, req(), 0).unwrap();
        r.procs.lock().unwrap().push(ProcInfo { pid: 100, start_time: 0 });
        assert_eq!(r.sup.snapshots()[0].pid, None, "the spawned stub is not tracked as the game");
        // ...a normal game's own process, by contrast, is tracked from the start.
        let other = rig();
        other.sup.launch_at(&other.game, req(), 0).unwrap();
        assert_eq!(other.sup.snapshots()[0].pid, Some(100));
    }

    #[test]
    fn force_stop_ends_every_game_process_and_closes_the_session_at_once() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 1_000).unwrap();
        // The launcher stub (100) and the real game (200) are both alive.
        r.procs.lock().unwrap().extend([ProcInfo { pid: 100, start_time: 1_000 }, ProcInfo { pid: 200, start_time: 1_001 }]);
        r.sup.poll(1_004);
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Running);

        r.sup.stop("ultrakill", 1_030).unwrap();
        assert!(r.procs.lock().unwrap().is_empty(), "every process of the game was ended");
        assert!(r.sup.snapshots().is_empty(), "back to idle immediately, no waiting for the exit grace");
        let s = &r.db.list_sessions(None).unwrap()[0];
        assert_eq!((s.completion_status.as_str(), s.ended_at, s.duration_secs), ("completed", Some(1_030), 26));
        assert!(r.events.0.lock().unwrap().iter().any(|e| e == "Idle"));
        // And it can be launched again straight away.
        assert!(r.sup.launch_at(&r.game, req(), 1_040).is_ok());
    }

    #[test]
    fn force_stop_of_something_not_running_is_a_clear_error() {
        let r = rig();
        assert_eq!(r.sup.stop("ultrakill", 5).unwrap_err().code(), "not_found");
        assert_eq!(r.sup.stop("no-such-game", 5).unwrap_err().code(), "not_found");
    }

    #[test]
    fn force_stop_failure_is_reported_and_the_game_stays_tracked() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 0).unwrap();
        r.procs.lock().unwrap().push(ProcInfo { pid: 100, start_time: 0 });
        r.sup.poll(2);
        r.refuse_kill.store(true, Ordering::SeqCst);
        let err = r.sup.stop("ultrakill", 10).unwrap_err();
        assert_eq!(err.code(), "launch_failed");
        assert!(err.to_string().contains("administrator"));
        assert_eq!(r.sup.snapshots()[0].state, RuntimeState::Running, "still running, still tracked");
        assert_eq!(r.db.active_sessions().unwrap().len(), 1, "the session is not closed while the game lives");
        r.refuse_kill.store(false, Ordering::SeqCst);
        r.sup.stop("ultrakill", 11).unwrap();
        assert!(r.db.active_sessions().unwrap().is_empty());
    }

    #[test]
    fn stopping_during_launch_records_it_without_inventing_a_session() {
        let r = rig();
        r.sup.launch_at(&r.game, req(), 0).unwrap();
        r.sup.stop("ultrakill", 3).unwrap();
        assert!(r.sup.snapshots().is_empty());
        assert!(r.db.list_sessions(None).unwrap().is_empty());
        let l = &r.db.list_launches(5).unwrap()[0];
        assert_eq!(l.outcome, "failed");
        assert!(l.error.as_deref().unwrap().contains("stopped"));
    }

    /// Force-stops a *real* process (a copy of ping.exe named like a game) end to end.
    #[test]
    fn real_process_can_be_force_stopped() {
        use crate::processes::launcher::RealSpawner;
        use crate::processes::source::SysinfoSource;

        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join("Stop Me Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("StopMe.exe");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        std::fs::copy(format!(r"{system}\System32\PING.EXE"), &exe).unwrap();
        let db = Arc::new(Db::open_memory());
        db.link_game(
            "undertale",
            &LinkData { installation_path: Some(game_dir.display().to_string()), launch_target: exe.display().to_string(), launch_method: "direct".into(), launch_args: String::new(), working_dir: None, source: "manual" },
        )
        .unwrap();
        let game = db.get_game("undertale").unwrap();
        let sup = Supervisor::new(db.clone(), Arc::new(RealSpawner), Arc::new(Recorder::default()), Box::new(SysinfoSource::new()), false);
        // ping -n 120 would run for two minutes if nobody stopped it.
        let req = LaunchRequest { method: LaunchMethod::Direct, target: exe.display().to_string(), args: vec!["-n".into(), "120".into(), "127.0.0.1".into()], cwd: Some(game_dir) };
        sup.launch(&game, req).unwrap();
        let start = std::time::Instant::now();
        while sup.snapshots().first().map(|s| s.state) != Some(RuntimeState::Running) && start.elapsed().as_secs() < 20 {
            sup.poll(now());
            std::thread::sleep(Duration::from_millis(300));
        }
        assert_eq!(sup.snapshots()[0].state, RuntimeState::Running);
        let pid = sup.snapshots()[0].pid.expect("a pid");

        let stopped_at = std::time::Instant::now();
        sup.stop("undertale", now()).unwrap();
        assert!(stopped_at.elapsed().as_secs() < 5, "stopping is quick");
        assert!(SysinfoSource::new().check(&[pid]).is_empty(), "the process is really gone");
        assert!(sup.snapshots().is_empty());
        assert_eq!(db.list_sessions(None).unwrap()[0].completion_status, "completed");
    }

    #[test]
    fn detect_running_adopts_external_launches_once() {
        let r = rig();
        r.procs.lock().unwrap().push(ProcInfo { pid: 3, start_time: 1 });
        r.sup.detect_running(&[r.game.clone()], 50);
        r.sup.detect_running(&[r.game.clone()], 55); // second call must not create a duplicate
        assert_eq!(r.db.list_sessions(None).unwrap().len(), 1);
        assert_eq!(r.sup.snapshots().len(), 1);
    }
}
