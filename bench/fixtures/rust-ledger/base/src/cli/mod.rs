//! Command-line interface: turns `argv` into a [`Command`].

mod help;
mod parser;

use std::path::PathBuf;

use crate::model::Kind;
use crate::output::Format;
use crate::util::{Date, Money, YearMonth};

pub use help::{command_help, USAGE};
pub use parser::parse;

/// A fully parsed command line.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    /// `--dir`: the data directory.
    pub dir: Option<PathBuf>,
    /// `--format`: overrides `output.format` from the config.
    pub format: Option<Format>,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Init,
    Add(AddArgs),
    List(ListArgs),
    Edit(EditArgs),
    Remove { id: u64 },
    RenameCategory { from: String, to: String },
    Categories,
    Report(ReportArgs),
    Import(ImportArgs),
    Config,
    Help { topic: Option<String> },
    Version,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddArgs {
    pub date: Date,
    pub amount: Money,
    pub category: String,
    pub kind: Kind,
    pub payee: String,
    pub note: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortKey {
    #[default]
    Date,
    Amount,
    Category,
    Payee,
    Id,
}

/// Selection options shared by `list` and `report categories`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Selection {
    pub filter: Option<String>,
    pub month: Option<YearMonth>,
    pub from: Option<Date>,
    pub to: Option<Date>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListArgs {
    pub selection: Selection,
    pub sort: SortKey,
    pub descending: bool,
    pub limit: Option<usize>,
}

/// Fields left as `None` are not changed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EditArgs {
    pub id: u64,
    pub date: Option<Date>,
    pub amount: Option<Money>,
    pub category: Option<String>,
    pub kind: Option<Kind>,
    pub payee: Option<String>,
    pub note: Option<String>,
    /// `Some` replaces all tags; `--clear-tags` gives `Some(vec![])`.
    pub tags: Option<Vec<String>>,
}

impl EditArgs {
    pub fn is_empty(&self) -> bool {
        self.date.is_none()
            && self.amount.is_none()
            && self.category.is_none()
            && self.kind.is_none()
            && self.payee.is_none()
            && self.note.is_none()
            && self.tags.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReportArgs {
    Monthly { year: Option<i32> },
    Categories(Selection),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportArgs {
    pub path: PathBuf,
    pub category: Option<String>,
    pub dry_run: bool,
}
