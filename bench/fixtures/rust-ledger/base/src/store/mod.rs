//! Persistence of the ledger as a line-based text file.
//!
//! ```text
//! # tally ledger v1
//! next_id=3
//! 1|2026-01-03|expense|12.50|groceries|Corner Shop|weekly shop|food,home
//! 2|2026-01-04|income|2000.00|salary|ACME Ltd||
//! ```
//!
//! Fields are separated by `|`; see [`codec`] for escaping. Blank lines and
//! lines starting with `#` are ignored, so the file can be edited by hand.

pub mod atomic;
pub mod codec;

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::Entry;

pub const LEDGER_FILE: &str = "ledger.txt";
pub const HEADER: &str = "# tally ledger v1";

/// All entries plus the id counter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ledger {
    pub next_id: u64,
    pub entries: Vec<Entry>,
}

impl Ledger {
    pub fn new() -> Ledger {
        Ledger {
            next_id: 1,
            entries: Vec::new(),
        }
    }

    /// Append `entry`, assigning it the next id. Returns the id.
    pub fn insert(&mut self, mut entry: Entry) -> u64 {
        let id = self.next_id.max(1);
        entry.id = id;
        self.next_id = id + 1;
        self.entries.push(entry);
        id
    }

    pub fn get(&self, id: u64) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.id == id)
    }

    pub fn remove(&mut self, id: u64) -> Option<Entry> {
        let pos = self.entries.iter().position(|e| e.id == id)?;
        Some(self.entries.remove(pos))
    }
}

/// A ledger stored in a data directory.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Open an existing ledger; fails with `NotInitialized` if there is none.
    pub fn open(dir: &Path) -> Result<Store> {
        let store = Store {
            dir: dir.to_path_buf(),
        };
        if !store.ledger_path().is_file() {
            return Err(Error::NotInitialized(dir.to_path_buf()));
        }
        Ok(store)
    }

    /// Create the directory and an empty ledger. Returns `false` if one already existed.
    pub fn init(dir: &Path) -> Result<(Store, bool)> {
        fs::create_dir_all(dir).map_err(|e| Error::io_at(dir, e))?;
        let store = Store {
            dir: dir.to_path_buf(),
        };
        if store.ledger_path().exists() {
            return Ok((store, false));
        }
        store.save(&Ledger::new())?;
        Ok((store, true))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn ledger_path(&self) -> PathBuf {
        self.dir.join(LEDGER_FILE)
    }

    pub fn load(&self) -> Result<Ledger> {
        let path = self.ledger_path();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(Error::NotInitialized(self.dir.clone()))
            }
            Err(e) => return Err(Error::io_at(path, e)),
        };
        parse_ledger(&text, &path)
    }

    pub fn save(&self, ledger: &Ledger) -> Result<()> {
        atomic::write_atomic(&self.ledger_path(), render_ledger(ledger).as_bytes())
    }
}

pub fn parse_ledger(text: &str, path: &Path) -> Result<Ledger> {
    let mut ledger = Ledger::new();
    let mut declared_next: Option<u64> = None;
    for (idx, raw) in text.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let corrupt = |message: String| Error::Corrupt {
            path: path.to_path_buf(),
            line: line_no,
            message,
        };
        if let Some(v) = line.strip_prefix("next_id=") {
            let n = v
                .trim()
                .parse()
                .map_err(|_| corrupt(format!("bad next_id '{v}'")))?;
            declared_next = Some(n);
            continue;
        }
        let entry = codec::decode_entry(line).map_err(corrupt)?;
        if ledger.entries.iter().any(|e| e.id == entry.id) {
            return Err(corrupt(format!("duplicate id {}", entry.id)));
        }
        ledger.entries.push(entry);
    }
    let max_id = ledger.entries.iter().map(|e| e.id).max().unwrap_or(0);
    ledger.next_id = declared_next.unwrap_or(0).max(max_id + 1);
    Ok(ledger)
}

pub fn render_ledger(ledger: &Ledger) -> String {
    let mut out = String::new();
    out.push_str(HEADER);
    out.push('\n');
    out.push_str(&format!("next_id={}\n", ledger.next_id));
    for e in &ledger.entries {
        out.push_str(&codec::encode_entry(e));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Kind;
    use crate::util::Money;

    fn sample() -> Entry {
        Entry {
            id: 0,
            date: "2026-03-01".parse().unwrap(),
            kind: Kind::Expense,
            amount: Money(1999),
            category: "books".into(),
            payee: "Shop | Co".into(),
            note: "line one\nline two \\ done".into(),
            tags: vec!["gift".into()],
        }
    }

    #[test]
    fn round_trips_through_text() {
        let mut ledger = Ledger::new();
        ledger.insert(sample());
        ledger.insert(sample());
        ledger.remove(1);
        let text = render_ledger(&ledger);
        let back = parse_ledger(&text, Path::new("ledger.txt")).unwrap();
        assert_eq!(back, ledger);
        assert_eq!(back.next_id, 3);
    }

    #[test]
    fn next_id_never_reuses_ids() {
        let text = "next_id=1\n5|2026-01-01|expense|1.00|a|||\n";
        let ledger = parse_ledger(text, Path::new("l")).unwrap();
        assert_eq!(ledger.next_id, 6);
    }

    #[test]
    fn reports_line_numbers() {
        let text = "# tally ledger v1\n\n1|2026-01-01|expense|oops|a|||\n";
        let err = parse_ledger(text, Path::new("l")).unwrap_err().to_string();
        assert!(err.starts_with("l:3:"), "{err}");
    }
}
