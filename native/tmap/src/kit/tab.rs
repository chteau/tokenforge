//! `tmap kit tab`: SQL over CSV / TSV / JSON-array / JSONL files via in-memory sqlite.

use super::jx::{dumps, py_float};
use super::util::die;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::Value;

const HELP: &str = "SQL over CSV / TSV / JSON-array / JSONL files, via in-memory sqlite.

  tmap kit tab FILE                     columns + inferred types, row count, 3 sample rows
  tmap kit tab FILE 'SQL'               run SQL; the table is named t (more files: t, t2, t3 ...)
  tmap kit tab A.csv B.jsonl 'SQL'      several files
  tmap kit tab --all FILE 'SQL'         print every row (default cap 50)

Numbers are stored as numbers. Nested JSON values are stored as JSON text
(query them with json_extract). Output is tab-separated with a header.
";

fn fail(m: &str) -> ! {
    die("tab", m, 2)
}

/// Python `int(s)` with whitespace and digit-separating underscores.
fn py_int(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let body = s.trim_start_matches(['+', '-']);
    if body.is_empty() || body.starts_with('_') || body.ends_with('_') || body.contains("__") {
        return None;
    }
    if !b.iter().all(|c| c.is_ascii_digit() || matches!(c, b'_' | b'+' | b'-')) {
        return None;
    }
    s.replace('_', "").parse().ok()
}

/// CSV cell -> number when it parses as int then float; "" -> NULL.
pub fn num(v: &str) -> Sql {
    let s = v.trim();
    if let Some(i) = py_int(s) {
        return Sql::Integer(i);
    }
    match super::tally::py_float_parse(s) {
        Some(f) if f.is_nan() => Sql::Null,
        Some(f) => Sql::Real(f),
        None if s.is_empty() => Sql::Null,
        None => Sql::Text(v.to_string()),
    }
}

fn json_cell(v: Option<&Value>) -> Sql {
    match v {
        None | Some(Value::Null) => Sql::Null,
        Some(Value::Bool(b)) => Sql::Integer(*b as i64),
        Some(Value::Number(n)) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(s)) => Sql::Text(s.clone()),
        Some(v) => Sql::Text(dumps(v, true, None)),
    }
}

/// Python csv.reader (excel dialect, strict=False) over newline-normalized text.
pub fn csv_rows(raw: &str, delim: char) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut f) = (vec![], vec![], String::new());
    let (mut inq, mut started, mut after_q) = (false, false, false);
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        if inq {
            if c == '"' {
                if it.peek() == Some(&'"') {
                    it.next();
                    f.push('"');
                } else {
                    inq = false;
                    after_q = true;
                }
            } else {
                f.push(c);
            }
            continue;
        }
        match c {
            '"' if !started && !after_q => {
                inq = true;
                started = true;
            }
            c if c == delim => {
                row.push(std::mem::take(&mut f));
                started = false;
                after_q = false;
            }
            '\n' => {
                if started || after_q || !row.is_empty() || !f.is_empty() {
                    row.push(std::mem::take(&mut f));
                }
                rows.push(std::mem::take(&mut row));
                started = false;
                after_q = false;
            }
            c => {
                f.push(c);
                started = true;
            }
        }
    }
    if started || after_q || !row.is_empty() || !f.is_empty() || inq {
        row.push(f);
        rows.push(row);
    }
    rows
}

/// Columns and rows of one file, with the original's format detection.
pub fn rows_of(f: &str, raw: &str) -> Result<(Vec<String>, Vec<Vec<Sql>>), String> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw).replace("\r\n", "\n").replace('\r', "\n");
    let st = raw.trim_start().chars().next();
    let recs: Vec<Value> = if f.ends_with(".jsonl") || f.ends_with(".ndjson") || (st == Some('{') && raw.contains("\n{")) {
        raw.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect::<Result<_, _>>().map_err(|e| e.to_string())?
    } else if matches!(st, Some('[') | Some('{')) {
        match serde_json::from_str(&raw).map_err(|e| e.to_string())? {
            Value::Array(a) => a,
            v => vec![v],
        }
    } else {
        let first = raw.split('\n').next().unwrap_or("");
        let tsv = f.ends_with(".tsv") || first.matches('\t').count() > first.matches(',').count();
        let r = csv_rows(&raw, if tsv { '\t' } else { ',' });
        let Some(head) = r.first() else { return Ok((vec![], vec![])) };
        let cols: Vec<String> = head.iter().enumerate().map(|(i, c)| if c.trim().is_empty() { format!("c{i}") } else { c.trim().to_string() }).collect();
        let rows = r[1..]
            .iter()
            .filter(|row| !row.is_empty())
            .map(|row| {
                let mut v: Vec<Sql> = row.iter().map(|x| num(x)).collect();
                v.resize(cols.len().max(v.len()), Sql::Null);
                v.truncate(cols.len());
                v
            })
            .collect();
        return Ok((cols, rows));
    };
    let mut cols: Vec<String> = vec![];
    for x in &recs {
        let ks: Vec<String> = match x {
            Value::Object(m) => m.keys().cloned().collect(),
            _ => vec!["value".into()],
        };
        for k in ks {
            if !cols.contains(&k) {
                cols.push(k);
            }
        }
    }
    let rows = recs
        .iter()
        .map(|x| match x {
            Value::Object(m) => cols.iter().map(|k| json_cell(m.get(k))).collect(),
            v => cols.iter().map(|k| json_cell((k == "value").then_some(v))).collect(),
        })
        .collect();
    Ok((cols, rows))
}

fn ident(c: &str) -> String {
    dumps(&Value::String(c.into()), true, None)
}

/// Python `str()` of a sqlite value.
fn cell(v: ValueRef) -> String {
    match v {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => py_float(f),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => format!("b{}", super::jx::py_repr(&String::from_utf8_lossy(b))),
    }
}

/// Load `f` as table `name`; returns the row count.
pub fn load(db: &Connection, name: &str, f: &str, raw: &str) -> Result<(Vec<String>, usize), String> {
    let (cols, rows) = rows_of(f, raw).map_err(|e| format!("{f}: {e}"))?;
    if cols.is_empty() {
        return Err(format!("{f}: empty"));
    }
    let defs: Vec<String> = cols.iter().map(|c| ident(c)).collect();
    db.execute(&format!("create table {name} ({})", defs.join(", ")), []).map_err(|e| format!("{f}: {e}"))?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut st = tx.prepare(&format!("insert into {name} values ({})", vec!["?"; cols.len()].join(","))).map_err(|e| e.to_string())?;
        for r in &rows {
            st.execute(params_from_iter(r.iter())).map_err(|e| format!("{f}: {e}"))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((cols, rows.len()))
}

/// Summary lines: columns with sqlite types, then 3 sample rows.
pub fn summary(db: &Connection, name: &str, f: &str, cols: &[String], n: usize) -> Result<Vec<String>, rusqlite::Error> {
    let mut types = vec![];
    for c in cols {
        let mut st = db.prepare(&format!("select distinct typeof({}) from {name}", ident(c)))?;
        let ts: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        types.push(format!("{c}:{}", ts.join("|")));
    }
    let mut out = vec![format!("{name} <- {f}: {n} rows\n  {}", types.join(", "))];
    let mut st = db.prepare(&format!("select * from {name} limit 3"))?;
    let nc = st.column_count();
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let cells: Vec<String> = (0..nc).map(|i| cell(r.get_ref(i).unwrap()).chars().take(40).collect()).collect();
        out.push(format!("  {}", cells.join("\t")));
    }
    Ok(out)
}

/// Run one statement: "ok" for no result columns, else a TSV with header capped at `cap` rows.
pub fn query(db: &Connection, sql: &str, cap: Option<usize>) -> Result<Vec<String>, rusqlite::Error> {
    let mut st = db.prepare(sql)?;
    let nc = st.column_count();
    let head = st.column_names().join("\t");
    let mut rows = st.query([])?;
    if nc == 0 {
        while rows.next()?.is_some() {}
        return Ok(vec!["ok".into()]);
    }
    let mut out = vec![head];
    let mut n = 0;
    while let Some(r) = rows.next()? {
        if let Some(c) = cap.filter(|c| n >= *c) {
            out.push(format!("… more rows (cap {c}; --all or LIMIT)"));
            break;
        }
        out.push((0..nc).map(|i| cell(r.get_ref(i).unwrap())).collect::<Vec<_>>().join("\t"));
        n += 1;
    }
    Ok(out)
}

/// sqlite's own message, without rusqlite's "in SQL at offset N" suffix.
fn sql_err(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqlInputError { msg, .. } => msg,
        rusqlite::Error::SqliteFailure(_, Some(m)) => m,
        e => e.to_string(),
    }
}

pub fn main(args: Vec<String>) -> i32 {
    let mut a = args;
    if a.is_empty() || a[0] == "-h" || a[0] == "--help" {
        println!("{HELP}");
        return if a.is_empty() { 2 } else { 0 };
    }
    let mut cap = Some(50);
    if a[0] == "--all" {
        cap = None;
        a.remove(0);
    }
    let sql = (a.len() >= 2 && !std::path::Path::new(a.last().unwrap()).exists()).then(|| a.pop().unwrap());
    if a.is_empty() {
        fail("no file");
    }
    let db = Connection::open_in_memory().unwrap_or_else(|e| fail(&e.to_string()));
    for (i, f) in a.iter().enumerate() {
        let name = if i == 0 { "t".to_string() } else { format!("t{}", i + 1) };
        let raw = std::fs::read(f).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|e| fail(&format!("{f}: {e}")));
        super::util::note_raw(raw.len());
        let (cols, n) = load(&db, &name, f, &raw).unwrap_or_else(|e| fail(&e));
        if sql.is_none() {
            let out = summary(&db, &name, f, &cols, n).unwrap_or_else(|e| fail(&format!("SQL: {}", sql_err(e))));
            println!("{}", out.join("\n"));
        }
    }
    if let Some(q) = sql {
        let out = query(&db, &q, cap).unwrap_or_else(|e| fail(&format!("SQL: {}", sql_err(e))));
        println!("{}", out.join("\n"));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with(f: &str, raw: &str) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        load(&db, "t", f, raw).unwrap();
        db
    }

    #[test]
    fn inference() {
        assert_eq!(num(" 12 "), Sql::Integer(12));
        assert_eq!(num("1_000"), Sql::Integer(1000));
        assert_eq!(num("1.5e3"), Sql::Real(1500.0));
        assert_eq!(num(""), Sql::Null);
        assert_eq!(num("abc"), Sql::Text("abc".into()));
        assert_eq!(num("0x10"), Sql::Text("0x10".into()));
    }

    #[test]
    fn csv_parsing() {
        assert_eq!(csv_rows("a,\"b,c\",\"d\"\"e\"\n\n1,2\n", ','), vec![vec!["a", "b,c", "d\"e"], vec![], vec!["1", "2"]]);
        assert_eq!(csv_rows("\"multi\nline\",x", ','), vec![vec!["multi\nline", "x"]]);
        assert_eq!(csv_rows(",\n", ','), vec![vec!["", ""]]);
    }

    #[test]
    fn csv_summary_and_sql() {
        let db = db_with("x.csv", "name,age, \nbob,30,1.5\nann,,x\ncid,7\n");
        let s = summary(&db, "t", "x.csv", &["name".into(), "age".into(), "c2".into()], 3).unwrap();
        assert_eq!(s[0], "t <- x.csv: 3 rows\n  name:text, age:integer|null, c2:real|text|null");
        assert_eq!(s[1], "  bob\t30\t1.5");
        assert_eq!(query(&db, "select name, age*2 a from t order by name", None).unwrap(), vec!["name\ta", "ann\t", "bob\t60", "cid\t14"]);
        assert_eq!(query(&db, "select * from t", Some(1)).unwrap()[2], "… more rows (cap 1; --all or LIMIT)");
        assert_eq!(query(&db, "create table z (a)", None).unwrap(), vec!["ok"]);
        assert!(query(&db, "select * from nope", None).unwrap_err().to_string().contains("no such table"));
    }

    #[test]
    fn json_and_jsonl() {
        let db = db_with("x.json", r#"[{"a": 1, "b": {"c": [1, 2]}}, {"a": 2.5, "d": true}, 3]"#);
        assert_eq!(
            query(&db, "select a, b, d, value, json_extract(b, '$.c[1]') from t", None).unwrap(),
            vec!["a\tb\td\tvalue\tjson_extract(b, '$.c[1]')", "1\t{\"c\": [1, 2]}\t\t\t2", "2.5\t\t1\t\t", "\t\t\t3\t"]
        );
        let db = db_with("x.txt", "{\"k\": \"x\"}\n{\"k\": \"y\"}\n");
        assert_eq!(query(&db, "select count(*) n from t", None).unwrap(), vec!["n", "2"]);
        assert!(rows_of("x.json", "[1,").is_err());
    }

    #[test]
    fn tsv_detection() {
        let (cols, rows) = rows_of("x.txt", "a\tb\n1\t2\n").unwrap();
        assert_eq!(cols, vec!["a", "b"]);
        assert_eq!(rows[0], vec![Sql::Integer(1), Sql::Integer(2)]);
    }
}
