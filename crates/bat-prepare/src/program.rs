//! Program scripts: compiled modules emitted as one classic script that registers each
//! module function under its guest path. Convention in docs/design/image-format.md.

use crate::pack::{sha256_hex, Compiled};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Global the loader installs before `importScripts(programUrl)`.
pub const DEFINE: &str = "__bat_define";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramRecord {
    pub name: String,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    /// Guest paths registered by the script, in order.
    pub modules: Vec<String>,
}

/// Function header for a compiled body, from the facts word (`bat-modules` layout:
/// kind in bits 0..=2 with 1 = CommonJS, 2 = ESM; bit 3 = async).
///
/// An ES module's function can be started before its context exists: called with none, it
/// stops at once and takes the context from the `next(context)` that resumes it. The loader
/// does that when the script is loaded, so that the engine compiles the body then
/// (docs/design/decisions.md, 2026-10-11). The compiled body opens with its own
/// `"use strict"`, which is then an ordinary statement; the directive is repeated here.
pub fn function_header(facts: u32) -> &'static str {
    match (facts & 0b111, facts & (1 << 3) != 0) {
        (2, true) => "async function*(__bat){\"use strict\";if(__bat===void 0)__bat=yield;",
        (2, false) => "function*(__bat){\"use strict\";if(__bat===void 0)__bat=yield;",
        _ => "function(exports,require,module,__filename,__dirname,__bat){",
    }
}
/// What follows the function in `__bat_define(path, fn…)`: `,1` marks a function that can be
/// started without its context.
pub fn define_tail(facts: u32) -> &'static str {
    if facts & 0b111 == 2 {
        ",1"
    } else {
        ""
    }
}

/// A compiled body with its characters above U+00FF written as escapes where that keeps
/// its meaning (`bat_modules::narrow`), so that the engine can keep the script's text with
/// one byte per character. Returns how many such characters are left (any makes the whole
/// script two-byte text again).
pub fn narrowed<'c>(code: &'c [u8], facts: u32, left: &mut usize, escaped: &mut usize) -> std::borrow::Cow<'c, [u8]> {
    #[cfg(feature = "modules")]
    {
        // BAT_WIDE_SCRIPTS=1 leaves the text as it is (for comparing the two).
        if std::env::var_os("BAT_WIDE_SCRIPTS").is_none() && bat_modules::narrow::has_wide(code) {
            let done = std::str::from_utf8(code).ok().and_then(|text| bat_modules::narrow::narrow_body(text, facts & 0b111 == 2, facts & (1 << 3) != 0));
            match done {
                Some(done) => {
                    *left += done.left;
                    *escaped += done.escaped;
                    return std::borrow::Cow::Owned(done.code.into_bytes());
                }
                None => *left += String::from_utf8_lossy(code).chars().filter(|c| *c as u32 > 0xFF).count(),
            }
        }
    }
    let _ = (facts, &left, &escaped);
    std::borrow::Cow::Borrowed(code)
}

pub fn script_text(modules: &[(String, &Compiled)]) -> Vec<u8> {
    let (mut left, mut escaped) = (0, 0);
    let mut out = Vec::with_capacity(modules.iter().map(|(_, c)| c.code.len() + 128).sum());
    for (path, compiled) in modules {
        out.extend_from_slice(DEFINE.as_bytes());
        out.push(b'(');
        out.extend_from_slice(serde_json::to_string(path).expect("string").as_bytes());
        out.push(b',');
        // The header stays on the first line of the body so line numbers match the source.
        out.extend_from_slice(function_header(compiled.facts).as_bytes());
        out.extend_from_slice(&narrowed(&compiled.code, compiled.facts, &mut left, &mut escaped));
        out.extend_from_slice(b"\n}");
        out.extend_from_slice(define_tail(compiled.facts).as_bytes());
        out.extend_from_slice(b");\n");
    }
    if escaped + left > 0 {
        eprintln!("[prepare] program script: {escaped} characters above U+00FF written as escapes, {left} left{}", if left > 0 { " (its text stays two bytes a character in the browser)" } else { "" });
    }
    out
}

/// Write `program-<name>-<hash16>.js` into `out_dir`.
pub fn emit(out_dir: &Path, name: &str, modules: &[(String, &Compiled)]) -> Result<ProgramRecord> {
    let text = script_text(modules);
    let sha256 = sha256_hex(&text);
    let file = format!("program-{name}-{}.js", &sha256[..16]);
    fs::write(out_dir.join(&file), &text)?;
    Ok(ProgramRecord { name: name.to_string(), file, bytes: text.len() as u64, sha256, modules: modules.iter().map(|(p, _)| p.clone()).collect() })
}
