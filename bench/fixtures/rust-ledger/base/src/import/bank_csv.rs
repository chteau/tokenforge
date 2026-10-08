//! Parser for the CSV export format used by most retail banks:
//!
//! ```text
//! Date,Description,Amount,Balance
//! 03/01/2026,"CORNER SHOP, HIGH ST",-12.50,987.50
//! ```
//!
//! Dates are day-first, amounts are signed (negative = money out). Columns are
//! located by header name, so extra columns and different orders are fine.

use crate::error::{Error, Result};
use crate::util::{Date, Money};

#[derive(Debug, Clone, PartialEq)]
pub struct BankRow {
    /// 1-based line number in the source file.
    pub line: usize,
    pub date: Date,
    pub description: String,
    pub amount: Money,
}

/// Split one CSV record, honouring double quotes and `""` escapes.
pub fn split_record(line: &str) -> std::result::Result<Vec<String>, String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, in_quotes) {
            ('"', true) if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            ('"', true) => in_quotes = false,
            ('"', false) if cur.is_empty() => in_quotes = true,
            (',', false) => fields.push(std::mem::take(&mut cur)),
            (c, _) => cur.push(c),
        }
    }
    if in_quotes {
        return Err("unterminated quoted field".to_string());
    }
    fields.push(cur);
    Ok(fields)
}

fn column(header: &[String], name: &str) -> Result<usize> {
    header
        .iter()
        .position(|h| h.trim().eq_ignore_ascii_case(name))
        .ok_or_else(|| Error::invalid(format!("missing '{name}' column in bank file")))
}

pub fn parse(text: &str) -> Result<Vec<BankRow>> {
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.trim_end_matches('\r')))
        .filter(|(_, l)| !l.trim().is_empty());
    let (_, header_line) = lines
        .next()
        .ok_or_else(|| Error::invalid("bank file is empty"))?;
    let header = split_record(header_line.trim_start_matches('\u{feff}'))
        .map_err(|m| Error::invalid(format!("line 1: {m}")))?;
    let date_col = column(&header, "date")?;
    let desc_col = column(&header, "description")?;
    let amount_col = column(&header, "amount")?;

    let mut rows = Vec::new();
    for (line, raw) in lines {
        let bad = |m: String| Error::invalid(format!("line {line}: {m}"));
        let f = split_record(raw).map_err(bad)?;
        let get = |i: usize| f.get(i).map(|s| s.trim()).unwrap_or("");
        let date = Date::parse_dmy(get(date_col))
            .ok_or_else(|| bad(format!("invalid date '{}'", get(date_col))))?;
        let amount = Money::parse(get(amount_col)).map_err(bad)?;
        rows.push(BankRow {
            line,
            date,
            description: get(desc_col).to_string(),
            amount,
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_fields() {
        assert_eq!(
            split_record("a,\"b, c\",\"say \"\"x\"\"\",").unwrap(),
            vec!["a", "b, c", "say \"x\"", ""]
        );
        assert!(split_record("\"open").is_err());
    }

    #[test]
    fn parses_rows_by_header_name() {
        let rows = parse("Amount,Date,Description\n-1.00,05/03/2026,X\n\n2,06/03/2026,\"Y, Z\"\n")
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].line, 4);
        assert_eq!(rows[1].description, "Y, Z");
        assert_eq!(rows[0].amount, Money(-100));
    }

    #[test]
    fn reports_bad_lines() {
        let err = parse("Date,Description,Amount\n31/02/2026,X,1\n").unwrap_err();
        assert_eq!(err.to_string(), "line 2: invalid date '31/02/2026'");
    }
}
