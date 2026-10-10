//! Module facts: what the loader and the prepare tool need to know about a
//! module without parsing it again. One `u32` word plus an optional blob; the
//! encoding is documented in `docs/design/module-format.md` and mirrored by
//! `js/facts.ts`.

/// How the loader must evaluate the transformed code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum ModuleKind {
    /// Not a module this crate understands (never returned by a successful transform).
    #[default]
    Unknown = 0,
    /// `function (exports, require, module, __filename, __dirname, __bat)`
    CommonJs = 1,
    /// `function* (__bat)` or, with [`flags::ASYNC`], `async function* (__bat)`
    Esm = 2,
    /// CommonJS-shaped (`module.exports = JSON.parse(...)`); loaders should
    /// rather parse the original text themselves.
    Json = 3,
}

impl ModuleKind {
    pub fn from_bits(word: u32) -> ModuleKind {
        match word & flags::KIND_MASK {
            1 => ModuleKind::CommonJs,
            2 => ModuleKind::Esm,
            3 => ModuleKind::Json,
            _ => ModuleKind::Unknown,
        }
    }
}

/// Bit layout of the facts word. Bits 0..=2 hold the [`ModuleKind`].
pub mod flags {
    pub const KIND_MASK: u32 = 0b111;
    /// ESM with top-level await: the function is an `async function*`.
    pub const ASYNC: u32 = 1 << 3;
    /// Source used `import.meta` (rewritten to `__bat.meta`).
    pub const IMPORT_META: u32 = 1 << 4;
    /// Source used `import()` (rewritten to `__bat.import(...)`).
    pub const DYNAMIC_IMPORT: u32 = 1 << 5;
    /// References a free `require`.
    pub const USES_REQUIRE: u32 = 1 << 6;
    /// References a free `module`.
    pub const USES_MODULE: u32 = 1 << 7;
    /// References a free `exports`.
    pub const USES_EXPORTS: u32 = 1 << 8;
    /// References a free `__filename`.
    pub const USES_FILENAME: u32 = 1 << 9;
    /// References a free `__dirname`.
    pub const USES_DIRNAME: u32 = 1 << 10;
    /// CommonJS that marks itself `__esModule` (transpiled ESM).
    pub const ES_MODULE_MARKER: u32 = 1 << 11;
    /// ESM with a `default` export.
    pub const HAS_DEFAULT: u32 = 1 << 12;
    /// Export names are incomplete until `reexports` are followed
    /// (`export * from`, `module.exports = require(...)`, `__exportStar`).
    pub const HAS_REEXPORTS: u32 = 1 << 13;
    /// The transformed code is byte-identical to the source; an image need not
    /// store a second body.
    pub const CODE_IS_SOURCE: u32 = 1 << 14;
    /// A blob accompanies the word (at least one list is non-empty).
    pub const HAS_BLOB: u32 = 1 << 15;
    /// The source was TypeScript and/or JSX and went through the lowering step,
    /// so output lines do not match source lines (use the source map).
    pub const LOWERED: u32 = 1 << 16;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    pub kind: ModuleKind,
    /// Flag bits without the kind and without `HAS_BLOB` (see [`Facts::word`]).
    pub flags: u32,
    /// ESM: specifiers passed to `__bat.link`, in link order, deduplicated.
    pub imports: Vec<String>,
    /// `import("literal")` specifiers, deduplicated.
    pub dynamic_imports: Vec<String>,
    /// `require("literal")` specifiers (any nesting depth), deduplicated.
    pub requires: Vec<String>,
    /// Statically known export names. ESM: exact, sorted, without the names
    /// that arrive through `reexports`. CommonJS: what Node's
    /// `cjs-module-lexer` would detect, in source order.
    pub exports: Vec<String>,
    /// ESM: `export * from` specifiers. CommonJS: modules whose exports are
    /// re-exported wholesale.
    pub reexports: Vec<String>,
}

impl Facts {
    pub fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }

    pub fn is_async(&self) -> bool {
        self.has(flags::ASYNC)
    }

    fn lists(&self) -> [&Vec<String>; 5] {
        [&self.imports, &self.dynamic_imports, &self.requires, &self.exports, &self.reexports]
    }

    /// The 32-bit facts word.
    pub fn word(&self) -> u32 {
        let mut word = (self.flags & !(flags::KIND_MASK | flags::HAS_BLOB)) | self.kind as u32;
        if self.lists().iter().any(|l| !l.is_empty()) {
            word |= flags::HAS_BLOB;
        }
        word
    }

    /// The blob: five string lists (`imports`, `dynamic_imports`, `requires`,
    /// `exports`, `reexports`), each a LEB128 count followed by that many
    /// LEB128-length-prefixed UTF-8 strings. Empty when no list has entries.
    pub fn encode_blob(&self) -> Vec<u8> {
        let lists = self.lists();
        if lists.iter().all(|l| l.is_empty()) {
            return Vec::new();
        }
        let size: usize =
            lists.iter().map(|l| 2 + l.iter().map(|s| s.len() + 2).sum::<usize>()).sum();
        let mut out = Vec::with_capacity(size);
        for list in lists {
            write_varint(&mut out, list.len() as u32);
            for s in list {
                write_varint(&mut out, s.len() as u32);
                out.extend_from_slice(s.as_bytes());
            }
        }
        out
    }

    /// Inverse of [`Facts::word`] + [`Facts::encode_blob`]. `None` on a malformed blob.
    pub fn decode(word: u32, blob: &[u8]) -> Option<Facts> {
        let mut facts = Facts {
            kind: ModuleKind::from_bits(word),
            flags: word & !(flags::KIND_MASK | flags::HAS_BLOB),
            ..Facts::default()
        };
        if word & flags::HAS_BLOB == 0 || blob.is_empty() {
            return Some(facts);
        }
        let mut pos = 0usize;
        let mut lists: [Vec<String>; 5] = Default::default();
        for list in &mut lists {
            let count = read_varint(blob, &mut pos)?;
            for _ in 0..count {
                let len = read_varint(blob, &mut pos)? as usize;
                let bytes = blob.get(pos..pos.checked_add(len)?)?;
                pos += len;
                list.push(std::str::from_utf8(bytes).ok()?.to_owned());
            }
        }
        let [imports, dynamic_imports, requires, exports, reexports] = lists;
        facts.imports = imports;
        facts.dynamic_imports = dynamic_imports;
        facts.requires = requires;
        facts.exports = exports;
        facts.reexports = reexports;
        Some(facts)
    }
}

fn write_varint(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn read_varint(bytes: &[u8], pos: &mut usize) -> Option<u32> {
    let mut value = 0u32;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*pos)?;
        *pos += 1;
        value |= ((byte & 0x7f) as u32).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
}

/// Insertion-ordered string set used while collecting facts. Small lists are
/// scanned linearly; large ones get a hash index.
#[derive(Default)]
pub(crate) struct NameSet {
    items: Vec<String>,
    index: Option<std::collections::HashSet<String>>,
}

impl NameSet {
    pub fn insert(&mut self, name: &str) -> usize {
        if let Some(index) = &mut self.index {
            if !index.insert(name.to_owned()) {
                return self.items.iter().position(|s| s == name).unwrap_or(0);
            }
        } else {
            if let Some(found) = self.items.iter().position(|s| s == name) {
                return found;
            }
            if self.items.len() == 32 {
                let mut index: std::collections::HashSet<String> =
                    self.items.iter().cloned().collect();
                index.insert(name.to_owned());
                self.index = Some(index);
            }
        }
        self.items.push(name.to_owned());
        self.items.len() - 1
    }

    pub fn contains(&self, name: &str) -> bool {
        match &self.index {
            Some(index) => index.contains(name),
            None => self.items.iter().any(|s| s == name),
        }
    }

    pub fn into_vec(self) -> Vec<String> {
        self.items
    }
}
