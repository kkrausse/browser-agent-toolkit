//! Start-up program modules: the modules one program loads while starting, taken from
//! finished images and emitted as one script of `__bat_define(path, function…)` calls.
//!
//! Unlike the policy's program scripts this is an add-on to images that already exist:
//! the images are not changed and keep every body, so the loader works the same without
//! the script. The runtime loads it with `import()`, as a module, because that is the
//! path on which Chrome keeps a V8 code cache (docs/experiments/2026-10-09-startup.md);
//! evaluating the same bodies one by one with `eval` compiles them again in every process.
//!
//! A module script is strict code. ES modules are strict anyway. A CommonJS body is taken
//! only when it begins with a `"use strict"` directive, i.e. when it already is strict;
//! the others stay with the loader's `eval`. The caller checks that the whole file parses
//! as a module (`await` as an identifier and HTML-like comments are errors there).

use crate::program::{function_header, ProgramRecord, DEFINE};
use crate::pack::sha256_hex;
use anyhow::{anyhow, Context, Result};
use bat_image::writer::ImageFile;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const KIND_MASK: u32 = 0b111;
const KIND_CJS: u32 = 1;
const KIND_ESM: u32 = 2;
const CODE_IS_SOURCE: u32 = 1 << 14;

#[derive(Serialize)]
pub struct Summary {
    #[serde(flatten)]
    pub record: ProgramRecord,
    pub asked: usize,
    /// Not in any image (workspace files, files of another dependency tree).
    pub absent: usize,
    /// Not modules, failed to compile at prepare time, or already in a program script.
    pub not_modules: usize,
    /// CommonJS without a `"use strict"` directive: left to the loader.
    pub sloppy: usize,
}

/// True when the body's first token is a `"use strict"` directive.
fn starts_strict(code: &[u8]) -> bool {
    let mut i = 0;
    if code.starts_with(&[0xef, 0xbb, 0xbf]) {
        i = 3;
    }
    loop {
        while i < code.len() && code[i].is_ascii_whitespace() {
            i += 1;
        }
        if code[i..].starts_with(b"//") {
            while i < code.len() && code[i] != b'\n' {
                i += 1;
            }
        } else if code[i..].starts_with(b"/*") {
            match code[i + 2..].windows(2).position(|w| w == b"*/") {
                Some(end) => i += 2 + end + 2,
                None => return false,
            }
        } else if code[i..].starts_with(b"#!") && i <= 3 {
            while i < code.len() && code[i] != b'\n' {
                i += 1;
            }
        } else {
            break;
        }
    }
    code[i..].starts_with(b"\"use strict\"") || code[i..].starts_with(b"'use strict'")
}

/// `images`: `(file, guest mount path)`, searched in order. `modules`: guest absolute paths.
pub fn emit(images: &[(PathBuf, String)], name: &str, modules: &[String], out_dir: &Path) -> Result<Summary> {
    let files = images
        .iter()
        .map(|(path, mount)| Ok((ImageFile::open(path).with_context(|| format!("open {}", path.display()))?, mount.trim_end_matches('/').to_string())))
        .collect::<Result<Vec<_>>>()?;
    let mut text: Vec<u8> = Vec::new();
    let mut taken = Vec::new();
    let (mut absent, mut not_modules, mut sloppy) = (0, 0, 0);
    let mut seen = std::collections::HashSet::new();
    for path in modules {
        if !seen.insert(path.as_str()) {
            continue;
        }
        // The image under the longest mount path that holds the file.
        let mut found = None;
        for (file, mount) in &files {
            let Some(rel) = path.strip_prefix(mount.as_str()).filter(|rel| rel.starts_with('/')) else { continue };
            // No symlinks followed: the loader asks with real paths.
            if let Some(index) = file.image().resolve(bat_image::Image::ROOT, rel.trim_matches('/').as_bytes(), false) {
                if found.as_ref().is_none_or(|(_, _, len)| mount.len() > *len) {
                    found = Some((file, index, mount.len()));
                }
            }
        }
        let Some((file, index, _)) = found else {
            absent += 1;
            continue;
        };
        let facts = file.image().entry(index).facts;
        let kind = facts & KIND_MASK;
        if facts == 0 || facts & (bat_image::facts::FAILED | bat_image::facts::IN_PROGRAM) != 0 || (kind != KIND_CJS && kind != KIND_ESM) {
            not_modules += 1;
            continue;
        }
        let code = match file.read_compiled(index)? {
            Some(code) => code,
            None if facts & CODE_IS_SOURCE != 0 => file.read_body(index)?,
            None => {
                not_modules += 1;
                continue;
            }
        };
        if kind == KIND_CJS && !starts_strict(&code) {
            sloppy += 1;
            continue;
        }
        let code = code.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&code);
        // A hashbang is only legal at the very start of a script; the loader's eval has the same rule
        // and such files are stored compiled without it, so one here means the body cannot be wrapped.
        if code.starts_with(b"#!") {
            not_modules += 1;
            continue;
        }
        text.extend_from_slice(DEFINE.as_bytes());
        text.push(b'(');
        text.extend_from_slice(serde_json::to_string(path)?.as_bytes());
        // Parenthesised: V8 compiles the function with the script instead of on first call.
        text.extend_from_slice(b",(");
        text.extend_from_slice(function_header(facts).as_bytes());
        text.extend_from_slice(code);
        text.extend_from_slice(b"\n}));\n");
        taken.push(path.clone());
    }
    if taken.is_empty() {
        return Err(anyhow!("start-up program {name}: none of the {} listed modules can be taken", modules.len()));
    }
    let sha256 = sha256_hex(&text);
    let file = format!("program-{name}-{}.js", &sha256[..16]);
    fs::create_dir_all(out_dir)?;
    fs::write(out_dir.join(&file), &text)?;
    Ok(Summary { record: ProgramRecord { name: name.to_string(), file, bytes: text.len() as u64, sha256, modules: taken }, asked: seen.len(), absent, not_modules, sloppy })
}
