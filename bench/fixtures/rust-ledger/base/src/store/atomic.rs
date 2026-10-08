//! Crash-safe file replacement.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.tmp"))
}

/// Write `contents` to a temporary file next to `path`, flush it to disk and
/// rename it over `path`. Readers see either the old or the new file, never a
/// partial one.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    let tmp = temp_path(path);
    let result = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(Error::io_at(path, e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_file_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("tally-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.txt");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        assert!(!temp_path(&p).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reports_missing_directory() {
        let p = Path::new("/nonexistent-dir-for-tally/x.txt");
        assert!(write_atomic(p, b"x").is_err());
    }
}
