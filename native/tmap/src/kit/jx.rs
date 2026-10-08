//! `tmap kit jx`: inspect and edit JSON / JSONL / TOML without dumping it.
//! Output mirrors Python's json.dumps (", " / ": " separators, float repr, ASCII escapes).

use super::util::{die, read_stdin};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const HELP: &str = "Inspect and edit JSON / JSONL / TOML without dumping it. FILE may be '-' (stdin).

  tmap kit jx shape FILE [PATH]      type tree: keys, types, array lengths (items merged), depth 5
  tmap kit jx get   FILE PATH        value at PATH, compact JSON (truncated at 3000 chars; --full to lift)
  tmap kit jx keys  FILE [PATH]      keys / indices at PATH with value types
  tmap kit jx find  FILE REGEX       paths whose key or scalar value matches REGEX (max 50)
  tmap kit jx set   FILE PATH VALUE  in place; VALUE parsed as JSON, else stored as a string
  tmap kit jx del   FILE PATH        in place
  tmap kit jx merge FILE JSON        deep-merge an object into the root (in place)

PATH: a.b[0].c   or  a.\"key.with.dots\"[2]   ('' or . = root). JSONL = array of lines.
Writes keep the file's indent and trailing newline. TOML is read-only.
";

fn fail(m: &str) -> ! {
    die("jx", m, 2)
}

// ---- Python-compatible formatting (shared with tab / tally) ----

/// Python `repr(float)`: shortest round-trip digits, exponent form outside 1e-4..1e16.
pub fn py_float(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let e = format!("{f:e}");
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let (sign, mant) = mant.strip_prefix('-').map_or(("", mant), |m| ("-", m));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    if (-4..16).contains(&exp) {
        let body = if exp >= 0 {
            let k = exp as usize + 1;
            let int = if digits.len() >= k { digits[..k].to_string() } else { format!("{digits}{}", "0".repeat(k - digits.len())) };
            let frac = if digits.len() > k { &digits[k..] } else { "0" };
            format!("{int}.{frac}")
        } else {
            format!("0.{}{digits}", "0".repeat((-exp - 1) as usize))
        };
        format!("{sign}{body}")
    } else {
        format!("{sign}{mant}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// Python `repr(str)`.
pub fn py_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut o = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if c == q => {
                o.push('\\');
                o.push(c)
            }
            c if (c as u32) < 0x20 || (0x7f..0xa0).contains(&(c as u32)) => o.push_str(&format!("\\x{:02x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push(q);
    o
}

fn json_str(s: &str, ascii: bool, o: &mut String) {
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            c if (c as u32) < 0x20 || (ascii && (c as u32) > 0x7e) => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{u:04x}"));
                }
            }
            c => o.push(c),
        }
    }
    o.push('"');
}

fn num_str(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if !n.is_i64() && !n.is_u64() => {
            if f.is_nan() {
                "NaN".into()
            } else if f.is_infinite() {
                (if f > 0.0 { "Infinity" } else { "-Infinity" }).into()
            } else {
                py_float(f)
            }
        }
        _ => n.to_string(),
    }
}

/// Python `json.dumps(v, ensure_ascii=ascii, indent=indent)`.
pub fn dumps(v: &Value, ascii: bool, indent: Option<&str>) -> String {
    let mut o = String::new();
    dump(v, ascii, indent, 0, &mut o);
    o
}

fn dump(v: &Value, ascii: bool, ind: Option<&str>, lvl: usize, o: &mut String) {
    let open = |o: &mut String, c: char| {
        o.push(c);
        if let Some(i) = ind {
            o.push('\n');
            o.push_str(&i.repeat(lvl + 1));
        }
    };
    let sep = |o: &mut String| match ind {
        Some(i) => {
            o.push_str(",\n");
            o.push_str(&i.repeat(lvl + 1));
        }
        None => o.push_str(", "),
    };
    let close = |o: &mut String, c: char| {
        if let Some(i) = ind {
            o.push('\n');
            o.push_str(&i.repeat(lvl));
        }
        o.push(c);
    };
    match v {
        Value::Null => o.push_str("null"),
        Value::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => o.push_str(&num_str(n)),
        Value::String(s) => json_str(s, ascii, o),
        Value::Array(a) if a.is_empty() => o.push_str("[]"),
        Value::Object(m) if m.is_empty() => o.push_str("{}"),
        Value::Array(a) => {
            open(o, '[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    sep(o);
                }
                dump(x, ascii, ind, lvl + 1, o);
            }
            close(o, ']');
        }
        Value::Object(m) => {
            open(o, '{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    sep(o);
                }
                json_str(k, ascii, o);
                o.push_str(": ");
                dump(x, ascii, ind, lvl + 1, o);
            }
            close(o, '}');
        }
    }
}

/// Python `str(scalar)` for a JSON scalar.
fn py_str(v: &Value) -> String {
    match v {
        Value::Bool(b) => (if *b { "True" } else { "False" }).into(),
        Value::String(s) => s.clone(),
        Value::Number(n) if n.is_f64() => n.as_f64().map(py_float).unwrap_or_default(),
        _ => dumps(v, false, None),
    }
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---- paths ----

#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Idx(i64),
}

impl Seg {
    fn repr(&self) -> String {
        match self {
            Seg::Key(k) => py_repr(k),
            Seg::Idx(i) => i.to_string(),
        }
    }
}

pub fn parse_path(p: &str) -> Vec<Seg> {
    if p.is_empty() || p == "." {
        return vec![];
    }
    let re = Regex::new(r#"\.?"((?:[^"\\]|\\.)*)"|\.?([^.\[\]"]+)|\[(-?\d+)\]"#).unwrap();
    re.captures_iter(p)
        .map(|c| match (c.get(1), c.get(2), c.get(3)) {
            (Some(m), _, _) | (None, Some(m), _) => Seg::Key(m.as_str().to_string()),
            (_, _, Some(m)) => Seg::Idx(m.as_str().parse().unwrap_or(i64::MAX)),
            _ => unreachable!(),
        })
        .collect()
}

pub fn fmt_path(ps: &[Seg]) -> String {
    let ident = Regex::new(r"^[A-Za-z_][\w-]*$").unwrap();
    let mut s = String::new();
    for k in ps {
        match k {
            Seg::Idx(i) => s.push_str(&format!("[{i}]")),
            Seg::Key(k) => {
                if !s.is_empty() {
                    s.push('.');
                }
                s.push_str(&if ident.is_match(k) { k.clone() } else { dumps(&Value::String(k.clone()), true, None) });
            }
        }
    }
    if s.is_empty() { ".".into() } else { s }
}

fn norm_idx(i: i64, len: usize) -> Option<usize> {
    let j = if i < 0 { i + len as i64 } else { i };
    (0..len as i64).contains(&j).then_some(j as usize)
}

fn step(d: &Value, k: &Seg) -> Option<Value> {
    match (d, k) {
        (Value::Object(m), Seg::Key(k)) => m.get(k).cloned(),
        (Value::Array(a), Seg::Idx(i)) => norm_idx(*i, a.len()).map(|j| a[j].clone()),
        (Value::String(s), Seg::Idx(i)) => {
            let cs: Vec<char> = s.chars().collect();
            norm_idx(*i, cs.len()).map(|j| Value::String(cs[j].to_string()))
        }
        _ => None,
    }
}

pub fn walk(d: &Value, ps: &[Seg]) -> Result<Value, String> {
    let mut v = d.clone();
    for k in ps {
        v = step(&v, k).ok_or_else(|| format!("path not found at {}", k.repr()))?;
    }
    Ok(v)
}

fn walk_mut<'a>(d: &'a mut Value, ps: &[Seg]) -> Result<&'a mut Value, String> {
    let mut v = d;
    for k in ps {
        let nf = format!("path not found at {}", k.repr());
        v = match (v, k) {
            (Value::Object(m), Seg::Key(k)) => m.get_mut(k).ok_or(nf)?,
            (Value::Array(a), Seg::Idx(i)) => {
                let j = norm_idx(*i, a.len()).ok_or(nf)?;
                &mut a[j]
            }
            _ => return Err(nf),
        };
    }
    Ok(v)
}

fn key_str(k: &Seg) -> String {
    match k {
        Seg::Key(k) => k.clone(),
        Seg::Idx(i) => i.to_string(),
    }
}

/// `set`: create missing parent objects, then assign (append when index == len).
pub fn set(data: &mut Value, ps: &[Seg], val: Value) -> Result<(), String> {
    let (last, parents) = ps.split_last().ok_or("cannot replace root; use merge")?;
    let mut d = &mut *data;
    for k in parents {
        d = match d {
            // Python's dict also takes an int key here (dumped as a string).
            Value::Object(m) => m.entry(key_str(k)).or_insert_with(|| Value::Object(Map::new())),
            d => walk_mut(d, std::slice::from_ref(k))?,
        };
    }
    match (d, last) {
        (Value::Object(m), k) => {
            m.insert(key_str(k), val);
        }
        (Value::Array(a), Seg::Idx(i)) if *i == a.len() as i64 => a.push(val),
        (Value::Array(a), Seg::Idx(i)) => {
            let j = norm_idx(*i, a.len()).ok_or("cannot set: list assignment index out of range")?;
            a[j] = val;
        }
        (Value::Array(_), Seg::Key(_)) => return Err("cannot set: list indices must be integers or slices, not str".into()),
        (v, _) => return Err(format!("cannot set: '{}' object does not support item assignment", tname(v))),
    }
    Ok(())
}

pub fn del(data: &mut Value, ps: &[Seg]) -> Result<(), String> {
    let (last, parents) = ps.split_last().ok_or("cannot replace root; use merge")?;
    let ok = match (walk_mut(data, parents)?, last) {
        (Value::Object(m), Seg::Key(k)) => m.shift_remove(k).is_some(),
        (Value::Array(a), Seg::Idx(i)) => norm_idx(*i, a.len()).map(|j| a.remove(j)).is_some(),
        _ => false,
    };
    if ok { Ok(()) } else { Err("path not found".into()) }
}

pub fn deep_merge(a: &mut Map<String, Value>, b: Map<String, Value>) {
    for (k, v) in b {
        match (a.get_mut(&k), v) {
            (Some(Value::Object(x)), Value::Object(y)) => deep_merge(x, y),
            (_, v) => {
                a.insert(k, v);
            }
        }
    }
}

// ---- shape ----

pub fn tname(v: &Value) -> &'static str {
    match v {
        Value::Object(_) => "obj",
        Value::Array(_) => "arr",
        Value::String(_) => "str",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "num",
        Value::Number(_) => "int",
        Value::Null => "null",
    }
}

fn types_of<'a>(vs: impl Iterator<Item = &'a Value>) -> String {
    vs.map(tname).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join("|")
}

fn is_cont(v: &Value) -> bool {
    v.is_object() || v.is_array()
}

pub fn shape(v: &Value, ind: usize, depth: i32, out: &mut Vec<String>, merged: bool) {
    let mut pad = "  ".repeat(ind);
    match v {
        Value::Object(m) => {
            if depth == 0 {
                if let Some(l) = out.last_mut() {
                    l.push_str(&format!(" {{…{} keys}}", m.len()));
                }
                return;
            }
            for (k, x) in m.iter().take(60) {
                let mut l = format!("{pad}{k}: {}", tname(x));
                if let Value::Array(a) = x {
                    l += &format!("[{}]", a.len());
                }
                if !is_cont(x) {
                    l += &format!(" = {}", cut(&dumps(x, true, None), 50));
                }
                out.push(l);
                if is_cont(x) {
                    shape(x, ind + 1, depth - 1, out, false);
                }
            }
            if m.len() > 60 {
                out.push(format!("{pad}… {} more keys", m.len() - 60));
            }
        }
        Value::Array(a) if !a.is_empty() => {
            if depth == 0 {
                return;
            }
            let objs: Vec<&Map<String, Value>> = a.iter().filter_map(Value::as_object).collect();
            let types = types_of(a.iter());
            if objs.is_empty() {
                let eg = if types != "arr" { format!(" e.g. {}", cut(&dumps(&a[0], true, None), 60)) } else { String::new() };
                out.push(format!("{pad}[] items: {types}{eg}"));
                if a[0].is_array() {
                    shape(&a[0], ind + 1, depth - 1, out, false);
                }
                return;
            }
            let mut keys: Vec<(&String, Vec<&Value>)> = Vec::new();
            for o in &objs {
                for (k, x) in o.iter() {
                    match keys.iter_mut().find(|(kk, _)| *kk == k) {
                        Some((_, xs)) => xs.push(x),
                        None => keys.push((k, vec![x])),
                    }
                }
            }
            if !merged {
                let tail = if objs.len() > 1 { format!(", keys in {} objs:", objs.len()) } else { ":".into() };
                out.push(format!("{pad}[] items: {types}{tail}"));
            } else {
                pad = pad.get(2..).unwrap_or("").to_string();
            }
            for (k, xs) in keys.iter().take(60) {
                let opt = if xs.len() == objs.len() { String::new() } else { format!(" (in {}/{})", xs.len(), objs.len()) };
                out.push(format!("{pad}  {k}: {}{opt}", types_of(xs.iter().copied())));
                let sub: Vec<&Value> = xs.iter().copied().filter(|x| is_cont(x)).collect();
                if let Some(first) = sub.first() {
                    if first.is_object() {
                        let l = Value::Array(sub.iter().filter(|x| x.is_object()).map(|x| (*x).clone()).collect());
                        shape(&l, ind + 2, depth - 1, out, true);
                    } else {
                        shape(first, ind + 2, depth - 1, out, false);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Exactly what `jx shape` prints for `v`: type/size header, then the shape lines (no trailing newline).
pub fn shape_str(v: &Value) -> String {
    let head = match v {
        Value::Array(x) => format!("arr[{}]", x.len()),
        Value::Object(m) => format!("obj {} keys", m.len()),
        v => tname(v).to_string(),
    };
    let mut out = vec![head];
    shape(v, 0, 5, &mut out, false);
    out.join("\n")
}

// ---- load / write ----

#[derive(PartialEq, Debug)]
pub enum Kind {
    Json,
    Jsonl,
    Toml,
}

fn toml_fix(v: Value) -> Value {
    match v {
        Value::Object(m) => {
            if m.len() == 1 {
                if let Some(Value::String(s)) = m.get("$__toml_private_datetime") {
                    return Value::String(s.clone());
                }
            }
            Value::Object(m.into_iter().map(|(k, v)| (k, toml_fix(v))).collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(toml_fix).collect()),
        v => v,
    }
}

fn jsonl(raw: &str) -> Result<Value, serde_json::Error> {
    raw.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

pub fn parse(name: &str, raw: &str) -> Result<(Value, Kind), String> {
    if name.ends_with(".toml") {
        return toml::from_str::<Value>(raw).map(|v| (toml_fix(v), Kind::Toml)).map_err(|e| format!("{name}: bad TOML: {e}"));
    }
    if name.ends_with(".jsonl") || name.ends_with(".ndjson") {
        return jsonl(raw).map(|v| (v, Kind::Jsonl)).map_err(|e| format!("{name}: {e}"));
    }
    match serde_json::from_str(raw) {
        Ok(v) => Ok((v, Kind::Json)),
        Err(e) => jsonl(raw).map(|v| (v, Kind::Jsonl)).map_err(|_| format!("{name}: not JSON/JSONL: {e}")),
    }
}

/// Serialize like the original: JSONL one compact line per item; JSON keeps indent and trailing newline.
pub fn render(data: &Value, kind: &Kind, raw: &str) -> String {
    if *kind == Kind::Jsonl {
        let items = data.as_array().map(|a| a.iter().map(|x| dumps(x, false, None)).collect::<Vec<_>>()).unwrap_or_default();
        let s = items.join("\n") + "\n";
        return if super::util::is_crlf(raw) { s.replace('\n', "\r\n") } else { s };
    }
    let ind = if raw.trim().contains('\n') {
        Regex::new(r"\n([ \t]+)\S").unwrap().captures(raw).map(|c| c[1].to_string())
    } else {
        None
    };
    let ind = ind.map(|i| if i.contains('\t') { "\t".to_string() } else { " ".repeat(i.len()) });
    let mut s = dumps(data, false, ind.as_deref());
    if raw.ends_with('\n') {
        s.push('\n');
    }
    // Keep a CRLF file CRLF (JSON strings escape their newlines, so this only touches layout).
    if super::util::is_crlf(raw) { s.replace('\n', "\r\n") } else { s }
}

fn write(f: &str, data: &Value, kind: &Kind, raw: &str) {
    if f == "-" {
        println!("{}", dumps(data, false, Some("  ")));
        return;
    }
    if *kind == Kind::Toml {
        fail("TOML is read-only");
    }
    let tmp = format!("{f}.jx-tmp");
    let out = render(data, kind, raw);
    if let Err(e) = std::fs::write(&tmp, &out).and_then(|_| super::util::replace_file(std::path::Path::new(&tmp), std::path::Path::new(f), out.as_bytes())) {
        fail(&format!("{f}: {e}"));
    }
}

// ---- commands ----

pub fn get_str(v: &Value, full: bool) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        v if !is_cont(v) || dumps(v, true, None).chars().count() < 200 => dumps(v, false, None),
        v => dumps(v, false, Some(" ")),
    };
    let n = s.chars().count();
    if full || n <= 3000 { s } else { format!("{}\n…[{} more chars; use --full or a narrower path]", cut(&s, 3000), n - 3000) }
}

pub fn find(data: &Value, rx: &Regex) -> Vec<String> {
    fn rec(v: &Value, ps: &mut Vec<Seg>, rx: &Regex, hits: &mut Vec<String>) {
        if hits.len() >= 50 {
            return;
        }
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    ps.push(Seg::Key(k.clone()));
                    if rx.is_match(k) {
                        hits.push(format!("{}\t{}", fmt_path(ps), tname(x)));
                    }
                    rec(x, ps, rx, hits);
                    ps.pop();
                }
            }
            Value::Array(a) => {
                for (i, x) in a.iter().enumerate() {
                    ps.push(Seg::Idx(i as i64));
                    rec(x, ps, rx, hits);
                    ps.pop();
                }
            }
            Value::Null => {}
            v => {
                if rx.is_match(&py_str(v)) {
                    hits.push(format!("{}\t= {}", fmt_path(ps), cut(&dumps(v, true, None), 100)));
                }
            }
        }
    }
    let mut hits = Vec::new();
    rec(data, &mut Vec::new(), rx, &mut hits);
    hits
}

pub fn main(args: Vec<String>) -> i32 {
    let help = args.first().is_some_and(|a| a == "-h" || a == "--help");
    if args.len() < 2 || help {
        println!("{HELP}");
        return if help { 0 } else { 2 };
    }
    let full = args.iter().any(|x| x == "--full");
    let a: Vec<String> = args.into_iter().filter(|x| x != "--full").collect();
    let (cmd, f) = (a[0].as_str(), a[1].as_str());
    let raw = if f == "-" {
        read_stdin()
    } else {
        std::fs::read_to_string(f).unwrap_or_else(|e| fail(&format!("{f}: {e}")))
    };
    super::util::note_raw(raw.len());
    let (mut data, kind) = parse(f, &raw).unwrap_or_else(|e| fail(&e));
    let arg = |i: usize| a.get(i).map(String::as_str);
    let at = |data: &Value| walk(data, &parse_path(arg(2).unwrap_or(""))).unwrap_or_else(|e| fail(&e));
    match cmd {
        "shape" => println!("{}", shape_str(&at(&data))),
        "get" => println!("{}", get_str(&at(&data), full)),
        "keys" => {
            let v = at(&data);
            let items: Vec<(String, &Value)> = match &v {
                Value::Object(m) => m.iter().map(|(k, x)| (k.clone(), x)).collect(),
                Value::Array(x) => x.iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect(),
                _ => fail("not a container"),
            };
            for (k, x) in items.into_iter().take(200) {
                let tail = match x {
                    Value::Array(c) => format!("[{}]", c.len()),
                    Value::Object(c) => format!("[{}]", c.len()),
                    x => format!("\t{}", cut(&dumps(x, true, None), 80)),
                };
                println!("{k}\t{}{tail}", tname(x));
            }
        }
        "find" => {
            let pat = arg(2).unwrap_or_else(|| fail("find needs REGEX"));
            let rx = super::tally::compile(pat, false, false).unwrap_or_else(|e| fail(&e));
            let hits = find(&data, &rx);
            println!("{}", if hits.is_empty() { "no match".into() } else { hits.join("\n") });
            if hits.len() >= 50 {
                println!("(capped at 50)");
            }
        }
        "set" | "del" => {
            let ps = parse_path(arg(2).unwrap_or_else(|| fail(&format!("{cmd} needs PATH"))));
            if ps.is_empty() {
                fail("cannot replace root; use merge");
            }
            let r = if cmd == "set" {
                let v = arg(3).unwrap_or_else(|| fail("set needs VALUE"));
                set(&mut data, &ps, serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.into())))
            } else {
                del(&mut data, &ps)
            };
            r.unwrap_or_else(|e| fail(&e));
            write(f, &data, &kind, &raw);
            println!("{cmd} {} ok", fmt_path(&ps));
        }
        "merge" => {
            let b = match (arg(2).map(serde_json::from_str::<Value>), &mut data) {
                (Some(Ok(Value::Object(b))), Value::Object(_)) => b,
                _ => fail("merge needs JSON object and an object root"),
            };
            if let Value::Object(m) = &mut data {
                deep_merge(m, b);
            }
            write(f, &data, &kind, &raw);
            println!("merged ok");
        }
        _ => fail(&format!("unknown command {cmd}")),
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths() {
        assert_eq!(parse_path(""), vec![]);
        assert_eq!(parse_path("."), vec![]);
        assert_eq!(parse_path("a.b[0].c"), vec![Seg::Key("a".into()), Seg::Key("b".into()), Seg::Idx(0), Seg::Key("c".into())]);
        assert_eq!(parse_path(r#"a."key.with.dots"[-2]"#), vec![Seg::Key("a".into()), Seg::Key("key.with.dots".into()), Seg::Idx(-2)]);
        assert_eq!(fmt_path(&parse_path(r#"a."x y"[3].b-c"#)), r#"a."x y"[3].b-c"#);
        assert_eq!(fmt_path(&[Seg::Idx(1), Seg::Key("k".into())]), "[1].k");
        assert_eq!(fmt_path(&[]), ".");
    }

    #[test]
    fn walk_and_errors() {
        let d = json!({"a": [1, {"b": "xyz"}]});
        assert_eq!(walk(&d, &parse_path("a[-1].b")).unwrap(), json!("xyz"));
        assert_eq!(walk(&d, &parse_path("a[1].b[0]")).unwrap(), json!("x"));
        assert_eq!(walk(&d, &parse_path("a.x")).unwrap_err(), "path not found at 'x'");
        assert_eq!(walk(&d, &parse_path("a[5]")).unwrap_err(), "path not found at 5");
    }

    #[test]
    fn set_del_merge() {
        let mut d = json!({"a": [1]});
        set(&mut d, &parse_path("x.y.z"), json!(1)).unwrap();
        set(&mut d, &parse_path("a[1]"), json!(2)).unwrap();
        set(&mut d, &parse_path("a[-1]"), json!(3)).unwrap();
        assert!(set(&mut d, &parse_path("a[9]"), json!(3)).unwrap_err().contains("out of range"));
        assert_eq!(d, json!({"a": [1, 3], "x": {"y": {"z": 1}}}));
        del(&mut d, &parse_path("a[0]")).unwrap();
        assert_eq!(del(&mut d, &parse_path("nope")).unwrap_err(), "path not found");
        let mut m = json!({"k": {"p": 1, "q": 2}, "z": 0});
        deep_merge(m.as_object_mut().unwrap(), json!({"k": {"q": 3, "r": 4}, "n": 1}).as_object().unwrap().clone());
        assert_eq!(dumps(&m, true, None), r#"{"k": {"p": 1, "q": 3, "r": 4}, "z": 0, "n": 1}"#);
    }

    #[test]
    fn python_dumps() {
        let v: Value = serde_json::from_str(r#"{"a":1.0,"b":[1e20,1e-5,0.5,123.456],"c":"é\n","d":{},"e":[]}"#).unwrap();
        let exp = r#"{"a": 1.0, "b": [1e+20, 1e-05, 0.5, 123.456], "c": "E\n", "d": {}, "e": []}"#.replace('E', &format!("\\u{}", "00e9"));
        assert_eq!(dumps(&v, true, None), exp);
        assert_eq!(dumps(&json!({"a": [1, 2]}), false, Some(" ")), "{\n \"a\": [\n  1,\n  2\n ]\n}");
        assert_eq!(py_float(1e16), "1e+16");
        assert_eq!(py_float(1234567890123456.0), "1234567890123456.0");
        assert_eq!(py_float(0.0001), "0.0001");
        assert_eq!(py_repr("it's"), "\"it's\"");
    }

    #[test]
    fn render_keeps_crlf() {
        let raw = "{\r\n  \"a\": 1\r\n}\r\n";
        let (d, k) = parse("x.json", raw).unwrap();
        assert_eq!(render(&d, &k, raw), raw);
        let (d, k) = parse("x.jsonl", "{\"a\":1}\r\n{\"a\":2}\r\n").unwrap();
        assert_eq!(render(&d, &k, "{\"a\":1}\r\n{\"a\":2}\r\n"), "{\"a\": 1}\r\n{\"a\": 2}\r\n");
    }

    #[test]
    fn render_keeps_indent() {
        let raw = "{\n    \"a\": 1\n}\n";
        let (mut d, k) = parse("x.json", raw).unwrap();
        set(&mut d, &parse_path("b"), json!("s")).unwrap();
        assert_eq!(render(&d, &k, raw), "{\n    \"a\": 1,\n    \"b\": \"s\"\n}\n");
        assert_eq!(render(&d, &k, "{\"a\":1}"), "{\"a\": 1, \"b\": \"s\"}");
        let (d, k) = parse("x.txt", "{\"a\":1}\n{\"a\":2}\n").unwrap();
        assert_eq!(k, Kind::Jsonl);
        assert_eq!(render(&d, &k, ""), "{\"a\": 1}\n{\"a\": 2}\n");
    }

    #[test]
    fn toml_order_and_dates() {
        let (d, k) = parse("c.toml", "z = 1\na = 1979-05-27T07:32:00Z\n[t]\ny = [1, 2]\n").unwrap();
        assert_eq!(k, Kind::Toml);
        assert_eq!(dumps(&d, true, None), r#"{"z": 1, "a": "1979-05-27T07:32:00Z", "t": {"y": [1, 2]}}"#);
    }

    #[test]
    fn shape_and_find() {
        let d = json!({"items": [{"id": 1, "tags": ["a"]}, {"id": 2.5, "x": null}], "n": "v"});
        let mut out = vec![];
        shape(&d, 0, 5, &mut out, false);
        assert_eq!(
            out.join("\n"),
            "items: arr[2]\n  [] items: obj, keys in 2 objs:\n    id: int|num\n    tags: arr (in 1/2)\n      [] items: str e.g. \"a\"\n    x: null (in 1/2)\nn: str = \"v\""
        );
        let rx = Regex::new("^(id|v)$").unwrap();
        assert_eq!(find(&d, &rx), vec!["items[0].id\tint", "items[1].id\tnum", "n\t= \"v\""]);
        assert!(get_str(&json!("x".repeat(4000)), false).ends_with("[1000 more chars; use --full or a narrower path]"));
    }
}
