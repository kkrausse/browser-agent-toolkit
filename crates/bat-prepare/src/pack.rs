//! Items → image file. Reads, transforms and writes in parallel.

use crate::tree::{Item, Source};
use anyhow::{anyhow, Context, Result};
use bat_image::writer::{Builder, FileId};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Fixed mtime (2026-01-01T00:00:00Z) so identical inputs give identical images.
pub const IMAGE_MTIME: u64 = 1_767_225_600;

pub struct Compiled {
    pub code: Vec<u8>,
    pub facts: u32,
}

/// Module precompilation hook: `(guest absolute path, source bytes)` → compiled body and
/// facts, or `None` when the file is not a module. A returned empty `code` stores facts only.
pub type Transform<'a> = dyn Fn(&str, &[u8]) -> Option<Compiled> + Sync + 'a;

pub struct PackOptions<'a> {
    /// Guest mount point of the image root (recorded, and used to form guest paths).
    pub root: String,
    pub transform: Option<&'a Transform<'a>>,
    /// Extra in-head sections `(id, payload)`.
    pub sections: Vec<(u32, Vec<u8>)>,
    pub align_log2: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackStats {
    pub entries: u64,
    pub files: u64,
    pub dirs: u64,
    pub symlinks: u64,
    pub body_bytes: u64,
    pub compiled_modules: u64,
    pub compiled_bytes: u64,
    pub failed_modules: u64,
    pub head_bytes: u64,
    pub image_bytes: u64,
    pub sha256: String,
    pub transform_ms: u64,
    pub write_ms: u64,
    pub hash_ms: u64,
}

pub fn guest_path(root: &str, rel: &str) -> String {
    let root = root.trim_end_matches('/');
    if rel.is_empty() {
        if root.is_empty() { "/".into() } else { root.into() }
    } else {
        format!("{root}/{rel}")
    }
}

/// Extensions the module transform is offered. `.d.ts` and friends are excluded.
pub fn is_module_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".d.ts") || name.ends_with(".d.mts") || name.ends_with(".d.cts") {
        return false;
    }
    matches!(
        name.rsplit_once('.').map(|(_, e)| e),
        Some("js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "jsx" | "tsx")
    )
}

struct Prepared {
    /// Original bytes if they were read for the transform.
    original: Option<Vec<u8>>,
    compiled: Option<Compiled>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Write `items` as an image at `out` (a temporary sibling is written and renamed).
pub fn write_image(items: &[Item], options: PackOptions, out: &Path) -> Result<PackStats> {
    let started = Instant::now();
    // Phase 1: transform module files (reads them; the bytes are kept for the write).
    let prepared: Vec<Prepared> = items
        .par_iter()
        .map(|item| -> Result<Prepared> {
            let Some(transform) = options.transform else { return Ok(Prepared { original: None, compiled: None }) };
            if !item.is_file() || !is_module_path(&item.path) {
                return Ok(Prepared { original: None, compiled: None });
            }
            let guest = guest_path(&options.root, &item.path);
            match &item.source {
                Source::Host { path, .. } => {
                    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
                    let compiled = transform(&guest, &bytes);
                    Ok(Prepared { original: Some(bytes), compiled })
                }
                Source::Bytes(bytes) => Ok(Prepared { original: None, compiled: transform(&guest, bytes) }),
                _ => unreachable!(),
            }
        })
        .collect::<Result<_>>()?;
    let transform_ms = started.elapsed().as_millis() as u64;

    // Phase 2: layout.
    let mut builder = Builder::new();
    builder.align_log2(options.align_log2).mtime(IMAGE_MTIME);
    let mut ids: Vec<Option<FileId>> = Vec::with_capacity(items.len());
    let mut stats = PackStats {
        entries: 0, files: 0, dirs: 0, symlinks: 0, body_bytes: 0, compiled_modules: 0, compiled_bytes: 0,
        failed_modules: 0, head_bytes: 0, image_bytes: 0, sha256: String::new(), transform_ms, write_ms: 0, hash_ms: 0,
    };
    for (item, prep) in items.iter().zip(&prepared) {
        let err = |e| anyhow!("{}: {e}", item.path);
        match &item.source {
            Source::Dir => {
                builder.dir(&item.path, item.mode).map_err(err)?;
                ids.push(None);
            }
            Source::Symlink { target } => {
                builder.symlink(&item.path, target).map_err(err)?;
                stats.symlinks += 1;
                ids.push(None);
            }
            Source::Host { .. } | Source::Bytes(_) => {
                let len = prep.original.as_ref().map(|b| b.len() as u64).unwrap_or(item.len());
                let id = builder.file(&item.path, item.mode, len).map_err(err)?;
                if let Some(c) = &prep.compiled {
                    builder.set_compiled(id, c.code.len() as u64, c.facts).map_err(err)?;
                    if c.code.is_empty() {
                        if c.facts & bat_image::facts::FAILED != 0 {
                            stats.failed_modules += 1;
                        }
                    } else {
                        stats.compiled_modules += 1;
                        stats.compiled_bytes += c.code.len() as u64;
                    }
                }
                stats.files += 1;
                stats.body_bytes += len;
                ids.push(Some(id));
            }
        }
    }
    for (id, bytes) in options.sections {
        builder.section(id, bytes);
    }
    let plan = builder.plan().map_err(|e| anyhow!("image layout: {e}"))?;
    stats.head_bytes = plan.head.len() as u64;
    stats.image_bytes = plan.file_len;
    let image = bat_image::Image::new(&plan.head).map_err(|e| anyhow!("image head: {e:?}"))?;
    stats.entries = image.len() as u64;
    stats.dirs = stats.entries - stats.files - stats.symlinks;

    // Phase 3: bodies, positioned writes from all threads.
    let write_started = Instant::now();
    let tmp = tmp_path(out);
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::options().write(true).create(true).truncate(true).open(&tmp)
        .with_context(|| format!("create {}", tmp.display()))?;
    plan.begin(&file)?;
    items.par_iter().zip(prepared.par_iter()).zip(ids.par_iter()).try_for_each(|((item, prep), id)| -> Result<()> {
        let Some(id) = id else { return Ok(()) };
        let extents = plan.files[id.0];
        let read;
        let bytes: &[u8] = match (&prep.original, &item.source) {
            (Some(bytes), _) => bytes,
            (None, Source::Bytes(bytes)) => bytes,
            (None, Source::Host { path, .. }) => {
                read = fs::read(path).with_context(|| format!("read {}", path.display()))?;
                &read
            }
            _ => unreachable!(),
        };
        if bytes.len() != extents.body.len as usize {
            return Err(anyhow!("{} changed size while packing", item.path));
        }
        if !bytes.is_empty() {
            file.write_all_at(bytes, extents.body.offset)?;
        }
        if let (Some(extent), Some(compiled)) = (extents.compiled, &prep.compiled) {
            file.write_all_at(&compiled.code, extent.offset)?;
        }
        Ok(())
    })?;
    drop(file);
    stats.write_ms = write_started.elapsed().as_millis() as u64;

    let hash_started = Instant::now();
    stats.sha256 = sha256_file(&tmp)?;
    stats.hash_ms = hash_started.elapsed().as_millis() as u64;
    fs::rename(&tmp, out).with_context(|| format!("rename to {}", out.display()))?;
    Ok(stats)
}

fn tmp_path(out: &Path) -> PathBuf {
    let mut name = out.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".tmp{}", std::process::id()));
    out.with_file_name(name)
}

/// Read every entry back through the reader and compare with the items it was built from.
/// Returns the number of file bodies compared.
pub fn verify_image(image_path: &Path, items: &[Item]) -> Result<u64> {
    let image_file = bat_image::writer::ImageFile::open(image_path)?;
    let image = image_file.image();
    let compared = items
        .par_iter()
        .map(|item| -> Result<u64> {
            let index = image.lookup(item.path.as_bytes()).ok_or_else(|| anyhow!("missing entry {}", item.path))?;
            let entry = image.entry(index);
            if entry.path != item.path.as_bytes() {
                return Err(anyhow!("path mismatch at {}", item.path));
            }
            // The component walk must agree with the full-path search.
            let mut at = bat_image::Image::ROOT;
            for part in item.path.split('/') {
                at = image.lookup_child(at, part.as_bytes()).ok_or_else(|| anyhow!("walk failed at {}", item.path))?;
            }
            if at != index {
                return Err(anyhow!("walk/lookup disagree at {}", item.path));
            }
            if entry.mode != item.mode {
                return Err(anyhow!("mode mismatch at {}: {:o} != {:o}", item.path, entry.mode, item.mode));
            }
            match &item.source {
                Source::Dir => {
                    if !entry.is_dir() {
                        return Err(anyhow!("{} should be a directory", item.path));
                    }
                    Ok(0)
                }
                Source::Symlink { target } => {
                    if entry.target() != Some(target.as_bytes()) {
                        return Err(anyhow!("symlink target mismatch at {}", item.path));
                    }
                    Ok(0)
                }
                Source::Host { path, .. } => {
                    let body = image_file.read_body(index)?;
                    if body != fs::read(path)? {
                        return Err(anyhow!("body mismatch at {}", item.path));
                    }
                    Ok(1)
                }
                Source::Bytes(bytes) => {
                    if &image_file.read_body(index)? != bytes {
                        return Err(anyhow!("body mismatch at {}", item.path));
                    }
                    Ok(1)
                }
            }
        })
        .try_reduce(|| 0, |a, b| Ok(a + b))?;
    // Every directory's child range must list exactly the entries whose parent it is.
    let mut seen = 0u64;
    for dir in 0..image.len() {
        let mut previous: Option<&[u8]> = None;
        for child in image.children(dir) {
            let entry = image.entry(child);
            if entry.parent != dir || previous.is_some_and(|p| p >= entry.name) {
                return Err(anyhow!("bad child range under {}", String::from_utf8_lossy(image.entry(dir).path)));
            }
            previous = Some(entry.name);
            seen += 1;
        }
    }
    if seen != image.len() as u64 - 1 {
        return Err(anyhow!("child ranges cover {seen} of {} entries", image.len() - 1));
    }
    Ok(compared)
}
