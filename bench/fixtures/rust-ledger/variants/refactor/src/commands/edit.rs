use super::Context;
use crate::cli::EditArgs;
use crate::error::{Error, Result};
use crate::index::LedgerIndex;
use crate::util::Money;

pub fn run(ctx: &mut Context, args: EditArgs) -> Result<()> {
    if args.is_empty() {
        return Err(Error::usage("nothing to change (see `tally help edit`)"));
    }
    let store = ctx.store()?;
    let mut ledger = store.load()?;
    let pos = LedgerIndex::build(&ledger).require(args.id)?;

    let mut entry = ledger.entries[pos].clone();
    if let Some(d) = args.date {
        entry.date = d;
    }
    if let Some(a) = args.amount {
        if a.cents() < 0 {
            return Err(Error::invalid("amount must be greater than zero"));
        }
        if a.cents() > 100_000_000 {
            return Err(Error::invalid(format!(
                "amount exceeds the maximum of {}",
                Money(100_000_000).to_decimal()
            )));
        }
        entry.amount = a;
    }
    if let Some(c) = args.category {
        let name = c.trim().to_string();
        if name.is_empty() {
            return Err(Error::invalid("category must not be empty"));
        }
        if name.chars().count() > 32 {
            return Err(Error::invalid("category is longer than 32 characters"));
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(Error::invalid(format!(
                "category '{name}' may only contain letters, digits, '-' and '_'"
            )));
        }
        entry.category = name;
    }
    if let Some(k) = args.kind {
        entry.kind = k;
    }
    if let Some(p) = args.payee {
        if p.chars().any(char::is_control) {
            return Err(Error::invalid("payee must not contain control characters"));
        }
        if p.chars().count() > 64 {
            return Err(Error::invalid("payee is longer than 64 characters"));
        }
        entry.payee = p;
    }
    if let Some(n) = args.note {
        let n = n.trim();
        if n.chars().count() > 250 {
            return Err(Error::invalid("note is longer than 250 characters"));
        }
        entry.note = n.to_string();
    }
    if let Some(tags) = args.tags {
        let mut out: Vec<String> = Vec::new();
        for t in tags {
            let tag = t.trim().to_lowercase();
            if tag.is_empty() {
                return Err(Error::invalid("tag must not be empty"));
            }
            if tag.chars().count() > 16 {
                return Err(Error::invalid(format!(
                    "tag '{tag}' is longer than 16 characters"
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
        entry.tags = out;
    }
    ledger.entries[pos] = entry;
    store.save(&ledger)?;
    ctx.say(&format!("updated entry {}", args.id))
}
