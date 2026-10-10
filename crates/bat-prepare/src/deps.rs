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
    /// The app is a member of a Bun workspace; its install was relocated.
    pub workspace: bool,
    /// Tree as installed for the guest (substitutions applied), before pruning.
    pub before: TreeStats,
    pub after: TreeStats,
    pub substitutions: Vec<AppliedSubstitution>,
    pub removed_packages: Vec<String>,
    /// Workspace mode: store packages only other members needed, dropped before `before`.
    pub unreachable_packages: u64,
    /// Store ids of packages that are not from the lockfile (workspace members, `file:`
    /// directories); they live in `node_modules/.linked` and travel in the layer image.
    #[serde(default)]
    pub local_packages: Vec<String>,
    /// Executable links declared by packages that Bun did not write (it is not consistent).
    #[serde(default)]
    pub added_bin_links: u64,
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

/// Lay a shim directory over an installed package. Existing files are replaced, never
/// written through: the installed file may be a hard link into Bun's cache.
fn overlay_package(from: &Path, package: &Path) -> Result<()> {
    fn lay(from: &Path, to: &Path, top: bool) -> Result<()> {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from).with_context(|| format!("read {}", from.display()))? {
            let entry = entry?;
            let name = entry.file_name();
            if name == "node_modules" || name == ".git" || (top && (name == "package.json" || name == "package.overlay.json")) {
                continue;
            }
            let (source, target) = (entry.path(), to.join(&name));
            if fs::metadata(&source)?.is_dir() {
                lay(&source, &target, false)?;
            } else {
                if fs::symlink_metadata(&target).is_ok() {
                    fs::remove_file(&target)?;
                }
                fs::copy(&source, &target).with_context(|| format!("copy {}", source.display()))?;
            }
        }
        Ok(())
    }
    lay(from, package, true)?;
    if let Ok(text) = fs::read_to_string(from.join("package.overlay.json")) {
        let over: Map<String, Value> = serde_json::from_str(&text).context("parse package.overlay.json")?;
        let manifest_path = package.join("package.json");
        let mut manifest: Map<String, Value> = serde_json::from_str(&fs::read_to_string(&manifest_path)?).context("parse installed package.json")?;
        manifest.extend(over);
        fs::remove_file(&manifest_path)?;
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)? + "\n")?;
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

/// A workspace member: its directory relative to the workspace root and its manifest.
#[derive(Debug, Clone)]
pub struct Member {
    pub rel: String,
    pub name: String,
    pub manifest_text: String,
    pub manifest: Value,
}

/// Where the app's lock lives and which local packages its install needs.
#[derive(Debug, Clone)]
pub struct Project {
    pub app: PathBuf,
    /// Directory holding `bun.lock`: the app itself, or the enclosing Bun workspace root.
    pub root: PathBuf,
    pub lock_text: String,
    pub root_manifest_text: String,
    /// Workspace mode: every member (the app included). Empty for a standalone app.
    pub members: Vec<Member>,
    /// Workspace mode: members the app depends on through `workspace:` (transitively).
    pub linked: Vec<Member>,
    /// Standalone mode: `file:` inputs.
    pub local: Vec<PathBuf>,
}

impl Project {
    pub fn is_workspace(&self) -> bool {
        self.root != self.app
    }

    pub fn discover(app: &Path) -> Result<Project> {
        let app = app.canonicalize().with_context(|| format!("app directory {}", app.display()))?;
        if app.join("bun.lock").is_file() {
            let root_manifest_text = fs::read_to_string(app.join("package.json")).context("read package.json")?;
            let pkg: Value = serde_json::from_str(&root_manifest_text).context("parse package.json")?;
            if pkg.get("workspaces").is_some() {
                bail!("preparing a workspace root is not supported; pass a member directory");
            }
            return Ok(Project {
                lock_text: fs::read_to_string(app.join("bun.lock"))?,
                local: local_inputs(&app)?,
                root: app.clone(),
                app,
                root_manifest_text,
                members: vec![],
                linked: vec![],
            });
        }
        // No lock beside the app: look for the Bun workspace that owns it.
        let mut dir = app.parent();
        while let Some(root) = dir {
            let manifest_path = root.join("package.json");
            if manifest_path.is_file() && root.join("bun.lock").is_file() {
                let root_manifest_text = fs::read_to_string(&manifest_path)?;
                let pkg: Value = serde_json::from_str(&root_manifest_text).context("parse workspace package.json")?;
                let patterns: Vec<String> = match pkg.get("workspaces") {
                    Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                    Some(Value::Object(map)) => map
                        .get("packages")
                        .and_then(Value::as_array)
                        .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    _ => vec![],
                };
                let mut members = Vec::new();
                for pattern in &patterns {
                    for rel in expand_workspace_pattern(root, pattern)? {
                        let text = fs::read_to_string(root.join(&rel).join("package.json"))?;
                        let manifest: Value = serde_json::from_str(&text).with_context(|| format!("parse {rel}/package.json"))?;
                        let name = manifest.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                        members.push(Member { rel, name, manifest_text: text, manifest });
                    }
                }
                let app_rel = app.strip_prefix(root)?.to_string_lossy().into_owned();
                let Some(app_member) = members.iter().find(|m| m.rel == app_rel) else {
                    bail!("{} has no bun.lock and is not a member of the workspace at {}", app.display(), root.display());
                };
                let mut linked: Vec<Member> = Vec::new();
                let mut queue = vec![app_member.clone()];
                while let Some(member) = queue.pop() {
                    for (name, value) in runtime_dependencies(&member.manifest, member.rel == app_rel) {
                        if !value.as_str().is_some_and(|v| v.starts_with("workspace:")) {
                            continue;
                        }
                        let Some(target) = members.iter().find(|m| &m.name == name) else {
                            bail!("workspace dependency {name} of {} is not a workspace member", member.name);
                        };
                        if target.rel != app_rel && !linked.iter().any(|m| m.rel == target.rel) {
                            linked.push(target.clone());
                            queue.push(target.clone());
                        }
                    }
                }
                linked.sort_by(|a, b| a.rel.cmp(&b.rel));
                return Ok(Project {
                    lock_text: fs::read_to_string(root.join("bun.lock"))?,
                    root: root.to_path_buf(),
                    app,
                    root_manifest_text,
                    members,
                    linked,
                    local: vec![],
                });
            }
            dir = root.parent();
        }
        bail!("no bun.lock in {} or in an enclosing Bun workspace (a text lockfile is required)", app.display())
    }

    pub fn app_manifest(&self) -> Result<(String, Value)> {
        let text = fs::read_to_string(self.app.join("package.json")).context("read package.json")?;
        let value = serde_json::from_str(&text).context("parse package.json")?;
        Ok((text, value))
    }
}

/// Dependencies a package brings to whoever installs it. The app itself also gets its
/// devDependencies (Vite and friends live there); a linked library does not.
fn runtime_dependencies(pkg: &Value, with_dev: bool) -> Vec<(&String, &Value)> {
    let mut keys = vec!["dependencies", "optionalDependencies", "peerDependencies"];
    if with_dev {
        keys.push("devDependencies");
    }
    keys.into_iter().filter_map(|key| pkg.get(key)?.as_object()).flat_map(|map| map.iter()).collect()
}

/// `packages/*` or a literal directory; only directories with a package.json count.
fn expand_workspace_pattern(root: &Path, pattern: &str) -> Result<Vec<String>> {
    let pattern = pattern.trim_start_matches("./").trim_end_matches('/');
    let mut out = Vec::new();
    if let Some(parent) = pattern.strip_suffix("/*") {
        if parent.contains('*') {
            bail!("unsupported workspace pattern {pattern}");
        }
        let Ok(entries) = fs::read_dir(root.join(parent)) else { return Ok(out) };
        for entry in entries {
            let entry = entry?;
            if entry.path().join("package.json").is_file() {
                out.push(format!("{parent}/{}", entry.file_name().to_string_lossy()));
            }
        }
    } else if pattern.contains('*') {
        bail!("unsupported workspace pattern {pattern}");
    } else if root.join(pattern).join("package.json").is_file() {
        out.push(pattern.to_string());
    }
    out.sort();
    Ok(out)
}

/// What a linked workspace package contributes to the guest: its `files` (as `npm pack`
/// would take them, plain names and directories only) or, without `files`, everything
/// except `node_modules` and `.git`.
pub fn member_files(dir: &Path, manifest: &Value) -> Vec<PathBuf> {
    match manifest.get("files").and_then(Value::as_array) {
        Some(files) => {
            let mut out = vec![dir.join("package.json")];
            for file in files.iter().filter_map(Value::as_str) {
                let path = dir.join(file.trim_start_matches("./"));
                if path.exists() && !out.contains(&path) {
                    out.push(path);
                }
            }
            out
        }
        None => fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_name() != "node_modules" && e.file_name() != ".git")
                    .map(|e| e.path())
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn relative_to(from_dir: &Path, to: &Path) -> PathBuf {
    let from: Vec<_> = from_dir.components().collect();
    let to_parts: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push("..");
    }
    for part in &to_parts[common..] {
        out.push(part);
    }
    out
}

/// Symlinks directly in a `node_modules` directory, including one scope level:
/// `(name, link path)`.
fn links_in(node_modules: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(node_modules) else { return Ok(out) };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            out.push((name, entry.path()));
        } else if ft.is_dir() && name.starts_with('@') {
            for scoped in fs::read_dir(entry.path())? {
                let scoped = scoped?;
                if scoped.file_type()?.is_symlink() {
                    out.push((format!("{name}/{}", scoped.file_name().to_string_lossy()), scoped.path()));
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Turn a workspace member's view of an isolated install into a standalone
/// `node_modules`: the store moves to `<guest>/node_modules/.bun`, the member's links are
/// re-pointed at it, linked workspace packages are copied into the store like `file:`
/// packages, and store packages nothing reaches (other members' devDependencies) go.
fn relocate_workspace(stage_root: &Path, project: &Project, guest: &Path) -> Result<(PathBuf, Vec<String>)> {
    let store_src = stage_root.join("node_modules/.bun");
    let node_modules = guest.join("node_modules");
    if guest.exists() {
        fs::remove_dir_all(guest)?;
    }
    fs::create_dir_all(&node_modules)?;
    let store = node_modules.join(".bun");
    fs::rename(&store_src, &store).context("move the package store")?;
    let app_rel = project.app.strip_prefix(&project.root)?.to_path_buf();

    struct Ctx<'a> {
        stage_root: &'a Path,
        store_src: &'a Path,
        store: &'a Path,
        project: &'a Project,
        materialized: Vec<String>,
    }
    fn package_dir(ctx: &Ctx, member: &Member) -> PathBuf {
        ctx.store.join(format!("{}@workspace", member.name.replace('/', "+"))).join("node_modules").join(&member.name)
    }
    fn materialize(ctx: &mut Ctx, member: &Member) -> Result<PathBuf> {
        let dest = package_dir(ctx, member);
        if ctx.materialized.contains(&member.rel) {
            return Ok(dest);
        }
        ctx.materialized.push(member.rel.clone());
        let staged = ctx.stage_root.join(&member.rel);
        fs::create_dir_all(&dest)?;
        for entry in fs::read_dir(&staged)? {
            let entry = entry?;
            if entry.file_name() != "node_modules" {
                copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
            }
        }
        let wanted: BTreeSet<String> = runtime_dependencies(&member.manifest, false).into_iter().map(|(n, _)| n.clone()).collect();
        let siblings = dest.parent().and_then(|p| if member.name.contains('/') { p.parent() } else { Some(p) }).expect("store layout").to_path_buf();
        link_into(ctx, &staged.join("node_modules"), &siblings, Some(&wanted))?;
        Ok(dest)
    }
    fn link_into(ctx: &mut Ctx, from: &Path, to: &Path, only: Option<&BTreeSet<String>>) -> Result<()> {
        for (name, link) in links_in(from)? {
            if only.is_some_and(|names| !names.contains(&name)) {
                continue;
            }
            let target = normalize(&link.parent().expect("link parent").join(fs::read_link(&link)?));
            let resolved = if let Ok(rest) = target.strip_prefix(ctx.store_src) {
                ctx.store.join(rest)
            } else if let Some(member) = ctx.project.members.iter().find(|m| ctx.stage_root.join(&m.rel) == target).cloned() {
                materialize(ctx, &member)?
            } else {
                bail!("link {} points outside the package store: {}", link.display(), target.display());
            };
            let dest = to.join(&name);
            let parent = dest.parent().expect("link parent");
            fs::create_dir_all(parent)?;
            if fs::symlink_metadata(&dest).is_ok() {
                continue;
            }
            std::os::unix::fs::symlink(relative_to(parent, &resolved), &dest)?;
        }
        Ok(())
    }
    let mut ctx = Ctx { stage_root, store_src: &store_src, store: &store, project, materialized: vec![] };
    let app_modules = stage_root.join(&app_rel).join("node_modules");
    link_into(&mut ctx, &app_modules, &node_modules, None)?;
    // Executable links are relative to their sibling packages and stay valid as they are.
    let bin = app_modules.join(".bin");
    if bin.is_dir() {
        fs::create_dir_all(node_modules.join(".bin"))?;
        for entry in fs::read_dir(&bin)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                std::os::unix::fs::symlink(fs::read_link(entry.path())?, node_modules.join(".bin").join(entry.file_name()))?;
            }
        }
    }

    // Reachability over the store: from the app's links, through each package's siblings.
    let id_of = |link: &Path| -> Option<String> {
        let target = normalize(&link.parent()?.join(fs::read_link(link).ok()?));
        Some(target.strip_prefix(&store).ok()?.components().next()?.as_os_str().to_string_lossy().into_owned())
    };
    let mut reachable: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = links_in(&node_modules)?.iter().filter_map(|(_, link)| id_of(link)).collect();
    while let Some(id) = queue.pop() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        for (_, link) in links_in(&store.join(&id).join("node_modules"))? {
            if let Some(next) = id_of(&link) {
                if !reachable.contains(&next) {
                    queue.push(next);
                }
            }
        }
    }
    let mut unreachable = Vec::new();
    for entry in fs::read_dir(&store)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id != "node_modules" && entry.file_type()?.is_dir() && !reachable.contains(&id) {
            fs::remove_dir_all(entry.path())?;
            unreachable.push(id);
        }
    }
    unreachable.sort();
    Ok((node_modules, unreachable))
}

/// Directory, beside the package store, that holds the packages which do not come from
/// the lockfile (see [`split_local`]). It is packed as its own small image.
pub const LOCAL_STORE: &str = ".linked";

/// Is this store entry a package built from local files rather than fetched at a locked
/// version? Workspace members (`<name>@workspace`, written by `relocate_workspace`) and
/// `file:` dependencies; the policy's shim packages are local too but are part of the
/// tool, not of the app, and stay in the store.
fn is_local_store_id(id: &str) -> bool {
    id.ends_with("@workspace") || (id.contains("@file+") && !id.contains("@file+.bat-shims+"))
}

/// Move the store entries of local packages from `node_modules/.bun/<id>` to
/// `node_modules/.linked/<id>` and re-point every relative link that crosses the move.
///
/// What a visitor's browser keeps is one image per content hash. A workspace-linked
/// package (the app's own library, rebuilt all the time) inside the 240 MB dependency
/// image gave that image a new hash on every rebuild; with its files in a directory of
/// their own, they can travel in a second, small image mounted there, and the big one
/// depends only on the lockfile and the policy. The package's own dependency links stay
/// beside it (`.linked/<id>/node_modules/<dep>` → `../../../.bun/<dep id>/…`), so
/// resolution from inside the package is unchanged.
/// Returns the moved ids.
pub fn split_local(node_modules: &Path) -> Result<Vec<String>> {
    let store = node_modules.join(".bun");
    let local = node_modules.join(LOCAL_STORE);
    let mut ids = Vec::new();
    if let Ok(entries) = fs::read_dir(&store) {
        for entry in entries {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_dir() && is_local_store_id(&id) {
                ids.push(id);
            }
        }
    }
    ids.sort();
    if ids.is_empty() {
        return Ok(ids);
    }
    let moved = |path: &Path| -> PathBuf {
        match path.strip_prefix(&store) {
            Ok(rest) if rest.components().next().is_some_and(|c| ids.iter().any(|id| c.as_os_str() == id.as_str())) => local.join(rest),
            _ => path.to_path_buf(),
        }
    };
    // Every relative link, with what it points at, before anything moves.
    let mut links: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
    visit(node_modules, &mut |path, meta| {
        if meta.file_type().is_symlink() {
            let target = fs::read_link(path)?;
            if target.is_relative() {
                let resolved = normalize(&path.parent().expect("link parent").join(&target));
                links.push((path.to_path_buf(), target, resolved));
            }
        }
        Ok(())
    })?;
    fs::create_dir_all(&local)?;
    for id in &ids {
        fs::rename(store.join(id), local.join(id)).with_context(|| format!("move local package {id}"))?;
    }
    for (link, target, resolved) in links {
        let (new_link, new_resolved) = (moved(&link), moved(&resolved));
        if new_link == link && new_resolved == resolved {
            continue;
        }
        let new_target = relative_to(new_link.parent().expect("link parent"), &new_resolved);
        if new_target != target {
            fs::remove_file(&new_link)?;
            std::os::unix::fs::symlink(&new_target, &new_link)?;
        }
    }
    Ok(ids)
}

/// Give every `node_modules` directory of the tree the executable links its packages
/// declare (`bin` in package.json), where Bun did not write them. Returns how many were
/// added.
///
/// Bun's isolated linker does not always write the same set: of four installs of the
/// TODO tree, one lacked `.bun/update-browserslist-db@…/node_modules/.bin/browserslist`,
/// and one missing link is a different image hash, i.e. a full download for every
/// visitor. Links Bun did write are kept as they are; only missing ones are added, in a
/// fixed order, so the result does not depend on which ones Bun skipped.
pub fn complete_bins(node_modules: &Path) -> Result<u64> {
    let mut dirs = vec![node_modules.to_path_buf()];
    for store in [".bun", LOCAL_STORE] {
        let Ok(entries) = fs::read_dir(node_modules.join(store)) else { continue };
        for entry in entries {
            let inner = entry?.path().join("node_modules");
            if inner.is_dir() {
                dirs.push(inner);
            }
        }
    }
    let mut added = 0;
    for dir in dirs {
        // Packages visible here: plain names and one scope level, links or directories.
        let mut names = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if name.starts_with('@') {
                if let Ok(scoped) = fs::read_dir(entry.path()) {
                    for inner in scoped {
                        names.push(format!("{name}/{}", inner?.file_name().to_string_lossy()));
                    }
                }
            } else {
                names.push(name);
            }
        }
        names.sort();
        for name in names {
            let Ok(text) = fs::read_to_string(dir.join(&name).join("package.json")) else { continue };
            let Ok(pkg) = serde_json::from_str::<Value>(&text) else { continue };
            let bins: Vec<(String, String)> = match pkg.get("bin") {
                Some(Value::String(path)) => vec![(name.rsplit('/').next().unwrap_or(&name).to_string(), path.clone())],
                Some(Value::Object(map)) => map.iter().filter_map(|(command, path)| Some((command.clone(), path.as_str()?.to_string()))).collect(),
                _ => continue,
            };
            for (command, path) in bins {
                let path = path.trim_start_matches("./");
                if command.is_empty() || command.contains('/') || path.is_empty() || path.split('/').any(|part| part == "..") {
                    continue;
                }
                let link = dir.join(".bin").join(&command);
                if fs::symlink_metadata(&link).is_ok() || !dir.join(&name).join(path).is_file() {
                    continue;
                }
                fs::create_dir_all(dir.join(".bin"))?;
                std::os::unix::fs::symlink(format!("../{name}/{path}"), &link)?;
                added += 1;
            }
        }
    }
    Ok(added)
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
    let project = Project::discover(app)?;
    let (_, pkg) = project.app_manifest()?;
    let root_pkg: Value = serde_json::from_str(&project.root_manifest_text).context("parse root package.json")?;
    let lock = parse_jsonc(&project.lock_text).context("parse bun.lock")?;

    // Stage under the project's absolute path so relative `file:` references keep working.
    let tree = work.join("tree");
    if tree.exists() {
        fs::remove_dir_all(&tree)?;
    }
    let mirror = |path: &Path| tree.join(path.strip_prefix("/").unwrap_or(path));
    let stage = mirror(&project.root);
    fs::create_dir_all(&stage)?;
    for input in &project.local {
        copy_tree(input, &mirror(input))?;
    }
    for member in &project.members {
        // Bun needs every member's manifest; only linked members contribute files.
        fs::create_dir_all(stage.join(&member.rel))?;
        fs::write(stage.join(&member.rel).join("package.json"), &member.manifest_text)?;
    }
    for member in &project.linked {
        let dir = project.root.join(&member.rel);
        for path in member_files(&dir, &member.manifest) {
            copy_tree(&path, &stage.join(&member.rel).join(path.strip_prefix(&dir)?))?;
        }
    }
    fs::write(stage.join("package.json"), &project.root_manifest_text)?;
    fs::write(stage.join("bun.lock"), &project.lock_text)?;

    let cache = work.join("bun-cache");
    let cache = cache.to_string_lossy();
    let started = Instant::now();
    let installer = format!("bun {}", run_bun(bun, &["--version"], &stage)?.trim());
    // 1. The project's own lock, frozen: proves the lock matches the manifest.
    run_bun(bun, &["install", "--linker", "isolated", "--frozen-lockfile", "--ignore-scripts", "--cache-dir", &cache], &stage)?;

    // 2. Overrides from the policy table, then let Bun re-resolve.
    let mut overrides: Map<String, Value> = root_pkg.get("overrides").and_then(Value::as_object).cloned().unwrap_or_default();
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
        let value = if let Some(source) = policy.local_dir(&sub.with) {
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
    let mut derived = root_pkg.clone();
    if !overrides.is_empty() {
        derived.as_object_mut().ok_or_else(|| anyhow!("package.json is not an object"))?.insert("overrides".into(), Value::Object(overrides));
    }
    let derived_manifest = serde_json::to_string_pretty(&derived)? + "\n";
    fs::write(stage.join("package.json"), &derived_manifest)?;
    run_bun(bun, &["install", "--linker", "isolated", "--ignore-scripts", "--cache-dir", &cache], &stage)?;
    let install_ms = started.elapsed().as_millis() as u64;

    let (node_modules, unreachable_packages) = if project.is_workspace() {
        relocate_workspace(&stage, &project, &work.join("guest"))?
    } else {
        (stage.join("node_modules"), Vec::new())
    };
    let local_packages = split_local(&node_modules)?;
    let added_bin_links = complete_bins(&node_modules)?;
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
        if let Some(overlay) = sub.overlay.as_deref() {
            let source = policy.local_dir(overlay).ok_or_else(|| anyhow!("overlay for {} must be dir:<path>", sub.package))?;
            overlay_package(&source, root).with_context(|| format!("overlay for {}", sub.package))?;
        }
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
            installer, workspace: project.is_workspace(), before, after, substitutions: applied, removed_packages,
            unreachable_packages: unreachable_packages.len() as u64, local_packages, added_bin_links, removed_files, removed_dangling_links,
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

