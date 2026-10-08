//! `tmap kit http`: one HTTP request, a compact answer (status line, then the body cut to size).

use super::util::die;
use serde_json::Value;
use std::io::Read;
use std::time::{Duration, Instant};

const HELP: &str = "HTTP request with a compact answer: status line, then the body cut to size.

  tmap kit http [METHOD] URL [BODY] [-H 'K: V']... [-q PATH] [--shape] [--full] [--headers]
  BODY: JSON text, @file, or k=v pairs (sent as a JSON object)
  -q PATH   print only that path of a JSON response (jx syntax: a.b[0].c)
  --shape   print the JSON response's shape (see jx) instead of the body
  JSON bodies over 3000 chars print their shape automatically; --full lifts all limits.

  tmap kit http localhost:3000/api/users -q 'data[0]'
  tmap kit http POST :8080/login user=a pass=b
";
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CAP: usize = 3000;

/// Python's `json.dumps` compact separators: ", " and ": ".
struct PyCompact;

impl serde_json::ser::Formatter for PyCompact {
    fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }
    fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }
    fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        w.write_all(b": ")
    }
}

fn py_compact(v: &Value) -> String {
    let mut b = Vec::new();
    let _ = serde::Serialize::serialize(v, &mut serde_json::Serializer::with_formatter(&mut b, PyCompact));
    String::from_utf8(b).unwrap_or_default()
}

/// `json.dumps(v, indent=1, ensure_ascii=False)`.
fn py_indent1(v: &Value) -> String {
    let mut b = Vec::new();
    let _ = serde::Serialize::serialize(v, &mut serde_json::Serializer::with_formatter(&mut b, serde_json::ser::PrettyFormatter::with_indent(b" ")));
    String::from_utf8(b).unwrap_or_default()
}

fn cut(s: &str, n: usize) -> Option<(String, usize)> {
    let total = s.chars().count();
    (total > n).then(|| (s.chars().take(n).collect(), total - n))
}

/// `jx get - PATH`: path syntax a.b[0]."odd key"; strings raw, small values compact, big ones indented.
fn get(v: &Value, path: &str, full: bool) -> Result<String, String> {
    let re = regex::Regex::new(r#"\.?"((?:[^"\\]|\\.)*)"|\.?([^.\[\]"]+)|\[(-?\d+)\]"#).unwrap();
    let mut cur = v;
    if !matches!(path, "" | ".") {
        for c in re.captures_iter(path) {
            let next = match (c.get(1).or(c.get(2)), c.get(3)) {
                (Some(k), _) => cur.get(k.as_str()).ok_or(format!("'{}'", k.as_str())),
                (_, Some(i)) => {
                    let i: i64 = i.as_str().parse().unwrap_or(0);
                    let arr = cur.as_array();
                    let len = arr.map_or(0, |a| a.len() as i64);
                    let j = if i < 0 { i + len } else { i };
                    arr.and_then(|a| a.get(usize::try_from(j).ok()?)).ok_or(i.to_string())
                }
                _ => continue,
            };
            cur = next.map_err(|k| format!("path not found at {k}"))?;
        }
    }
    let s = match cur {
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) if py_compact(cur).chars().count() >= 200 => py_indent1(cur),
        _ => py_compact(cur),
    };
    Ok(match cut(&s, CAP).filter(|_| !full) {
        Some((head, more)) => format!("{head}\n…[{more} more chars; use --full or a narrower path]"),
        None => s,
    })
}

/// Body after the status line, and the exit code.
fn render(text: &str, q: Option<&str>, shape: bool, full: bool) -> (String, i32) {
    let js: Option<Value> = serde_json::from_str(text).ok();
    let n = text.chars().count();
    if let Some(js) = &js {
        if q.is_some() || shape || (n > CAP && !full) {
            if let Some(q) = q {
                return match get(js, q, full) {
                    Ok(s) => (s, 0),
                    Err(e) => (format!("jx: {e}"), 2),
                };
            }
            let note = if shape { String::new() } else { format!("(body {n} chars: shape shown; -q PATH for values, --full for all)\n") };
            return (note + &super::jx::shape_str(js), 0);
        }
    }
    let text = js.as_ref().map(py_indent1).unwrap_or_else(|| text.to_string());
    match cut(&text, CAP).filter(|_| !full) {
        Some((head, more)) => (format!("{head}\n…[{more} more chars; --full]"), 0),
        None => (text, 0),
    }
}

/// A ureq error without the URL ureq repeats in its Display.
pub fn transport(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Transport(t) => t.message().map_or_else(|| t.kind().to_string(), |m| format!("{}: {m}", t.kind())),
        e => e.to_string(),
    }
}

/// `:8080/x` -> http://localhost:8080/x; bare local hosts get http, others https.
fn norm_url(u: &str) -> String {
    let u = if u.starts_with(':') { format!("localhost{u}") } else { u.to_string() };
    if u.contains("://") {
        u
    } else if ["localhost", "127.", "0.0.0.0"].iter().any(|p| u.starts_with(p)) {
        format!("http://{u}")
    } else {
        format!("https://{u}")
    }
}

/// BODY: one JSON literal, @file, or k=v pairs (values parsed as JSON when they are).
fn body(pos: &[String]) -> Vec<u8> {
    if let [one] = pos {
        if let Some(f) = one.strip_prefix('@') {
            return std::fs::read(f).unwrap_or_else(|e| die("http", &format!("{f}: {e}"), 2));
        }
        if one.starts_with(['[', '{', '"']) {
            return one.clone().into_bytes();
        }
    }
    let mut obj = serde_json::Map::new();
    for kv in pos {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        obj.insert(k.to_string(), serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.to_string())));
    }
    py_compact(&Value::Object(obj)).into_bytes()
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.first().is_none_or(|x| x == "-h" || x == "--help") {
        println!("{HELP}");
        return if a.is_empty() { 2 } else { 0 };
    }
    let (mut hdr, mut q, mut shape, mut full, mut show_h, mut pos) = (Vec::<(String, String)>::new(), None, false, false, false, vec![]);
    while !a.is_empty() {
        let x = a.remove(0);
        let mut val = || if a.is_empty() { die("http", &format!("{x} needs a value"), 2) } else { a.remove(0) };
        match x.as_str() {
            "-H" => {
                let h = val();
                let (k, v) = h.split_once(':').unwrap_or((&h, ""));
                hdr.retain(|(n, _)| n != k.trim());
                hdr.push((k.trim().to_string(), v.trim().to_string()));
            }
            "-q" => q = Some(val()),
            "--shape" => shape = true,
            "--full" => full = true,
            "--headers" => show_h = true,
            _ => pos.push(x),
        }
    }
    let mut method = None;
    if pos.first().is_some_and(|p| METHODS.contains(&p.to_uppercase().as_str())) {
        method = Some(pos.remove(0).to_uppercase());
    }
    if pos.is_empty() {
        die("http", "no URL", 2);
    }
    let url = norm_url(&pos.remove(0));
    let data = (!pos.is_empty()).then(|| body(&pos));
    if data.is_some() && !hdr.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        hdr.push(("Content-Type".into(), "application/json".into()));
    }
    let method = method.unwrap_or_else(|| if data.is_some() { "POST" } else { "GET" }.into());

    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
    let mut req = agent.request(&method, &url);
    for (k, v) in &hdr {
        req = req.set(k, v);
    }
    let t = Instant::now();
    let res = match &data {
        Some(b) => req.send_bytes(b),
        None => req.call(),
    };
    let r = match res {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => die("http", &format!("{method} {url}: {}", transport(&e)), 2),
    };
    let (status, ct) = (r.status(), r.header("Content-Type").unwrap_or("").to_string());
    let heads: Vec<String> = r.headers_names().iter().flat_map(|n| r.all(n).into_iter().map(move |v| format!("  {n}: {v}"))).collect();
    let mut raw = Vec::new();
    if let Err(e) = r.into_reader().read_to_end(&mut raw) {
        die("http", &format!("{method} {url}: {e}"), 2);
    }
    super::util::note_raw(raw.len());
    println!("HTTP {status}  {method} {url}  {}B  {}ms  {ct}", raw.len(), t.elapsed().as_millis());
    if show_h {
        heads.iter().for_each(|h| println!("{h}"));
    }
    let (out, code) = render(&String::from_utf8_lossy(&raw), q.as_deref(), shape, full);
    if code == 0 { println!("{out}") } else { eprintln!("{out}") }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(norm_url(":8080/x"), "http://localhost:8080/x");
        assert_eq!(norm_url("127.0.0.1/a"), "http://127.0.0.1/a");
        assert_eq!(norm_url("example.com"), "https://example.com");
        assert_eq!(norm_url("http://h"), "http://h");
    }

    #[test]
    fn bodies() {
        assert_eq!(body(&["user=a".into(), "n=3".into(), "ok=true".into()]), br#"{"user": "a", "n": 3, "ok": true}"#.to_vec());
        assert_eq!(body(&[r#"{"a":1}"#.into()]), br#"{"a":1}"#.to_vec());
    }

    #[test]
    fn json_output() {
        let (s, c) = render(r#"{"a":[1,2],"b":{},"c":"é"}"#, None, false, false);
        assert_eq!((s.as_str(), c), ("{\n \"a\": [\n  1,\n  2\n ],\n \"b\": {},\n \"c\": \"é\"\n}", 0));
        assert_eq!(render(r#"{"d":[{"x":"hi"}]}"#, Some("d[0].x"), false, false).0, "hi");
        assert_eq!(render(r#"{"d":[{"x":[1, 2]}]}"#, Some("d[-1]"), false, false).0, r#"{"x": [1, 2]}"#);
        assert_eq!(render(r#"{"d":1}"#, Some("e"), false, false), ("jx: path not found at 'e'".into(), 2));
    }

    #[test]
    fn caps() {
        let big = "x".repeat(3500);
        assert!(render(&big, None, false, false).0.ends_with("x\n…[500 more chars; --full]"));
        assert_eq!(render(&big, None, false, true).0.len(), 3500);
        let js = format!("[\"{}\"]", "y".repeat(3100));
        assert!(render(&js, None, false, false).0.starts_with("(body 3104 chars: shape shown"));
    }
}
