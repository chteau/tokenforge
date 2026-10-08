//! The crate-wide error type.

use std::fmt;
use std::io;
use std::path::PathBuf;

#[derive(Debug)]
pub enum Error {
    /// Bad command line usage. Exit code 2.
    Usage(String),
    /// A value supplied by the user was rejected.
    Invalid(String),
    /// A referenced entry or category does not exist.
    NotFound(String),
    /// The data directory has not been initialised with `tally init`.
    NotInitialized(PathBuf),
    /// A file on disk could not be parsed.
    Corrupt {
        path: PathBuf,
        line: usize,
        message: String,
    },
    /// The configuration file is malformed.
    Config { line: usize, message: String },
    /// A filter expression could not be parsed.
    Query(String),
    Io {
        path: Option<PathBuf>,
        source: io::Error,
    },
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn invalid(msg: impl Into<String>) -> Error {
        Error::Invalid(msg.into())
    }

    pub fn usage(msg: impl Into<String>) -> Error {
        Error::Usage(msg.into())
    }

    pub fn io_at(path: impl Into<PathBuf>, source: io::Error) -> Error {
        Error::Io {
            path: Some(path.into()),
            source,
        }
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Usage(_) => 2,
            Error::NotFound(_) => 3,
            _ => 1,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Usage(m) => write!(f, "{m}"),
            Error::Invalid(m) => write!(f, "{m}"),
            Error::NotFound(m) => write!(f, "{m}"),
            Error::NotInitialized(dir) => write!(
                f,
                "no ledger found in {} (run `tally init` first)",
                dir.display()
            ),
            Error::Corrupt {
                path,
                line,
                message,
            } => write!(f, "{}:{line}: {message}", path.display()),
            Error::Config { line, message } => write!(f, "config line {line}: {message}"),
            Error::Query(m) => write!(f, "bad filter: {m}"),
            Error::Io {
                path: Some(p),
                source,
            } => write!(f, "{}: {source}", p.display()),
            Error::Io { path: None, source } => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(source: io::Error) -> Error {
        Error::Io { path: None, source }
    }
}

impl From<std::num::ParseIntError> for Error {
    fn from(e: std::num::ParseIntError) -> Error {
        Error::Invalid(format!("invalid number: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes() {
        assert_eq!(Error::usage("x").exit_code(), 2);
        assert_eq!(Error::NotFound("x".into()).exit_code(), 3);
        assert_eq!(Error::invalid("x").exit_code(), 1);
    }
}
