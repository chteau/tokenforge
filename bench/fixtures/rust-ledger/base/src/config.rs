//! Configuration from `<dir>/config.ini`, with environment overrides.
//!
//! ```ini
//! [general]
//! currency_symbol = €
//!
//! [output]
//! format = json
//! ```
//!
//! Every key can be overridden with an environment variable named
//! `TALLY_<SECTION>_<KEY>` in upper case, e.g. `TALLY_OUTPUT_FORMAT=csv`.
//! Precedence: environment, then the file, then the built-in default.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::error::{Error, Result};
use crate::output::Format;

pub const CONFIG_FILE: &str = "config.ini";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueKind {
    Text,
    Bool,
    Count,
    Format,
}

/// Known keys: (section.key, default, kind).
const KEYS: &[(&str, &str, ValueKind)] = &[
    ("general.currency_symbol", "$", ValueKind::Text),
    ("output.format", "table", ValueKind::Format),
    ("output.note_width", "30", ValueKind::Count),
    ("import.default_category", "uncategorized", ValueKind::Text),
    ("import.skip_duplicates", "true", ValueKind::Bool),
    ("cache.enabled", "true", ValueKind::Bool),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Default,
    File,
    Env,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Source::Default => "default",
            Source::File => "file",
            Source::Env => "env",
        })
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    values: BTreeMap<&'static str, (String, Source)>,
}

impl Default for Config {
    fn default() -> Self {
        let values = KEYS
            .iter()
            .map(|(k, d, _)| (*k, (d.to_string(), Source::Default)))
            .collect();
        Config { values }
    }
}

fn kind_of(key: &str) -> Option<(&'static str, ValueKind)> {
    KEYS.iter()
        .find(|(k, _, _)| *k == key)
        .map(|(k, _, t)| (*k, *t))
}

fn check_value(key: &str, kind: ValueKind, value: &str) -> std::result::Result<(), String> {
    match kind {
        ValueKind::Text => Ok(()),
        ValueKind::Bool => parse_bool(value)
            .map(|_| ())
            .ok_or_else(|| format!("{key}: expected true or false, got '{value}'")),
        ValueKind::Count => value
            .parse::<usize>()
            .map(|_| ())
            .map_err(|_| format!("{key}: expected a whole number, got '{value}'")),
        ValueKind::Format => value
            .parse::<Format>()
            .map(|_| ())
            .map_err(|e| format!("{key}: {e}")),
    }
}

fn parse_bool(v: &str) -> Option<bool> {
    match v.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

fn env_name(key: &str) -> String {
    format!("TALLY_{}", key.replace('.', "_").to_uppercase())
}

impl Config {
    /// Load `<dir>/config.ini` if present, then apply environment overrides.
    pub fn load(dir: &Path, env: &dyn Fn(&str) -> Option<String>) -> Result<Config> {
        let path = dir.join(CONFIG_FILE);
        let mut cfg = match fs::read_to_string(&path) {
            Ok(text) => Config::parse(&text)?,
            Err(e) if e.kind() == ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(Error::io_at(path, e)),
        };
        cfg.apply_env(env)?;
        Ok(cfg)
    }

    /// Parse INI text on top of the defaults.
    pub fn parse(text: &str) -> Result<Config> {
        let mut cfg = Config::default();
        let mut section = String::new();
        for (idx, raw) in text.lines().enumerate() {
            let line_no = idx + 1;
            let err = |message: String| Error::Config {
                line: line_no,
                message,
            };
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if let Some(rest) = line.strip_prefix('[') {
                let name = rest
                    .strip_suffix(']')
                    .ok_or_else(|| err(format!("unterminated section header '{line}'")))?;
                section = name.trim().to_lowercase();
                continue;
            }
            let (k, v) = line
                .split_once('=')
                .ok_or_else(|| err(format!("expected 'key = value', got '{line}'")))?;
            if section.is_empty() {
                return Err(err("key outside of a [section]".to_string()));
            }
            let full = format!("{section}.{}", k.trim().to_lowercase());
            let value = unquote(v.trim());
            let (key, kind) = kind_of(&full).ok_or_else(|| err(format!("unknown key '{full}'")))?;
            check_value(key, kind, &value).map_err(err)?;
            cfg.values.insert(key, (value, Source::File));
        }
        Ok(cfg)
    }

    fn apply_env(&mut self, env: &dyn Fn(&str) -> Option<String>) -> Result<()> {
        for (key, _, kind) in KEYS {
            let name = env_name(key);
            if let Some(v) = env(&name) {
                check_value(key, *kind, &v).map_err(|m| Error::invalid(format!("{name}: {m}")))?;
                self.values.insert(key, (v, Source::Env));
            }
        }
        Ok(())
    }

    /// Raw value of a known key. Panics on unknown keys: that is a programming error.
    pub fn get(&self, key: &str) -> &str {
        match self.values.get(key) {
            Some((v, _)) => v,
            None => panic!("unknown config key {key}"),
        }
    }

    pub fn get_bool(&self, key: &str) -> bool {
        parse_bool(self.get(key)).unwrap_or(false)
    }

    pub fn get_count(&self, key: &str) -> usize {
        self.get(key).parse().unwrap_or(0)
    }

    pub fn currency_symbol(&self) -> &str {
        self.get("general.currency_symbol")
    }

    pub fn format(&self) -> Format {
        self.get("output.format").parse().unwrap_or(Format::Table)
    }

    /// Every key with its effective value and where it came from.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &str, Source)> {
        self.values.iter().map(|(k, (v, s))| (*k, v.as_str(), *s))
    }
}

fn unquote(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn defaults_apply() {
        let c = Config::parse("").unwrap();
        assert_eq!(c.currency_symbol(), "$");
        assert_eq!(c.format(), Format::Table);
        assert!(c.get_bool("cache.enabled"));
    }

    #[test]
    fn file_values_and_comments() {
        let c = Config::parse(
            "# comment\n[general]\ncurrency_symbol = \"EUR \"\n; other\n[OUTPUT]\nformat=csv\n",
        )
        .unwrap();
        assert_eq!(c.currency_symbol(), "EUR ");
        assert_eq!(c.format(), Format::Csv);
    }

    #[test]
    fn rejects_unknown_keys_and_bad_values() {
        let e = Config::parse("[output]\ncolour = yes\n").unwrap_err();
        assert_eq!(e.to_string(), "config line 2: unknown key 'output.colour'");
        assert!(Config::parse("[cache]\nenabled = maybe\n").is_err());
        assert!(Config::parse("format = csv\n").is_err());
    }

    #[test]
    fn env_overrides_file() {
        let mut c = Config::parse("[output]\nformat = csv\n").unwrap();
        c.apply_env(&|k: &str| (k == "TALLY_OUTPUT_FORMAT").then(|| "json".to_string()))
            .unwrap();
        assert_eq!(c.format(), Format::Json);
        let mut d = Config::default();
        d.apply_env(&no_env).unwrap();
        assert_eq!(d.format(), Format::Table);
    }
}
