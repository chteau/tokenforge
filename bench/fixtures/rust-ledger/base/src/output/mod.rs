//! Rendering of tabular results as an aligned text table, JSON or CSV.
//!
//! Commands build a [`Table`] of typed [`Cell`]s and hand it to [`render`];
//! they never format output themselves, so every command supports every
//! format.

pub mod csv;
pub mod json;
pub mod table;

use std::fmt;
use std::io::{self, Write};
use std::str::FromStr;

use crate::util::{Date, Money};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Table,
    Json,
    Csv,
}

impl FromStr for Format {
    type Err = String;
    fn from_str(s: &str) -> Result<Format, String> {
        match s.to_ascii_lowercase().as_str() {
            "table" | "text" => Ok(Format::Table),
            "json" => Ok(Format::Json),
            "csv" => Ok(Format::Csv),
            other => Err(format!(
                "unknown format '{other}' (expected table, json or csv)"
            )),
        }
    }
}

impl fmt::Display for Format {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Format::Table => "table",
            Format::Json => "json",
            Format::Csv => "csv",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Text(String),
    Int(i64),
    Money(Money),
    Date(Date),
    /// A percentage with one decimal, stored in tenths of a percent.
    Percent(i64),
    Empty,
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Cell {
        Cell::Text(s.into())
    }
}

#[derive(Debug, Clone)]
pub struct Column {
    /// Machine name, used as the JSON key and CSV header.
    pub key: String,
    /// Human heading for the text table.
    pub title: String,
    pub align: Align,
    /// Truncate text cells to this many characters in the text table.
    pub max_width: Option<usize>,
}

impl Column {
    pub fn left(key: &str) -> Column {
        Column {
            key: key.to_string(),
            title: key.to_uppercase(),
            align: Align::Left,
            max_width: None,
        }
    }

    pub fn right(key: &str) -> Column {
        Column {
            align: Align::Right,
            ..Column::left(key)
        }
    }

    pub fn max_width(mut self, w: usize) -> Column {
        self.max_width = Some(w);
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct Table {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    /// Optional totals row, shown only in the text table.
    pub footer: Option<Vec<Cell>>,
}

impl Table {
    pub fn new(columns: Vec<Column>) -> Table {
        Table {
            columns,
            rows: Vec::new(),
            footer: None,
        }
    }

    pub fn push(&mut self, row: Vec<Cell>) {
        debug_assert_eq!(row.len(), self.columns.len());
        self.rows.push(row);
    }
}

/// Settings that affect how cells are shown.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub currency_symbol: String,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            currency_symbol: "$".to_string(),
        }
    }
}

pub fn render(
    table: &Table,
    format: Format,
    opts: &RenderOptions,
    out: &mut dyn Write,
) -> io::Result<()> {
    match format {
        Format::Table => table::render(table, opts, out),
        Format::Json => json::render(table, out),
        Format::Csv => csv::render(table, out),
    }
}

/// Plain textual value of a cell, as used by CSV.
pub(crate) fn plain(cell: &Cell) -> String {
    match cell {
        Cell::Text(s) => s.clone(),
        Cell::Int(n) => n.to_string(),
        Cell::Money(m) => m.to_decimal(),
        Cell::Date(d) => d.to_string(),
        Cell::Percent(p) => format_percent(*p),
        Cell::Empty => String::new(),
    }
}

pub(crate) fn format_percent(tenths: i64) -> String {
    let sign = if tenths < 0 { "-" } else { "" };
    let abs = tenths.unsigned_abs();
    format!("{sign}{}.{}%", abs / 10, abs % 10)
}

/// Integer percentage of `part` relative to `whole`, in tenths, rounded half up.
pub fn percent_tenths(part: i64, whole: i64) -> i64 {
    if whole == 0 {
        return 0;
    }
    (part * 2000 + whole) / (2 * whole)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_math() {
        assert_eq!(percent_tenths(1, 3), 333);
        assert_eq!(percent_tenths(2, 3), 667);
        assert_eq!(percent_tenths(5, 0), 0);
        assert_eq!(format_percent(1250), "125.0%");
    }

    #[test]
    fn parses_formats() {
        assert_eq!("JSON".parse::<Format>().unwrap(), Format::Json);
        assert!("xml".parse::<Format>().is_err());
    }
}
