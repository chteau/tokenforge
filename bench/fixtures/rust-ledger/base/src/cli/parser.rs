use std::path::PathBuf;
use std::str::FromStr;

use super::{
    AddArgs, Command, EditArgs, ImportArgs, Invocation, ListArgs, ReportArgs, Selection, SortKey,
};
use crate::error::{Error, Result};
use crate::model::Kind;
use crate::output::Format;
use crate::util::{Date, Money, YearMonth};

/// Option names a command accepts, and whether each takes a value.
type Spec = &'static [(&'static str, bool)];

const SELECTION: Spec = &[
    ("filter", true),
    ("month", true),
    ("from", true),
    ("to", true),
];

const LIST: Spec = &[
    ("filter", true),
    ("month", true),
    ("from", true),
    ("to", true),
    ("sort", true),
    ("desc", false),
    ("limit", true),
];

/// Positional arguments and options of one command, in order of appearance.
struct Args {
    command: &'static str,
    positionals: Vec<String>,
    options: Vec<(&'static str, Option<String>)>,
}

impl Args {
    fn split(command: &'static str, raw: &[String], spec: Spec) -> Result<Args> {
        let mut args = Args {
            command,
            positionals: Vec::new(),
            options: Vec::new(),
        };
        let mut i = 0;
        let mut only_positionals = false;
        while i < raw.len() {
            let tok = &raw[i];
            i += 1;
            if only_positionals || !tok.starts_with("--") {
                args.positionals.push(tok.clone());
                continue;
            }
            if tok == "--" {
                only_positionals = true;
                continue;
            }
            let body = &tok[2..];
            let (name, inline) = match body.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (body, None),
            };
            let (spec_name, takes_value) = spec
                .iter()
                .find(|(n, _)| *n == name)
                .copied()
                .ok_or_else(|| {
                    Error::usage(format!("unknown option '--{name}' for '{command}'"))
                })?;
            let value = match (takes_value, inline) {
                (true, Some(v)) => Some(v),
                (true, None) => {
                    let v = raw
                        .get(i)
                        .ok_or_else(|| Error::usage(format!("option '--{name}' needs a value")))?;
                    i += 1;
                    Some(v.clone())
                }
                (false, Some(_)) => {
                    return Err(Error::usage(format!(
                        "option '--{name}' does not take a value"
                    )))
                }
                (false, None) => None,
            };
            args.options.push((spec_name, value));
        }
        Ok(args)
    }

    fn expect_positionals(&self, names: &[&str]) -> Result<()> {
        if self.positionals.len() < names.len() {
            let missing = names[self.positionals.len()];
            return Err(Error::usage(format!(
                "'{}' is missing the {missing} argument",
                self.command
            )));
        }
        if self.positionals.len() > names.len() {
            return Err(Error::usage(format!(
                "unexpected argument '{}' for '{}'",
                self.positionals[names.len()],
                self.command
            )));
        }
        Ok(())
    }

    fn last(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .and_then(|(_, v)| v.as_deref())
    }

    fn all(&self, name: &str) -> Vec<String> {
        self.options
            .iter()
            .filter(|(n, _)| *n == name)
            .filter_map(|(_, v)| v.clone())
            .collect()
    }

    fn flag(&self, name: &str) -> bool {
        self.options.iter().any(|(n, _)| *n == name)
    }

    fn typed<T: FromStr<Err = String>>(&self, name: &str) -> Result<Option<T>> {
        self.last(name)
            .map(|v| {
                v.parse::<T>()
                    .map_err(|e| Error::usage(format!("--{name}: {e}")))
            })
            .transpose()
    }

    fn money(&self, name: &str) -> Result<Option<Money>> {
        self.last(name)
            .map(|v| Money::parse(v).map_err(|e| Error::usage(format!("--{name}: {e}"))))
            .transpose()
    }

    fn selection(&self) -> Result<Selection> {
        Ok(Selection {
            filter: self.last("filter").map(str::to_string),
            month: self.typed::<YearMonth>("month")?,
            from: self.typed::<Date>("from")?,
            to: self.typed::<Date>("to")?,
        })
    }
}

fn parse_id(s: &str) -> Result<u64> {
    s.parse()
        .map_err(|_| Error::usage(format!("invalid entry id '{s}'")))
}

/// Remove `--dir` and `--format` from anywhere before a `--`.
fn take_globals(args: &[String]) -> Result<(Option<PathBuf>, Option<Format>, Vec<String>)> {
    let mut dir = None;
    let mut format = None;
    let mut rest = Vec::new();
    let mut i = 0;
    let mut passthrough = false;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if passthrough {
            rest.push(a.clone());
            continue;
        }
        if a == "--" {
            passthrough = true;
            rest.push(a.clone());
            continue;
        }
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (a.as_str(), None),
        };
        if name != "--dir" && name != "--format" {
            rest.push(a.clone());
            continue;
        }
        let value = match inline {
            Some(v) => v,
            None => {
                let v = args
                    .get(i)
                    .ok_or_else(|| Error::usage(format!("option '{name}' needs a value")))?;
                i += 1;
                v.clone()
            }
        };
        if name == "--dir" {
            dir = Some(PathBuf::from(value));
        } else {
            format = Some(value.parse::<Format>().map_err(Error::Usage)?);
        }
    }
    Ok((dir, format, rest))
}

pub fn parse(argv: &[String]) -> Result<Invocation> {
    let (dir, format, rest) = take_globals(argv)?;
    let command = match rest.first().map(String::as_str) {
        None => Command::Help { topic: None },
        Some("-h" | "--help") => Command::Help { topic: None },
        Some("-V" | "--version") => Command::Version,
        Some(name) => parse_command(name, &rest[1..])?,
    };
    Ok(Invocation {
        dir,
        format,
        command,
    })
}

fn parse_command(name: &str, rest: &[String]) -> Result<Command> {
    if rest.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(Command::Help {
            topic: Some(name.to_string()),
        });
    }
    match name {
        "init" => {
            Args::split("init", rest, &[])?.expect_positionals(&[])?;
            Ok(Command::Init)
        }
        "add" => parse_add(rest),
        "list" | "ls" => parse_list(rest),
        "edit" => parse_edit(rest),
        "remove" | "rm" => {
            let a = Args::split("remove", rest, &[])?;
            a.expect_positionals(&["ID"])?;
            Ok(Command::Remove {
                id: parse_id(&a.positionals[0])?,
            })
        }
        "rename-category" => {
            let a = Args::split("rename-category", rest, &[])?;
            a.expect_positionals(&["OLD", "NEW"])?;
            Ok(Command::RenameCategory {
                from: a.positionals[0].clone(),
                to: a.positionals[1].clone(),
            })
        }
        "categories" => {
            Args::split("categories", rest, &[])?.expect_positionals(&[])?;
            Ok(Command::Categories)
        }
        "report" => parse_report(rest),
        "import" => {
            let a = Args::split("import", rest, &[("category", true), ("dry-run", false)])?;
            a.expect_positionals(&["FILE"])?;
            Ok(Command::Import(ImportArgs {
                path: PathBuf::from(&a.positionals[0]),
                category: a.last("category").map(str::to_string),
                dry_run: a.flag("dry-run"),
            }))
        }
        "config" => {
            Args::split("config", rest, &[])?.expect_positionals(&[])?;
            Ok(Command::Config)
        }
        "help" => Ok(Command::Help {
            topic: rest.first().cloned(),
        }),
        other => Err(Error::usage(format!(
            "unknown command '{other}' (run `tally help`)"
        ))),
    }
}

fn parse_add(rest: &[String]) -> Result<Command> {
    let a = Args::split(
        "add",
        rest,
        &[
            ("payee", true),
            ("note", true),
            ("tag", true),
            ("income", false),
        ],
    )?;
    a.expect_positionals(&["DATE", "AMOUNT", "CATEGORY"])?;
    let date = a.positionals[0].parse::<Date>().map_err(Error::Usage)?;
    let amount = Money::parse(&a.positionals[1]).map_err(Error::Usage)?;
    Ok(Command::Add(AddArgs {
        date,
        amount,
        category: a.positionals[2].clone(),
        kind: if a.flag("income") {
            Kind::Income
        } else {
            Kind::Expense
        },
        payee: a.last("payee").unwrap_or_default().to_string(),
        note: a.last("note").unwrap_or_default().to_string(),
        tags: a.all("tag"),
    }))
}

fn parse_list(rest: &[String]) -> Result<Command> {
    let a = Args::split("list", rest, LIST)?;
    a.expect_positionals(&[])?;
    let sort = match a.last("sort") {
        None | Some("date") => SortKey::Date,
        Some("amount") => SortKey::Amount,
        Some("category") => SortKey::Category,
        Some("payee") => SortKey::Payee,
        Some("id") => SortKey::Id,
        Some(other) => return Err(Error::usage(format!("--sort: unknown key '{other}'"))),
    };
    let limit = a
        .last("limit")
        .map(|v| {
            v.parse::<usize>()
                .map_err(|_| Error::usage(format!("--limit: invalid number '{v}'")))
        })
        .transpose()?;
    Ok(Command::List(ListArgs {
        selection: a.selection()?,
        sort,
        descending: a.flag("desc"),
        limit,
    }))
}

fn parse_edit(rest: &[String]) -> Result<Command> {
    let a = Args::split(
        "edit",
        rest,
        &[
            ("date", true),
            ("amount", true),
            ("category", true),
            ("payee", true),
            ("note", true),
            ("tag", true),
            ("clear-tags", false),
            ("income", false),
            ("expense", false),
        ],
    )?;
    a.expect_positionals(&["ID"])?;
    if a.flag("income") && a.flag("expense") {
        return Err(Error::usage(
            "--income and --expense are mutually exclusive",
        ));
    }
    let tags = a.all("tag");
    let tags = if a.flag("clear-tags") {
        if !tags.is_empty() {
            return Err(Error::usage("--clear-tags cannot be combined with --tag"));
        }
        Some(Vec::new())
    } else if tags.is_empty() {
        None
    } else {
        Some(tags)
    };
    let kind = if a.flag("income") {
        Some(Kind::Income)
    } else if a.flag("expense") {
        Some(Kind::Expense)
    } else {
        None
    };
    Ok(Command::Edit(EditArgs {
        id: parse_id(&a.positionals[0])?,
        date: a.typed::<Date>("date")?,
        amount: a.money("amount")?,
        category: a.last("category").map(str::to_string),
        kind,
        payee: a.last("payee").map(str::to_string),
        note: a.last("note").map(str::to_string),
        tags,
    }))
}

fn parse_report(rest: &[String]) -> Result<Command> {
    let Some(kind) = rest.first() else {
        return Err(Error::usage("'report' needs a kind: monthly or categories"));
    };
    match kind.as_str() {
        "monthly" => {
            let a = Args::split("report monthly", &rest[1..], &[("year", true)])?;
            a.expect_positionals(&[])?;
            let year = a
                .last("year")
                .map(|y| {
                    y.parse::<i32>()
                        .map_err(|_| Error::usage(format!("--year: invalid year '{y}'")))
                })
                .transpose()?;
            Ok(Command::Report(ReportArgs::Monthly { year }))
        }
        "categories" => {
            let a = Args::split("report categories", &rest[1..], SELECTION)?;
            a.expect_positionals(&[])?;
            Ok(Command::Report(ReportArgs::Categories(a.selection()?)))
        }
        other => Err(Error::usage(format!(
            "unknown report '{other}' (expected monthly or categories)"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn parses_add_with_globals_anywhere() {
        let inv = parse(&argv(
            "add 2026-01-03 12.50 Food --dir /tmp/x --tag a --tag=b --payee=Shop --format json",
        ))
        .unwrap();
        assert_eq!(inv.dir, Some(PathBuf::from("/tmp/x")));
        assert_eq!(inv.format, Some(Format::Json));
        match inv.command {
            Command::Add(a) => {
                assert_eq!(a.amount, Money(1250));
                assert_eq!(a.tags, vec!["a", "b"]);
                assert_eq!(a.payee, "Shop");
                assert_eq!(a.kind, Kind::Expense);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn usage_errors() {
        for (args, msg) in [
            ("add 2026-01-01 5", "'add' is missing the CATEGORY argument"),
            ("list --bogus", "unknown option '--bogus' for 'list'"),
            ("remove abc", "invalid entry id 'abc'"),
            ("edit 1 --income --expense", "mutually exclusive"),
            ("frobnicate", "unknown command 'frobnicate'"),
            ("list --limit", "option '--limit' needs a value"),
        ] {
            let err = parse(&argv(args)).unwrap_err();
            assert_eq!(err.exit_code(), 2);
            assert!(err.to_string().contains(msg), "{args}: {err}");
        }
    }

    #[test]
    fn negative_amount_is_positional() {
        let inv = parse(&argv("add 2026-01-01 -5 food")).unwrap();
        assert!(matches!(inv.command, Command::Add(a) if a.amount == Money(-500)));
    }

    #[test]
    fn edit_tags() {
        let inv = parse(&argv("edit 3 --clear-tags")).unwrap();
        assert!(matches!(inv.command, Command::Edit(e) if e.tags == Some(vec![])));
    }
}
