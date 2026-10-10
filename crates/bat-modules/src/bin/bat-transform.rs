//! Command-line front end, for the reference harness and for measuring.
//!
//!   bat-transform FILE [--type module|commonjs] [--map] [--json]
//!   bat-transform --bench DIR_OR_FILE [--threads N] [--repeat N]
//!
//! Without `--json` the transformed code goes to stdout and facts and
//! diagnostics to stderr. `--bench` transforms every module file under a tree
//! (reading each nearest package.json for `type`), in parallel, and reports
//! wall time for the transform alone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use bat_modules::{flags, transform, Facts, ModuleKind, Options, PackageType, Severity};

fn package_type_of(dir: &Path, cache: &mut HashMap<PathBuf, PackageType>) -> PackageType {
    if let Some(found) = cache.get(dir) {
        return *found;
    }
    let found = match std::fs::read_to_string(dir.join("package.json")) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(json) => match json.get("type").and_then(|t| t.as_str()) {
                Some("module") => PackageType::Module,
                Some("commonjs") => PackageType::CommonJs,
                _ => PackageType::None,
            },
            Err(_) => PackageType::None,
        },
        // Node stops at a node_modules boundary; so do we.
        Err(_) => match dir.parent() {
            Some(parent) if dir.file_name().is_some_and(|n| n != "node_modules") => {
                package_type_of(parent, cache)
            }
            _ => PackageType::None,
        },
    };
    cache.insert(dir.to_owned(), found);
    found
}

fn is_module_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".d.ts") || name.ends_with(".d.mts") || name.ends_with(".d.cts") {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" | "json")
    )
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            walk(&path, out);
        } else if kind.is_file() && is_module_file(&path) {
            out.push(path);
        }
    }
}

fn facts_json(facts: &Facts) -> serde_json::Value {
    serde_json::json!({
        "word": facts.word(),
        "kind": match facts.kind {
            ModuleKind::CommonJs => "cjs",
            ModuleKind::Esm => "esm",
            ModuleKind::Json => "json",
            ModuleKind::Unknown => "unknown",
        },
        "async": facts.is_async(),
        "imports": facts.imports,
        "dynamicImports": facts.dynamic_imports,
        "requires": facts.requires,
        "exports": facts.exports,
        "reexports": facts.reexports,
    })
}

fn bench(root: &Path, threads: usize, repeat: usize) {
    let mut files = Vec::new();
    if root.is_dir() {
        walk(root, &mut files);
    } else {
        files.push(root.to_owned());
    }
    files.sort();
    let mut cache = HashMap::new();
    let read_start = Instant::now();
    let inputs: Vec<(String, String, PackageType)> = files
        .iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(path).ok()?;
            let package_type = package_type_of(path.parent()?, &mut cache);
            Some((path.to_string_lossy().into_owned(), text, package_type))
        })
        .collect();
    let bytes: usize = inputs.iter().map(|i| i.1.len()).sum();
    eprintln!(
        "read {} files, {:.1} MB in {:.2?}",
        inputs.len(),
        bytes as f64 / 1e6,
        read_start.elapsed()
    );

    for round in 0..repeat {
        let next = AtomicUsize::new(0);
        let counts = Mutex::new((0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize));
        let failures = Mutex::new(Vec::new());
        let start = Instant::now();
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| {
                    let (mut cjs, mut esm, mut json, mut tla, mut same, mut out_bytes, mut blob) =
                        (0, 0, 0, 0, 0, 0, 0);
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((name, text, package_type)) = inputs.get(i) else { break };
                        let options = Options { package_type: *package_type, ..Options::default() };
                        let output = transform(text, name, &options);
                        if !output.ok() {
                            let d = output
                                .diagnostics
                                .iter()
                                .find(|d| d.severity == Severity::Error)
                                .unwrap();
                            failures.lock().unwrap().push(format!(
                                "{name}:{}:{}: {}",
                                d.line, d.column, d.message
                            ));
                            continue;
                        }
                        match output.facts.kind {
                            ModuleKind::CommonJs => cjs += 1,
                            ModuleKind::Esm => esm += 1,
                            ModuleKind::Json => json += 1,
                            ModuleKind::Unknown => {}
                        }
                        tla += output.facts.is_async() as usize;
                        same += output.facts.has(flags::CODE_IS_SOURCE) as usize;
                        out_bytes += output.code.len();
                        blob += output.facts.encode_blob().len();
                    }
                    let mut total = counts.lock().unwrap();
                    total.0 += cjs;
                    total.1 += esm;
                    total.2 += json;
                    total.3 += tla;
                    total.4 += same;
                    total.5 += out_bytes;
                    total.6 += blob;
                });
            }
        });
        let elapsed = start.elapsed();
        let (cjs, esm, json, tla, same, out_bytes, blob) = *counts.lock().unwrap();
        let failures = failures.into_inner().unwrap();
        eprintln!(
            "round {round}: {elapsed:.3?} on {threads} threads: {cjs} cjs ({same} unchanged), {esm} esm ({tla} async), {json} json, {} failed; out {:.1} MB, facts blobs {:.1} kB",
            failures.len(),
            out_bytes as f64 / 1e6,
            blob as f64 / 1e3,
        );
        if round == 0 {
            for failure in failures.iter().take(40) {
                eprintln!("  FAIL {failure}");
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
    };
    let has = |flag: &str| args.iter().any(|a| a == flag);

    if let Some(root) = value("--bench") {
        let threads = value("--threads")
            .and_then(|t| t.parse().ok())
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()));
        let repeat = value("--repeat").and_then(|t| t.parse().ok()).unwrap_or(1);
        bench(Path::new(&root), threads, repeat);
        return;
    }

    let Some(file) = args.iter().find(|a| !a.starts_with("--") && value("--type").as_ref() != Some(a))
    else {
        eprintln!("usage: bat-transform FILE [--type module|commonjs] [--map] [--json] | --bench DIR");
        std::process::exit(2);
    };
    let path = Path::new(file);
    let source = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("{file}: {e}");
        std::process::exit(2);
    });
    let package_type = match value("--type").as_deref() {
        Some("module") => PackageType::Module,
        Some("commonjs") => PackageType::CommonJs,
        Some("none") => PackageType::None,
        _ => package_type_of(path.parent().unwrap_or(Path::new(".")), &mut HashMap::new()),
    };
    let options = Options { package_type, source_map: has("--map"), ..Options::default() };
    let start = Instant::now();
    let output = transform(&source, file, &options);
    let elapsed = start.elapsed();

    if has("--json") {
        let diagnostics: Vec<_> = output
            .diagnostics
            .iter()
            .map(|d| {
                serde_json::json!({
                    "severity": if d.severity == Severity::Error { "error" } else { "warning" },
                    "message": d.message, "line": d.line, "column": d.column,
                })
            })
            .collect();
        let json = serde_json::json!({
            "ok": output.ok(),
            "code": output.code,
            "facts": facts_json(&output.facts),
            "map": output.map,
            "diagnostics": diagnostics,
        });
        println!("{json}");
        return;
    }
    for d in &output.diagnostics {
        eprintln!("{file}:{}:{}: {:?}: {}", d.line, d.column, d.severity, d.message);
    }
    eprintln!("{} ({elapsed:.2?})", facts_json(&output.facts));
    if let Some(map) = &output.map {
        eprintln!("map: {map}");
    }
    print!("{}", output.code);
    if !output.ok() {
        std::process::exit(1);
    }
}
