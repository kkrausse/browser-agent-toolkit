//! Guest dependency preparation: stage the app's manifest and lock, install with Bun's
//! isolated linker, substitute packages per policy, prune what the guest never reads.
//! Bun stays the only installer; this module only decides overrides and removals.

use crate::pack::sha256_file;
use crate::policy::{name_matches, path_matches, Pinned, Policy};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TreeStats {
    pub files: u64,
    pub symlinks: u64,
    pub dirs: u64,
    pub bytes: u64,
}

pub fn tree_stats(root: &Path) -> Result<TreeStats> {
    let mut stats = TreeStats::default();
    visit(root, &mut |path, meta| {
        if meta.file_type().is_symlink() {
            stats.symlinks += 1;
        } else if meta.is_dir() {
            stats.dirs += 1;
        } else {
            stats.files += 1;
            stats.bytes += meta.len();
        }
        let _ = path;
        Ok(())
    })?;
    Ok(stats)
}

/// Depth-first visit of everything below `root` (not `root` itself), symlinks not followed.
fn visit(root: &Path, f: &mut dyn FnMut(&Path, &fs::Metadata) -> Result<()>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("read_dir {}", root.display()))? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let path = entry.path();
        f(&path, &meta)?;
        if meta.is_dir() {
            visit(&path, f)?;
        }
    }
    Ok(())
}

/// Bun's text lockfile is JSON with trailing commas.
pub fn parse_jsonc(text: &str) -> Result<Value> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            out.push(c);
            if c == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 1;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
            out.push(c);
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        } else if c == b',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if !matches!(bytes.get(j), Some(b'}') | Some(b']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    Ok(serde_json::from_slice(&out)?)
}

fn is_plain_version(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Versions at which `package` is locked.
fn locked_versions(lock: &Value, package: &str) -> BTreeSet<String> {
    let prefix = format!("{package}@");
    lock.get("packages")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|packages| packages.values())
        .filter_map(|entry| entry.get(0)?.as_str()?.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedSubstitution {
    pub package: String,
    pub version: String,
    #[serde(rename = "override")]
    pub override_value: String,
    /// Path of the installed replacement, relative to node_modules.
    pub installed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepsReport {
    pub installer: String,
    pub before: TreeStats,
    pub after: TreeStats,
    pub substitutions: Vec<AppliedSubstitution>,
    pub removed_packages: Vec<String>,
    pub removed_files: u64,
    pub removed_dangling_links: u64,
    pub install_ms: u64,
    pub prune_ms: u64,
}

pub struct Deps {
    pub node_modules: PathBuf,
    pub report: DepsReport,
}

pub fn run_bun(bun: &str, args: &[&str], cwd: &Path) -> Result<String> {
    let output = Command::new(bun)
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .output()
        .with_context(|| format!("spawn {bun}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        bail!("`{bun} {}` failed in {}:\n{text}", args.join(" "), cwd.display());
    }
    Ok(text)
}

/// Copy a directory tree: symlinks verbatim, modes kept, `node_modules` and `.git` skipped.
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(from).with_context(|| format!("stat {}", from.display()))?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    } else if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name();
            if name == "node_modules" || name == ".git" {
                continue;
            }
            copy_tree(&entry.path(), &to.join(name))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to).with_context(|| format!("copy {}", from.display()))?;
    }
    Ok(())
}

fn all_dependencies(pkg: &Value) -> impl Iterator<Item = (&String, &Value)> {
    ["dependencies", "devDependencies", "optionalDependencies"]
        .into_iter()
        .filter_map(|key| pkg.get(key)?.as_object())
        .flat_map(|map| map.iter())
}

/// Local directories (or tarballs) the app reaches through `file:` dependencies, transitively.
pub fn local_inputs(app: &Path) -> Result<Vec<PathBuf>> {
    fn collect(dir: &Path, app: &Path, seen: &mut Vec<PathBuf>) -> Result<()> {
        let text = fs::read_to_string(dir.join("package.json")).with_context(|| format!("read {}/package.json", dir.display()))?;
        let pkg: Value = serde_json::from_str(&text)?;
        for (name, value) in all_dependencies(&pkg) {
            let Some(rel) = value.as_str().and_then(|v| v.strip_prefix("file:")) else { continue };
            if rel.starts_with('/') {
                bail!("absolute file: dependency is not supported: {name}");
            }
            let source = dir.join(rel).canonicalize().with_context(|| format!("file: dependency {name} -> {rel}"))?;
            if app.starts_with(&source) {
                bail!("local dependency {name} contains the application");
            }
            if seen.contains(&source) {
                continue;
            }
            seen.push(source.clone());
            if source.is_dir() {
                collect(&source, app, seen)?;
            }
        }
        Ok(())
    }
    let mut seen = Vec::new();
    collect(app, app, &mut seen)?;
    Ok(seen)
}

/// Real package directories in an isolated-linker tree: `.bun/<id>/node_modules/<name>`.
fn package_roots(node_modules: &Path) -> Result<Vec<(PathBuf, PathBuf)>> {
    let store = node_modules.join(".bun");
    let mut roots = Vec::new();
    if !store.is_dir() {
        return Ok(roots);
    }
    for id in fs::read_dir(&store)? {
        let id = id?.path();
        let inner = id.join("node_modules");
        if !inner.is_dir() || fs::symlink_metadata(&id)?.file_type().is_symlink() {
            continue;
        }
        for entry in fs::read_dir(&inner)? {
            let entry = entry?;
            let ft = entry.file_type()?;
            if ft.is_dir() && entry.file_name().to_string_lossy().starts_with('@') {
                for scoped in fs::read_dir(entry.path())? {
                    let scoped = scoped?;
                    if scoped.file_type()?.is_dir() {
                        roots.push((id.clone(), scoped.path()));
                    }
                }
            } else if ft.is_dir() && entry.file_name() != ".bin" {
                roots.push((id.clone(), entry.path()));
            }
        }
    }
    roots.sort();
    Ok(roots)
}

fn restricts_platform(pkg: &Value) -> bool {
    let list = |key: &str| -> Vec<String> {
        match pkg.get(key) {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            Some(Value::String(s)) => vec![s.clone()],
            _ => vec![],
        }
    };
    let (os, cpu) = (list("os"), list("cpu"));
    if cpu.iter().any(|c| c == "wasm32") {
        return false;
    }
    // A list made only of exclusions (`!win32`) does not tie the package to a platform.
    let positive = |l: &[String]| l.iter().any(|v| !v.starts_with('!') && v != "any" && v != "*");
    positive(&os) || positive(&cpu)
}

pub struct DepsOptions<'a> {
    pub app: &'a Path,
    pub work: &'a Path,
    pub policy: &'a Policy,
    pub bun: &'a str,
    /// Verified application files; copies of these inside packages are removed.
    pub application_files: &'a [(String, Pinned)],
}

pub fn prepare(options: DepsOptions) -> Result<Deps> {
    let DepsOptions { app, work, policy, bun, application_files } = options;
    let app = app.canonicalize().with_context(|| format!("app directory {}", app.display()))?;
    let manifest = fs::read_to_string(app.join("package.json")).context("read package.json")?;
    let lock_text = fs::read_to_string(app.join("bun.lock")).context("read bun.lock (text lockfile required)")?;
    let pkg: Value = serde_json::from_str(&manifest).context("parse package.json")?;
    let lock = parse_jsonc(&lock_text).context("parse bun.lock")?;
    if pkg.get("workspaces").is_some() {
        bail!("workspace-root preparation is not supported");
    }

    // Stage under the app's absolute path so relative `file:` references keep working.
    let tree = work.join("tree");
    if tree.exists() {
        fs::remove_dir_all(&tree)?;
    }
    let mirror = |path: &Path| tree.join(path.strip_prefix("/").unwrap_or(path));
    let stage = mirror(&app);
    fs::create_dir_all(&stage)?;
    for input in local_inputs(&app)? {
        copy_tree(&input, &mirror(&input))?;
    }
    fs::write(stage.join("package.json"), &manifest)?;
    fs::write(stage.join("bun.lock"), &lock_text)?;

    let cache = work.join("bun-cache");
    let cache = cache.to_string_lossy();
    let started = Instant::now();
    let installer = format!("bun {}", run_bun(bun, &["--version"], &stage)?.trim());
    // 1. The project's own lock, frozen: proves the lock matches the manifest.
    run_bun(bun, &["install", "--linker", "isolated", "--frozen-lockfile", "--ignore-scripts", "--cache-dir", &cache], &stage)?;

    // 2. Overrides from the policy table, then let Bun re-resolve.
    let mut overrides: Map<String, Value> = pkg.get("overrides").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut applied = Vec::new();
    for sub in &policy.substitutions {
        let versions = locked_versions(&lock, &sub.package);
        let Some(version) = versions.iter().next().cloned() else { continue };
        if versions.len() > 1 {
            bail!("multiple locked versions of {}: a root override cannot preserve them", sub.package);
        }
        if !is_plain_version(&version) {
            bail!("unsupported locked version {}@{version}", sub.package);
        }
        let value = if let Some(dir) = sub.with.strip_prefix("dir:") {
            let source = policy.base.as_deref().unwrap_or(Path::new(".")).join(dir);
            let name = sub.package.replace(['/', '@'], "_");
            copy_tree(&source, &stage.join(".bat-shims").join(&name))
                .with_context(|| format!("shim package for {}", sub.package))?;
            format!("file:.bat-shims/{name}")
        } else {
            sub.with.replace("{version}", &version)
        };
        if let Some(existing) = overrides.get(&sub.package) {
            if existing.as_str() != Some(&value) {
                bail!("project override for {} conflicts with the guest policy", sub.package);
            }
        }
        overrides.insert(sub.package.clone(), Value::String(value.clone()));
        applied.push(AppliedSubstitution { package: sub.package.clone(), version, override_value: value, installed: None });
    }
    let mut derived = pkg.clone();
    if !overrides.is_empty() {
        derived.as_object_mut().ok_or_else(|| anyhow!("package.json is not an object"))?.insert("overrides".into(), Value::Object(overrides));
    }
    let derived_manifest = serde_json::to_string_pretty(&derived)? + "\n";
    fs::write(stage.join("package.json"), &derived_manifest)?;
    run_bun(bun, &["install", "--linker", "isolated", "--ignore-scripts", "--cache-dir", &cache], &stage)?;
    let install_ms = started.elapsed().as_millis() as u64;

    let node_modules = stage.join("node_modules");
    let before = tree_stats(&node_modules)?;
    let prune_started = Instant::now();

    // Installed replacements must carry their payload.
    let roots = package_roots(&node_modules)?;
    let mut packages = Vec::new();
    for (id, root) in &roots {
        let Ok(text) = fs::read_to_string(root.join("package.json")) else { continue };
        let Ok(json) = serde_json::from_str::<Value>(&text) else { continue };
        let name = json.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let version = json.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
        packages.push((id.clone(), root.clone(), name, version, json));
    }
    for applied in applied.iter_mut() {
        let sub = policy.substitutions.iter().find(|s| s.package == applied.package).expect("applied from policy");
        let installed_name = match applied.override_value.strip_prefix("npm:") {
            Some(alias) => alias.rsplit_once('@').map(|(n, _)| n).unwrap_or(alias).to_string(),
            None => sub.package.clone(),
        };
        let found = packages.iter().find(|(_, root, name, _, _)| {
            *name == installed_name && sub.expect.as_ref().is_none_or(|file| root.join(file).is_file())
        });
        let Some((_, root, ..)) = found else {
            bail!("substitution for {} did not install {installed_name}{}", sub.package,
                sub.expect.as_ref().map(|f| format!(" with {f}")).unwrap_or_default());
        };
        applied.installed = Some(root.strip_prefix(&node_modules)?.to_string_lossy().into_owned());
    }

    // 3. Prune.
    let mut removed_packages = Vec::new();
    let mut removed_files = 0u64;
    let mut touched: BTreeSet<PathBuf> = BTreeSet::new();
    let pruned_name = |name: &str| policy.prune.packages.iter().any(|p| name_matches(p, name));
    for (id, _root, name, version, json) in &packages {
        let remove = pruned_name(name) || (policy.prune.native_packages && restricts_platform(json));
        if remove && id.exists() {
            fs::remove_dir_all(id)?;
            touched.insert(id.clone());
            removed_packages.push(format!("{name}@{version}"));
        }
    }
    let mut doomed = Vec::new();
    visit(&node_modules, &mut |path, meta| {
        if !meta.is_file() {
            return Ok(());
        }
        let rel = path.strip_prefix(&node_modules)?.to_string_lossy();
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        let mut remove = policy.prune.extensions.iter().any(|ext| name.ends_with(ext.as_str()))
            || policy.prune.paths.iter().any(|p| path_matches(p, &rel));
        if !remove && policy.prune.duplicates_of_application {
            for (_, pinned) in application_files {
                if meta.len() == pinned.bytes && sha256_file(path)? == pinned.sha256 {
                    remove = true;
                }
            }
        }
        if remove {
            doomed.push(path.to_path_buf());
        }
        Ok(())
    })?;
    for path in doomed {
        fs::remove_file(&path)?;
        removed_files += 1;
        touched.insert(path);
    }
    // Links into removed packages now dangle; removing one can orphan another.
    let mut removed_dangling_links = 0u64;
    loop {
        let mut dangling = Vec::new();
        visit(&node_modules, &mut |path, meta| {
            if meta.file_type().is_symlink() && fs::metadata(path).is_err() {
                dangling.push(path.to_path_buf());
            }
            Ok(())
        })?;
        if dangling.is_empty() {
            break;
        }
        for path in dangling {
            fs::remove_file(&path)?;
            removed_dangling_links += 1;
            touched.insert(path);
        }
    }
    // Directories emptied by the removals above.
    for path in &touched {
        let mut dir = path.parent();
        while let Some(d) = dir {
            if d == node_modules || !d.starts_with(&node_modules) || fs::remove_dir(d).is_err() {
                break; // not empty (or already gone)
            }
            dir = d.parent();
        }
    }

    // Every direct dependency the policy did not prune must still resolve.
    for (name, _) in all_dependencies(&pkg) {
        if pruned_name(name) {
            continue;
        }
        if !node_modules.join(name).join("package.json").is_file() {
            // Optional platform packages may legitimately be absent.
            if pkg.get("optionalDependencies").and_then(|o| o.get(name)).is_some() {
                continue;
            }
            bail!("required dependency {name} is missing from the guest tree");
        }
    }
    let after = tree_stats(&node_modules)?;
    removed_packages.sort();
    Ok(Deps {
        node_modules,
        report: DepsReport {
            installer, before, after, substitutions: applied, removed_packages, removed_files, removed_dangling_links,
            install_ms, prune_ms: prune_started.elapsed().as_millis() as u64,
        },
    })
}

/// Install the application's support packages (ripgrep) from the pinned manifest and lock.
pub fn prepare_support(work: &Path, manifest: &Value, lock: &Value, expect: &[String], bun: &str) -> Result<PathBuf> {
    let dir = work.join("support");
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    let lock_text = serde_json::to_string(lock)?;
    fs::write(dir.join("package.json"), serde_json::to_string(manifest)?)?;
    fs::write(dir.join("bun.lock"), &lock_text)?;
    let cache = work.join("bun-cache");
    run_bun(bun, &["install", "--linker", "isolated", "--frozen-lockfile", "--ignore-scripts", "--cache-dir", &cache.to_string_lossy()], &dir)?;
    if fs::read_to_string(dir.join("bun.lock"))? != lock_text {
        bail!("frozen support lock changed");
    }
    let node_modules = dir.join("node_modules");
    for file in expect {
        if fs::metadata(node_modules.join(file)).is_err() {
            bail!("support package file missing: {file}");
        }
    }
    Ok(node_modules)
}

