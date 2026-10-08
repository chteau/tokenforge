use super::{filter_for, Context};
use crate::cli::{ListArgs, SortKey};
use crate::error::Result;
use crate::model::Entry;
use crate::output::{Cell, Column, Table};
use crate::util::Money;

/// The standard table of entries, shared by `list` and `import --dry-run`.
pub fn entry_table(entries: &[&Entry], note_width: usize) -> Table {
    let mut table = Table::new(vec![
        Column::right("id"),
        Column::left("date"),
        Column::left("category"),
        Column::right("amount"),
        Column::left("payee"),
        Column::left("tags"),
        Column::left("note").max_width(note_width.max(4)),
    ]);
    for e in entries {
        table.push(vec![
            Cell::Int(e.id as i64),
            Cell::Date(e.date),
            Cell::text(e.category.clone()),
            Cell::Money(e.signed_amount()),
            Cell::text(e.payee.clone()),
            Cell::text(e.tags.join(",")),
            Cell::text(e.note.clone()),
        ]);
    }
    let total: Money = entries.iter().map(|e| e.signed_amount()).sum();
    table.footer = Some(vec![
        Cell::Empty,
        Cell::text("total"),
        Cell::Empty,
        Cell::Money(total),
        Cell::Empty,
        Cell::Empty,
        Cell::Empty,
    ]);
    table
}

fn sort(entries: &mut [&Entry], key: SortKey, descending: bool) {
    entries.sort_by(|a, b| {
        let primary = match key {
            SortKey::Date => a.date.cmp(&b.date),
            SortKey::Amount => a.amount.cmp(&b.amount),
            SortKey::Category => a.category.cmp(&b.category),
            SortKey::Payee => a.payee.to_lowercase().cmp(&b.payee.to_lowercase()),
            SortKey::Id => a.id.cmp(&b.id),
        };
        primary.then(a.date.cmp(&b.date)).then(a.id.cmp(&b.id))
    });
    if descending {
        entries.reverse();
    }
}

pub fn run(ctx: &mut Context, args: ListArgs) -> Result<()> {
    let filter = filter_for(&args.selection)?;
    let ledger = ctx.store()?.load()?;
    let mut entries = filter.apply(&ledger.entries);
    sort(&mut entries, args.sort, args.descending);
    if let Some(n) = args.limit {
        entries.truncate(n);
    }
    let note_width = ctx.config.get_count("output.note_width");
    ctx.render(&entry_table(&entries, note_width))
}
