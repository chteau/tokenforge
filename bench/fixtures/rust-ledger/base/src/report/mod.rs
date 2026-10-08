//! Aggregated views of the ledger.

use std::collections::BTreeMap;

use crate::cache::{Summary, Totals};
use crate::model::{Entry, Kind};
use crate::output::{percent_tenths, Cell, Column, Table};
use crate::util::Money;

fn totals_cells(t: &Totals) -> Vec<Cell> {
    vec![
        Cell::Int(t.count as i64),
        Cell::Money(t.expenses),
        Cell::Money(t.income),
        Cell::Money(t.net()),
    ]
}

fn sum<'a>(it: impl Iterator<Item = &'a Totals>) -> Totals {
    it.fold(Totals::default(), |mut acc, t| {
        acc.count += t.count;
        acc.expenses += t.expenses;
        acc.income += t.income;
        acc
    })
}

/// One row per month, optionally limited to one year, with a totals footer.
pub fn monthly(summary: &Summary, year: Option<i32>) -> Table {
    let mut table = Table::new(vec![
        Column::left("month"),
        Column::right("count"),
        Column::right("expenses"),
        Column::right("income"),
        Column::right("net"),
    ]);
    let months: Vec<_> = summary
        .months
        .iter()
        .filter(|(m, _)| year.is_none_or(|y| m.year() == y))
        .collect();
    for (month, t) in &months {
        let mut row = vec![Cell::text(month.to_string())];
        row.extend(totals_cells(t));
        table.push(row);
    }
    let total = sum(months.iter().map(|(_, t)| *t));
    let mut footer = vec![Cell::text("total")];
    footer.extend(totals_cells(&total));
    table.footer = Some(footer);
    table
}

/// Category totals across the whole ledger.
pub fn categories(summary: &Summary) -> Table {
    let mut table = Table::new(vec![
        Column::left("category"),
        Column::right("count"),
        Column::right("expenses"),
        Column::right("income"),
    ]);
    for (name, t) in &summary.categories {
        table.push(vec![
            Cell::text(name.clone()),
            Cell::Int(t.count as i64),
            Cell::Money(t.expenses),
            Cell::Money(t.income),
        ]);
    }
    table
}

/// Per-category breakdown of a filtered set of entries, largest spend first,
/// with each category's share of total expenses.
pub fn category_breakdown(entries: &[&Entry]) -> Table {
    let mut by_cat: BTreeMap<&str, Totals> = BTreeMap::new();
    for e in entries {
        let t = by_cat.entry(e.category.as_str()).or_default();
        t.count += 1;
        match e.kind {
            Kind::Expense => t.expenses += e.amount,
            Kind::Income => t.income += e.amount,
        }
    }
    let total_spend: Money = by_cat.values().map(|t| t.expenses).sum();
    let mut rows: Vec<(&str, Totals)> = by_cat.into_iter().collect();
    rows.sort_by(|a, b| b.1.expenses.cmp(&a.1.expenses).then(a.0.cmp(b.0)));

    let mut table = Table::new(vec![
        Column::left("category"),
        Column::right("count"),
        Column::right("expenses"),
        Column::right("income"),
        Column::right("net"),
        Column::right("share"),
    ]);
    for (name, t) in &rows {
        let mut row = vec![Cell::text(*name)];
        row.extend(totals_cells(t));
        row.push(Cell::Percent(percent_tenths(
            t.expenses.cents(),
            total_spend.cents(),
        )));
        table.push(row);
    }
    let total = sum(rows.iter().map(|(_, t)| t));
    let mut footer = vec![Cell::text("total")];
    footer.extend(totals_cells(&total));
    footer.push(Cell::Empty);
    table.footer = Some(footer);
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(cat: &str, kind: Kind, cents: i64, date: &str) -> Entry {
        Entry {
            id: 0,
            date: date.parse().unwrap(),
            kind,
            amount: Money(cents),
            category: cat.into(),
            payee: String::new(),
            note: String::new(),
            tags: vec![],
        }
    }

    #[test]
    fn breakdown_orders_by_spend_and_computes_share() {
        let entries = [
            e("food", Kind::Expense, 100, "2026-01-01"),
            e("rent", Kind::Expense, 300, "2026-01-02"),
            e("salary", Kind::Income, 1000, "2026-01-03"),
        ];
        let refs: Vec<&Entry> = entries.iter().collect();
        let t = category_breakdown(&refs);
        assert_eq!(t.rows[0][0], Cell::text("rent"));
        assert_eq!(t.rows[0][5], Cell::Percent(750));
        assert_eq!(t.rows[2][5], Cell::Percent(0));
    }

    #[test]
    fn monthly_filters_by_year() {
        let entries = [
            e("food", Kind::Expense, 100, "2025-12-31"),
            e("food", Kind::Expense, 200, "2026-01-01"),
        ];
        let s = Summary::compute(&entries);
        let t = monthly(&s, Some(2026));
        assert_eq!(t.rows.len(), 1);
        assert_eq!(t.footer.as_ref().unwrap()[2], Cell::Money(Money(200)));
    }
}
