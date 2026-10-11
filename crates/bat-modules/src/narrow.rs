//! Function bodies in which no character is above U+00FF, where that can be had.
//!
//! An engine keeps the source text of every script it has loaded, and keeps it with one
//! byte per character only if every character fits in one: a single character above
//! U+00FF anywhere in a 27 MB program script makes it 55 MB of memory in the tab
//! (docs/experiments/2026-10-11-memory-reduction.md). Such characters are almost always
//! inside string literals, templates, regular expressions and comments, where `\uXXXX`
//! means the same. This pass rewrites them there and nowhere else:
//!
//! - string literals and the quasis of untagged templates: the escape has the same value;
//! - regular expression literals: the escape matches the same code unit, and in a `u` or
//!   `v` expression two surrogate escapes in a row are one code point, as the character was;
//! - comments: no meaning, except that a line separator inside a block comment counts as
//!   a line break for semicolon insertion, so U+2028 and U+2029 stay there.
//!
//! Left alone: the quasis of tagged templates (the tag sees the raw text) and identifiers.
//! A body with a wide character in one of those keeps it, and with it its two-byte text;
//! `Narrowed::left` says how many.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;

pub struct Narrowed {
    pub code: String,
    /// Characters above U+00FF replaced by escapes.
    pub escaped: usize,
    /// Characters above U+00FF still in the code.
    pub left: usize,
}

/// True when the UTF-8 text has a character above U+00FF (lead bytes 0xC4 and up).
pub fn has_wide(code: &[u8]) -> bool {
    code.iter().any(|b| *b >= 0xC4)
}

#[derive(Default)]
struct Spans {
    /// `(start, end, is_comment)` in offsets of the wrapped text.
    list: Vec<(u32, u32, bool)>,
}

impl<'a> Visit<'a> for Spans {
    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.list.push((it.span.start, it.span.end, false));
    }
    fn visit_reg_exp_literal(&mut self, it: &RegExpLiteral<'a>) {
        self.list.push((it.span.start, it.span.end, false));
    }
    fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
        for quasi in &it.quasis {
            self.list.push((quasi.span.start, quasi.span.end, false));
        }
        walk::walk_template_literal(self, it);
    }
    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        // The tag and the substitutions, not the quasis: their raw text is visible to the tag.
        self.visit_expression(&it.tag);
        for expression in &it.quasi.expressions {
            self.visit_expression(expression);
        }
    }
}

/// `body` is a compiled function body as a program script holds it: of an ES module (the
/// body of an `async function*` or `function*`) or of a CommonJS module (a plain function).
/// `None`: nothing to do, or the body did not parse here (it is then left as it is).
pub fn narrow_body(body: &str, generator: bool, is_async: bool) -> Option<Narrowed> {
    if !has_wide(body.as_bytes()) {
        return None;
    }
    let head = match (generator, is_async) {
        (true, true) => "async function*f(){",
        (true, false) => "function*f(){",
        (false, _) => "function f(exports,require,module,__filename,__dirname,__bat){",
    };
    let mut wrapped = String::with_capacity(head.len() + body.len() + 2);
    wrapped.push_str(head);
    wrapped.push_str(body);
    wrapped.push_str("\n}");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &wrapped, SourceType::cjs()).with_options(ParseOptions::default()).parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        return None;
    }
    let mut spans = Spans::default();
    spans.visit_program(&parsed.program);
    for comment in &parsed.program.comments {
        spans.list.push((comment.span.start, comment.span.end, true));
    }
    spans.list.sort_unstable();

    let offset = head.len();
    let end = offset + body.len();
    let mut out = String::with_capacity(body.len() + body.len() / 64);
    let (mut escaped, mut left) = (0usize, 0usize);
    let mut at = offset;
    let count_wide = |text: &str| text.chars().filter(|c| *c as u32 > 0xFF).count();
    for (start, stop, comment) in spans.list {
        let (start, stop) = ((start as usize).max(at), (stop as usize).min(end));
        if start >= stop {
            continue;
        }
        let between = &wrapped[at..start];
        left += count_wide(between);
        out.push_str(between);
        let inside = &wrapped[start..stop];
        if !has_wide(inside.as_bytes()) {
            out.push_str(inside);
            at = stop;
            continue;
        }
        // `after_backslash`: the previous character was an unescaped backslash, so this one
        // is escaped by it. `\中` means `中`; the backslash that is there starts the escape.
        let mut after_backslash = false;
        for c in inside.chars() {
            let code = c as u32;
            if code <= 0xFF {
                out.push(c);
                after_backslash = c == '\\' && !after_backslash;
                continue;
            }
            // A line separator: after a backslash it is a line continuation (nothing), and
            // inside a comment it is a line break. Both stay.
            if (code == 0x2028 || code == 0x2029) && (after_backslash || comment) {
                out.push(c);
                left += 1;
                after_backslash = false;
                continue;
            }
            let mut units = [0u16; 2];
            for (i, unit) in c.encode_utf16(&mut units).iter().enumerate() {
                if i > 0 || !after_backslash {
                    out.push('\\');
                }
                out.push('u');
                for shift in [12, 8, 4, 0] {
                    out.push(char::from_digit(((*unit >> shift) & 0xF) as u32, 16).unwrap());
                }
            }
            escaped += 1;
            after_backslash = false;
        }
        at = stop;
    }
    let rest = &wrapped[at..end];
    left += count_wide(rest);
    out.push_str(rest);
    if escaped == 0 {
        return None;
    }
    Some(Narrowed { code: out, escaped, left })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(body: &str) -> String {
        narrow_body(body, false, false).map_or_else(|| body.to_string(), |n| n.code)
    }

    // The cases where a careless escape changes the program: each is one I had to get right
    // while writing the pass (an escaped character, a tagged template, a line separator).
    #[test]
    fn escapes_only_where_the_meaning_is_kept() {
        assert_eq!(run("var a = '中'; // 文\n"), "var a = '\\u4e2d'; // \\u6587\n");
        assert_eq!(run("var a = '\\中';"), "var a = '\\u4e2d';");
        assert_eq!(run("var a = '\\\\中';"), "var a = '\\\\\\u4e2d';");
        assert_eq!(run("var a = `x${'😀'}中`;"), "var a = `x${'\\ud83d\\ude00'}\\u4e2d`;");
        assert_eq!(run("var a = tag`中${'文'}`;"), "var a = tag`中${'\\u6587'}`;");
        assert_eq!(run("var a = /[中-文]/u;"), "var a = /[\\u4e2d-\\u6587]/u;");
        assert_eq!(run("var 中 = '文';"), "var 中 = '\\u6587';");
        assert_eq!(run("a /* x\u{2028}y 中 */\nb"), "a /* x\u{2028}y \\u4e2d */\nb");
        assert_eq!(run("var a = 'é';"), "var a = 'é';");
    }
}
