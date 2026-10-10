//! Plain C ABI for the wasm32-unknown-unknown build of the esbuild transform. No
//! wasm-bindgen, no imports. Wrapped by `packages/guest-shims/esbuild/lib/bat-oxc.js`.
//!
//! ```text
//! bat_alloc(len) -> ptr                          bytes for the caller to fill
//! bat_free(ptr, len)
//! bat_esbuild_transform(src, src_len, opts, opts_len) -> result
//! bat_result_free(result)
//! ```
//!
//! `result` points at eleven little-endian u32:
//!
//! ```text
//! 0 status        0 ok, 1 errors (see messages), 2 not supported here (see reason)
//! 1 code ptr      2 code len       UTF-8
//! 3 map ptr       4 map len        source map JSON, len 0 when absent
//! 5 messages ptr  6 messages len   lines "E|W \t line \t column \t length \t text \n"
//! 7 imports ptr   8 imports len    lines "kind \t specifier \n", kind: i import statement,
//!                                  d dynamic import, r require call
//! 9 reason ptr    10 reason len    why status is 2
//! ```
//!
//! `opts`: u32 flags; four strings (u32 length + UTF-8, empty = unset): sourcefile,
//! jsxFactory, jsxFragment, jsxImportSource; u32 n then n pairs of strings (define key,
//! value); u32 n then n pairs of strings (import specifier, replacement).
//! Flag bits: 0-1 loader (0 js, 1 jsx, 2 ts, 3 tsx); 2 source map; 3 sourcesContent;
//! 4-5 jsx (0 classic, 1 automatic, 2 preserve); 6 jsxDev; 7 keep unused imports;
//! 8 experimentalDecorators; 9 useDefineForClassFields = false; 10 minify whitespace;
//! 11 ASCII only; 12 keep legal comments; 13 collect imports.

use bat_tools::esbuild::{transform, ImportKind, Jsx, Loader, Options};

#[repr(C)]
struct ResultBlock {
    header: [u32; 11],
    code: String,
    map: String,
    messages: String,
    imports: String,
}

#[no_mangle]
pub extern "C" fn bat_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` must come from `bat_alloc(len)` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn bat_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> u32 {
        let value = self.bytes.get(self.pos..self.pos + 4).map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        self.pos += 4;
        value
    }
    fn string(&mut self) -> String {
        let len = self.u32() as usize;
        let text = self.bytes.get(self.pos..self.pos + len).and_then(|b| std::str::from_utf8(b).ok()).unwrap_or("");
        self.pos += len;
        text.to_owned()
    }
    fn optional(&mut self) -> Option<String> {
        Some(self.string()).filter(|s| !s.is_empty())
    }
    fn pairs(&mut self) -> Vec<(String, String)> {
        (0..self.u32()).map(|_| (self.string(), self.string())).collect()
    }
}

fn parse_options(bytes: &[u8]) -> Options {
    let mut reader = Reader { bytes, pos: 0 };
    let flags = reader.u32();
    let bit = |n: u32| flags & (1 << n) != 0;
    Options {
        loader: match flags & 3 {
            1 => Loader::Jsx,
            2 => Loader::Ts,
            3 => Loader::Tsx,
            _ => Loader::Js,
        },
        source_map: bit(2),
        sources_content: bit(3),
        jsx: match (flags >> 4) & 3 {
            1 => Jsx::Automatic,
            2 => Jsx::Preserve,
            _ => Jsx::Classic,
        },
        jsx_dev: bit(6),
        keep_unused_imports: bit(7),
        experimental_decorators: bit(8),
        assign_class_fields: bit(9),
        minify_whitespace: bit(10),
        ascii_only: bit(11),
        legal_comments: bit(12),
        collect_imports: bit(13),
        sourcefile: reader.string(),
        jsx_factory: reader.optional(),
        jsx_fragment: reader.optional(),
        jsx_import_source: reader.optional(),
        define: reader.pairs(),
        rewrite_imports: reader.pairs(),
    }
}

/// # Safety
/// Both pointer/length pairs must describe readable memory; `src` must be UTF-8.
#[no_mangle]
pub unsafe extern "C" fn bat_esbuild_transform(src: *const u8, src_len: usize, opts: *const u8, opts_len: usize) -> *mut u32 {
    let source = std::str::from_utf8_unchecked(std::slice::from_raw_parts(src, src_len));
    let options = parse_options(if opts_len == 0 { &[] } else { std::slice::from_raw_parts(opts, opts_len) });
    let output = transform(source, &options);

    let mut messages = String::new();
    for m in &output.messages {
        let text = m.text.replace(['\n', '\t'], " ");
        messages.push_str(&format!("{}\t{}\t{}\t{}\t{}\n", if m.error { 'E' } else { 'W' }, m.line, m.column, m.length, text));
    }
    let mut imports = String::new();
    for import in &output.imports {
        imports.push(match import.kind {
            ImportKind::ImportStatement => 'i',
            ImportKind::DynamicImport => 'd',
            ImportKind::RequireCall => 'r',
        });
        imports.push('\t');
        imports.push_str(&import.specifier);
        imports.push('\n');
    }
    let reason: &'static str = output.needs_fallback.unwrap_or("");
    let status = if output.needs_fallback.is_some() { 2 } else if output.ok() { 0 } else { 1 };
    let mut block = Box::new(ResultBlock {
        header: [0; 11],
        code: output.code,
        map: output.map.unwrap_or_default(),
        messages,
        imports,
    });
    let at = |s: &str| (s.as_ptr() as u32, s.len() as u32);
    let (code, map, messages, imports, reason) = (at(&block.code), at(&block.map), at(&block.messages), at(&block.imports), at(reason));
    block.header = [status, code.0, code.1, map.0, map.1, messages.0, messages.1, imports.0, imports.1, reason.0, reason.1];
    Box::into_raw(block) as *mut u32
}

/// # Safety
/// `result` must come from `bat_esbuild_transform` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn bat_result_free(result: *mut u32) {
    drop(Box::from_raw(result as *mut ResultBlock));
}
