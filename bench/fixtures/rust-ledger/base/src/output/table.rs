//! Aligned plain-text tables.

use std::io::{self, Write};

use super::{format_percent, Align, Cell, RenderOptions, Table};
use crate::util::text::{pad_left, pad_right, truncate, width};

const GAP: &str = "  ";

fn show(cell: &Cell, opts: &RenderOptions) -> String {
    match cell {
        Cell::Text(s) => s.replace('\n', " "),
        Cell::Int(n) => n.to_string(),
        Cell::Money(m) => m.display_with(&opts.currency_symbol),
        Cell::Date(d) => d.to_string(),
        Cell::Percent(p) => format_percent(*p),
        Cell::Empty => String::new(),
    }
}

pub fn render(table: &Table, opts: &RenderOptions, out: &mut dyn Write) -> io::Result<()> {
    if table.rows.is_empty() {
        return writeln!(out, "(no rows)");
    }
    let mut lines: Vec<Vec<String>> = Vec::new();
    lines.push(table.columns.iter().map(|c| c.title.clone()).collect());
    let body = table.rows.iter().chain(table.footer.iter());
    for row in body {
        let cells = row
            .iter()
            .zip(&table.columns)
            .map(|(cell, col)| {
                let s = show(cell, opts);
                match col.max_width {
                    Some(w) => truncate(&s, w),
                    None => s,
                }
            })
            .collect();
        lines.push(cells);
    }
    let widths: Vec<usize> = (0..table.columns.len())
        .map(|i| lines.iter().map(|l| width(&l[i])).max().unwrap_or(0))
        .collect();
    let footer_at = table.footer.as_ref().map(|_| lines.len() - 1);
    for (n, line) in lines.iter().enumerate() {
        if Some(n) == footer_at {
            let total: usize = widths.iter().sum::<usize>() + GAP.len() * (widths.len() - 1);
            writeln!(out, "{}", "-".repeat(total))?;
        }
        let mut text = String::new();
        for (i, (s, col)) in line.iter().zip(&table.columns).enumerate() {
            if i > 0 {
                text.push_str(GAP);
            }
            match col.align {
                Align::Left => text.push_str(&pad_right(s, widths[i])),
                Align::Right => text.push_str(&pad_left(s, widths[i])),
            }
        }
        writeln!(out, "{}", text.trim_end())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::Column;
    use crate::util::Money;

    #[test]
    fn aligns_columns() {
        let mut t = Table::new(vec![Column::left("name"), Column::right("amount")]);
        t.push(vec![Cell::text("rent"), Cell::Money(Money(-120000))]);
        t.push(vec![Cell::text("coffee"), Cell::Money(Money(-350))]);
        let mut buf = Vec::new();
        render(&t, &RenderOptions::default(), &mut buf).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(
            s,
            "NAME       AMOUNT\nrent    -$1200.00\ncoffee     -$3.50\n"
        );
    }

    #[test]
    fn empty_table() {
        let t = Table::new(vec![Column::left("a")]);
        let mut buf = Vec::new();
        render(&t, &RenderOptions::default(), &mut buf).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "(no rows)\n");
    }
}
