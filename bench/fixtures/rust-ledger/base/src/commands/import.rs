use std::fs;

use super::list::entry_table;
use super::Context;
use crate::cli::ImportArgs;
use crate::error::{Error, Result};
use crate::import;
use crate::util::text::plural;

pub fn run(ctx: &mut Context, args: ImportArgs) -> Result<()> {
    let store = ctx.store()?;
    let text = fs::read_to_string(&args.path).map_err(|e| Error::io_at(&args.path, e))?;
    let rows = import::parse_bank_csv(&text)?;
    let category = args
        .category
        .unwrap_or_else(|| ctx.config.get("import.default_category").to_string());
    let skip = ctx.config.get_bool("import.skip_duplicates");
    let mut ledger = store.load()?;
    let plan = import::plan(&rows, &ledger, &category, skip)?;
    let summary = format!(
        "{} {}, skipped {}",
        if args.dry_run {
            "would import"
        } else {
            "imported"
        },
        plural(plan.entries.len(), "entry", "entries"),
        plural(plan.duplicates, "duplicate", "duplicates"),
    );
    if args.dry_run {
        let refs: Vec<_> = plan.entries.iter().collect();
        let width = ctx.config.get_count("output.note_width");
        ctx.render(&entry_table(&refs, width))?;
        return ctx.say(&summary);
    }
    for entry in plan.entries {
        ledger.insert(entry);
    }
    store.save(&ledger)?;
    ctx.say(&summary)
}
