//! The pure state machine behind "Launching → Running → ended".
//! It never touches the OS or the database, so every edge case can be unit tested.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Launching,
    Running,
}

#[derive(Debug, Clone, Copy)]
pub struct TrackerConfig {
    /// How long to wait for a matching process before giving up on confirming the launch.
    pub confirm_timeout: i64,
    /// How long a running game may have no matching process before we call the session over.
    /// Bridges launcher → game hand-offs and brief restarts.
    pub exit_grace: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Nothing,
    /// A real game process has been seen: the session may begin now.
    Confirmed,
    /// The game is gone. The session ends at the last moment it was actually seen running.
    Ended { ended_at: i64 },
    /// No game process ever appeared within the timeout.
    GaveUp,
}

#[derive(Debug, Clone)]
pub struct Tracker {
    pub phase: Phase,
    cfg: TrackerConfig,
    since: i64,
    last_seen: i64,
    missing_since: Option<i64>,
}

impl Tracker {
    pub fn launching(now: i64, cfg: TrackerConfig) -> Tracker {
        Tracker { phase: Phase::Launching, cfg, since: now, last_seen: now, missing_since: None }
    }

    /// For resuming a session that was already confirmed (recovery / external detection).
    pub fn running(now: i64, cfg: TrackerConfig) -> Tracker {
        Tracker { phase: Phase::Running, cfg, since: now, last_seen: now, missing_since: None }
    }

    pub fn last_seen(&self) -> i64 {
        self.last_seen
    }

    pub fn tick(&mut self, now: i64, process_alive: bool) -> Decision {
        match self.phase {
            Phase::Launching => {
                if process_alive {
                    self.phase = Phase::Running;
                    self.last_seen = now;
                    self.missing_since = None;
                    Decision::Confirmed
                } else if now - self.since >= self.cfg.confirm_timeout {
                    Decision::GaveUp
                } else {
                    Decision::Nothing
                }
            }
            Phase::Running => {
                if process_alive {
                    self.last_seen = now;
                    self.missing_since = None;
                    Decision::Nothing
                } else {
                    let since = *self.missing_since.get_or_insert(now);
                    if now - since >= self.cfg.exit_grace {
                        Decision::Ended { ended_at: self.last_seen }
                    } else {
                        Decision::Nothing
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: TrackerConfig = TrackerConfig { confirm_timeout: 60, exit_grace: 6 };

    #[test]
    fn confirms_when_process_appears() {
        let mut t = Tracker::launching(100, CFG);
        assert_eq!(t.tick(101, false), Decision::Nothing);
        assert_eq!(t.tick(103, true), Decision::Confirmed);
        assert_eq!(t.phase, Phase::Running);
    }

    #[test]
    fn handoff_from_launcher_to_game_is_tolerated() {
        // The launcher process vanishes first; the real game shows up 20s later.
        let mut t = Tracker::launching(0, CFG);
        for s in 1..20 {
            assert_eq!(t.tick(s, false), Decision::Nothing);
        }
        assert_eq!(t.tick(20, true), Decision::Confirmed);
    }

    #[test]
    fn unconfirmed_launch_gives_up_instead_of_claiming_running() {
        let mut t = Tracker::launching(0, CFG);
        assert_eq!(t.tick(59, false), Decision::Nothing);
        assert_eq!(t.tick(60, false), Decision::GaveUp);
        assert_eq!(t.phase, Phase::Launching);
    }

    #[test]
    fn session_ends_at_last_seen_after_grace_never_later() {
        let mut t = Tracker::running(0, CFG);
        assert_eq!(t.tick(10, true), Decision::Nothing);
        assert_eq!(t.tick(13, false), Decision::Nothing); // gone, within grace
        assert_eq!(t.tick(16, false), Decision::Nothing);
        assert_eq!(t.tick(19, false), Decision::Ended { ended_at: 10 });
    }

    #[test]
    fn brief_disappearance_does_not_end_the_session() {
        let mut t = Tracker::running(0, CFG);
        assert_eq!(t.tick(5, false), Decision::Nothing);
        assert_eq!(t.tick(8, true), Decision::Nothing); // came back
        assert_eq!(t.tick(9, false), Decision::Nothing);
        assert_eq!(t.tick(14, false), Decision::Nothing); // grace restarted at 9
        assert_eq!(t.tick(15, false), Decision::Ended { ended_at: 8 });
    }
}
