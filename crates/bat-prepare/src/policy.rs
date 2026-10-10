//! Guest preparation policy: substitutions, prune rules, application pins, launch
//! descriptions. Loaded from `data/guest-policy.json` (embedded) or `--policy <file>`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const DEFAULT_POLICY: &str = include_str!("../data/guest-policy.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default)]
    pub substitutions: Vec<Substitution>,
    #[serde(default)]
    pub prune: Prune,
    pub application: Option<Application>,
    #[serde(default)]
    pub programs: Vec<ProgramSpec>,
    #[serde(default)]
    pub launch: Map<String, Value>,
    /// Programs run after the image is ready whose output files become project files.
    #[serde(default)]
    pub project_scripts: Vec<ProjectScript>,
    /// Directory `dir:` paths are relative to: the policy file's directory; for the
    /// embedded policy `$BAT_POLICY_BASE`, else `data/` of the crate the tool was built from.
    #[serde(skip)]
    pub base: Option<PathBuf>,
}

/// If `package` is locked (at exactly one version), override it with `with`, where
/// `{version}` is the locked version. `with` is an npm alias (`npm:name@{version}`), a
/// tarball URL, or `dir:<path>` naming a local package directory (a shim).
#[derive(Debug, Clone, Deserialize)]
pub struct Substitution {
    pub package: String,
    pub with: String,
    /// File that must exist in the installed replacement, relative to its package root.
    pub expect: Option<String>,
    /// `dir:<path>`: files laid over the installed replacement (a shim in front of the
    /// package it falls back to). `package.overlay.json` is merged into the installed
    /// `package.json` (top-level keys replace); the directory's own `package.json`,
    /// `node_modules` and `.git` are not copied.
    pub overlay: Option<String>,
}

/// A host program that derives project files from the prepared guest tree (for example a
/// dependency-optimizer cache). It is run with these environment variables and every file
/// it leaves under `BAT_SCRIPT_OUT` is added to the manifest's project files at the same
/// workspace-relative path:
///
/// - `BAT_APP`: the application directory on the host
/// - `BAT_GUEST_NODE_MODULES`: the pruned guest `node_modules` the image was packed from
/// - `BAT_PROJECT_FILES`: JSON file, the project files so far (`{"/path": text | {encoding, data}}`)
/// - `BAT_WORKSPACE`: the guest workspace path; `BAT_LAUNCH`: JSON of the launch descriptions
/// - `BAT_IMAGE_SHA256`: identity of the dependency image
/// - `BAT_SCRIPT_OUT` (emptied before the run), `BAT_SCRIPT_CACHE` (kept between runs)
///
/// A failing script is reported and skipped: the guest then does that work itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    pub name: String,
    /// Command and arguments; a `dir:<path>` argument is resolved like a shim directory.
    pub run: Vec<String>,
    /// Run only if this path exists below the guest `node_modules`.
    pub if_exists: Option<String>,
}

impl Policy {
    /// The local directory a `dir:<path>` value names.
    pub fn local_dir(&self, value: &str) -> Option<PathBuf> {
        let dir = value.strip_prefix("dir:")?;
        Some(self.base.as_deref().unwrap_or(Path::new(".")).join(dir))
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prune {
    /// Package names, `*` allowed as a trailing wildcard.
    #[serde(default)]
    pub packages: Vec<String>,
    /// Remove packages whose package.json restricts `os` or `cpu` (except `wasm32`).
    #[serde(default)]
    pub native_packages: bool,
    /// File name suffixes removed anywhere in the tree.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Paths relative to node_modules, `*` matches within one component, `**` any depth.
    #[serde(default)]
    pub paths: Vec<String>,
    /// Remove files byte-identical to an application file (toolkit packages ship copies).
    #[serde(default)]
    pub duplicates_of_application: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: String,
    pub guest_directory: String,
    pub files: Map<String, Value>,
    pub support: Option<Support>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Pinned {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    pub guest_directory: String,
    pub manifest: Value,
    pub lock: Value,
    #[serde(default)]
    pub expect: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProgramSpec {
    pub name: String,
    /// Guest absolute paths of the modules to emit, in registration order.
    pub modules: Vec<String>,
}

impl Application {
    pub fn pinned(&self) -> Result<Vec<(String, Pinned)>> {
        self.files
            .iter()
            .map(|(name, value)| Ok((name.clone(), serde_json::from_value(value.clone()).with_context(|| format!("application file {name}"))?)))
            .collect()
    }
}

pub fn load(path: Option<&Path>) -> Result<(Policy, String)> {
    let (text, base) = match path {
        Some(path) => (
            std::fs::read_to_string(path).with_context(|| format!("read policy {}", path.display()))?,
            path.canonicalize()?.parent().map(Path::to_path_buf),
        ),
        None => (
            DEFAULT_POLICY.to_string(),
            Some(std::env::var_os("BAT_POLICY_BASE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/data")))),
        ),
    };
    let mut policy: Policy = serde_json::from_str(&text).context("parse policy")?;
    policy.base = base;
    Ok((policy, text))
}

/// `pattern` with an optional trailing `*`.
pub fn name_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => pattern == name,
    }
}

/// Glob over `/`-separated paths: `*` within a component, `**` across components.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    fn component(p: &[u8], s: &[u8]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some(b'*'), _) => component(&p[1..], s) || (!s.is_empty() && component(p, &s[1..])),
            (Some(a), Some(b)) if a == b => component(&p[1..], &s[1..]),
            _ => false,
        }
    }
    fn parts(p: &[&str], s: &[&str]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some(&"**"), _) => parts(&p[1..], s) || (!s.is_empty() && parts(p, &s[1..])),
            (Some(a), Some(b)) if component(a.as_bytes(), b.as_bytes()) => parts(&p[1..], &s[1..]),
            _ => false,
        }
    }
    let p: Vec<&str> = pattern.split('/').collect();
    let s: Vec<&str> = path.split('/').collect();
    parts(&p, &s)
}
