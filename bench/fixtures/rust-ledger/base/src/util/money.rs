//! Money amounts stored as integer cents.

use std::fmt;

/// An amount of money in cents. Never use floating point for money.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Money(pub i64);

impl Money {
    pub const ZERO: Money = Money(0);

    pub fn cents(self) -> i64 {
        self.0
    }

    /// Parse `12`, `12.5`, `12.50`, `-3.20` or `1,250.00`.
    pub fn parse(input: &str) -> Result<Money, String> {
        let bad = || format!("invalid amount '{input}'");
        let s = input.trim();
        let (negative, s) = match s.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, s.strip_prefix('+').unwrap_or(s)),
        };
        let s: String = s.chars().filter(|c| *c != ',').collect();
        let (whole, frac) = match s.split_once('.') {
            Some((w, f)) => (w, f),
            None => (s.as_str(), ""),
        };
        if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        if frac.len() > 2 || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        if s.contains('.') && frac.is_empty() {
            return Err(bad());
        }
        let whole: i64 = whole.parse().map_err(|_| bad())?;
        let frac_cents: i64 = match frac.len() {
            0 => 0,
            1 => frac.parse::<i64>().map_err(|_| bad())? * 10,
            _ => frac.parse().map_err(|_| bad())?,
        };
        let cents = whole
            .checked_mul(100)
            .and_then(|c| c.checked_add(frac_cents))
            .ok_or_else(bad)?;
        Ok(Money(if negative { -cents } else { cents }))
    }

    /// Plain decimal form, e.g. `-12.50`. Used by CSV and JSON output.
    pub fn to_decimal(self) -> String {
        let sign = if self.0 < 0 { "-" } else { "" };
        let abs = self.0.unsigned_abs();
        format!("{sign}{}.{:02}", abs / 100, abs % 100)
    }

    /// Human form with a currency symbol, e.g. `-$12.50`.
    pub fn display_with(self, symbol: &str) -> String {
        let sign = if self.0 < 0 { "-" } else { "" };
        let abs = self.0.unsigned_abs();
        format!("{sign}{symbol}{}.{:02}", abs / 100, abs % 100)
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_decimal())
    }
}

impl std::ops::Add for Money {
    type Output = Money;
    fn add(self, rhs: Money) -> Money {
        Money(self.0 + rhs.0)
    }
}

impl std::ops::Sub for Money {
    type Output = Money;
    fn sub(self, rhs: Money) -> Money {
        Money(self.0 - rhs.0)
    }
}

impl std::ops::AddAssign for Money {
    fn add_assign(&mut self, rhs: Money) {
        self.0 += rhs.0;
    }
}

impl std::iter::Sum for Money {
    fn sum<I: Iterator<Item = Money>>(iter: I) -> Money {
        iter.fold(Money::ZERO, |a, b| a + b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_forms() {
        assert_eq!(Money::parse("12").unwrap(), Money(1200));
        assert_eq!(Money::parse("12.5").unwrap(), Money(1250));
        assert_eq!(Money::parse("0.07").unwrap(), Money(7));
        assert_eq!(Money::parse("-3.20").unwrap(), Money(-320));
        assert_eq!(Money::parse("1,250.00").unwrap(), Money(125000));
        assert!(Money::parse("12.").is_err());
        assert!(Money::parse("1.234").is_err());
        assert!(Money::parse("abc").is_err());
        assert!(Money::parse("").is_err());
    }

    #[test]
    fn formats() {
        assert_eq!(Money(-1250).to_decimal(), "-12.50");
        assert_eq!(Money(7).display_with("$"), "$0.07");
        assert_eq!(Money(-99).display_with("EUR "), "-EUR 0.99");
    }
}
