use super::Context;
use crate::error::{Error, Result};
use crate::index::LedgerIndex;
use crate::util::text::plural;

pub fn run(ctx: &mut Context, from: &str, to: &str) -> Result<()> {
    let from = from.trim().to_lowercase();
    let to = to.trim().to_lowercase();
    if to.is_empty() {
        return Err(Error::invalid("category must not be empty"));
    }
    if to.len() > 30 {
        return Err(Error::invalid("category is longer than 30 characters"));
    }
    if !to
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(Error::invalid(
            "category may only contain letters, digits, '-' and '_'",
        ));
    }
    if from == to {
        return Err(Error::invalid("old and new category are the same"));
    }
    let store = ctx.store()?;
    let mut ledger = store.load()?;
    let positions = LedgerIndex::build(&ledger).in_category(&from).to_vec();
    if positions.is_empty() {
        return Err(Error::NotFound(format!("no entries in category '{from}'")));
    }
    for &pos in &positions {
        ledger.entries[pos].category = to.clone();
    }
    store.save(&ledger)?;
    ctx.say(&format!(
        "renamed '{from}' to '{to}' ({})",
        plural(positions.len(), "entry", "entries")
    ))
}
