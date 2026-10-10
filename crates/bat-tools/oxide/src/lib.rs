//! Plain C ABI over `tailwindcss_oxide::Scanner` for wasm32-wasip1. No N-API,
//! no wasm-bindgen, no threads. The JS side is
//! `packages/guest-shims/tailwindcss-oxide/index.js`; it mirrors what
//! `crates/node/src/lib.rs` in the Tailwind repository does over N-API.
//!
//! ```text
//! ox_input(len) -> ptr        scratch the caller fills before a call
//! ox_result_ptr() / ox_result_len()   bytes produced by the last call
//! ox_chdir(len)               input: UTF-8 path; sets the working directory
//! ox_new(len) -> handle       input: strings (base, pattern, "1"|"0")*
//! ox_drop(handle)
//! ox_scan(handle) -> status
//! ox_scan_files(handle, len) -> status          input: strings (kind, value, extension)*
//! ox_positions(handle, len) -> status           input: strings (kind, value, extension)
//! ox_files / ox_scanned_files / ox_globs / ox_normalized_sources (handle) -> status
//! ```
//!
//! Input strings: each a little-endian u32 byte length followed by UTF-8.
//! `kind` is "f" (value is a file path) or "c" (value is the content).
//! Results: each string followed by a NUL byte (so JS decodes once and splits).
//! `ox_globs`/`ox_normalized_sources` emit (base, pattern) pairs;
//! `ox_positions` emits (decimal UTF-16 offset, candidate) pairs.
//! Status 0 is success; 1 means the result is an error message.

use std::cell::RefCell;

use tailwindcss_oxide::{ChangedContent, GlobEntry, PublicSourceEntry, Scanner};

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn ox_input(len: usize) -> *mut u8 {
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        input.clear();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn ox_result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn ox_result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

fn input_strings(len: usize) -> Vec<String> {
    INPUT.with(|input| {
        let input = input.borrow();
        let bytes = &input[..len.min(input.len())];
        let mut strings = Vec::new();
        let mut at = 0;
        while at + 4 <= bytes.len() {
            let n = u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                as usize;
            at += 4;
            let end = (at + n).min(bytes.len());
            strings.push(String::from_utf8_lossy(&bytes[at..end]).into_owned());
            at = end;
        }
        strings
    })
}

fn respond<I, S>(strings: I) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<[u8]>,
{
    RESULT.with(|result| {
        let mut result = result.borrow_mut();
        result.clear();
        for string in strings {
            result.extend_from_slice(string.as_ref());
            result.push(0);
        }
    });
    0
}

fn fail(message: String) -> i32 {
    RESULT.with(|result| {
        let mut result = result.borrow_mut();
        result.clear();
        result.extend_from_slice(message.as_bytes());
    });
    1
}

fn changed_content(kind: &str, value: String, extension: String) -> ChangedContent {
    if kind == "f" {
        ChangedContent::File(value.into(), extension)
    } else {
        ChangedContent::Content(value, extension)
    }
}

fn pairs(globs: Vec<GlobEntry>) -> i32 {
    respond(globs.into_iter().flat_map(|glob| [glob.base, glob.pattern]))
}

/// # Safety
/// `handle` must be a live value returned by `ox_new`.
unsafe fn scanner<'a>(handle: *mut Scanner) -> &'a mut Scanner {
    &mut *handle
}

#[no_mangle]
pub extern "C" fn ox_chdir(len: usize) -> i32 {
    let path = INPUT.with(|input| String::from_utf8_lossy(&input.borrow()[..len]).into_owned());
    match std::env::set_current_dir(&path) {
        Ok(()) => 0,
        Err(error) => fail(format!("chdir {path}: {error}")),
    }
}

#[no_mangle]
pub extern "C" fn ox_new(len: usize) -> *mut Scanner {
    let strings = input_strings(len);
    let sources = strings
        .chunks_exact(3)
        .map(|entry| PublicSourceEntry {
            base: entry[0].clone(),
            pattern: entry[1].clone(),
            negated: entry[2] == "1",
        })
        .collect();
    Box::into_raw(Box::new(Scanner::new(sources)))
}

/// # Safety
/// `handle` must come from `ox_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn ox_drop(handle: *mut Scanner) {
    drop(Box::from_raw(handle));
}

/// # Safety
/// `handle` must be a live value returned by `ox_new` (all functions below).
#[no_mangle]
pub unsafe extern "C" fn ox_scan(handle: *mut Scanner) -> i32 {
    respond(scanner(handle).scan())
}

#[no_mangle]
pub unsafe extern "C" fn ox_scan_files(handle: *mut Scanner, len: usize) -> i32 {
    let mut strings = input_strings(len).into_iter();
    let mut input = Vec::new();
    while let (Some(kind), Some(value), Some(extension)) =
        (strings.next(), strings.next(), strings.next())
    {
        input.push(changed_content(&kind, value, extension));
    }
    respond(scanner(handle).scan_content(input))
}

#[no_mangle]
pub unsafe extern "C" fn ox_positions(handle: *mut Scanner, len: usize) -> i32 {
    let mut strings = input_strings(len).into_iter();
    let (Some(kind), Some(value), Some(extension)) =
        (strings.next(), strings.next(), strings.next())
    else {
        return fail("getCandidatesWithPositions: malformed input".into());
    };
    // Like the N-API binding: a file is read here, as UTF-8, and scanned as content.
    let content = if kind == "f" {
        match std::fs::read_to_string(&value) {
            Ok(content) => content,
            Err(error) => return fail(format!("Failed to read file: {value}: {error}")),
        }
    } else {
        value
    };
    let found = scanner(handle)
        .get_candidates_with_positions(ChangedContent::Content(content.clone(), extension));

    // UTF-8 byte offsets to UTF-16 code unit offsets, as `crates/node/src/utf16.rs`:
    // a forward cursor that restarts when a position goes backwards, and that
    // rounds a position inside a character up to the next boundary.
    let (mut utf8, mut utf16) = (0usize, 0usize);
    let mut out = Vec::with_capacity(found.len() * 2);
    for (candidate, position) in found {
        if position < utf8 {
            utf8 = 0;
            utf16 = 0;
        }
        for c in content[utf8..].chars() {
            if utf8 >= position {
                break;
            }
            utf8 += c.len_utf8();
            utf16 += c.len_utf16();
        }
        out.push(utf16.to_string());
        out.push(candidate);
    }
    respond(out)
}

#[no_mangle]
pub unsafe extern "C" fn ox_files(handle: *mut Scanner) -> i32 {
    respond(scanner(handle).get_files())
}

#[no_mangle]
pub unsafe extern "C" fn ox_scanned_files(handle: *mut Scanner) -> i32 {
    respond(scanner(handle).get_scanned_files())
}

#[no_mangle]
pub unsafe extern "C" fn ox_globs(handle: *mut Scanner) -> i32 {
    pairs(scanner(handle).get_globs())
}

#[no_mangle]
pub unsafe extern "C" fn ox_normalized_sources(handle: *mut Scanner) -> i32 {
    pairs(scanner(handle).get_normalized_sources())
}
