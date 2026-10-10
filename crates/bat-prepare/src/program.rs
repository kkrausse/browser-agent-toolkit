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

pub fn script_text(modules: &[(String, &Compiled)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(modules.iter().map(|(_, c)| c.code.len() + 128).sum());
    for (path, compiled) in modules {
        out.extend_from_slice(DEFINE.as_bytes());
        out.push(b'(');
        out.extend_from_slice(serde_json::to_string(path).expect("string").as_bytes());
        out.push(b',');
        out.extend_from_slice(format!("{},", compiled.facts).as_bytes());
        out.extend_from_slice(&compiled.code);
        out.extend_from_slice(b"\n);\n");
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
