use super::Context;
use crate::error::Result;
use crate::index::LedgerIndex;

pub fn run(ctx: &mut Context, id: u64) -> Result<()> {
    let store = ctx.store()?;
    let mut ledger = store.load()?;
    let pos = LedgerIndex::build(&ledger).require(id)?;
    ledger.entries.remove(pos);
    store.save(&ledger)?;
    ctx.say(&format!("removed entry {id}"))
}
