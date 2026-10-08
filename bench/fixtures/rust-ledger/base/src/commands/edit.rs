use super::Context;
use crate::cli::EditArgs;
use crate::error::{Error, Result};
use crate::index::LedgerIndex;
use crate::model::validate;

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
        entry.amount = a;
    }
    if let Some(c) = args.category {
        entry.category = c;
    }
    if let Some(k) = args.kind {
        entry.kind = k;
    }
    if let Some(p) = args.payee {
        entry.payee = p;
    }
    if let Some(n) = args.note {
        entry.note = n;
    }
    if let Some(t) = args.tags {
        entry.tags = t;
    }
    validate::entry(&mut entry)?;
    ledger.entries[pos] = entry;
    store.save(&ledger)?;
    ctx.say(&format!("updated entry {}", args.id))
}
