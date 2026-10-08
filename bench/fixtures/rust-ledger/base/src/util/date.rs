//! Calendar dates in `YYYY-MM-DD` form and calendar months in `YYYY-MM` form.

use std::fmt;
use std::str::FromStr;

/// A calendar date without a time zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    year: i32,
    month: u32,
    day: u32,
}

pub fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

impl Date {
    pub fn new(year: i32, month: u32, day: u32) -> Option<Date> {
        if !(1..=9999).contains(&year) || !(1..=12).contains(&month) {
            return None;
        }
        if day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Date { year, month, day })
    }

    pub fn year(&self) -> i32 {
        self.year
    }

    pub fn month(&self) -> u32 {
        self.month
    }

    pub fn day(&self) -> u32 {
        self.day
    }

    pub fn year_month(&self) -> YearMonth {
        YearMonth {
            year: self.year,
            month: self.month,
        }
    }

    /// Parse a day-first date such as `31/01/2026`, as used by bank exports.
    pub fn parse_dmy(s: &str) -> Option<Date> {
        let mut parts = s.trim().split('/');
        let day = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let year = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Date::new(year, month, day)
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

impl FromStr for Date {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bad = || format!("invalid date '{s}' (expected YYYY-MM-DD)");
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return Err(bad());
        }
        let year = parse_digits(&s[0..4]).ok_or_else(bad)? as i32;
        let month = parse_digits(&s[5..7]).ok_or_else(bad)?;
        let day = parse_digits(&s[8..10]).ok_or_else(bad)?;
        Date::new(year, month, day).ok_or_else(bad)
    }
}

/// A calendar month, used for monthly filters and reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct YearMonth {
    year: i32,
    month: u32,
}

impl YearMonth {
    pub fn new(year: i32, month: u32) -> Option<YearMonth> {
        if (1..=9999).contains(&year) && (1..=12).contains(&month) {
            Some(YearMonth { year, month })
        } else {
            None
        }
    }

    pub fn year(&self) -> i32 {
        self.year
    }

    pub fn month(&self) -> u32 {
        self.month
    }

    pub fn first_day(&self) -> Date {
        Date {
            year: self.year,
            month: self.month,
            day: 1,
        }
    }

    pub fn last_day(&self) -> Date {
        Date {
            year: self.year,
            month: self.month,
            day: days_in_month(self.year, self.month),
        }
    }

    pub fn contains(&self, date: Date) -> bool {
        date.year == self.year && date.month == self.month
    }

    pub fn next(&self) -> YearMonth {
        if self.month == 12 {
            YearMonth {
                year: self.year + 1,
                month: 1,
            }
        } else {
            YearMonth {
                year: self.year,
                month: self.month + 1,
            }
        }
    }
}

impl fmt::Display for YearMonth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

impl FromStr for YearMonth {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bad = || format!("invalid month '{s}' (expected YYYY-MM)");
        let b = s.as_bytes();
        if b.len() != 7 || b[4] != b'-' {
            return Err(bad());
        }
        let year = parse_digits(&s[0..4]).ok_or_else(bad)? as i32;
        let month = parse_digits(&s[5..7]).ok_or_else(bad)?;
        YearMonth::new(year, month).ok_or_else(bad)
    }
}

fn parse_digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_iso_dates() {
        let d: Date = "2026-02-28".parse().unwrap();
        assert_eq!(d.to_string(), "2026-02-28");
        assert!("2026-02-29".parse::<Date>().is_err());
        assert!("2024-02-29".parse::<Date>().is_ok());
        assert!("2026-2-01".parse::<Date>().is_err());
        assert!("2026-13-01".parse::<Date>().is_err());
    }

    #[test]
    fn month_bounds() {
        let m: YearMonth = "2026-04".parse().unwrap();
        assert_eq!(m.first_day().to_string(), "2026-04-01");
        assert_eq!(m.last_day().to_string(), "2026-04-30");
        assert_eq!(
            "2026-12".parse::<YearMonth>().unwrap().next().to_string(),
            "2027-01"
        );
    }

    #[test]
    fn parses_day_first_dates() {
        assert_eq!(
            Date::parse_dmy("03/01/2026").unwrap().to_string(),
            "2026-01-03"
        );
        assert!(Date::parse_dmy("31/02/2026").is_none());
    }
}
