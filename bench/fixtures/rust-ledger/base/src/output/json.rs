//! JSON output: an array with one object per row, keyed by column key.

use std::io::{self, Write};

use super::{Cell, Table};

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn value(cell: &Cell) -> String {
    match cell {
        Cell::Text(s) => escape(s),
        Cell::Int(n) => n.to_string(),
        Cell::Money(m) => m.to_decimal(),
        Cell::Date(d) => escape(&d.to_string()),
        Cell::Percent(p) => {
            let sign = if *p < 0 { "-" } else { "" };
            format!("{sign}{}.{}", p.unsigned_abs() / 10, p.unsigned_abs() % 10)
        }
        Cell::Empty => "null".to_string(),
    }
}

pub fn render(table: &Table, out: &mut dyn Write) -> io::Result<()> {
    if table.rows.is_empty() {
        return writeln!(out, "[]");
    }
    writeln!(out, "[")?;
    for (n, row) in table.rows.iter().enumerate() {
        let fields: Vec<String> = table
            .columns
            .iter()
            .zip(row)
            .map(|(col, cell)| format!("{}: {}", escape(&col.key), value(cell)))
            .collect();
        let comma = if n + 1 < table.rows.len() { "," } else { "" };
        writeln!(out, "  {{{}}}{comma}", fields.join(", "))?;
    }
    writeln!(out, "]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::Column;
    use crate::util::Money;

    #[test]
    fn renders_rows() {
        let mut t = Table::new(vec![Column::left("name"), Column::right("amount")]);
        t.push(vec![Cell::text("a \"b\""), Cell::Money(Money(-5))]);
        t.push(vec![Cell::Empty, Cell::Int(3)]);
        let mut buf = Vec::new();
        render(&t, &mut buf).unwrap();
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "[\n  {\"name\": \"a \\\"b\\\"\", \"amount\": -0.05},\n  {\"name\": null, \"amount\": 3}\n]\n"
        );
    }
}
