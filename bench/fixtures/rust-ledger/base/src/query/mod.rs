//! Filter expressions such as
//! `category=groceries and amount>=20 and not payee~market`.
//!
//! Grammar (keywords are case-insensitive):
//!
//! ```text
//! expr  := and ("or" and)*
//! and   := unary ("and" unary)*
//! unary := "not" unary | "(" expr ")" | FIELD OP VALUE
//! OP    := = | != | < | <= | > | >= | ~
//! ```
//!
//! Fields: `id`, `date`, `month`, `kind`, `amount`, `category`, `payee`,
//! `note`, `tag`. Text comparisons ignore case; `~` means "contains".

mod lexer;
mod parser;

use std::fmt;

use crate::error::{Error, Result};
use crate::model::{Entry, Kind};
use crate::util::{Date, Money, YearMonth};

pub use parser::parse;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Id,
    Date,
    Month,
    Kind,
    Amount,
    Category,
    Payee,
    Note,
    Tag,
}

impl Field {
    pub fn from_name(name: &str) -> Option<Field> {
        Some(match name.to_ascii_lowercase().as_str() {
            "id" => Field::Id,
            "date" => Field::Date,
            "month" => Field::Month,
            "kind" => Field::Kind,
            "amount" => Field::Amount,
            "category" | "cat" => Field::Category,
            "payee" => Field::Payee,
            "note" => Field::Note,
            "tag" => Field::Tag,
            _ => return None,
        })
    }
}

impl fmt::Display for Field {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = format!("{self:?}").to_lowercase();
        f.write_str(&s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
}

impl Op {
    fn holds(self, ord: std::cmp::Ordering) -> bool {
        use std::cmp::Ordering::*;
        match self {
            Op::Eq => ord == Equal,
            Op::Ne => ord != Equal,
            Op::Lt => ord == Less,
            Op::Le => ord != Greater,
            Op::Gt => ord == Greater,
            Op::Ge => ord != Less,
            Op::Contains => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(u64),
    Date(Date),
    Month(YearMonth),
    Money(Money),
    Kind(Kind),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Cmp { field: Field, op: Op, value: Value },
}

impl Expr {
    pub fn matches(&self, e: &Entry) -> bool {
        match self {
            Expr::And(a, b) => a.matches(e) && b.matches(e),
            Expr::Or(a, b) => a.matches(e) || b.matches(e),
            Expr::Not(a) => !a.matches(e),
            Expr::Cmp { field, op, value } => compare(e, *field, *op, value),
        }
    }
}

fn text_cmp(have: &str, op: Op, want: &str) -> bool {
    let have = have.to_lowercase();
    let want = want.to_lowercase();
    match op {
        Op::Contains => have.contains(&want),
        _ => op.holds(have.cmp(&want)),
    }
}

fn compare(e: &Entry, field: Field, op: Op, value: &Value) -> bool {
    match (field, value) {
        (Field::Id, Value::Int(n)) => op.holds(e.id.cmp(n)),
        (Field::Date, Value::Date(d)) => op.holds(e.date.cmp(d)),
        (Field::Month, Value::Month(m)) => op.holds(e.date.year_month().cmp(m)),
        (Field::Amount, Value::Money(m)) => op.holds(e.amount.cmp(m)),
        (Field::Kind, Value::Kind(k)) => (e.kind == *k) == (op == Op::Eq),
        (Field::Category, Value::Text(t)) => text_cmp(&e.category, op, t),
        (Field::Payee, Value::Text(t)) => text_cmp(&e.payee, op, t),
        (Field::Note, Value::Text(t)) => text_cmp(&e.note, op, t),
        (Field::Tag, Value::Text(t)) => {
            let tag = t.trim_start_matches('#').to_lowercase();
            e.has_tag(&tag) == (op == Op::Eq)
        }
        _ => false,
    }
}

/// Everything that narrows down a list of entries: an optional expression
/// plus an inclusive date range.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub expr: Option<Expr>,
    pub from: Option<Date>,
    pub to: Option<Date>,
}

impl Filter {
    pub fn new(
        expr: Option<&str>,
        month: Option<YearMonth>,
        from: Option<Date>,
        to: Option<Date>,
    ) -> Result<Filter> {
        let expr = expr.map(parse).transpose()?;
        let (mut lo, mut hi) = (from, to);
        if let Some(m) = month {
            if from.is_some() || to.is_some() {
                return Err(Error::usage("--month cannot be combined with --from/--to"));
            }
            lo = Some(m.first_day());
            hi = Some(m.last_day());
        }
        if let (Some(a), Some(b)) = (lo, hi) {
            if a > b {
                return Err(Error::usage(format!("--from {a} is after --to {b}")));
            }
        }
        Ok(Filter {
            expr,
            from: lo,
            to: hi,
        })
    }

    pub fn matches(&self, e: &Entry) -> bool {
        if let Some(from) = self.from {
            if e.date < from {
                return false;
            }
        }
        if let Some(to) = self.to {
            if e.date > to {
                return false;
            }
        }
        self.expr.as_ref().is_none_or(|x| x.matches(e))
    }

    pub fn apply<'a>(&self, entries: &'a [Entry]) -> Vec<&'a Entry> {
        entries.iter().filter(|e| self.matches(e)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(date: &str, cents: i64, cat: &str, payee: &str, tags: &[&str]) -> Entry {
        Entry {
            id: 1,
            date: date.parse().unwrap(),
            kind: Kind::Expense,
            amount: Money(cents),
            category: cat.into(),
            payee: payee.into(),
            note: String::new(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn evaluates_boolean_logic() {
        let e = entry("2026-01-31", 2500, "food", "Night Market", &["weekend"]);
        let yes = [
            "category=food",
            "amount>=25",
            "amount<25.01",
            "payee~market and tag=#weekend",
            "not kind=income",
            "month=2026-01",
            "(category=rent or category=food) and date<=2026-01-31",
        ];
        for q in yes {
            assert!(parse(q).unwrap().matches(&e), "{q}");
        }
        let no = ["category!=food", "amount>25", "tag=work", "date>2026-01-31"];
        for q in no {
            assert!(!parse(q).unwrap().matches(&e), "{q}");
        }
    }

    #[test]
    fn month_range_is_inclusive() {
        let f = Filter::new(None, Some("2026-01".parse().unwrap()), None, None).unwrap();
        assert!(f.matches(&entry("2026-01-31", 1, "a", "", &[])));
        assert!(f.matches(&entry("2026-01-01", 1, "a", "", &[])));
        assert!(!f.matches(&entry("2026-02-01", 1, "a", "", &[])));
    }
}
