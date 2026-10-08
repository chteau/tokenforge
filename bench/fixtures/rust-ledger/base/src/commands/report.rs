use super::{filter_for, Context};
use crate::cache;
use crate::cli::ReportArgs;
use crate::error::Result;
use crate::report;

pub fn run(ctx: &mut Context, args: ReportArgs) -> Result<()> {
    let store = ctx.store()?;
    let table = match args {
        ReportArgs::Monthly { year } => {
            let summary = cache::summary(&store, ctx.use_cache())?;
            report::monthly(&summary, year)
        }
        ReportArgs::Categories(selection) => {
            let filter = filter_for(&selection)?;
            let ledger = store.load()?;
            report::category_breakdown(&filter.apply(&ledger.entries))
        }
    };
    ctx.render(&table)
}
