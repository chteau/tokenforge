use super::Context;
use crate::cache;
use crate::error::Result;
use crate::report;

pub fn run(ctx: &mut Context) -> Result<()> {
    let store = ctx.store()?;
    let summary = cache::summary(&store, ctx.use_cache())?;
    ctx.render(&report::categories(&summary))
}
