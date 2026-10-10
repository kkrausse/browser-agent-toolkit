//! End-to-end preparation of one app: guest dependency tree + application → image and
//! program scripts (rebuilt only when their inputs change), then `manifest.json` with the
//! launch descriptions and the editable project files (rewritten on every run, cheap).

use crate::deps::{self, DepsReport};
use crate::pack::{self, sha256_file, PackOptions, PackStats};
use crate::policy::{self, Pinned, Policy};
use crate::program::{self, ProgramRecord};
use crate::tree::{self, Item, Source};
use crate::modules;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::os::fd::AsFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct AppOptions {
    pub app: PathBuf,
    pub out: PathBuf,
    pub work: PathBuf,
    /// App-relative files or directories delivered as editable source.
    pub source: Vec<String>,
    /// Extra project files: `(workspace-relative guest path, host file)`.
    pub files: Vec<(String, PathBuf)>,
    pub policy: Option<PathBuf>,
    /// Directory holding the application files named by the policy (OpenCode build output).
    pub application_dir: Option<PathBuf>,
    pub workspace: String,
    pub bun: String,
    pub force: bool,
    pub verify: bool,
    /// JSON merged over the policy's `launch.preview`.
    pub preview: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecord {
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    /// Guest path the image root is mounted at.
    pub mount: String,
    pub entries: u64,
    pub head_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    fingerprint: String,
    image: ImageRecord,
    programs: Vec<ProgramRecord>,
    dependencies: DepsReport,
    pack: PackStats,
    application: Value,
    build_ms: Value,
    /// Host path of the guest `node_modules` the image was packed from (for project scripts).
    #[serde(default)]
    node_modules: Option<PathBuf>,
}

struct Fingerprint(Sha256);

impl Fingerprint {
    fn field(&mut self, label: &str, bytes: &[u8]) {
        self.0.update((label.len() as u64).to_le_bytes());
        self.0.update(label.as_bytes());
        self.0.update((bytes.len() as u64).to_le_bytes());
        self.0.update(bytes);
    }
    /// Names, sizes and mtimes of a tree (not contents): cheap, and enough to notice edits.
    fn tree(&mut self, label: &str, root: &Path) -> Result<()> {
        let meta = fs::metadata(root).with_context(|| format!("stat {}", root.display()))?;
        if !meta.is_dir() {
            self.field(label, format!("{}:{}:{}", meta.len(), meta.mtime(), meta.mtime_nsec()).as_bytes());
            return Ok(());
        }
        let mut lines = Vec::new();
        fn walk(dir: &Path, rel: &str, lines: &mut Vec<String>) -> Result<()> {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "node_modules" || name == ".git" {
                    continue;
                }
                let meta = entry.metadata()?;
                let rel = tree::join(rel, &name);
                if meta.is_dir() {
                    walk(&entry.path(), &rel, lines)?;
                } else {
                    lines.push(format!("{rel}\0{}\0{}\0{}", meta.len(), meta.mtime(), meta.mtime_nsec()));
                }
            }
            Ok(())
        }
        walk(root, "", &mut lines)?;
        lines.sort();
        self.field(label, lines.join("\n").as_bytes());
        Ok(())
    }
}

/// The parts of package.json that decide the installed tree.
fn dependency_view(pkg: &Value) -> Value {
    let mut view = Map::new();
    for key in ["name", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", "patchedDependencies", "trustedDependencies", "workspaces"] {
        if let Some(value) = pkg.get(key) {
            view.insert(key.into(), value.clone());
        }
    }
    Value::Object(view)
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Text stays text; anything that is not UTF-8 keeps its bytes as base64.
fn project_file(bytes: Vec<u8>) -> Value {
    match String::from_utf8(bytes) {
        Ok(text) => Value::String(text),
        Err(e) => json!({ "encoding": "base64", "data": base64(e.as_bytes()) }),
    }
}

fn check_relative(path: &str) -> Result<()> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\')
        || path.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p == ".git" || p == "node_modules")
    {
        bail!("path must be app-relative without `..`, `.git` or `node_modules`: {path:?}");
    }
    Ok(())
}

fn collect_source(app: &Path, source: &[String], project: &mut Map<String, Value>) -> Result<()> {
    fn add(app: &Path, host: &Path, rel: &str, project: &mut Map<String, Value>) -> Result<()> {
        let real = host.canonicalize().with_context(|| format!("source {}", host.display()))?;
        if !real.starts_with(app) {
            bail!("source {rel} resolves outside the application");
        }
        if real.is_dir() {
            let mut names: Vec<_> = fs::read_dir(&real)?.collect::<std::io::Result<Vec<_>>>()?;
            names.sort_by_key(|e| e.file_name());
            for entry in names {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == "node_modules" {
                    continue;
                }
                add(app, &entry.path(), &format!("{rel}/{name}"), project)?;
            }
        } else {
            project.insert(format!("/{rel}"), project_file(fs::read(&real)?));
        }
        Ok(())
    }
    for rel in source {
        check_relative(rel)?;
        add(app, &app.join(rel), rel, project)?;
    }
    Ok(())
}

fn merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(base), Value::Object(over)) => {
            for (key, value) in over {
                merge(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, over) => *base = over.clone(),
    }
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
    if fs::read(path).is_ok_and(|existing| existing == bytes) {
        return Ok(false);
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(true)
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

pub fn prepare_app(options: AppOptions) -> Result<Value> {
    let started = Instant::now();
    let app = options.app.canonicalize().with_context(|| format!("app directory {}", options.app.display()))?;
    fs::create_dir_all(&options.out)?;
    fs::create_dir_all(&options.work)?;
    let (mut policy, policy_text) = policy::load(options.policy.as_deref())?;
    let workspace = options.workspace.trim_end_matches('/').to_string();
    if !workspace.starts_with('/') {
        bail!("--workspace must be an absolute guest path");
    }
    let project = deps::Project::discover(&app)?;
    let (manifest_text, pkg) = project.app_manifest()?;
    if options.application_dir.is_none() {
        policy.application = None;
        policy.programs.clear();
    }
    let application_dir = options.application_dir.as_deref();
    let pinned: Vec<(String, Pinned)> = match &policy.application {
        Some(application) => application.pinned()?,
        None => Vec::new(),
    };

    // ---- Fingerprint of everything the image and program scripts are made from.
    let mut fp = Fingerprint(Sha256::new());
    fp.field("format", b"bat-prepared-v1");
    fp.tree("tool", &std::env::current_exe()?)?;
    fp.field("transform", modules::TRANSFORM_VERSION.as_bytes());
    fp.field("policy", policy_text.as_bytes());
    fp.field("workspace", workspace.as_bytes());
    fp.field("bun", options.bun.as_bytes());
    fp.field("package.json", serde_json::to_string(&dependency_view(&pkg))?.as_bytes());
    fp.field("bun.lock", project.lock_text.as_bytes());
    for input in &project.local {
        fp.tree(&format!("local:{}", input.display()), input)?;
    }
    if project.is_workspace() {
        let root_pkg: Value = serde_json::from_str(&project.root_manifest_text)?;
        fp.field("workspace-root", serde_json::to_string(&dependency_view(&root_pkg))?.as_bytes());
        for member in &project.members {
            fp.field(&format!("member:{}", member.rel), serde_json::to_string(&dependency_view(&member.manifest))?.as_bytes());
        }
        for member in &project.linked {
            let dir = project.root.join(&member.rel);
            fp.field(&format!("linked:{}", member.rel), member.manifest_text.as_bytes());
            for path in deps::member_files(&dir, &member.manifest) {
                fp.tree(&format!("linked:{}", path.display()), &path)?;
            }
        }
    }
    for sub in &policy.substitutions {
        for value in [Some(&sub.with), sub.overlay.as_ref()].into_iter().flatten() {
            if let Some(dir) = policy.local_dir(value) {
                fp.tree(&format!("shim:{value}"), &dir)?;
            }
        }
    }
    if let Some(dir) = application_dir {
        fp.field("application-dir", dir.to_string_lossy().as_bytes());
        for (name, _) in &pinned {
            fp.tree(&format!("application:{name}"), &dir.join(name))?;
        }
    }
    let fingerprint = pack::hex(&fp.0.finalize());
    let fingerprint_ms = ms(started);

    // ---- Reuse or rebuild the image.
    let state_path = options.work.join("state.json");
    let cached: Option<State> = (!options.force)
        .then(|| fs::read(&state_path).ok().and_then(|b| serde_json::from_slice::<State>(&b).ok()))
        .flatten()
        .filter(|state| {
            let present = |file: &str, bytes: u64| fs::metadata(options.out.join(file)).is_ok_and(|m| m.len() == bytes);
            state.fingerprint == fingerprint
                && present(&state.image.file, state.image.bytes)
                && state.programs.iter().all(|p| present(&p.file, p.bytes))
        });
    let reused = cached.is_some();
    let state = match cached {
        Some(state) => state,
        None => {
            let state = build_image(&options, &app, &policy, &pinned, &workspace, &fingerprint)?;
            fs::write(&state_path, serde_json::to_vec_pretty(&state)?)?;
            state
        }
    };
    let image_ms = ms(started) - fingerprint_ms;

    // ---- Manifest: launch descriptions and project files. Always recomputed.
    let manifest_started = Instant::now();
    let (project_is_workspace, lock_text) = (project.is_workspace(), project.lock_text.clone());
    let mut project = Map::new();
    collect_source(&app, &options.source, &mut project)?;
    project.insert("/package.json".into(), Value::String(manifest_text));
    if !project_is_workspace {
        project.insert("/bun.lock".into(), Value::String(lock_text));
    }
    for (guest, host) in &options.files {
        check_relative(guest.trim_start_matches('/'))?;
        let bytes = fs::read(host).with_context(|| format!("read {}", host.display()))?;
        project.insert(format!("/{}", guest.trim_start_matches('/')), project_file(bytes));
    }
    let mut launch = Value::Object(policy.launch.clone());
    if let Some(preview) = &options.preview {
        merge(&mut launch["preview"], preview);
    }
    let scripts = run_project_scripts(&policy, &options, &app, &state, &workspace, &launch, &mut project)?;
    if policy.application.is_none() {
        if let Some(map) = launch.as_object_mut() {
            map.remove("agent");
        }
    }
    let known: HashSet<&str> = state.programs.iter().map(|p| p.name.as_str()).collect();
    if let Some(map) = launch.as_object_mut() {
        for description in map.values_mut() {
            // A launch only names program scripts that were actually emitted.
            if let Some(Value::Array(programs)) = description.get_mut("programs") {
                programs.retain(|p| p.as_str().is_some_and(|name| known.contains(name)));
            }
        }
    }
    let manifest = json!({
        "format": "bat-prepared-v1",
        "image": state.image,
        "programs": state.programs,
        "launch": launch,
        "workspace": workspace,
        "source": options.source,
        "project": project,
        "application": state.application,
        "dependencies": state.dependencies,
        "scripts": scripts,
    });
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    let manifest_changed = write_if_changed(&options.out.join("manifest.json"), &manifest_bytes)?;

    // Drop outputs of earlier builds.
    let keep: HashSet<&str> = std::iter::once(state.image.file.as_str()).chain(state.programs.iter().map(|p| p.file.as_str())).collect();
    for entry in fs::read_dir(&options.out)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = (name.starts_with("image-") && name.ends_with(".batimg")) || (name.starts_with("program-") && name.ends_with(".js"));
        if ours && !keep.contains(name.as_str()) {
            fs::remove_file(entry.path())?;
        }
    }

    Ok(json!({
        "out": options.out,
        "imageReused": reused,
        "manifestChanged": manifest_changed,
        "image": state.image,
        "programs": state.programs,
        "projectFiles": project_len(&manifest),
        "manifestBytes": manifest_bytes.len(),
        "dependencies": state.dependencies,
        "pack": state.pack,
        "buildMs": state.build_ms,
        "ms": { "fingerprint": fingerprint_ms, "image": image_ms, "manifest": ms(manifest_started), "total": ms(started) },
    }))
}

/// Run the policy's project scripts (see `policy::ProjectScript`) and add their output
/// files to `project`. Returns one report per script for the manifest.
fn run_project_scripts(policy: &Policy, options: &AppOptions, app: &Path, state: &State, workspace: &str, launch: &Value, project: &mut Map<String, Value>) -> Result<Vec<Value>> {
    let mut reports = Vec::new();
    for script in &policy.project_scripts {
        let started = Instant::now();
        let Some(node_modules) = state.node_modules.as_deref().filter(|p| p.is_dir()) else {
            eprintln!("project script {}: skipped, the guest node_modules is gone (rebuild with --force)", script.name);
            reports.push(json!({ "name": script.name, "ok": false, "skipped": "no guest node_modules" }));
            continue;
        };
        if script.if_exists.as_ref().is_some_and(|path| !node_modules.join(path).exists()) {
            continue;
        }
        let dir = options.work.canonicalize()?.join("scripts").join(&script.name);
        let (out, cache, files) = (dir.join("out"), dir.join("cache"), dir.join("project.json"));
        if out.exists() {
            fs::remove_dir_all(&out)?;
        }
        fs::create_dir_all(&out)?;
        fs::create_dir_all(&cache)?;
        fs::write(&files, serde_json::to_vec(&project)?)?;
        let args: Vec<PathBuf> = script.run.iter().map(|arg| policy.local_dir(arg).unwrap_or_else(|| PathBuf::from(arg))).collect();
        let Some((command, rest)) = args.split_first() else { bail!("project script {} has no command", script.name) };
        let status = std::process::Command::new(command)
            .args(rest)
            .current_dir(app)
            .env("BAT_APP", app)
            .env("BAT_GUEST_NODE_MODULES", node_modules)
            .env("BAT_PROJECT_FILES", &files)
            .env("BAT_WORKSPACE", workspace)
            .env("BAT_LAUNCH", launch.to_string())
            .env("BAT_IMAGE_SHA256", &state.image.sha256)
            .env("BAT_SCRIPT_OUT", &out)
            .env("BAT_SCRIPT_CACHE", &cache)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(std::io::stderr().as_fd().try_clone_to_owned()?))
            .status();
        let ok = matches!(&status, Ok(status) if status.success());
        if !ok {
            eprintln!("project script {} failed ({status:?}); continuing without its files", script.name);
            reports.push(json!({ "name": script.name, "ok": false, "ms": ms(started) }));
            continue;
        }
        let mut items = Vec::new();
        tree::walk(&out, "", &mut items)?;
        let (mut count, mut bytes) = (0u64, 0u64);
        for item in items {
            let Source::Host { path, len } = &item.source else { continue };
            check_relative(&item.path)?;
            project.insert(format!("/{}", item.path), project_file(fs::read(path)?));
            count += 1;
            bytes += len;
        }
        reports.push(json!({ "name": script.name, "ok": true, "files": count, "bytes": bytes, "ms": ms(started) }));
    }
    Ok(reports)
}

fn project_len(manifest: &Value) -> usize {
    manifest["project"].as_object().map_or(0, Map::len)
}

fn build_image(options: &AppOptions, app: &Path, policy: &Policy, pinned: &[(String, Pinned)], workspace: &str, fingerprint: &str) -> Result<State> {
    let started = Instant::now();
    let application_dir = options.application_dir.as_deref();

    // Application files are verified against their pins while Bun installs.
    let (verified, installed) = std::thread::scope(|scope| {
        let verify = scope.spawn(|| -> Result<()> {
            let Some(dir) = application_dir else { return Ok(()) };
            for (name, pin) in pinned {
                let path = dir.join(name);
                let len = fs::metadata(&path).with_context(|| format!("application file {}", path.display()))?.len();
                if len != pin.bytes || sha256_file(&path)? != pin.sha256 {
                    bail!("application file {name} does not match its pinned size and sha256");
                }
            }
            Ok(())
        });
        let install = deps::prepare(deps::DepsOptions { app, work: &options.work, policy, bun: &options.bun, application_files: pinned });
        (verify.join().expect("verify thread"), install)
    });
    verified?;
    let installed = installed?;
    let deps_ms = ms(started);

    let mut items: Vec<Item> = Vec::new();
    tree::walk(&installed.node_modules, &format!("{}/node_modules", workspace.trim_start_matches('/')), &mut items)?;
    let mut application = Value::Null;
    if let (Some(spec), Some(dir)) = (&policy.application, application_dir) {
        let guest = spec.guest_directory.trim_matches('/').to_string();
        for (name, pin) in pinned {
            items.push(Item { path: tree::join(&guest, name), mode: 0o644, source: Source::Host { path: dir.join(name), len: pin.bytes } });
        }
        if let Some(support) = &spec.support {
            let node_modules = deps::prepare_support(&options.work, &support.manifest, &support.lock, &support.expect, &options.bun)?;
            tree::walk(&node_modules, support.guest_directory.trim_matches('/'), &mut items)?;
        }
        application = json!({ "id": spec.id, "directory": spec.guest_directory, "files": spec.files });
    }
    let collect_ms = ms(started) - deps_ms;

    let program_modules: HashSet<String> = policy.programs.iter().flat_map(|p| p.modules.iter().cloned()).collect();
    let transform = modules::transform();
    let meta = json!({ "tool": concat!("bat-prepare ", env!("CARGO_PKG_VERSION")), "transform": modules::TRANSFORM_VERSION, "mount": "/" });
    let tmp_image = options.out.join("image.partial.batimg");
    let output = pack::write_image(
        &items,
        PackOptions {
            root: "/".into(),
            transform: transform.as_deref(),
            sections: vec![
                (bat_image::SECTION_META, serde_json::to_vec(&meta)?),
                (bat_image::SECTION_PROGRAMS, serde_json::to_vec(&policy.programs)?),
            ],
            align_log2: 4,
            program_modules: if transform.is_some() { program_modules } else { HashSet::new() },
        },
        &tmp_image,
    )?;
    let stats = output.stats;
    let mut verify_ms = Value::Null;
    if options.verify {
        let verify_started = Instant::now();
        let compared = pack::verify_image(&tmp_image, &items)?;
        verify_ms = json!({ "ms": ms(verify_started), "entries": items.len(), "bodies": compared });
    }
    let file = format!("image-{}.batimg", &stats.sha256[..16]);
    fs::rename(&tmp_image, options.out.join(&file))?;
    let pack_ms = ms(started) - deps_ms - collect_ms;

    let program_started = Instant::now();
    let mut programs = Vec::new();
    for spec in &policy.programs {
        let modules: Vec<_> = spec
            .modules
            .iter()
            .filter_map(|path| output.program_code.iter().find(|(p, _)| p == path).map(|(p, c)| (p.clone(), c)))
            .collect();
        if modules.len() != spec.modules.len() {
            if transform.is_some() {
                let missing: Vec<_> = spec.modules.iter().filter(|m| !modules.iter().any(|(p, _)| p == *m)).collect();
                return Err(anyhow!("program {}: modules did not compile or are not in the image: {missing:?}", spec.name));
            }
            continue; // no transform available: no program scripts
        }
        programs.push(program::emit(&options.out, &spec.name, &modules)?);
    }

    Ok(State {
        fingerprint: fingerprint.to_string(),
        image: ImageRecord { file, bytes: stats.image_bytes, sha256: stats.sha256.clone(), mount: "/".into(), entries: stats.entries, head_bytes: stats.head_bytes },
        programs,
        dependencies: installed.report,
        pack: stats,
        application,
        node_modules: Some(installed.node_modules.clone()),
        build_ms: json!({ "dependencies": deps_ms, "collect": collect_ms, "pack": pack_ms, "programs": ms(program_started), "verify": verify_ms, "total": ms(started) }),
    })
}
