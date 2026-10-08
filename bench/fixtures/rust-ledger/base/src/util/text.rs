//! Text helpers for terminal output.

/// Number of characters (not bytes) in `s`.
pub fn width(s: &str) -> usize {
    s.chars().count()
}

/// Shorten `s` to at most `max` characters, ending with `...` when cut.
pub fn truncate(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    if max <= 3 {
        return s.chars().take(max).collect();
    }
    let mut out: String = s.chars().take(max - 3).collect();
    out.push_str("...");
    out
}

pub fn pad_right(s: &str, w: usize) -> String {
    let mut out = s.to_string();
    for _ in width(s)..w {
        out.push(' ');
    }
    out
}

pub fn pad_left(s: &str, w: usize) -> String {
    let mut out = String::new();
    for _ in width(s)..w {
        out.push(' ');
    }
    out.push_str(s);
    out
}

/// `1 entry`, `2 entries`.
pub fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {many}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_chars() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 8), "hello...");
        assert_eq!(truncate("café au lait", 6), "caf...");
    }

    #[test]
    fn pads() {
        assert_eq!(pad_left("7", 3), "  7");
        assert_eq!(pad_right("ab", 4), "ab  ");
        assert_eq!(plural(1, "entry", "entries"), "1 entry");
    }
}
