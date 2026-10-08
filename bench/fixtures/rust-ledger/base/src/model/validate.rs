//! Validation and normalisation of user-supplied entry fields.
//!
//! Every command that creates or changes entries goes through these
//! functions so the ledger never contains values that `add` would reject.

use crate::error::{Error, Result};
use crate::model::Entry;
use crate::util::{Date, Money};

pub const MAX_CATEGORY_LEN: usize = 32;
pub const MAX_PAYEE_LEN: usize = 64;
pub const MAX_NOTE_LEN: usize = 200;
pub const MAX_TAG_LEN: usize = 16;
pub const MAX_AMOUNT_CENTS: i64 = 100_000_000;
pub const MIN_YEAR: i32 = 1970;
pub const MAX_YEAR: i32 = 2100;

/// Categories are lower-cased and restricted to `[a-z0-9_-]`.
pub fn category(raw: &str) -> Result<String> {
    let name = raw.trim().to_lowercase();
    if name.is_empty() {
        return Err(Error::invalid("category must not be empty"));
    }
    if name.chars().count() > MAX_CATEGORY_LEN {
        return Err(Error::invalid(format!(
            "category is longer than {MAX_CATEGORY_LEN} characters"
        )));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(Error::invalid(format!(
            "category '{name}' may only contain letters, digits, '-' and '_'"
        )));
    }
    Ok(name)
}

pub fn amount(value: Money) -> Result<Money> {
    if value.cents() <= 0 {
        return Err(Error::invalid("amount must be greater than zero"));
    }
    if value.cents() > MAX_AMOUNT_CENTS {
        return Err(Error::invalid(format!(
            "amount exceeds the maximum of {}",
            Money(MAX_AMOUNT_CENTS).to_decimal()
        )));
    }
    Ok(value)
}

pub fn payee(raw: &str) -> Result<String> {
    let p = raw.trim();
    if p.chars().any(char::is_control) {
        return Err(Error::invalid("payee must not contain control characters"));
    }
    if p.chars().count() > MAX_PAYEE_LEN {
        return Err(Error::invalid(format!(
            "payee is longer than {MAX_PAYEE_LEN} characters"
        )));
    }
    Ok(p.to_string())
}

pub fn note(raw: &str) -> Result<String> {
    let n = raw.trim();
    if n.chars().count() > MAX_NOTE_LEN {
        return Err(Error::invalid(format!(
            "note is longer than {MAX_NOTE_LEN} characters"
        )));
    }
    Ok(n.to_string())
}

/// Tags are lower-cased, may be written with a leading `#`, and are de-duplicated
/// keeping the first occurrence.
pub fn tags(raw: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for t in raw {
        let tag = t.trim().trim_start_matches('#').to_lowercase();
        if tag.is_empty() {
            return Err(Error::invalid("tag must not be empty"));
        }
        if tag.chars().count() > MAX_TAG_LEN {
            return Err(Error::invalid(format!(
                "tag '{tag}' is longer than {MAX_TAG_LEN} characters"
            )));
        }
        if !tag
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(Error::invalid(format!(
                "tag '{tag}' may only contain letters, digits and '-'"
            )));
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    Ok(out)
}

pub fn date(d: Date) -> Result<Date> {
    if d.year() < MIN_YEAR || d.year() > MAX_YEAR {
        return Err(Error::invalid(format!(
            "date {d} is outside the supported range ({MIN_YEAR}-{MAX_YEAR})"
        )));
    }
    Ok(d)
}

/// Normalise every field of `e` in place, or report the first problem.
pub fn entry(e: &mut Entry) -> Result<()> {
    e.date = date(e.date)?;
    e.amount = amount(e.amount)?;
    e.category = category(&e.category)?;
    e.payee = payee(&e.payee)?;
    e.note = note(&e.note)?;
    e.tags = tags(&e.tags)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_rules() {
        assert_eq!(category("  Groceries ").unwrap(), "groceries");
        assert!(category("").is_err());
        assert!(category("eating out").is_err());
        assert!(category(&"x".repeat(33)).is_err());
        assert_eq!(category("car_2-fuel").unwrap(), "car_2-fuel");
    }

    #[test]
    fn amount_rules() {
        assert!(amount(Money(0)).is_err());
        assert!(amount(Money(-5)).is_err());
        assert!(amount(Money(MAX_AMOUNT_CENTS + 1)).is_err());
        assert_eq!(amount(Money(1)).unwrap(), Money(1));
    }

    #[test]
    fn tag_rules() {
        let raw: Vec<String> = ["#Food", "food", "home"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(tags(&raw).unwrap(), vec!["food", "home"]);
        assert!(tags(&["a b".to_string()]).is_err());
    }
}
