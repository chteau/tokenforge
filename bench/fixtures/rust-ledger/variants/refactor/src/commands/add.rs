use super::Context;
use crate::cli::AddArgs;
use crate::error::{Error, Result};
use crate::model::Entry;
use crate::util::{Date, Money};

const MAX_CATEGORY_LEN: usize = 32;
const MAX_PAYEE_LEN: usize = 64;
const MAX_NOTE_LEN: usize = 200;
const MAX_TAG_LEN: usize = 16;
const MAX_AMOUNT_CENTS: i64 = 100_000_000;

pub fn run(ctx: &mut Context, args: AddArgs) -> Result<()> {
    let store = ctx.store()?;
    let entry = Entry {
        id: 0,
        date: check_date(args.date)?,
        kind: args.kind,
        amount: check_amount(args.amount)?,
        category: normalize_category(&args.category)?,
        payee: normalize_payee(&args.payee)?,
        note: normalize_note(&args.note)?,
        tags: normalize_tags(&args.tags)?,
    };
    let mut ledger = store.load()?;
    let id = ledger.insert(entry);
    store.save(&ledger)?;
    ctx.say(&format!("added entry {id}"))
}

fn check_date(d: Date) -> Result<Date> {
    if d.year() < 1970 || d.year() > 2100 {
        return Err(Error::invalid(format!(
            "date {d} is outside the supported range (1970-2100)"
        )));
    }
    Ok(d)
}

fn check_amount(value: Money) -> Result<Money> {
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

fn normalize_category(raw: &str) -> Result<String> {
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

fn normalize_payee(raw: &str) -> Result<String> {
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

fn normalize_note(raw: &str) -> Result<String> {
    let n = raw.trim();
    if n.chars().count() > MAX_NOTE_LEN {
        return Err(Error::invalid(format!(
            "note is longer than {MAX_NOTE_LEN} characters"
        )));
    }
    Ok(n.to_string())
}

fn normalize_tags(raw: &[String]) -> Result<Vec<String>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_rules() {
        assert_eq!(normalize_category("  Groceries ").unwrap(), "groceries");
        assert!(normalize_category("").is_err());
        assert!(normalize_category("eating out").is_err());
        assert!(normalize_category(&"x".repeat(33)).is_err());
    }

    #[test]
    fn amount_and_tag_rules() {
        assert!(check_amount(Money(0)).is_err());
        assert!(check_amount(Money(MAX_AMOUNT_CENTS + 1)).is_err());
        let raw: Vec<String> = ["#Food", "food", "home"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(normalize_tags(&raw).unwrap(), vec!["food", "home"]);
    }
}
