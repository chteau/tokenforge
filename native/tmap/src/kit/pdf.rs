//! `tmap kit pdf`: a PDF as plain text, so a paper costs its words instead of one page image per page.

use super::util::die;
use pdf_extract::{Document, MediaBox, Object, OutputDev, OutputError, Transform};
use std::panic::{catch_unwind, AssertUnwindSafe};

const HELP: &str = "Extract the text of a PDF (papers, reports) instead of reading its pages as images.

  tmap kit pdf FILE [--pages A-B]

  --pages A-B   only pages A..B (1-based, inclusive; `--pages 3` = page 3 only)

Output: a header line, then `--- page n ---` and the page text (hyphenated line breaks joined,
spaces collapsed, paragraph breaks kept). Read the page itself (Read FILE pages: \"n\") for a figure,
table or equation that does not survive as text.
Exit 0 ok | 2 usage error or unreadable PDF | 3 nothing printed: the PDF looks scanned / image-only
or the text layer is unreliable (too little text, or garbage characters); read the pages instead.";

const T: &str = "pdf";

/// Unreliable below this many non-whitespace characters per page, on average.
const MIN_CHARS_PER_PAGE: usize = 200;

pub fn main(args: Vec<String>) -> i32 {
    let mut file: Option<String> = None;
    let mut range: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            "--pages" | "-p" => range = Some(it.next().unwrap_or_else(|| die(T, "--pages needs a value (A-B)", 2))),
            x if x.starts_with("--pages=") => range = Some(x["--pages=".len()..].to_string()),
            x if x.starts_with('-') && x.len() > 1 => die(T, &format!("unknown option {x} (see --help)"), 2),
            _ if file.is_some() => die(T, "one FILE only", 2),
            _ => file = Some(a),
        }
    }
    let Some(file) = file else { die(T, "usage: tmap kit pdf FILE [--pages A-B]", 2) };
    let range = range.map(|r| parse_range(&r).unwrap_or_else(|| die(T, &format!("bad --pages {r} (want A-B, A- or A)"), 2)));
    let bytes = std::fs::read(&file).unwrap_or_else(|e| die(T, &format!("{file}: {e}"), 2));
    let ex = match extract(&bytes, range) {
        Ok(x) => x,
        Err(e) => die(T, &format!("{file}: {e}"), 2),
    };
    let pages: Vec<(u32, String)> = ex.pages.into_iter().map(|(n, t)| (n, normalize(&t))).collect();
    if let Err(why) = verdict(&pages, ex.failed) {
        eprintln!("{T}: {file}: {why}; Read the pages as images instead (Read FILE with pages: \"n\")");
        return 3;
    }
    // savings: the page images the model would have read instead (not counted for exit 3, it reads them anyway)
    super::util::note_raw_tokens(ex.image_tokens);
    let span = match range {
        Some(_) if pages.len() == 1 && ex.total > 1 => format!("page {} of {}", pages[0].0, ex.total),
        Some(_) if pages.len() as u32 != ex.total => {
            format!("pages {}-{} of {}", pages.first().map_or(0, |p| p.0), pages.last().map_or(0, |p| p.0), ex.total)
        }
        _ => format!("{} pages", ex.total),
    };
    let mut out = format!(
        "[tokenforge: text of {file}, {span}, extracted; for a figure, table or equation Read {file} with pages: \"n\"]\n"
    );
    for (n, t) in &pages {
        out.push_str(&format!("--- page {n} ---\n"));
        if !t.is_empty() {
            out.push_str(t);
            out.push('\n');
        }
    }
    print!("{out}");
    0
}

/// `A-B`, `A-`, `A` (1-based) -> (A, B); B = u32::MAX for an open end.
fn parse_range(s: &str) -> Option<(u32, u32)> {
    let s = s.trim();
    let (a, b) = match s.split_once('-') {
        Some((a, b)) => (a.trim().parse().ok()?, if b.trim().is_empty() { u32::MAX } else { b.trim().parse().ok()? }),
        None => {
            let a = s.parse().ok()?;
            (a, a)
        }
    };
    (a >= 1 && a <= b).then_some((a, b))
}

#[derive(Debug)]
struct Extracted {
    total: u32,
    /// (page number, raw text) for the requested pages.
    pages: Vec<(u32, String)>,
    /// Pages whose extraction failed or panicked (their text is empty).
    failed: usize,
    /// What the requested pages would cost read as images.
    image_tokens: u64,
}

/// Load (decrypting with the empty user password if needed) and extract the pages in `range`.
fn extract(bytes: &[u8], range: Option<(u32, u32)>) -> Result<Extracted, String> {
    // The crate panics on malformed input: keep the default hook from printing a backtrace.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = catch_unwind(AssertUnwindSafe(|| extract_inner(bytes, range))).unwrap_or_else(|_| Err("cannot parse this PDF".into()));
    std::panic::set_hook(prev);
    r
}

fn extract_inner(bytes: &[u8], range: Option<(u32, u32)>) -> Result<Extracted, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("not a readable PDF ({e})"))?;
    if doc.is_encrypted() {
        doc.decrypt("").map_err(|_| "encrypted, and the empty password does not open it".to_string())?;
    }
    let all = doc.get_pages();
    let total = all.len() as u32;
    if total == 0 {
        return Err("no pages".into());
    }
    let (a, b) = range.unwrap_or((1, total));
    if a > total {
        return Err(format!("--pages starts at {a} but the PDF has {total} pages"));
    }
    let b = b.min(total);
    let (mut pages, mut failed, mut image_tokens) = (Vec::new(), 0, 0);
    for n in a..=b {
        if let Some(id) = all.get(&n) {
            image_tokens += page_image_tokens(&doc, *id);
        }
        let mut s = String::new();
        let ok = catch_unwind(AssertUnwindSafe(|| {
            let mut out = Collector::new(&mut s);
            pdf_extract::output_doc_page(&doc, &mut out as &mut dyn OutputDev, n).is_ok()
        }))
        .unwrap_or(false);
        if !ok {
            failed += 1;
            s.clear();
        }
        pages.push((n, s));
    }
    Ok(Extracted { total, pages, failed, image_tokens })
}

/// Text in content-stream order (TeX and typst write a column at a time), with a line break when the
/// baseline moves and a blank line on a large move down or any jump back up (next column, float).
/// Unlike the crate's PlainTextOutput it also works when the CTM flips the y axis.
struct Collector<'a> {
    out: &'a mut String,
    flip_h: f64,
    first: bool,
    started: bool,
    last_x_end: f64,
    last_y: f64,
    last_size: f64,
}

impl<'a> Collector<'a> {
    fn new(out: &'a mut String) -> Self {
        Collector { out, flip_h: 0.0, first: false, started: false, last_x_end: 0.0, last_y: 0.0, last_size: 10.0 }
    }
}

impl OutputDev for Collector<'_> {
    fn begin_page(&mut self, _n: u32, mb: &MediaBox, _art: Option<(f64, f64, f64, f64)>) -> Result<(), OutputError> {
        self.flip_h = mb.ury - mb.lly;
        self.started = false;
        Ok(())
    }
    fn end_page(&mut self) -> Result<(), OutputError> {
        self.out.push('\n');
        Ok(())
    }
    fn output_character(&mut self, trm: &Transform, width: f64, _sp: f64, font_size: f64, ch: &str) -> Result<(), OutputError> {
        let (x, y) = (trm.m31, self.flip_h - trm.m32);
        // side of the square with the area of the transformed (font_size, font_size) vector
        let (vx, vy) = (font_size * (trm.m11 + trm.m21), font_size * (trm.m12 + trm.m22));
        let size = (vx * vy).abs().sqrt().max(0.1);
        if !x.is_finite() || !y.is_finite() {
            return Ok(());
        }
        if self.started {
            let unit = size.max(self.last_size);
            let dy = y - self.last_y;
            if dy > 1.6 * unit || dy < -unit {
                self.out.push_str("\n\n");
            } else if dy.abs() > 0.5 * unit {
                self.out.push('\n');
            } else if self.first && x > self.last_x_end + 0.12 * unit && !self.out.ends_with([' ', '\n']) && ch != " " {
                self.out.push(' ');
            }
        }
        for c in ch.chars() {
            push_char(self.out, c);
        }
        self.first = false;
        self.started = true;
        self.last_y = y;
        self.last_size = size;
        self.last_x_end = x + width * size;
        Ok(())
    }
    fn begin_word(&mut self) -> Result<(), OutputError> {
        self.first = true;
        Ok(())
    }
    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
    fn end_line(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
}

/// Ligatures (ﬁ) and math alphanumerics (𝐸) as plain letters; soft hyphens as `-`.
fn push_char(out: &mut String, c: char) {
    use unicode_normalization::UnicodeNormalization;
    match c {
        '\u{fb00}'..='\u{fb06}' | '\u{1d400}'..='\u{1d7ff}' => out.extend(std::iter::once(c).nfkc()),
        '\u{ad}' | '\u{2010}' | '\u{2011}' => out.push('-'),
        _ => out.push(c),
    }
}

/// Tokens the page costs as an image: its MediaBox scaled to a 1568 px long edge (A4 ~2.3k).
fn page_image_tokens(doc: &Document, id: (u32, u16)) -> u64 {
    let size = (|| {
        let mut d = doc.get_dictionary(id).ok()?;
        for _ in 0..16 {
            if let Ok(Object::Array(b)) = d.get(b"MediaBox").map(|o| doc.dereference(o).map(|x| x.1.clone()).unwrap_or(o.clone())) {
                let v: Vec<f64> = b.iter().filter_map(|o| o.as_float().ok().map(f64::from).or_else(|| o.as_i64().ok().map(|i| i as f64))).collect();
                if v.len() == 4 {
                    return Some(((v[2] - v[0]).abs(), (v[3] - v[1]).abs()));
                }
            }
            d = doc.get_dictionary(d.get(b"Parent").ok()?.as_reference().ok()?).ok()?;
        }
        None
    })()
    .unwrap_or((595.0, 842.0));
    let long = size.0.max(size.1).max(1.0);
    super::img::image_tokens((size.0 / long * 1568.0) as u32, (size.1 / long * 1568.0) as u32)
}

/// Clean one page: join `exam-\nple`, collapse spaces, trim lines, at most one blank line in a row.
fn normalize(t: &str) -> String {
    let t = t.replace("\r\n", "\n").replace(['\r', '\u{c}'], "\n").replace('\u{a0}', " ");
    // table-of-contents leaders `. . . . .` -> ` … `
    let leaders = super::code::common::re!(r"(?:\s*\.){4,}\s*");
    let lines: Vec<String> =
        t.lines().map(|l| leaders.replace_all(&l.split_whitespace().collect::<Vec<_>>().join(" "), " … ").trim().to_string()).collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let mut cur = lines[i].clone();
        i += 1;
        // `exam-` + `ple`: a lowercase letter, a hyphen at the line end, a lowercase letter next.
        loop {
            // across a column or page break the continuation follows one blank line
            let k = if i + 1 < lines.len() && lines[i].is_empty() { i + 1 } else { i };
            if k >= lines.len() || !joins(&cur, &lines[k]) {
                break;
            }
            cur.pop();
            if cur.ends_with(' ') {
                cur.pop();
            }
            cur.push_str(&lines[k]);
            i = k + 1;
        }
        if cur.is_empty() && out.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        out.push(cur);
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out.join("\n")
}

/// `exam-` or `exam -` (some generators leave a gap before the hyphen) followed by a lowercase word.
fn joins(cur: &str, next: &str) -> bool {
    let Some(stem) = cur.strip_suffix('-') else { return false };
    let stem = stem.strip_suffix(' ').unwrap_or(stem);
    stem.chars().next_back().is_some_and(char::is_lowercase) && next.chars().next().is_some_and(char::is_lowercase)
}

/// Ok, or why the text layer should not be trusted (scanned pages, broken font encodings).
fn verdict(pages: &[(u32, String)], failed: usize) -> Result<(), String> {
    let n = pages.len().max(1);
    if failed * 2 > n {
        return Err(format!("text extraction failed on {failed} of {n} pages"));
    }
    let (mut chars, mut bad, mut alnum) = (0usize, 0usize, 0usize);
    let (mut words, mut long_words) = (0usize, 0usize);
    for (_, t) in pages {
        for c in t.chars().filter(|c| !c.is_whitespace()) {
            chars += 1;
            if c.is_alphanumeric() {
                alnum += 1;
            }
            // replacement char, private use (unmapped glyphs), C0/C1 controls
            if c == '\u{fffd}' || ('\u{e000}'..='\u{f8ff}').contains(&c) || c.is_control() {
                bad += 1;
            }
        }
        for w in t.split_whitespace() {
            words += 1;
            if w.chars().count() > 30 {
                long_words += 1;
            }
        }
    }
    let avg = chars / n;
    if avg < MIN_CHARS_PER_PAGE {
        return Err(format!("looks scanned or image-only ({avg} characters of text per page)"));
    }
    if bad * 100 > chars * 2 {
        return Err(format!("unreliable text layer ({}% unmapped or replacement characters)", bad * 100 / chars));
    }
    if alnum * 100 < chars * 55 {
        return Err(format!("unreliable text layer (only {}% letters or digits)", alnum * 100 / chars));
    }
    // words run together: the PDF has no usable spacing
    if long_words * 100 > words * 5 {
        return Err(format!("unreliable text layer ({}% of words longer than 30 characters)", long_words * 100 / words.max(1)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
    }

    fn text(pages: &[(u32, String)]) -> String {
        pages.iter().map(|p| p.1.as_str()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("2-5"), Some((2, 5)));
        assert_eq!(parse_range("3"), Some((3, 3)));
        assert_eq!(parse_range("4-"), Some((4, u32::MAX)));
        assert_eq!(parse_range("0-2"), None);
        assert_eq!(parse_range("5-2"), None);
        assert_eq!(parse_range("x"), None);
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize("an exam-\nple of  text\n\n\n\nnext   para\n"), "an example of text\n\nnext para");
        assert_eq!(normalize("exam-\nple"), "example");
        assert_eq!(normalize("tempor inci -\ndidunt ut"), "tempor incididunt ut");
        assert_eq!(normalize("et ma-\n\ngnis dis\n\nNext"), "et magnis dis\n\nNext");
        // a real dash before an uppercase word or a number stays
        assert_eq!(normalize("Jean-\nPaul and 1-\n2"), "Jean-\nPaul and 1-\n2");
        assert_eq!(normalize("\n\n  a\t b \n"), "a b");
        assert_eq!(normalize("C.1 v1.3 . . . . . . . . 20\nEnd...."), "C.1 v1.3 … 20\nEnd …");
    }

    #[test]
    fn verdict_heuristics() {
        let prose = "The quick brown fox jumps over the lazy dog near the river bank. ".repeat(6);
        assert!(verdict(&[(1, prose.clone()), (2, prose.clone())], 0).is_ok());
        // too little text: scanned
        assert!(verdict(&[(1, "Figure 1".into()), (2, String::new())], 0).unwrap_err().contains("scanned"));
        // one figure-only page among text pages is fine on average
        assert!(verdict(&[(1, prose.clone()), (2, prose.clone()), (3, "Fig. 2".into())], 0).is_ok());
        // unmapped glyphs
        let junk: String = prose.chars().map(|c| if c == 'e' { '\u{fffd}' } else { c }).collect();
        assert!(verdict(&[(1, junk)], 0).unwrap_err().contains("replacement"));
        let pua: String = prose.chars().map(|c| if c.is_alphabetic() { '\u{e01f}' } else { c }).collect();
        assert!(verdict(&[(1, pua)], 0).is_err());
        // symbols instead of letters (wrong encoding)
        let sym: String = prose.chars().map(|c| if c.is_alphabetic() && c < 'n' { '#' } else { c }).collect();
        assert!(verdict(&[(1, sym)], 0).unwrap_err().contains("letters"));
        // no spaces between words
        let glued = prose.replace(' ', "");
        assert!(verdict(&[(1, glued)], 0).unwrap_err().contains("longer than 30"));
        // most pages crashed
        assert!(verdict(&[(1, prose.clone()), (2, String::new()), (3, String::new())], 2).is_err());
    }

    #[test]
    fn paper_two_columns() {
        let ex = extract(&fixture("paper.pdf"), None).unwrap();
        assert_eq!((ex.total, ex.failed), (3, 0));
        assert!(ex.image_tokens > 3 * 1500);
        let pages: Vec<(u32, String)> = ex.pages.into_iter().map(|(n, t)| (n, normalize(&t))).collect();
        assert!(verdict(&pages, 0).is_ok());
        let all = text(&pages);
        assert!(all.contains("an example of wasted context"), "{all}");
        assert!(all.contains("incididunt") && !all.contains("inci -"), "{all}");
        assert!(all.contains("Token Budgets for Reading Papers"));
        assert!(all.contains("E = mc") || all.contains("E = m c") || all.contains("E=mc"), "{all}");
        assert!(all.contains("Accuracy") && all.contains("0.93"));
        // reading order: sections in sequence, the closing paragraph last
        let pos = |s: &str| all.find(s).unwrap_or_else(|| panic!("{s} missing"));
        assert!(pos("Introduction") < pos("Method") && pos("Method") < pos("Results") && pos("Results") < pos("Discussion"));
        assert!(pos("Discussion") < pos("column-sentinel"));
    }

    #[test]
    fn encrypted_with_empty_user_password() {
        let ex = extract(&fixture("encrypted.pdf"), None).unwrap();
        assert_eq!(ex.total, 3);
        assert!(normalize(&ex.pages[0].1).contains("Token Budgets for Reading Papers"));
    }

    #[test]
    fn page_range() {
        let ex = extract(&fixture("paper.pdf"), Some((2, 9))).unwrap();
        assert_eq!(ex.pages.iter().map(|p| p.0).collect::<Vec<_>>(), vec![2, 3]);
        assert!(extract(&fixture("paper.pdf"), Some((4, 5))).unwrap_err().contains("3 pages"));
    }

    #[test]
    fn scanned_is_rejected() {
        let ex = extract(&fixture("scanned.pdf"), None).unwrap();
        assert_eq!(ex.total, 2);
        let pages: Vec<(u32, String)> = ex.pages.into_iter().map(|(n, t)| (n, normalize(&t))).collect();
        assert!(verdict(&pages, ex.failed).unwrap_err().contains("scanned"));
    }

    #[test]
    fn garbage_input_does_not_panic() {
        assert!(extract(b"not a pdf at all", None).is_err());
        let mut cut = fixture("paper.pdf");
        cut.truncate(cut.len() / 3);
        let _ = extract(&cut, None); // error or partial text, never a panic
    }
}
