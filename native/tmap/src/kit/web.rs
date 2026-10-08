//! `tmap kit web`: read a web page as an outline or a few sections instead of the whole page.

use super::util::die;
use regex::Regex;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const HELP: &str = "Read a web page without pulling the whole page into context.

  tmap kit web URL                    title + numbered section outline (+ size of each section)
  tmap kit web URL -s \"terms\"         the sections that best match the terms (ranked, capped ~4000 chars)
  tmap kit web URL -n N[,M]           print section N (and M) in full
  tmap kit web URL --ask \"question\"   a small model (tmap kit distill) reads the page, prints only the answer
  tmap kit web URL --full             the whole page as text (capped 30000 chars)
  --fresh  ignore the 24h cache      --links  keep link targets as [text](url)

HTML is reduced to readable markdown-ish text (main/article only; nav, scripts, footers dropped).
GitHub blob URLs are fetched as raw files. JSON responses print their shape (see jx).
Cache: $XDG_CACHE_HOME/tokenforge/web (default ~/.cache/tokenforge/web; %LOCALAPPDATA%\\tokenforge\\web on Windows).
";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) tokenforge-kit/1.0";

fn fail(m: String) -> ! {
    die("web", &m, 2)
}

/// First `n` chars of `s`.
fn take(s: &str, n: usize) -> &str {
    s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

fn clen(s: &str) -> usize {
    s.chars().count()
}

// ---------- HTML to text ----------

fn entity(name: &str) -> Option<char> {
    if let Some(n) = name.strip_prefix('#') {
        let v = match n.strip_prefix(['x', 'X']) {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => n.parse().ok()?,
        };
        return Some(char::from_u32(v).filter(|&c| c != '\0').unwrap_or('\u{fffd}'));
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "hellip" => '…',
        "mdash" => '—',
        "ndash" => '–',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "laquo" => '«',
        "raquo" => '»',
        "middot" => '·',
        "bull" => '•',
        "times" => '×',
        "deg" => '°',
        "euro" => '€',
        "para" => '¶',
        "sect" => '§',
        "larr" => '←',
        "rarr" => '→',
        "uarr" => '↑',
        "darr" => '↓',
        "le" => '≤',
        "ge" => '≥',
        "ne" => '≠',
        "shy" => '\u{ad}',
        "zwj" => '\u{200d}',
        "zwnj" => '\u{200c}',
        "ensp" => '\u{2002}',
        "emsp" => '\u{2003}',
        "thinsp" => '\u{2009}',
        "check" => '✓',
        _ => return None,
    })
}

/// html.unescape for numeric references and the common named entities.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let re = Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?").unwrap();
    re.replace_all(s, |c: &regex::Captures| {
        let (all, name) = (&c[0], &c[1]);
        let ok = all.ends_with(';') || name.starts_with('#') || matches!(name, "amp" | "lt" | "gt" | "quot" | "nbsp");
        match entity(name).filter(|_| ok) {
            Some(ch) => ch.to_string(),
            None => all.to_string(),
        }
    })
    .into_owned()
}

#[derive(Debug, PartialEq)]
enum Tok {
    Start(String, Vec<(String, Option<String>)>, bool),
    End(String),
    Text(String),
}

fn is_name_end(c: char) -> bool {
    c.is_whitespace() || c == '/' || c == '>'
}

/// Tolerant tokenizer in the spirit of Python's HTMLParser: lowercase names, unescaped text and attributes,
/// script/style bodies as raw text, comments and doctypes dropped.
fn tokenize(h: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut i = 0;
    let push_text = |out: &mut Vec<Tok>, s: &str| {
        if !s.is_empty() {
            out.push(Tok::Text(unescape(s)));
        }
    };
    while i < h.len() {
        let rest = &h[i..];
        if !rest.starts_with('<') {
            let j = rest.find('<').unwrap_or(rest.len());
            push_text(&mut out, &rest[..j]);
            i += j;
            continue;
        }
        let next = rest[1..].chars().next();
        if rest.starts_with("<!--") {
            i += rest.find("-->").map_or(rest.len(), |j| j + 3);
        } else if rest.starts_with("<!") || rest.starts_with("<?") {
            i += rest.find('>').map_or(rest.len(), |j| j + 1);
        } else if rest.starts_with("</") && rest[2..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            let name: String = rest[2..].chars().take_while(|&c| !is_name_end(c)).collect();
            out.push(Tok::End(name.to_ascii_lowercase()));
            i += rest.find('>').map_or(rest.len(), |j| j + 1);
        } else if next.is_some_and(|c| c.is_ascii_alphabetic()) {
            let name: String = rest[1..].chars().take_while(|&c| !is_name_end(c)).collect::<String>().to_ascii_lowercase();
            let mut j = 1 + name.len();
            let b = rest.as_bytes();
            let (mut attrs, mut selfclose) = (Vec::new(), false);
            while j < b.len() {
                match b[j] {
                    b'>' => {
                        j += 1;
                        break;
                    }
                    b'/' => {
                        selfclose = b.get(j + 1) == Some(&b'>');
                        j += 1;
                    }
                    c if c.is_ascii_whitespace() => j += 1,
                    _ => {
                        let s = j;
                        while j < b.len() && !b[j].is_ascii_whitespace() && !matches!(b[j], b'=' | b'>') && !(b[j] == b'/' && b.get(j + 1) == Some(&b'>')) {
                            j += 1;
                        }
                        let key = rest[s..j].to_ascii_lowercase();
                        while j < b.len() && b[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        let mut val = None;
                        if b.get(j) == Some(&b'=') {
                            j += 1;
                            while j < b.len() && b[j].is_ascii_whitespace() {
                                j += 1;
                            }
                            let vs;
                            if let Some(&qc @ (b'"' | b'\'')) = b.get(j) {
                                vs = j + 1;
                                j = rest[vs..].find(qc as char).map_or(b.len(), |k| vs + k);
                                val = Some(unescape(&rest[vs..j]));
                                j = (j + 1).min(b.len());
                            } else {
                                vs = j;
                                while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'>' {
                                    j += 1;
                                }
                                val = Some(unescape(&rest[vs..j]));
                            }
                        }
                        attrs.push((key, val));
                    }
                }
            }
            i += j;
            let raw = !selfclose && (name == "script" || name == "style");
            out.push(Tok::Start(name.clone(), attrs, selfclose));
            if raw {
                let close = format!("</{name}");
                let body = &h[i..];
                let k = body.to_ascii_lowercase().find(&close).unwrap_or(body.len());
                if k > 0 {
                    out.push(Tok::Text(body[..k].to_string()));
                }
                i += k;
            }
        } else {
            push_text(&mut out, "<");
            i += 1;
        }
    }
    out
}

const SKIP: &[&str] = &["script", "style", "nav", "footer", "header", "aside", "svg", "noscript", "form", "button", "iframe", "template"];
const BLOCK: &[&str] = &[
    "p", "div", "section", "article", "main", "br", "tr", "table", "ul", "ol", "dl", "dt", "dd", "blockquote", "figure", "figcaption", "details", "summary",
];
const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];

fn heading(tag: &str) -> Option<usize> {
    let b = tag.as_bytes();
    (b.len() == 2 && b[0] == b'h' && (b'1'..=b'6').contains(&b[1])).then(|| (b[1] - b'0') as usize)
}

/// Markdown-ish text: headings as #, list items as "- ", pre as fences, cells joined by " | ".
/// Skipped regions (nav, scripts, aria-hidden, sidebars, navigation roles) end at their matching close tag.
fn render(toks: &[Tok], links: bool) -> String {
    let ws = Regex::new(r"\s+").unwrap();
    let mut out = String::new();
    let (mut skip, mut pre, mut href): (Option<(&str, usize)>, usize, Option<String>) = (None, 0, None);
    let end = |out: &mut String, tag: &str, skip: &mut Option<(&str, usize)>, pre: &mut usize, href: &mut Option<String>| {
        if let Some((t, d)) = skip {
            if *t == tag {
                *d -= 1;
                if *d == 0 {
                    *skip = None;
                }
            }
            return;
        }
        if heading(tag).is_some() || BLOCK.contains(&tag) {
            out.push('\n');
        } else if tag == "pre" {
            *pre = pre.saturating_sub(1);
            out.push_str("\n```\n");
        } else if tag == "code" && *pre == 0 {
            out.push('`');
        } else if tag == "a" && links {
            if let Some(h) = href.take() {
                out.push_str(&if h.starts_with('#') { "]".to_string() } else { format!("]({h})") });
            }
        }
    };
    for t in toks {
        match t {
            Tok::Start(tag, attrs, sc) => {
                if let Some((s, d)) = &mut skip {
                    if s == tag && !sc && !VOID.contains(&tag.as_str()) {
                        *d += 1;
                    }
                    continue;
                }
                let at = |k: &str| attrs.iter().find(|(n, _)| n == k).and_then(|(_, v)| v.as_deref());
                if SKIP.contains(&tag.as_str())
                    || at("aria-hidden") == Some("true")
                    || at("class").unwrap_or("").contains("sidebar")
                    || matches!(at("role"), Some("navigation" | "banner" | "contentinfo"))
                {
                    if !sc && !VOID.contains(&tag.as_str()) {
                        skip = Some((tag, 1));
                    }
                    continue;
                }
                if let Some(n) = heading(tag) {
                    out.push_str(&format!("\n\n{} ", "#".repeat(n)));
                } else if tag == "li" {
                    out.push_str("\n- ");
                } else if tag == "pre" {
                    pre += 1;
                    out.push_str("\n```\n");
                } else if tag == "code" && pre == 0 {
                    out.push('`');
                } else if tag == "td" || tag == "th" {
                    out.push_str(" | ");
                } else if BLOCK.contains(&tag.as_str()) {
                    out.push('\n');
                } else if tag == "a" && links {
                    href = at("href").map(str::to_string);
                    out.push('[');
                }
                if *sc {
                    end(&mut out, tag, &mut skip, &mut pre, &mut href);
                }
            }
            Tok::End(tag) => end(&mut out, tag, &mut skip, &mut pre, &mut href),
            Tok::Text(d) if skip.is_none() => {
                if pre > 0 {
                    out.push_str(d);
                } else {
                    out.push_str(&ws.replace_all(d, " "));
                }
            }
            Tok::Text(_) => {}
        }
    }
    out
}

/// Prefer <main>, then <article>, then [role=main]; fall back to <body>.
fn main_part(h: &str) -> &str {
    for rx in [r"(?is)<main\b.*?</main>", r"(?is)<article\b.*?</article>", r#"(?is)<[^>]+role=["']main["'].*?</div>\s*</div>"#, r"(?is)<body\b.*?</body>"] {
        if let Some(m) = Regex::new(rx).unwrap().find(h) {
            if clen(m.as_str()) > 500 {
                return m.as_str();
            }
        }
    }
    h
}

/// (title, text) of an HTML page.
fn to_text(h: &str, links: bool) -> (String, String) {
    let title = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap().captures(h).map(|c| unescape(&c[1]).trim().to_string()).unwrap_or_default();
    let t = render(&tokenize(main_part(h)), links);
    let t = Regex::new(r"[ \t]+\n").unwrap().replace_all(&t, "\n");
    // <li><p>text</p>  ->  "- text" (only when text follows)
    let t = Regex::new(r"\n- *(?:\n\s*)+").unwrap().replace_all(&t, |c: &regex::Captures| {
        let m = c.get(0).unwrap();
        if m.end() == t.len() { m.as_str().to_string() } else { "\n- ".to_string() }
    });
    let t = Regex::new(r"(?m)\n- *$").unwrap().replace_all(&t, ""); // empty bullets
    let t = Regex::new(r"\n{3,}").unwrap().replace_all(&t, "\n\n");
    (title, t.trim().to_string())
}

// ---------- fetch + cache ----------

fn cache_dir() -> PathBuf {
    super::util::cache_home().join("tokenforge").join("web")
}

fn fnv(s: &str) -> String {
    let h = s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

fn decode(raw: &[u8], ct: &str) -> String {
    let cs = Regex::new(r"charset=([\w-]+)").unwrap().captures(ct).map(|c| c[1].to_ascii_lowercase());
    match cs.as_deref() {
        Some("iso-8859-1" | "latin-1" | "latin1" | "windows-1252" | "cp1252" | "us-ascii" | "ascii") => raw.iter().map(|&b| b as char).collect(),
        _ => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// The page as {url, status, ct, kind, bytes, title, text}, from the 24h cache unless `fresh`; plus "cached".
fn fetch(url: &str, links: bool, fresh: bool) -> (Value, bool) {
    let dir = cache_dir();
    let path = dir.join(format!("{}.json", fnv(&format!("{url}{}", if links { "|links" } else { "" }))));
    let young = |p: &PathBuf| p.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|d| d.as_secs() < 86400);
    if !fresh && young(&path) {
        if let Some(doc) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            return (doc, true);
        }
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
    let res = agent.get(url).set("User-Agent", UA).set("Accept", "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5").call();
    let r = match res {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => fail(format!("HTTP {code} {} for {url}", r.status_text())),
        Err(e) => fail(format!("{url}: {}", super::http::transport(&e))),
    };
    let (status, ct) = (r.status(), r.header("Content-Type").unwrap_or("").to_string());
    let mut raw = Vec::new();
    if let Err(e) = r.into_reader().read_to_end(&mut raw) {
        fail(format!("{url}: {e}"));
    }
    let body = decode(&raw, &ct);
    let kind = if ct.contains("json") || url.ends_with(".json") {
        "json"
    } else if ct.contains("html") && !url.ends_with(".md") && !url.ends_with(".txt") {
        "html"
    } else {
        "text"
    };
    let (title, text) = if kind == "html" { to_text(&body, links) } else { (String::new(), body) };
    let doc = json!({"url": url, "status": status, "ct": ct, "kind": kind, "bytes": raw.len(), "title": title, "text": text});
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(&path, doc.to_string());
    }
    (doc, false)
}

// ---------- sections ----------

#[derive(Debug)]
struct Sec {
    h: String,
    lvl: usize,
    text: String,
}

/// Split at markdown headings outside code fences; drop an empty preamble.
fn sections(text: &str) -> Vec<Sec> {
    let re = Regex::new(r"^(#{1,6})\s+(.*\S)\s*$").unwrap();
    let mut secs = Vec::new();
    let (mut h, mut lvl, mut body, mut in_code) = ("(top)".to_string(), 0, Vec::new(), false);
    for l in text.split('\n') {
        if l.starts_with("```") {
            in_code = !in_code;
        }
        match re.captures(l).filter(|_| !in_code) {
            Some(c) => {
                secs.push((std::mem::replace(&mut h, c[2].trim_matches(['#', ' ']).to_string()), lvl, std::mem::take(&mut body)));
                lvl = c[1].len();
            }
            None => body.push(l),
        }
    }
    secs.push((h, lvl, body));
    secs.into_iter()
        .filter(|(h, _, b)| h != "(top)" || !b.concat().trim().is_empty())
        .map(|(h, lvl, b)| Sec { h, lvl, text: b.join("\n").trim().to_string() })
        .collect()
}

fn hashes(lvl: usize) -> String {
    "#".repeat(lvl.max(1))
}

fn outline(secs: &[Sec], text: &str) -> String {
    let mut s = String::new();
    for (i, x) in secs.iter().enumerate() {
        s += &format!("{:>3}. {}{}  ({})\n", i + 1, "  ".repeat(x.lvl.saturating_sub(1)), take(&x.h, 100), clen(&x.text));
    }
    let n = clen(text);
    if secs.len() <= 2 && n <= 4000 {
        s += &format!("\n{text}\n");
    } else if secs.len() <= 2 {
        s += &format!("\n{}\n…  (no headings: use -s TERMS, --ask, or --full)\n", take(text, 1500));
    }
    s
}

/// Sections ranked by term hits (heading x3, body capped at 10 per term, +5 if all terms present), ~4000 chars.
fn search(secs: &[Sec], query: &str) -> String {
    let mut terms: Vec<String> = Regex::new(r"\w+").unwrap().find_iter(query).map(|m| m.as_str().to_lowercase()).filter(|t| clen(t) > 2).collect();
    if terms.is_empty() {
        terms.push(query.to_lowercase());
    }
    let score = |s: &Sec| {
        let (h, b) = (s.h.to_lowercase(), s.text.to_lowercase());
        let hb = format!("{h}{b}");
        let base: usize = terms.iter().map(|t| 3 * h.matches(t.as_str()).count() + b.matches(t.as_str()).count().min(10)).sum();
        base + if terms.iter().all(|t| hb.contains(t.as_str())) { 5 } else { 0 }
    };
    let mut ranked: Vec<(usize, usize)> = secs.iter().enumerate().map(|(i, s)| (score(s), i)).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let (mut out, mut budget) = (String::new(), 4000i64);
    for &(sc, i) in &ranked {
        if sc == 0 || budget <= 0 {
            break;
        }
        let s = &secs[i];
        let chunk = take(&s.text, budget as usize);
        let more = if clen(chunk) < clen(&s.text) { "\n…" } else { "" };
        out += &format!("\n[{}] {} {}\n{chunk}{more}\n", i + 1, hashes(s.lvl), s.h);
        budget -= (clen(chunk) + clen(&s.h)) as i64;
    }
    if ranked.first().is_some_and(|r| r.0 == 0) {
        out += "no section matches; see the outline (tmap kit web URL) or --ask\n";
    }
    out
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.first().is_none_or(|x| x == "-h" || x == "--help") {
        println!("{HELP}");
        return if a.is_empty() { 2 } else { 0 };
    }
    let (mut s, mut n, mut ask, mut full, mut fresh, mut links, mut url) = (None, None, None, false, false, false, None);
    while !a.is_empty() {
        let x = a.remove(0);
        let mut val = || if a.is_empty() { fail(format!("{x} needs a value")) } else { a.remove(0) };
        match x.as_str() {
            "-s" => s = Some(val()),
            "-n" => n = Some(val()),
            "--ask" => ask = Some(val()),
            "--full" => full = true,
            "--fresh" => fresh = true,
            "--links" => links = true,
            _ if url.is_none() => url = Some(x),
            _ => fail(format!("unexpected {x}")),
        }
    }
    let mut url = url.unwrap_or_else(|| fail("no URL".into()));
    if !url.contains("://") {
        url = format!("https://{url}");
    }
    if let Some(c) = Regex::new(r"^https://github\.com/([^/]+)/([^/]+)/blob/(.+)$").unwrap().captures(&url) {
        url = format!("https://raw.githubusercontent.com/{}/{}/{}", &c[1], &c[2], &c[3]);
    }
    let (doc, cached) = fetch(&url, links, fresh);
    let field = |k: &str| doc[k].as_str().unwrap_or("").to_string();
    let (text, bytes) = (field("text"), doc["bytes"].as_u64().unwrap_or(0));
    // A page fetch would put the whole converted text in context.
    super::util::note_raw(text.len());
    if field("kind") == "json" {
        println!("{url}  JSON {bytes}B");
        let v = serde_json::from_str::<Value>(&text).or_else(|e| {
            let rows: Result<Vec<Value>, _> = text.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect();
            rows.map(Value::Array).map_err(|_| e)
        });
        return match v {
            Ok(v) => {
                println!("{}", super::jx::shape_str(&v));
                0
            }
            Err(e) => die("jx", &format!("-: not JSON/JSONL: {e}"), 2),
        };
    }
    let secs = sections(&text);
    let title = field("title");
    let head = format!(
        "{}  ({}KB, {} chars text{})",
        if title.is_empty() { &url } else { &title },
        bytes / 1024,
        clen(&text),
        if cached { ", cached" } else { "" }
    );
    println!("{head}");
    if let Some(q) = ask {
        return match super::distill::distill_text(&q, &text) {
            Ok(ans) => {
                println!("{}", ans.trim_end());
                0
            }
            Err(e) => {
                eprintln!("web: {e}");
                1
            }
        };
    }
    if full {
        let more = clen(&text).saturating_sub(30000);
        println!("{}{}", take(&text, 30000), if more > 0 { format!("\n…[{more} more chars; use -s or -n]") } else { String::new() });
    } else if let Some(n) = n {
        for x in n.split(',') {
            let i: i64 = x.trim().parse().unwrap_or_else(|_| fail(format!("bad section number {x}")));
            let Some(s) = usize::try_from(i - 1).ok().and_then(|i| secs.get(i)) else {
                fail(format!("no section {x} (1-{})", secs.len()));
            };
            println!("\n{} {}\n{}", hashes(s.lvl), s.h, take(&s.text, 12000));
        }
    } else if let Some(q) = s {
        print!("{}", search(&secs, &q));
    } else {
        print!("{}", outline(&secs, &text));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> String {
        format!("<html><head><title>Doc &amp; Co</title><style>p{{}}</style></head><body>{body}<p>{}</p></body></html>", "pad ".repeat(150))
    }

    #[test]
    fn html_to_markdownish() {
        let h = page(
            r#"<nav><a href="/">Home</a></nav><div class="sidebar"><div>side</div><p>more side</p></div>
            <h1>Intro</h1><p>Hello   <code>x&lt;y</code> world&nbsp;!</p>
            <ul><li><p>one</p></li><li></li><li>two <a href="/t">link</a></li></ul>
            <pre>let a = 1;
  b</pre><script>if (a < b) { "</p>" }</script>
            <h2 id="u">Usage</h2><table><tr><td>k</td><td>v</td></tr></table><br/>end"#,
        );
        let (title, t) = to_text(&h, false);
        assert_eq!(title, "Doc & Co");
        assert!(t.starts_with("# Intro\n\nHello `x<y` world !\n\n- one\n\n- - two link"), "{t}"); // same as the Python original
        assert!(t.contains("```\nlet a = 1;\n  b\n```"), "{t}");
        assert!(t.contains("## Usage\n\n | k | v"), "{t}");
        assert!(!t.contains("side") && !t.contains("Home") && !t.contains("</p>"), "{t}");
        let (_, l) = to_text(&page(r##"<p><a href="/t">x</a> <a href="#s">y</a></p>"##), true);
        assert!(l.starts_with("[x](/t) [y]"), "{l}");
    }

    #[test]
    fn tokens() {
        let t = tokenize(r#"<A HREF='x' data-x=1 hidden>t<!-- c --></a><br/>"#);
        assert_eq!(t[0], Tok::Start("a".into(), vec![("href".into(), Some("x".into())), ("data-x".into(), Some("1".into())), ("hidden".into(), None)], false));
        assert_eq!(t[2], Tok::End("a".into()));
        assert_eq!(t[3], Tok::Start("br".into(), vec![], true));
        assert_eq!(unescape("&#x41;&#66;&amp;&bogus;&copy"), "AB&&bogus;&copy");
    }

    #[test]
    fn sections_outline_search() {
        let text = "pre\n# A\nalpha text\n```\n# not a heading\n```\n## B ##\nbeta beta install\n# C\ngamma";
        let secs = sections(text);
        assert_eq!(secs.iter().map(|s| (s.h.as_str(), s.lvl)).collect::<Vec<_>>(), [("(top)", 0), ("A", 1), ("B", 2), ("C", 1)]);
        assert!(secs[1].text.contains("# not a heading"));
        let o = outline(&secs, text);
        assert!(o.starts_with("  1. (top)  (3)\n  2. A  (34)\n  3.   B  (17)\n  4. C  (5)\n"), "{o}");
        let s = search(&secs, "beta install");
        assert!(s.starts_with("\n[3] ## B\nbeta beta install\n"), "{s}");
        assert!(search(&secs, "zzz").ends_with("no section matches; see the outline (tmap kit web URL) or --ask\n"));
        assert!(sections("\n\n# Only\nx").len() == 1);
    }

    #[test]
    fn misc() {
        assert_eq!(take("héllo", 2), "hé");
        assert_eq!(decode(b"caf\xe9", "text/html; charset=ISO-8859-1"), "café");
        assert_eq!(fnv("x").len(), 16);
        assert!(main_part(&page("<main>short</main>")).starts_with("<body>"));
    }
}
