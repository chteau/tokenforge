//! In-memory lookups over a loaded [`Ledger`].
//!
//! The index stores positions, not references, so it can be built, used to
//! find an entry and then dropped before the ledger is mutated.

use std::collections::{BTreeMap, HashMap};

use crate::error::{Error, Result};
use crate::store::Ledger;

#[derive(Debug, Default)]
pub struct LedgerIndex {
    by_id: HashMap<u64, usize>,
    by_category: BTreeMap<String, Vec<usize>>,
}

impl LedgerIndex {
    pub fn build(ledger: &Ledger) -> LedgerIndex {
        let mut idx = LedgerIndex::default();
        for (pos, e) in ledger.entries.iter().enumerate() {
            idx.by_id.insert(e.id, pos);
            idx.by_category
                .entry(e.category.clone())
                .or_default()
                .push(pos);
        }
        idx
    }

    pub fn position(&self, id: u64) -> Option<usize> {
        self.by_id.get(&id).copied()
    }

    /// Position of `id`, or a `NotFound` error naming it.
    pub fn require(&self, id: u64) -> Result<usize> {
        self.position(id)
            .ok_or_else(|| Error::NotFound(format!("no entry with id {id}")))
    }

    /// Positions of every entry in `category`, in ledger order.
    pub fn in_category(&self, category: &str) -> &[usize] {
        self.by_category
            .get(category)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Category names with their entry counts, sorted by name.
    pub fn categories(&self) -> impl Iterator<Item = (&str, usize)> {
        self.by_category.iter().map(|(k, v)| (k.as_str(), v.len()))
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Entry, Kind};
    use crate::util::Money;

    fn ledger() -> Ledger {
        let mut l = Ledger::new();
        for cat in ["rent", "food", "food"] {
            l.insert(Entry {
                id: 0,
                date: "2026-01-01".parse().unwrap(),
                kind: Kind::Expense,
                amount: Money(100),
                category: cat.into(),
                payee: String::new(),
                note: String::new(),
                tags: vec![],
            });
        }
        l
    }

    #[test]
    fn finds_by_id_and_category() {
        let l = ledger();
        let idx = LedgerIndex::build(&l);
        assert_eq!(idx.position(3), Some(2));
        assert!(idx.require(9).is_err());
        assert_eq!(idx.in_category("food"), &[1, 2]);
        let cats: Vec<_> = idx.categories().collect();
        assert_eq!(cats, vec![("food", 2), ("rent", 1)]);
        assert_eq!(idx.len(), 3);
    }
}
