use super::Context;
use crate::error::{Error, Result};
use crate::index::LedgerIndex;
use crate::model::validate;
use crate::util::text::plural;

pub fn run(ctx: &mut Context, from: &str, to: &str) -> Result<()> {
    let from = from.trim().to_lowercase();
    let to = validate::category(to)?;
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
