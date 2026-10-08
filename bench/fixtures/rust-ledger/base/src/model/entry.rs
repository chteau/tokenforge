use std::fmt;
use std::str::FromStr;

use crate::util::{Date, Money};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Expense,
    Income,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Expense => "expense",
            Kind::Income => "income",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Kind {
    type Err = String;
    fn from_str(s: &str) -> Result<Kind, String> {
        match s {
            "expense" => Ok(Kind::Expense),
            "income" => Ok(Kind::Income),
            other => Err(format!("unknown kind '{other}'")),
        }
    }
}

/// One ledger line. `amount` is always positive; `kind` gives the direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: u64,
    pub date: Date,
    pub kind: Kind,
    pub amount: Money,
    pub category: String,
    pub payee: String,
    pub note: String,
    pub tags: Vec<String>,
}

impl Entry {
    /// Expenses are negative, income positive.
    pub fn signed_amount(&self) -> Money {
        match self.kind {
            Kind::Expense => Money(-self.amount.0),
            Kind::Income => self.amount,
        }
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_amount_follows_kind() {
        let mut e = Entry {
            id: 1,
            date: "2026-01-01".parse().unwrap(),
            kind: Kind::Expense,
            amount: Money(500),
            category: "food".into(),
            payee: String::new(),
            note: String::new(),
            tags: vec!["x".into()],
        };
        assert_eq!(e.signed_amount(), Money(-500));
        e.kind = Kind::Income;
        assert_eq!(e.signed_amount(), Money(500));
        assert!(e.has_tag("x"));
    }
}
