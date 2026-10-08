use super::Context;
use crate::error::Result;
use crate::output::{Cell, Column, Table};

pub fn run(ctx: &mut Context) -> Result<()> {
    let mut table = Table::new(vec![
        Column::left("key"),
        Column::left("value"),
        Column::left("source"),
    ]);
    for (key, value, source) in ctx.config.entries() {
        table.push(vec![
            Cell::text(key),
            Cell::text(value),
            Cell::text(source.to_string()),
        ]);
    }
    ctx.render(&table)
}
