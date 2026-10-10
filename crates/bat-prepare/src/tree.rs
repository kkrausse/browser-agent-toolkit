//! Host directory trees → flat item lists with image-relative paths.

use anyhow::{bail, Context, Result};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub enum Source {
    /// Regular file read from the host when the image is written.
    Host { path: PathBuf, len: u64 },
    /// Bytes produced by prepare itself.
    Bytes(Vec<u8>),
    Dir,
    Symlink { target: String },
}

#[derive(Debug, Clone)]
pub struct Item {
    /// Image-relative path, `/`-separated, no leading slash.
    pub path: String,
    pub mode: u16,
    pub source: Source,
}

impl Item {
    pub fn is_file(&self) -> bool {
        matches!(self.source, Source::Host { .. } | Source::Bytes(_))
    }
    pub fn len(&self) -> u64 {
        match &self.source {
            Source::Host { len, .. } => *len,
            Source::Bytes(b) => b.len() as u64,
            _ => 0,
        }
    }
}

pub fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Walk `host` and append its contents under image path `prefix` (`""` = image root).
/// Symlinks are recorded verbatim, never followed. Directory modes are kept.
pub fn walk(host: &Path, prefix: &str, out: &mut Vec<Item>) -> Result<()> {
    let meta = fs::symlink_metadata(host).with_context(|| format!("stat {}", host.display()))?;
    if !meta.is_dir() {
        bail!("{} is not a directory", host.display());
    }
    if !prefix.is_empty() {
        out.push(Item { path: prefix.to_string(), mode: (meta.permissions().mode() & 0o7777) as u16, source: Source::Dir });
    }
    walk_inner(host, prefix, out)
}

fn walk_inner(host: &Path, prefix: &str, out: &mut Vec<Item>) -> Result<()> {
    let mut names: Vec<_> = fs::read_dir(host)
        .with_context(|| format!("read_dir {}", host.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { bail!("non-UTF-8 name in {}", host.display()) };
        let path = entry.path();
        let meta = entry.metadata()?; // does not follow symlinks
        let mode = (meta.permissions().mode() & 0o7777) as u16;
        let rel = join(prefix, name);
        let ft = meta.file_type();
        if ft.is_symlink() {
            let target = fs::read_link(&path)?;
            let Some(target) = target.to_str() else { bail!("non-UTF-8 symlink target at {}", path.display()) };
            out.push(Item { path: rel, mode: 0o777, source: Source::Symlink { target: target.to_string() } });
        } else if ft.is_dir() {
            out.push(Item { path: rel.clone(), mode, source: Source::Dir });
            walk_inner(&path, &rel, out)?;
        } else if ft.is_file() {
            out.push(Item { path: rel, mode, source: Source::Host { path, len: meta.len() } });
        }
        // Sockets, fifos and devices have no meaning in the guest; skipped.
    }
    Ok(())
}
