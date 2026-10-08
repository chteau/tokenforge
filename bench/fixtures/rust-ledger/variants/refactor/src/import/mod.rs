//! Importing transactions exported by a bank.

pub mod bank_csv;

use std::collections::HashSet;

use crate::error::{Error, Result};
use crate::model::{Entry, Kind};
use crate::store::Ledger;
use crate::util::hash::fnv1a_fields;
use crate::util::text::truncate;
use crate::util::Money;

pub use bank_csv::{parse as parse_bank_csv, BankRow};

/// Bank descriptions are often padded or very long; payees are capped at this.
const MAX_PAYEE_LEN: usize = 64;

/// What an import would do.
#[derive(Debug, Default)]
pub struct ImportPlan {
    pub entries: Vec<Entry>,
    pub duplicates: usize,
}

fn dedup_key(date: &str, signed: Money, payee: &str) -> u64 {
    fnv1a_fields(&[date, &signed.to_decimal(), &payee.to_lowercase()])
}

/// Turn bank rows into ledger entries. Negative amounts become expenses,
/// positive amounts income. Rows that match an existing entry (same date,
/// signed amount and payee) are skipped when `skip_duplicates` is set.
pub fn plan(
    rows: &[BankRow],
    ledger: &Ledger,
    category: &str,
    skip_duplicates: bool,
) -> Result<ImportPlan> {
    let existing: HashSet<u64> = ledger
        .entries
        .iter()
        .map(|e| dedup_key(&e.date.to_string(), e.signed_amount(), &e.payee))
        .collect();
    let mut plan = ImportPlan::default();
    for row in rows {
        let kind = if row.amount.cents() < 0 {
            Kind::Expense
        } else {
            Kind::Income
        };
        let entry = Entry {
            id: 0,
            date: row.date,
            kind,
            amount: Money(row.amount.cents().abs()),
            category: category.trim().to_string(),
            payee: truncate(row.description.trim(), MAX_PAYEE_LEN),
            note: String::new(),
            tags: Vec::new(),
        };
        check_row(&entry).map_err(|e| Error::invalid(format!("line {}: {e}", row.line)))?;
        let key = dedup_key(&entry.date.to_string(), entry.signed_amount(), &entry.payee);
        if skip_duplicates && existing.contains(&key) {
            plan.duplicates += 1;
            continue;
        }
        plan.entries.push(entry);
    }
    Ok(plan)
}

fn check_row(e: &Entry) -> Result<()> {
    if e.amount.cents() <= 0 {
        return Err(Error::invalid("amount must be greater than zero"));
    }
    if e.category.is_empty() {
        return Err(Error::invalid("category must not be empty"));
    }
    if e.category.chars().count() > 32 {
        return Err(Error::invalid("category is longer than 32 characters"));
    }
    if !e
        .category
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::invalid(format!(
            "category '{}' may only contain letters, digits, '-' and '_'",
            e.category
        )));
    }
    if e.payee.chars().any(char::is_control) {
        return Err(Error::invalid("payee must not contain control characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_existing_and_maps_signs() {
        let rows = parse_bank_csv(
            "Date,Description,Amount,Balance\n01/02/2026,Cafe,-3.50,96.50\n02/02/2026,Refund,10.00,106.50\n",
        )
        .unwrap();
        let mut ledger = Ledger::new();
        let first = plan(&rows, &ledger, "misc", true).unwrap();
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.entries[0].kind, Kind::Expense);
        assert_eq!(first.entries[1].kind, Kind::Income);
        for e in first.entries {
            ledger.insert(e);
        }
        let second = plan(&rows, &ledger, "misc", true).unwrap();
        assert_eq!(second.entries.len(), 0);
        assert_eq!(second.duplicates, 2);
    }
}
