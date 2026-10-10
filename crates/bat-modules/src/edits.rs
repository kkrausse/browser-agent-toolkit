//! Span edits over the original text. The transform decides *what* to change
//! from the AST and scope analysis, then changes only those byte ranges, so
//! everything it does not touch keeps its line and column.

pub(crate) struct Edit {
    pub start: u32,
    pub end: u32,
    text_start: u32,
    text_end: u32,
}

#[derive(Default)]
pub(crate) struct Edits {
    list: Vec<Edit>,
    /// Replacement texts, concatenated.
    text: String,
}

impl Edits {
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// Replace `start..end` with whatever `write` appends.
    pub fn replace_with(&mut self, start: u32, end: u32, write: impl FnOnce(&mut String)) {
        let text_start = self.text.len() as u32;
        write(&mut self.text);
        self.list.push(Edit { start, end, text_start, text_end: self.text.len() as u32 });
    }

    pub fn replace(&mut self, start: u32, end: u32, text: &str) {
        self.replace_with(start, end, |out| out.push_str(text));
    }

    pub fn insert(&mut self, at: u32, text: &str) {
        self.replace(at, at, text);
    }

    /// Remove a whole statement. A `;` stays behind so the neighbours cannot
    /// merge through automatic semicolon insertion, and every line break stays
    /// so later lines keep their numbers.
    pub fn remove_statement(&mut self, source: &str, start: u32, end: u32) {
        let removed = &source.as_bytes()[start as usize..end as usize];
        self.replace_with(start, end, |out| {
            out.push(';');
            for _ in 0..removed.iter().filter(|b| **b == b'\n').count() {
                out.push('\n');
            }
        });
    }

    /// Sorted, non-overlapping edits. An edit that starts inside an earlier,
    /// wider one is dropped (the outer edit wins: a removed statement takes
    /// the identifier rewrites inside it with it).
    fn normalized(&mut self) -> Vec<(u32, u32, &str)> {
        // Stable: edits at the same offset keep insertion order.
        self.list.sort_by_key(|e| e.start);
        let mut out: Vec<(u32, u32, &str)> = Vec::with_capacity(self.list.len());
        let mut covered = 0u32;
        for edit in &self.list {
            if edit.start < covered {
                continue;
            }
            covered = covered.max(edit.end);
            out.push((
                edit.start,
                edit.end,
                &self.text[edit.text_start as usize..edit.text_end as usize],
            ));
        }
        out
    }

    /// Apply to `source`, writing `prelude` first. Returns the new text and,
    /// if asked, the applied edits as `(start, end, replacement_len)` for
    /// source-map adjustment.
    pub fn apply(
        &mut self,
        source: &str,
        prelude: &str,
        want_applied: bool,
    ) -> (String, Vec<(u32, u32, u32)>) {
        let extra = self.text.len();
        let edits = self.normalized();
        let mut out = String::with_capacity(source.len() + prelude.len() + extra + 1);
        out.push_str(prelude);
        let mut applied = Vec::new();
        let mut cursor = 0usize;
        for (start, end, text) in edits {
            out.push_str(&source[cursor..start as usize]);
            out.push_str(text);
            cursor = end as usize;
            if want_applied {
                applied.push((start, end, text.len() as u32));
            }
        }
        out.push_str(&source[cursor..]);
        (out, applied)
    }
}
