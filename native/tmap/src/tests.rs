use crate::index::{self, Index, NONE};
use crate::query::{self, FindOpts};
use std::fs;
use std::path::PathBuf;

fn fixture(files: &[(&str, &str)]) -> (PathBuf, Index) {
    let dir = std::env::temp_dir().join(format!("tmap-test-{}-{}", std::process::id(), rand_suffix()));
    for (p, body) in files {
        let path = dir.join(p);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    std::env::set_var("TMAP_CACHE_DIR", dir.join(".tmap-cache"));
    let (idx, _) = index::refresh(&dir, true).unwrap();
    (dir, idx)
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

const RUST: &str = r#"
/// A stack of layers.
pub struct LayerStack {
    layers: Vec<Layer>,
}

impl LayerStack {
    pub fn add_layer(&mut self, layer: Layer) -> usize {
        self.layers.push(layer);
        clamp_opacity(1.0);
        self.layers.len()
    }
}

pub fn clamp_opacity(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

const MAX_LAYERS: usize = 64;
"#;

#[test]
fn words_split_identifiers() {
    assert_eq!(query::words("parseHTTPHeader2"), ["parse", "http", "header", "2"]);
    assert_eq!(query::words("add_layer"), ["add", "layer"]);
    assert_eq!(query::words("LayerStack::new"), ["layer", "stack", "new"]);
}

#[test]
fn rust_definitions_nesting_and_signatures() {
    let (_, idx) = fixture(&[("src/layers.rs", RUST)]);
    let f = &idx.files[0];
    let get = |n: &str| f.syms.iter().position(|s| s.name == n).unwrap_or_else(|| panic!("missing {n}"));
    let stack = &f.syms[get("LayerStack")];
    assert_eq!((stack.kind.as_str(), stack.start, stack.end), ("struct", 3, 5));
    let add = &f.syms[get("add_layer")];
    assert_eq!(add.kind, "method");
    assert_eq!(add.sig, "pub fn add_layer(&mut self, layer: Layer) -> usize");
    assert_eq!(f.syms[add.parent as usize].kind, "impl");
    assert_eq!(f.syms[get("clamp_opacity")].parent, NONE);
    assert_eq!(f.syms[get("MAX_LAYERS")].kind, "constant");
    let call = f.calls.iter().find(|c| c.name == "clamp_opacity").expect("call recorded");
    assert_eq!(f.syms[call.from as usize].name, "add_layer");
}

#[test]
fn find_ranks_name_matches_and_ignores_substrings_inside_words() {
    let (_, idx) = fixture(&[
        ("src/layers.rs", RUST),
        ("src/camera.rs", "pub fn orthographic_view(model: u32) -> u32 { model }\n"),
        ("vendor/lib/layers.rs", "pub fn add_layer() {}\n"),
    ]);
    let o = FindOpts { limit: 5, kind: None, within: None };
    let out = query::find(&idx, &["add layer".to_string()], &o);
    let first = out.lines().next().unwrap();
    assert!(first.starts_with("src/layers.rs:"), "own code first, got:\n{out}");
    assert!(out.contains("vendor/lib/layers.rs"), "vendor still listed, lower");
    let none = query::find(&idx, &["graph".to_string(), "mode".to_string()], &o);
    assert!(!none.contains("orthographic"), "graph must not match inside orthographic:\n{none}");
}

#[test]
fn typescript_python_go_are_indexed() {
    let (_, idx) = fixture(&[
        ("web/history.ts", "export class History {\n  undo(): boolean {\n    return true;\n  }\n}\nexport function createHistory(): History {\n  return new History();\n}\n"),
        ("py/filters.py", "class Blur:\n    def apply(self, img):\n        return box(img)\n\ndef box(img):\n    return img\n"),
        ("go/main.go", "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n"),
    ]);
    let names = |p: &str| idx.files.iter().find(|f| f.path == p).unwrap().syms.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
    assert!(names("web/history.ts").contains(&"undo".to_string()));
    assert!(names("web/history.ts").contains(&"createHistory".to_string()));
    let py = idx.files.iter().find(|f| f.path == "py/filters.py").unwrap();
    let apply = py.syms.iter().find(|s| s.name == "apply").unwrap();
    assert_eq!(apply.sig, "def apply(self, img)");
    assert_eq!(py.syms[apply.parent as usize].name, "Blur");
    assert!(names("go/main.go").contains(&"Start".to_string()));
}

#[test]
fn skips_dependency_dirs_and_refreshes_incrementally() {
    let (dir, idx) = fixture(&[("src/a.ts", "export function a() {}\n"), ("node_modules/x/index.js", "function x() {}\n"), ("dist/b.js", "function b() {}\n")]);
    assert_eq!(idx.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["src/a.ts"]);
    fs::write(dir.join("src/c.ts"), "export function c() {}\n").unwrap();
    let (idx2, stats) = index::refresh(&dir, false).unwrap();
    assert_eq!(stats.parsed, 1, "only the new file is parsed");
    assert_eq!(idx2.files.len(), 2);
    fs::remove_file(dir.join("src/a.ts")).unwrap();
    let (idx3, stats) = index::refresh(&dir, false).unwrap();
    assert_eq!((stats.parsed, stats.removed, idx3.files.len()), (0, 1, 1));
}

#[test]
fn tree_slice_and_callers() {
    let (_, idx) = fixture(&[("src/layers.rs", RUST), ("src/ui/panel.rs", "pub fn draw() { clamp_opacity(0.5); }\n")]);
    let t = query::tree(&idx, "", 3);
    assert!(t.contains("layers.rs: LayerStack{1}, clamp_opacity(), MAX_LAYERS"), "{t}");
    assert!(t.contains("    ui/\n      panel.rs: draw()"), "{t}");
    assert_eq!(query::slice(&idx, "clamp_opacity"), "src/layers.rs:15-17\n");
    let c = query::callers(&idx, "clamp_opacity", 40);
    assert!(c.contains("src/layers.rs:10  in method add_layer") && c.contains("src/ui/panel.rs:1  in function draw"), "{c}");
}
