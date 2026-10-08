use super::Context;
use crate::cache;
use crate::error::Result;
use crate::store::Store;

pub fn run(ctx: &mut Context) -> Result<()> {
    let (store, created) = Store::init(&ctx.dir)?;
    if created {
        cache::clear(&store);
        ctx.say(&format!(
            "initialised empty ledger in {}",
            ctx.dir.display()
        ))
    } else {
        ctx.say(&format!("ledger already exists in {}", ctx.dir.display()))
    }
}
