//! Source maps for lowered (TypeScript/JSX) files. Codegen produces a map for
//! its own output; the ESM/CJS pass then edits that output in place (lines
//! kept, columns shifted), so each mapping's generated position is moved
//! through the same edits.

use std::borrow::Cow;

use oxc_sourcemap::{SourceMap, Token};

fn line_starts(text: &str) -> Vec<u32> {
    let mut starts = vec![0u32];
    starts.extend(memchr_newlines(text.as_bytes()));
    starts
}

fn memchr_newlines(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    bytes.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i as u32 + 1)
}

/// Byte offset of UTF-16 column `col` on the line starting at `start`.
fn offset_of(text: &str, ascii: bool, start: u32, col: u32) -> u32 {
    if ascii {
        return (start + col).min(text.len() as u32);
    }
    let mut units = 0u32;
    for (i, c) in text[start as usize..].char_indices() {
        if units >= col || c == '\n' {
            return start + i as u32;
        }
        units += c.len_utf16() as u32;
    }
    text.len() as u32
}

/// `edits`: sorted, non-overlapping `(start, end, replacement_len)` over
/// `lowered`; `prelude_len` bytes were written before everything.
pub(crate) fn adjust(
    map: &SourceMap,
    lowered: &str,
    edits: &[(u32, u32, u32)],
    prelude_len: u32,
) -> String {
    if edits.is_empty() && prelude_len == 0 {
        return map.to_json_string();
    }
    let ascii = lowered.is_ascii();
    let starts = line_starts(lowered);

    // Old offset -> new offset. Offsets inside a replaced range map to the
    // start of its replacement.
    let translate = |offset: u32, cursor: &mut usize, shift: &mut i64| -> u32 {
        while *cursor < edits.len() && edits[*cursor].1 <= offset {
            let (start, end, len) = edits[*cursor];
            *shift += len as i64 - (end - start) as i64;
            *cursor += 1;
        }
        let base = match edits.get(*cursor) {
            Some((start, _, _)) if *start < offset => *start,
            _ => offset,
        };
        (base as i64 + *shift) as u32 + prelude_len
    };

    // New start offset of every line (lines are preserved by the edits).
    let mut new_starts = Vec::with_capacity(starts.len());
    {
        let (mut cursor, mut shift) = (0usize, 0i64);
        for (line, start) in starts.iter().enumerate() {
            let translated = translate(*start, &mut cursor, &mut shift);
            new_starts.push(if line == 0 { 0 } else { translated });
        }
    }

    let (mut cursor, mut shift) = (0usize, 0i64);
    let mut last = 0u32;
    let tokens: Vec<Token> = map
        .get_tokens()
        .map(|token| {
            let line = (token.get_dst_line() as usize).min(starts.len() - 1);
            let old = offset_of(lowered, ascii, starts[line], token.get_dst_col()).max(last);
            last = old;
            let new = translate(old, &mut cursor, &mut shift);
            // Inserted text is ASCII, so byte and UTF-16 deltas agree unless a
            // removed range held non-ASCII text on this line; accept that.
            let old_col = token.get_dst_col() as i64;
            let byte_col_old = (old - starts[line]) as i64;
            let byte_col_new = new as i64 - new_starts[line] as i64;
            let col = if ascii {
                byte_col_new
            } else {
                old_col + (byte_col_new - byte_col_old)
            };
            Token::new(
                token.get_dst_line(),
                col.max(0) as u32,
                token.get_src_line(),
                token.get_src_col(),
                token.get_source_id(),
                token.get_name_id(),
            )
        })
        .collect();

    let adjusted = SourceMap::new(
        map.get_file().map(|s| Cow::Owned(s.to_owned())),
        map.get_names().map(|s| Cow::Owned(s.to_owned())).collect(),
        map.get_source_root().map(|s| Cow::Owned(s.to_owned())),
        map.get_sources().map(|s| Cow::Owned(s.to_owned())).collect(),
        map.get_source_contents().map(|s| s.map(|s| Cow::Owned(s.to_owned()))).collect(),
        tokens.into_boxed_slice(),
        None,
    );
    adjusted.to_json_string()
}
