//! One module per sub-command. Each exposes `run(ctx, args)`.

mod add;
mod categories;
mod config;
mod edit;
mod import;
mod init;
mod list;
mod remove;
mod rename;
mod report;

use std::io::Write;
use std::path::PathBuf;

use crate::cli::{Command, Selection};
use crate::config::Config;
use crate::error::Result;
use crate::output::{self, Format, RenderOptions, Table};
use crate::query::Filter;
use crate::store::Store;

/// Everything a command needs: where the data lives, the effective
/// configuration and where to write output.
pub struct Context<'a> {
    pub dir: PathBuf,
    pub config: Config,
    pub format: Format,
    pub out: &'a mut dyn Write,
}

impl Context<'_> {
    pub fn store(&self) -> Result<Store> {
        Store::open(&self.dir)
    }

    pub fn render_options(&self) -> RenderOptions {
        RenderOptions {
            currency_symbol: self.config.currency_symbol().to_string(),
        }
    }

    /// Render a table in the selected output format.
    pub fn render(&mut self, table: &Table) -> Result<()> {
        let opts = self.render_options();
        output::render(table, self.format, &opts, self.out)?;
        Ok(())
    }

    /// Print a one-line status message.
    pub fn say(&mut self, msg: &str) -> Result<()> {
        writeln!(self.out, "{msg}")?;
        Ok(())
    }

    pub fn use_cache(&self) -> bool {
        self.config.get_bool("cache.enabled")
    }
}

pub(crate) fn filter_for(sel: &Selection) -> Result<Filter> {
    Filter::new(sel.filter.as_deref(), sel.month, sel.from, sel.to)
}

pub fn dispatch(command: Command, ctx: &mut Context) -> Result<()> {
    match command {
        Command::Init => init::run(ctx),
        Command::Add(args) => add::run(ctx, args),
        Command::List(args) => list::run(ctx, args),
        Command::Edit(args) => edit::run(ctx, args),
        Command::Remove { id } => remove::run(ctx, id),
        Command::RenameCategory { from, to } => rename::run(ctx, &from, &to),
        Command::Categories => categories::run(ctx),
        Command::Report(args) => report::run(ctx, args),
        Command::Import(args) => import::run(ctx, args),
        Command::Config => config::run(ctx),
        Command::Help { .. } | Command::Version => Ok(()),
    }
}
