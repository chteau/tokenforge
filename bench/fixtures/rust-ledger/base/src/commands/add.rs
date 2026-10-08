use super::Context;
use crate::cli::AddArgs;
use crate::error::Result;
use crate::model::{validate, Entry};

pub fn run(ctx: &mut Context, args: AddArgs) -> Result<()> {
    let store = ctx.store()?;
    let mut entry = Entry {
        id: 0,
        date: args.date,
        kind: args.kind,
        amount: args.amount,
        category: args.category,
        payee: args.payee,
        note: args.note,
        tags: args.tags,
    };
    validate::entry(&mut entry)?;
    let mut ledger = store.load()?;
    let id = ledger.insert(entry);
    store.save(&ledger)?;
    ctx.say(&format!("added entry {id}"))
}
