//! Escaping for the `|`-separated line format.
//!
//! `\` is written as `\\`, `|` as `\|`, newline as `\n` and carriage return
//! as `\r`. Everything else is written verbatim.

use crate::model::{Entry, Kind};
use crate::util::Money;

pub const SEP: char = '|';

pub fn escape_field(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '|' => out.push_str("\\|"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out
}

/// Join already-unescaped fields into one line.
pub fn join_fields<S: AsRef<str>>(fields: &[S]) -> String {
    let escaped: Vec<String> = fields.iter().map(|f| escape_field(f.as_ref())).collect();
    escaped.join("|")
}

/// Split a line on unescaped separators and unescape each field.
pub fn split_fields(line: &str) -> Result<Vec<String>, String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('\\') => cur.push('\\'),
                Some('|') => cur.push('|'),
                Some('n') => cur.push('\n'),
                Some('r') => cur.push('\r'),
                Some(other) => return Err(format!("unknown escape '\\{other}'")),
                None => return Err("line ends with a lone '\\'".to_string()),
            },
            SEP => fields.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    fields.push(cur);
    Ok(fields)
}

pub fn encode_entry(e: &Entry) -> String {
    join_fields(&[
        e.id.to_string(),
        e.date.to_string(),
        e.kind.to_string(),
        e.amount.to_decimal(),
        e.category.clone(),
        e.payee.clone(),
        e.note.clone(),
        e.tags.join(","),
    ])
}

pub fn decode_entry(line: &str) -> Result<Entry, String> {
    let f = split_fields(line)?;
    if f.len() != 8 {
        return Err(format!("expected 8 fields, found {}", f.len()));
    }
    let id = f[0]
        .parse::<u64>()
        .map_err(|_| format!("bad id '{}'", f[0]))?;
    let date = f[1].parse()?;
    let kind: Kind = f[2].parse()?;
    let amount = Money::parse(&f[3])?;
    let tags = if f[7].is_empty() {
        Vec::new()
    } else {
        f[7].split(',').map(str::to_string).collect()
    };
    Ok(Entry {
        id,
        date,
        kind,
        amount,
        category: f[4].clone(),
        payee: f[5].clone(),
        note: f[6].clone(),
        tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_round_trip() {
        let fields = ["a|b", "back\\slash", "multi\nline", ""];
        let line = join_fields(&fields);
        assert_eq!(line, "a\\|b|back\\\\slash|multi\\nline|");
        assert_eq!(split_fields(&line).unwrap(), fields);
    }

    #[test]
    fn rejects_bad_escapes() {
        assert!(split_fields("a\\x").is_err());
        assert!(split_fields("a\\").is_err());
    }
}
