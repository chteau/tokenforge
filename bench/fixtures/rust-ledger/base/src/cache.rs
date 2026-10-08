//! A persistent summary of per-category and per-month totals.
//!
//! Reports over a large ledger only need these totals, so they are kept in
//! `<dir>/summary.cache` together with a fingerprint of the ledger file they
//! were computed from. When the fingerprint no longer matches, the summary is
//! recomputed from the ledger and the cache file is rewritten.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{Entry, Kind};
use crate::store::{atomic, codec, Store};
use crate::util::hash::fnv1a;
use crate::util::{Money, YearMonth};

pub const CACHE_FILE: &str = "summary.cache";
const CACHE_HEADER: &str = "# tally summary cache v1";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub count: usize,
    pub expenses: Money,
    pub income: Money,
}

impl Totals {
    fn add(&mut self, e: &Entry) {
        self.count += 1;
        match e.kind {
            Kind::Expense => self.expenses += e.amount,
            Kind::Income => self.income += e.amount,
        }
    }

    pub fn net(&self) -> Money {
        self.income - self.expenses
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub categories: BTreeMap<String, Totals>,
    pub months: BTreeMap<YearMonth, Totals>,
}

impl Summary {
    pub fn compute(entries: &[Entry]) -> Summary {
        let mut s = Summary::default();
        for e in entries {
            s.categories.entry(e.category.clone()).or_default().add(e);
            s.months.entry(e.date.year_month()).or_default().add(e);
        }
        s
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    hash: u64,
}

impl Fingerprint {
    fn encode(&self) -> String {
        format!("{}:{:016x}", self.len, self.hash)
    }

    fn decode(s: &str) -> Option<Fingerprint> {
        let (len, hash) = s.split_once(':')?;
        Some(Fingerprint {
            len: len.parse().ok()?,
            hash: u64::from_str_radix(hash, 16).ok()?,
        })
    }
}

fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let bytes = fs::read(path).map_err(|e| Error::io_at(path, e))?;
    Ok(Fingerprint {
        len: bytes.len() as u64,
        hash: fnv1a(&bytes),
    })
}

/// The current summary, served from the cache file when it is up to date.
pub fn summary(store: &Store, use_cache: bool) -> Result<Summary> {
    if !use_cache {
        return Ok(Summary::compute(&store.load()?.entries));
    }
    let ledger_path = store.ledger_path();
    if !ledger_path.is_file() {
        return Err(Error::NotInitialized(store.dir().to_path_buf()));
    }
    let cache_path = store.dir().join(CACHE_FILE);
    let fp = fingerprint(&ledger_path)?;
    if let Some(cached) = read_cache(&cache_path, fp) {
        return Ok(cached);
    }
    let summary = Summary::compute(&store.load()?.entries);
    // The cache is an optimisation; failing to write it must not fail the command.
    let _ = atomic::write_atomic(&cache_path, render_cache(&summary, fp).as_bytes());
    Ok(summary)
}

fn render_cache(s: &Summary, fp: Fingerprint) -> String {
    let mut out = format!("{CACHE_HEADER}\nfingerprint={}\n", fp.encode());
    let row = |kind: &str, key: String, t: &Totals| {
        codec::join_fields(&[
            kind.to_string(),
            key,
            t.count.to_string(),
            t.expenses.to_decimal(),
            t.income.to_decimal(),
        ])
    };
    for (name, t) in &s.categories {
        out.push_str(&row("c", name.clone(), t));
        out.push('\n');
    }
    for (month, t) in &s.months {
        out.push_str(&row("m", month.to_string(), t));
        out.push('\n');
    }
    out
}

/// Parse the cache file; `None` if it is missing, stale or unreadable.
fn read_cache(path: &Path, expected: Fingerprint) -> Option<Summary> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    if lines.next()? != CACHE_HEADER {
        return None;
    }
    let fp = Fingerprint::decode(lines.next()?.strip_prefix("fingerprint=")?)?;
    if fp != expected {
        return None;
    }
    let mut s = Summary::default();
    for line in lines {
        let f = codec::split_fields(line).ok()?;
        if f.len() != 5 {
            return None;
        }
        let t = Totals {
            count: f[2].parse().ok()?,
            expenses: Money::parse(&f[3]).ok()?,
            income: Money::parse(&f[4]).ok()?,
        };
        match f[0].as_str() {
            "c" => {
                s.categories.insert(f[1].clone(), t);
            }
            "m" => {
                s.months.insert(f[1].parse().ok()?, t);
            }
            _ => return None,
        }
    }
    Some(s)
}

/// Remove the cache file, e.g. after `init`. Missing files are fine.
pub fn clear(store: &Store) {
    let _ = fs::remove_file(store.dir().join(CACHE_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_text_round_trips() {
        let mut s = Summary::default();
        s.categories.insert(
            "a|b".into(),
            Totals {
                count: 2,
                expenses: Money(150),
                income: Money(0),
            },
        );
        s.months.insert(
            "2026-02".parse().unwrap(),
            Totals {
                count: 2,
                expenses: Money(150),
                income: Money(9),
            },
        );
        let fp = Fingerprint { len: 10, hash: 42 };
        let dir = std::env::temp_dir().join(format!("tally-cache-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(CACHE_FILE);
        fs::write(&p, render_cache(&s, fp)).unwrap();
        assert_eq!(read_cache(&p, fp), Some(s));
        assert_eq!(read_cache(&p, Fingerprint { len: 10, hash: 43 }), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
