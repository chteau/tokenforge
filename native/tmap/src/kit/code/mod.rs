//! Language-aware tools: stack detection, build/test/format runners, dependency lookup.
//! Core stacks (rust go ts cs luau dart py) are inline; the others plug in through `langs`.

pub mod check;
pub mod common;
pub mod deps;
pub mod fmt;
pub mod langs;
pub mod proj;
pub mod test;
