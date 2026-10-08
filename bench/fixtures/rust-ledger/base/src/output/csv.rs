//! RFC 4180 style CSV output with a header row of column keys.

use std::io::{self, Write};

use super::{plain, Table};

pub fn quote(field: &str) -> String {
    if field.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

pub fn render(table: &Table, out: &mut dyn Write) -> io::Result<()> {
    let header: Vec<String> = table.columns.iter().map(|c| quote(&c.key)).collect();
    writeln!(out, "{}", header.join(","))?;
    for row in &table.rows {
        let fields: Vec<String> = row.iter().map(|c| quote(&plain(c))).collect();
        writeln!(out, "{}", fields.join(","))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_when_needed() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote("a,b"), "\"a,b\"");
        assert_eq!(quote("say \"hi\""), "\"say \"\"hi\"\"\"");
    }
}
