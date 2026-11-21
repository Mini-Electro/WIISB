//! A single error type for everything that crosses the IPC boundary.
//! The frontend receives `{ code, message }` — never a stack trace.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    AlreadyRunning(String),
    #[error("{0}")]
    LaunchFailed(String),
    #[error("Your game library drive could not be accessed.")]
    DriveUnavailable,
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Database(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Invalid(_) => "invalid",
            AppError::NotFound(_) => "not_found",
            AppError::AlreadyRunning(_) => "already_running",
            AppError::LaunchFailed(_) => "launch_failed",
            AppError::DriveUnavailable => "drive_unavailable",
            AppError::Io(_) => "io",
            AppError::Database(_) => "database",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        // Details go to the technical log; the user gets a calm message.
        log::error!("database error: {e}");
        AppError::Database("The launcher database reported a problem. Details were written to the log.".into())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        log::error!("io error: {e}");
        AppError::Io(format!("A file operation failed: {}", friendly_io(&e)))
    }
}

pub fn friendly_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.raw_os_error() {
        Some(740) => return "the program requires administrator rights".into(),
        Some(193) => return "the file is not a valid Windows program".into(),
        _ => {}
    }
    match e.kind() {
        NotFound => "the file or folder was not found".into(),
        PermissionDenied => "access was denied".into(),
        _ => match e.raw_os_error() {
            Some(c) => format!("Windows error {c}"),
            None => e.kind().to_string(),
        },
    }
}

pub type AppResult<T> = Result<T, AppError>;
