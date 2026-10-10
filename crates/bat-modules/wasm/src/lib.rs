//! Plain C ABI for the wasm32-unknown-unknown build. No wasm-bindgen: three
//! allocation functions and one transform call, wrapped by `../js/transform.ts`.
//! Build with `../build-wasm.sh`.
//!
//! ```text
//! bat_alloc(len) -> ptr                    bytes for the caller to fill
//! bat_free(ptr, len)
//! bat_transform(src, src_len, name, name_len, opts, opts_len) -> result
//! bat_result_free(result)
//! ```
//!
//! `result` points at ten little-endian u32:
//!
//! ```text
//! 0 ok (1/0)      1 facts word
//! 2 code ptr      3 code len        UTF-8; may point into `src` when unchanged
//! 4 blob ptr      5 blob len        facts blob
//! 6 map ptr       7 map len         source map JSON, len 0 when absent
//! 8 diag ptr      9 diag len        UTF-8 lines "E|W \t line \t column \t message \n"
//! ```
//!
//! `opts` (may be empty for defaults): u32 flags, then four strings, each a
//! u32 length followed by UTF-8 (empty = unset): jsxImportSource, jsxFactory,
//! jsxFragmentFactory, dynamicImport. Flag bits: 0-1 package type (0 none,
//! 1 commonjs, 2 module); 2-3 forced kind (0 none, 1 cjs, 2 esm, 3 json);
//! 4 source map; 5-6 jsx (0 automatic, 1 automatic dev, 2 classic);
//! 7 verbatimModuleSyntax; 8 experimentalDecorators; 9 emitDecoratorMetadata;
//! 10 useDefineForClassFields = false.

use std::borrow::Cow;

use bat_modules::{transform, JsxMode, ModuleKind, Options, PackageType, Severity};

#[repr(C)]
struct ResultBlock {
    header: [u32; 10],
    code: Option<String>,
    blob: Vec<u8>,
    map: Option<String>,
    diagnostics: String,
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

fn parse_options(bytes: &[u8]) -> Options {
    let mut options = Options::default();
    if bytes.len() < 4 {
        return options;
    }
    let flags = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    options.package_type = match flags & 3 {
        1 => PackageType::CommonJs,
        2 => PackageType::Module,
        _ => PackageType::None,
    };
    options.force_kind = match (flags >> 2) & 3 {
        1 => Some(ModuleKind::CommonJs),
        2 => Some(ModuleKind::Esm),
        3 => Some(ModuleKind::Json),
        _ => None,
    };
    options.source_map = flags & (1 << 4) != 0;
    options.ts.jsx = match (flags >> 5) & 3 {
        1 => JsxMode::AutomaticDev,
        2 => JsxMode::Classic,
        _ => JsxMode::Automatic,
    };
    options.ts.verbatim_module_syntax = flags & (1 << 7) != 0;
    options.ts.experimental_decorators = flags & (1 << 8) != 0;
    options.ts.emit_decorator_metadata = flags & (1 << 9) != 0;
    options.ts.use_define_for_class_fields = flags & (1 << 10) == 0;
    options.async_context = flags & (1 << 11) != 0;

    let mut pos = 4usize;
    let mut next = || -> Option<String> {
        let len = u32::from_le_bytes(bytes.get(pos..pos + 4)?.try_into().ok()?) as usize;
        pos += 4;
        let text = std::str::from_utf8(bytes.get(pos..pos + len)?).ok()?;
        pos += len;
        (!text.is_empty()).then(|| text.to_owned())
    };
    options.ts.jsx_import_source = next();
    options.ts.jsx_factory = next();
    options.ts.jsx_fragment_factory = next();
    options.dynamic_import = next();
    options
}

/// # Safety
/// The three pointer/length pairs must describe readable memory; `src` and
/// `name` must be UTF-8. `src` must stay allocated until the result has been
/// read (unchanged code points into it).
#[no_mangle]
pub unsafe extern "C" fn bat_transform(
    src: *const u8,
    src_len: usize,
    name: *const u8,
    name_len: usize,
    opts: *const u8,
    opts_len: usize,
) -> *mut u32 {
    let source = std::str::from_utf8_unchecked(std::slice::from_raw_parts(src, src_len));
    let filename = std::str::from_utf8_unchecked(std::slice::from_raw_parts(name, name_len));
    let options = parse_options(if opts_len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(opts, opts_len)
    });

    let output = transform(source, filename, &options);
    let ok = output.ok();
    let mut diagnostics = String::new();
    for d in &output.diagnostics {
        diagnostics.push(if d.severity == Severity::Error { 'E' } else { 'W' });
        diagnostics.push('\t');
        diagnostics.push_str(&d.line.to_string());
        diagnostics.push('\t');
        diagnostics.push_str(&d.column.to_string());
        diagnostics.push('\t');
        diagnostics.extend(d.message.chars().map(|c| if c == '\n' { ' ' } else { c }));
        diagnostics.push('\n');
    }
    let word = output.facts.word();
    let blob = output.facts.encode_blob();
    let (code_ptr, code_len, code) = match output.code {
        Cow::Borrowed(text) => (text.as_ptr(), text.len(), None),
        Cow::Owned(text) => (text.as_ptr(), text.len(), Some(text)),
    };
    let mut block = Box::new(ResultBlock {
        header: [0; 10],
        code,
        blob,
        map: output.map,
        diagnostics,
    });
    let map = block.map.as_deref().unwrap_or("");
    block.header = [
        ok as u32,
        word,
        code_ptr as u32,
        code_len as u32,
        block.blob.as_ptr() as u32,
        block.blob.len() as u32,
        map.as_ptr() as u32,
        map.len() as u32,
        block.diagnostics.as_ptr() as u32,
        block.diagnostics.len() as u32,
    ];
    Box::into_raw(block) as *mut u32
}

/// # Safety
/// `result` must come from `bat_transform` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn bat_result_free(result: *mut u32) {
    drop(Box::from_raw(result as *mut ResultBlock));
}
