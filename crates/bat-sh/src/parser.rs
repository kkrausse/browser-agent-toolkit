//! Recursive-descent parser for the shell language: lists, `&&`/`||`,
//! pipelines, redirections, here-documents, the compound commands, function
//! definitions, and words with all their quoting and `$` forms.
use crate::ast::*;
use std::cell::RefCell;
use std::rc::Rc;

pub type PR<T> = Result<T, String>;

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// A command word: ends at blanks and operators.
    Normal,
    /// Inside double quotes.
    Dq,
    /// The operand of `${x:-…}` outside double quotes: ends at `}`.
    BraceUnq,
    /// The same inside double quotes.
    BraceDq,
    /// Here-document body or arithmetic text: only `$`, backquote and backslash are special.
    Heredoc,
}

struct Pending {
    delim: String,
    strip: bool,
    quoted: bool,
    body: Rc<RefCell<Word>>,
}

pub struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    pending: Vec<Pending>,
    /// Reading the right-hand side of `=~` inside `[[ ]]`: only blanks end a word.
    regex_word: bool,
}

fn is_name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}
fn is_name(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
pub fn valid_name(s: &str) -> bool {
    !s.is_empty() && is_name_start(s.as_bytes()[0]) && s.bytes().all(is_name)
}

pub fn parse(src: &str) -> PR<Cmd> {
    let mut p = Parser::new(src.as_bytes());
    let c = p.list()?;
    p.newlines()?;
    if p.i < p.s.len() {
        return Err(p.unexpected());
    }
    Ok(c)
}

/// Text in which only `$`-forms and backquotes are expanded (here-documents, arithmetic).
pub fn parse_text(src: &str) -> PR<Word> {
    Parser::new(src.as_bytes()).parts(Ctx::Heredoc, false)
}

impl<'a> Parser<'a> {
    fn new(s: &'a [u8]) -> Parser<'a> {
        Parser { s, i: 0, pending: Vec::new(), regex_word: false }
    }
    fn peek(&self) -> u8 {
        self.at(0)
    }
    fn at(&self, k: usize) -> u8 {
        self.s.get(self.i + k).copied().unwrap_or(0)
    }
    fn starts(&self, t: &str) -> bool {
        self.s[self.i..].starts_with(t.as_bytes())
    }
    fn is_meta(&self, c: u8) -> bool {
        if self.regex_word {
            return matches!(c, b' ' | b'\t' | b'\n');
        }
        matches!(c, b' ' | b'\t' | b'\n' | b'|' | b'&' | b';' | b'(' | b')' | b'<' | b'>')
    }
    fn unexpected(&self) -> String {
        if self.i >= self.s.len() {
            return "syntax error: unexpected end of file".into();
        }
        let rest = &self.s[self.i..];
        let end = rest.iter().position(|c| matches!(c, b' ' | b'\n' | b'\t')).unwrap_or(rest.len()).clamp(1, 12).min(rest.len());
        let tok = String::from_utf8_lossy(&rest[..end]);
        format!("syntax error near unexpected token `{}'", if tok == "\n" { "newline".into() } else { tok })
    }

    /// Blanks, line continuations and a comment.
    fn blank(&mut self) {
        loop {
            match self.peek() {
                b' ' | b'\t' | b'\r' => self.i += 1,
                b'\\' if self.at(1) == b'\n' => self.i += 2,
                b'#' => {
                    while self.i < self.s.len() && self.s[self.i] != b'\n' {
                        self.i += 1;
                    }
                }
                _ => break,
            }
        }
    }
    fn newlines(&mut self) -> PR<()> {
        loop {
            self.blank();
            if self.peek() == b'\n' {
                self.i += 1;
                self.heredocs()?;
            } else {
                return Ok(());
            }
        }
    }
    /// Called just after a newline: read the bodies of the here-documents announced on that line.
    fn heredocs(&mut self) -> PR<()> {
        for p in std::mem::take(&mut self.pending) {
            let mut body: Vec<u8> = Vec::new();
            loop {
                if self.i >= self.s.len() {
                    break;
                }
                let end = self.s[self.i..].iter().position(|c| *c == b'\n').map(|n| self.i + n).unwrap_or(self.s.len());
                let mut line = &self.s[self.i..end];
                self.i = (end + 1).min(self.s.len());
                if p.strip {
                    while line.first() == Some(&b'\t') {
                        line = &line[1..];
                    }
                }
                if line == p.delim.as_bytes() {
                    break;
                }
                body.extend_from_slice(line);
                body.push(b'\n');
            }
            let text = String::from_utf8_lossy(&body).into_owned();
            *p.body.borrow_mut() = if p.quoted { vec![Part::Quoted(text)] } else { parse_text(&text)? };
        }
        Ok(())
    }

    /// The unquoted word at the cursor, for recognising reserved words.
    fn kw(&self) -> &'a str {
        let mut j = self.i;
        while j < self.s.len() {
            let c = self.s[j];
            if self.is_meta(c) || matches!(c, b'\'' | b'"' | b'\\' | b'$' | b'`') {
                break;
            }
            j += 1;
        }
        std::str::from_utf8(&self.s[self.i..j]).unwrap_or("")
    }
    fn at_list_end(&self) -> bool {
        if self.i >= self.s.len() || self.peek() == b')' || self.starts(";;") || self.starts(";&") {
            return true;
        }
        matches!(self.kw(), "then" | "else" | "elif" | "fi" | "do" | "done" | "esac" | "}")
    }
    fn expect_kw(&mut self, name: &str) -> PR<()> {
        self.newlines()?;
        if self.kw() == name {
            self.i += name.len();
            Ok(())
        } else {
            Err(format!("{} (expected `{}')", self.unexpected(), name))
        }
    }

    pub fn list(&mut self) -> PR<Cmd> {
        let mut items = Vec::new();
        loop {
            self.newlines()?;
            if self.at_list_end() {
                break;
            }
            let c = self.and_or()?;
            self.blank();
            let mut bg = false;
            let mut more = true;
            match self.peek() {
                b'&' if self.at(1) != b'&' => {
                    self.i += 1;
                    bg = true;
                }
                b';' if self.at(1) != b';' && self.at(1) != b'&' => self.i += 1,
                b'\n' => {}
                _ => more = false,
            }
            items.push((c, bg));
            if !more {
                break;
            }
        }
        if items.len() == 1 && !items[0].1 {
            return Ok(items.pop().unwrap().0);
        }
        Ok(Cmd::List(items))
    }

    fn and_or(&mut self) -> PR<Cmd> {
        let first = self.pipeline()?;
        let mut rest = Vec::new();
        loop {
            self.blank();
            let and = if self.starts("&&") {
                true
            } else if self.starts("||") {
                false
            } else {
                break;
            };
            self.i += 2;
            self.newlines()?;
            rest.push((and, self.pipeline()?));
        }
        if rest.is_empty() {
            Ok(first)
        } else {
            Ok(Cmd::AndOr { first: Box::new(first), rest })
        }
    }

    fn pipeline(&mut self) -> PR<Cmd> {
        self.blank();
        let mut negate = false;
        while self.kw() == "!" {
            self.i += 1;
            negate = !negate;
            self.blank();
        }
        let mut cmds = vec![self.command()?];
        loop {
            self.blank();
            if self.peek() == b'|' && self.at(1) != b'|' {
                self.i += 1;
                if self.peek() == b'&' {
                    // `|&`: stderr joins the pipe.
                    self.i += 1;
                    let dup = Redir { fd: Some(2), op: RedirOp::DupOut, target: vec![Part::Lit("1".into())], body: Default::default() };
                    match cmds.last_mut() {
                        Some(Cmd::Simple { redirs, .. }) | Some(Cmd::Group(_, redirs)) | Some(Cmd::Subshell(_, redirs)) => redirs.push(dup),
                        _ => {}
                    }
                }
                self.newlines()?;
                cmds.push(self.command()?);
            } else {
                break;
            }
        }
        if cmds.len() == 1 && !negate {
            Ok(cmds.pop().unwrap())
        } else {
            Ok(Cmd::Pipeline { negate, cmds })
        }
    }

    fn redirs(&mut self) -> PR<Vec<Redir>> {
        let mut out = Vec::new();
        loop {
            self.blank();
            match self.try_redir()? {
                Some(r) => out.push(r),
                None => return Ok(out),
            }
        }
    }

    fn command(&mut self) -> PR<Cmd> {
        self.blank();
        if self.peek() == b'(' {
            if self.at(1) == b'(' {
                if let Some(end) = self.find_arith_end(self.i + 2) {
                    let text = String::from_utf8_lossy(&self.s[self.i + 2..end]).into_owned();
                    self.i = end + 2;
                    return Ok(Cmd::Arith(parse_text(&text)?));
                }
            }
            self.i += 1;
            let body = self.list()?;
            self.newlines()?;
            if self.peek() != b')' {
                return Err(self.unexpected());
            }
            self.i += 1;
            return Ok(Cmd::Subshell(Box::new(body), self.redirs()?));
        }
        match self.kw() {
            "{" => {
                self.i += 1;
                let body = self.list()?;
                self.expect_kw("}")?;
                Ok(Cmd::Group(Box::new(body), self.redirs()?))
            }
            "if" => {
                self.i += 2;
                let mut clauses = Vec::new();
                let mut otherwise = None;
                let cond = self.list()?;
                self.expect_kw("then")?;
                clauses.push((cond, self.list()?));
                loop {
                    self.newlines()?;
                    match self.kw() {
                        "elif" => {
                            self.i += 4;
                            let cond = self.list()?;
                            self.expect_kw("then")?;
                            clauses.push((cond, self.list()?));
                        }
                        "else" => {
                            self.i += 4;
                            otherwise = Some(Box::new(self.list()?));
                            self.expect_kw("fi")?;
                            break;
                        }
                        "fi" => {
                            self.i += 2;
                            break;
                        }
                        _ => return Err(format!("{} (expected `fi')", self.unexpected())),
                    }
                }
                Ok(Cmd::If { clauses, otherwise, redirs: self.redirs()? })
            }
            k @ ("while" | "until") => {
                self.i += 5;
                let cond = self.list()?;
                self.expect_kw("do")?;
                let body = self.list()?;
                self.expect_kw("done")?;
                Ok(Cmd::While { until: k == "until", cond: Box::new(cond), body: Box::new(body), redirs: self.redirs()? })
            }
            "for" => {
                self.i += 3;
                self.blank();
                if self.starts("((") {
                    let end = self.find_arith_end(self.i + 2).ok_or_else(|| self.unexpected())?;
                    let text = String::from_utf8_lossy(&self.s[self.i + 2..end]).into_owned();
                    self.i = end + 2;
                    let mut it = text.splitn(3, ';');
                    let init = parse_text(it.next().unwrap_or(""))?;
                    let cond = parse_text(it.next().unwrap_or(""))?;
                    let step = parse_text(it.next().unwrap_or(""))?;
                    self.blank();
                    if self.peek() == b';' {
                        self.i += 1;
                    }
                    self.expect_kw("do")?;
                    let body = self.list()?;
                    self.expect_kw("done")?;
                    return Ok(Cmd::ForArith { init, cond, step, body: Box::new(body), redirs: self.redirs()? });
                }
                let var = self.kw().to_string();
                if !valid_name(&var) {
                    return Err(self.unexpected());
                }
                self.i += var.len();
                self.newlines()?;
                let mut words = None;
                if self.kw() == "in" {
                    self.i += 2;
                    let mut list = Vec::new();
                    loop {
                        self.blank();
                        let c = self.peek();
                        if c == 0 || self.is_meta(c) {
                            break;
                        }
                        list.push(self.word()?);
                    }
                    words = Some(list);
                }
                self.blank();
                if self.peek() == b';' {
                    self.i += 1;
                }
                self.expect_kw("do")?;
                let body = self.list()?;
                self.expect_kw("done")?;
                Ok(Cmd::For { var, words, body: Box::new(body), redirs: self.redirs()? })
            }
            "case" => {
                self.i += 4;
                self.blank();
                let word = self.word()?;
                self.expect_kw("in")?;
                let mut arms = Vec::new();
                loop {
                    self.newlines()?;
                    if self.kw() == "esac" {
                        self.i += 4;
                        break;
                    }
                    if self.i >= self.s.len() {
                        return Err(self.unexpected());
                    }
                    if self.peek() == b'(' {
                        self.i += 1;
                    }
                    let mut pats = Vec::new();
                    loop {
                        self.blank();
                        pats.push(self.word()?);
                        self.blank();
                        if self.peek() == b'|' {
                            self.i += 1;
                        } else {
                            break;
                        }
                    }
                    if self.peek() != b')' {
                        return Err(self.unexpected());
                    }
                    self.i += 1;
                    let body = self.list()?;
                    self.newlines()?;
                    if self.starts(";;&") {
                        self.i += 3;
                    } else if self.starts(";;") || self.starts(";&") {
                        self.i += 2;
                    }
                    arms.push((pats, body));
                }
                Ok(Cmd::Case { word, arms, redirs: self.redirs()? })
            }
            "function" => {
                self.i += 8;
                self.blank();
                let name = self.kw().to_string();
                if name.is_empty() {
                    return Err(self.unexpected());
                }
                self.i += name.len();
                self.blank();
                if self.peek() == b'(' {
                    self.i += 1;
                    self.blank();
                    if self.peek() != b')' {
                        return Err(self.unexpected());
                    }
                    self.i += 1;
                }
                self.newlines()?;
                Ok(Cmd::FuncDef { name, body: Rc::new(self.command()?) })
            }
            "[[" => {
                self.i += 2;
                let mut toks = Vec::new();
                loop {
                    self.newlines()?;
                    if self.i >= self.s.len() {
                        return Err(self.unexpected());
                    }
                    if self.kw() == "]]" {
                        self.i += 2;
                        break;
                    }
                    if self.starts("&&") || self.starts("||") {
                        toks.push(CondTok::Op(String::from_utf8_lossy(&self.s[self.i..self.i + 2]).into_owned()));
                        self.i += 2;
                    } else if matches!(self.peek(), b'(' | b')' | b'<' | b'>') {
                        toks.push(CondTok::Op((self.peek() as char).to_string()));
                        self.i += 1;
                    } else if self.kw() == "!" {
                        toks.push(CondTok::Op("!".into()));
                        self.i += 1;
                    } else {
                        let after_match = matches!(toks.last(), Some(CondTok::W(w)) if matches!(w.as_slice(), [Part::Lit(s)] if s == "=~"));
                        self.regex_word = after_match;
                        let w = self.word();
                        self.regex_word = false;
                        toks.push(CondTok::W(w?));
                    }
                }
                Ok(Cmd::Cond(toks))
            }
            "then" | "else" | "elif" | "fi" | "do" | "done" | "esac" | "}" => Err(self.unexpected()),
            _ => self.simple(),
        }
    }

    fn simple(&mut self) -> PR<Cmd> {
        let mut assigns = Vec::new();
        let mut words: Vec<Word> = Vec::new();
        let mut redirs = Vec::new();
        loop {
            self.blank();
            if let Some(r) = self.try_redir()? {
                redirs.push(r);
                continue;
            }
            let c = self.peek();
            if c == 0 || self.is_meta(c) {
                break;
            }
            let w = self.word()?;
            if words.is_empty() {
                if let Some(a) = as_assign(&w) {
                    assigns.push(a);
                    continue;
                }
            }
            words.push(w);
            if words.len() == 1 && assigns.is_empty() && redirs.is_empty() {
                let save = self.i;
                self.blank();
                if self.peek() == b'(' {
                    self.i += 1;
                    self.blank();
                    if self.peek() == b')' {
                        if let [Part::Lit(name)] = words[0].as_slice() {
                            let name = name.clone();
                            self.i += 1;
                            self.newlines()?;
                            return Ok(Cmd::FuncDef { name, body: Rc::new(self.command()?) });
                        }
                    }
                }
                self.i = save;
            }
        }
        if words.is_empty() && assigns.is_empty() && redirs.is_empty() {
            return Err(self.unexpected());
        }
        Ok(Cmd::Simple { assigns, words, redirs })
    }

    fn try_redir(&mut self) -> PR<Option<Redir>> {
        let save = self.i;
        let mut fd = None;
        let mut j = self.i;
        while j < self.s.len() && self.s[j].is_ascii_digit() {
            j += 1;
        }
        if j > self.i && j < self.s.len() && matches!(self.s[j], b'<' | b'>') {
            fd = std::str::from_utf8(&self.s[self.i..j]).ok().and_then(|t| t.parse().ok());
            self.i = j;
        }
        let op = if self.starts("&>>") {
            self.i += 3;
            RedirOp::OutErr { append: true }
        } else if self.starts("&>") {
            self.i += 2;
            RedirOp::OutErr { append: false }
        } else if self.starts("<<<") {
            self.i += 3;
            RedirOp::HereStr
        } else if self.starts("<<") {
            self.i += 2;
            let strip = self.peek() == b'-';
            if strip {
                self.i += 1;
            }
            self.blank();
            let w = self.word()?;
            let quoted = w.iter().any(|p| !matches!(p, Part::Lit(_)));
            let mut delim = String::new();
            flatten_literal(&w, &mut delim);
            let body: Rc<RefCell<Word>> = Default::default();
            self.pending.push(Pending { delim, strip, quoted, body: body.clone() });
            return Ok(Some(Redir { fd, op: RedirOp::HereDoc, target: Vec::new(), body }));
        } else if self.starts("<&") {
            self.i += 2;
            RedirOp::DupIn
        } else if self.starts("<>") {
            self.i += 2;
            RedirOp::InOut
        } else if self.starts("<") && self.at(1) != b'(' {
            self.i += 1;
            RedirOp::In
        } else if self.starts(">>") {
            self.i += 2;
            RedirOp::Append
        } else if self.starts(">&") {
            self.i += 2;
            RedirOp::DupOut
        } else if self.starts(">|") {
            self.i += 2;
            RedirOp::Out
        } else if self.starts(">") && self.at(1) != b'(' {
            self.i += 1;
            RedirOp::Out
        } else {
            self.i = save;
            return Ok(None);
        };
        self.blank();
        let c = self.peek();
        if c == 0 || self.is_meta(c) {
            return Err(self.unexpected());
        }
        let target = self.word()?;
        Ok(Some(Redir { fd, op, target, body: Default::default() }))
    }

    fn word(&mut self) -> PR<Word> {
        let w = self.parts(Ctx::Normal, false)?;
        if w.is_empty() {
            return Err(self.unexpected());
        }
        Ok(w)
    }

    fn find_arith_end(&self, start: usize) -> Option<usize> {
        let mut depth = 0;
        let mut j = start;
        while j < self.s.len() {
            match self.s[j] {
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        return if self.s.get(j + 1) == Some(&b')') { Some(j) } else { None };
                    }
                    depth -= 1;
                }
                _ => {}
            }
            j += 1;
        }
        None
    }

    fn parts(&mut self, ctx: Ctx, stop_slash: bool) -> PR<Word> {
        let mut out: Word = Vec::new();
        let mut lit: Vec<u8> = Vec::new();
        let quoted_lit = matches!(ctx, Ctx::Dq | Ctx::BraceDq | Ctx::Heredoc);
        fn flush(lit: &mut Vec<u8>, out: &mut Word, quoted: bool) {
            if !lit.is_empty() {
                let s = String::from_utf8_lossy(lit).into_owned();
                out.push(if quoted { Part::Quoted(s) } else { Part::Lit(s) });
                lit.clear();
            }
        }
        let unq = matches!(ctx, Ctx::Normal | Ctx::BraceUnq);
        loop {
            let c = self.peek();
            if self.i >= self.s.len() {
                break;
            }
            match ctx {
                Ctx::Normal => {
                    if self.is_meta(c) {
                        break;
                    }
                }
                Ctx::Dq => {
                    if c == b'"' {
                        break;
                    }
                }
                Ctx::BraceUnq | Ctx::BraceDq => {
                    if c == b'}' || (stop_slash && c == b'/') {
                        break;
                    }
                }
                Ctx::Heredoc => {}
            }
            match c {
                b'\\' => {
                    let n = self.at(1);
                    if n == b'\n' {
                        self.i += 2;
                    } else if unq {
                        if self.i + 1 >= self.s.len() {
                            lit.push(b'\\');
                            self.i += 1;
                        } else {
                            flush(&mut lit, &mut out, quoted_lit);
                            let len = utf8_len(n).min(self.s.len() - self.i - 1);
                            out.push(Part::Quoted(String::from_utf8_lossy(&self.s[self.i + 1..self.i + 1 + len]).into_owned()));
                            self.i += 1 + len;
                        }
                    } else if matches!(n, b'$' | b'`' | b'\\') || (n == b'"' && ctx != Ctx::Heredoc) || (n == b'}' && ctx == Ctx::BraceDq) {
                        lit.push(n);
                        self.i += 2;
                    } else {
                        lit.push(b'\\');
                        self.i += 1;
                    }
                }
                b'\'' if unq => {
                    flush(&mut lit, &mut out, quoted_lit);
                    let start = self.i + 1;
                    let end = self.s[start..].iter().position(|c| *c == b'\'').map(|n| start + n).ok_or("syntax error: unterminated quoted string")?;
                    out.push(Part::Quoted(String::from_utf8_lossy(&self.s[start..end]).into_owned()));
                    self.i = end + 1;
                }
                b'"' if unq => {
                    flush(&mut lit, &mut out, quoted_lit);
                    self.i += 1;
                    let inner = self.parts(Ctx::Dq, false)?;
                    if self.peek() != b'"' {
                        return Err("syntax error: unterminated quoted string".into());
                    }
                    self.i += 1;
                    out.push(Part::Dq(inner));
                }
                b'"' if ctx == Ctx::BraceDq => self.i += 1,
                b'$' if unq && self.at(1) == b'\'' => {
                    flush(&mut lit, &mut out, quoted_lit);
                    self.i += 2;
                    out.push(Part::Quoted(self.ansi_c()?));
                }
                b'$' if unq && self.at(1) == b'"' => self.i += 1,
                b'$' => {
                    flush(&mut lit, &mut out, quoted_lit);
                    out.push(self.dollar(!unq)?);
                }
                b'`' => {
                    flush(&mut lit, &mut out, quoted_lit);
                    let mut text: Vec<u8> = Vec::new();
                    self.i += 1;
                    loop {
                        if self.i >= self.s.len() {
                            return Err("syntax error: unterminated backquote".into());
                        }
                        let c = self.s[self.i];
                        if c == b'`' {
                            self.i += 1;
                            break;
                        }
                        if c == b'\\' && matches!(self.at(1), b'`' | b'\\' | b'$') {
                            text.push(self.at(1));
                            self.i += 2;
                        } else {
                            text.push(c);
                            self.i += 1;
                        }
                    }
                    let text = String::from_utf8_lossy(&text).into_owned();
                    out.push(Part::CmdSub(Rc::new(parse(&text)?)));
                }
                _ => {
                    lit.push(c);
                    self.i += 1;
                }
            }
        }
        flush(&mut lit, &mut out, quoted_lit);
        Ok(out)
    }

    fn ansi_c(&mut self) -> PR<String> {
        let mut out: Vec<u8> = Vec::new();
        loop {
            if self.i >= self.s.len() {
                return Err("syntax error: unterminated quoted string".into());
            }
            let c = self.s[self.i];
            self.i += 1;
            if c == b'\'' {
                break;
            }
            if c != b'\\' {
                out.push(c);
                continue;
            }
            let n = self.peek();
            self.i += 1;
            match n {
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'r' => out.push(b'\r'),
                b'a' => out.push(7),
                b'b' => out.push(8),
                b'e' | b'E' => out.push(27),
                b'f' => out.push(12),
                b'v' => out.push(11),
                b'0'..=b'7' => {
                    let mut v = (n - b'0') as u32;
                    for _ in 0..2 {
                        if matches!(self.peek(), b'0'..=b'7') {
                            v = v * 8 + (self.peek() - b'0') as u32;
                            self.i += 1;
                        }
                    }
                    out.push(v as u8);
                }
                b'x' | b'u' => {
                    let max = if n == b'x' { 2 } else { 4 };
                    let mut v = 0u32;
                    let mut k = 0;
                    while k < max && self.peek().is_ascii_hexdigit() {
                        v = v * 16 + (self.peek() as char).to_digit(16).unwrap();
                        self.i += 1;
                        k += 1;
                    }
                    if n == b'x' {
                        out.push(v as u8);
                    } else {
                        let mut b = [0u8; 4];
                        out.extend_from_slice(char::from_u32(v).unwrap_or('?').encode_utf8(&mut b).as_bytes());
                    }
                }
                other => out.push(other),
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    fn name(&mut self) -> String {
        let start = self.i;
        let c = self.peek();
        if is_name_start(c) {
            while is_name(self.peek()) {
                self.i += 1;
            }
        } else if c.is_ascii_digit() {
            while self.peek().is_ascii_digit() {
                self.i += 1;
            }
        } else if matches!(c, b'@' | b'*' | b'#' | b'?' | b'$' | b'!' | b'-') {
            self.i += 1;
        }
        String::from_utf8_lossy(&self.s[start..self.i]).into_owned()
    }

    fn dollar(&mut self, in_dq: bool) -> PR<Part> {
        let n = self.at(1);
        if n == b'(' {
            if self.at(2) == b'(' {
                if let Some(end) = self.find_arith_end(self.i + 3) {
                    let text = String::from_utf8_lossy(&self.s[self.i + 3..end]).into_owned();
                    self.i = end + 2;
                    return Ok(Part::Arith(parse_text(&text)?));
                }
            }
            self.i += 2;
            let saved = std::mem::replace(&mut self.regex_word, false);
            let c = if self.at_only_close() { Cmd::List(Vec::new()) } else { self.list()? };
            self.newlines()?;
            self.regex_word = saved;
            if self.peek() != b')' {
                return Err("syntax error: unterminated command substitution".into());
            }
            self.i += 1;
            return Ok(Part::CmdSub(Rc::new(c)));
        }
        if n == b'{' {
            return self.param_brace(in_dq);
        }
        if is_name_start(n) {
            self.i += 1;
            let name = self.name();
            return Ok(Part::Param(Box::new(Param { name, op: ParamOp::Plain })));
        }
        if n.is_ascii_digit() || matches!(n, b'@' | b'*' | b'#' | b'?' | b'$' | b'!' | b'-') {
            self.i += 2;
            return Ok(Part::Param(Box::new(Param { name: (n as char).to_string(), op: ParamOp::Plain })));
        }
        self.i += 1;
        Ok(Part::Quoted("$".into()))
    }
    fn at_only_close(&mut self) -> bool {
        self.blank();
        self.peek() == b')'
    }

    fn param_brace(&mut self, in_dq: bool) -> PR<Part> {
        let bad = || -> String { "bad substitution".into() };
        self.i += 2;
        if self.peek() == b'#' && self.at(1) != b'}' {
            let save = self.i;
            self.i += 1;
            let name = self.name();
            self.skip_subscript();
            if !name.is_empty() && self.peek() == b'}' {
                self.i += 1;
                return Ok(Part::Param(Box::new(Param { name, op: ParamOp::Len })));
            }
            self.i = save;
        }
        let name = self.name();
        if name.is_empty() {
            return Err(bad());
        }
        self.skip_subscript();
        let wctx = if in_dq { Ctx::BraceDq } else { Ctx::BraceUnq };
        let c = self.peek();
        let op = match c {
            b'}' => ParamOp::Plain,
            b':' if matches!(self.at(1), b'-' | b'=' | b'+' | b'?') => {
                let kind = self.at(1);
                self.i += 2;
                ParamOp::Default { colon: true, kind, word: self.parts(wctx, false)? }
            }
            b':' => {
                self.i += 1;
                // Offsets are arithmetic: take the raw text up to the closing brace.
                let start = self.i;
                let mut depth = 0;
                while self.i < self.s.len() {
                    match self.s[self.i] {
                        b'{' => depth += 1,
                        b'}' if depth == 0 => break,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    self.i += 1;
                }
                let raw = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                let (off, len) = match raw.split_once(':') {
                    Some((a, b)) => (parse_text(a)?, Some(parse_text(b)?)),
                    None => (parse_text(&raw)?, None),
                };
                ParamOp::Slice { off, len }
            }
            b'-' | b'=' | b'+' | b'?' => {
                self.i += 1;
                ParamOp::Default { colon: false, kind: c, word: self.parts(wctx, false)? }
            }
            b'#' | b'%' => {
                self.i += 1;
                let longest = self.peek() == c;
                if longest {
                    self.i += 1;
                }
                ParamOp::Trim { suffix: c == b'%', longest, pat: self.parts(Ctx::BraceUnq, false)? }
            }
            b'/' => {
                self.i += 1;
                let all = self.peek() == b'/';
                if all {
                    self.i += 1;
                }
                let pat = self.parts(Ctx::BraceUnq, true)?;
                let rep = if self.peek() == b'/' {
                    self.i += 1;
                    self.parts(wctx, false)?
                } else {
                    Vec::new()
                };
                ParamOp::Subst { all, pat, rep }
            }
            b'^' | b',' => {
                self.i += 1;
                let all = self.peek() == c;
                if all {
                    self.i += 1;
                }
                ParamOp::Case { upper: c == b'^', all }
            }
            _ => return Err(bad()),
        };
        if self.peek() != b'}' {
            return Err(bad());
        }
        self.i += 1;
        Ok(Part::Param(Box::new(Param { name, op })))
    }
    /// `${name[@]}`: there are no arrays; the subscript is accepted and ignored.
    fn skip_subscript(&mut self) {
        if self.peek() == b'[' {
            if let Some(n) = self.s[self.i..].iter().position(|c| *c == b']') {
                self.i += n + 1;
            }
        }
    }
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

fn flatten_literal(w: &Word, out: &mut String) {
    for p in w {
        match p {
            Part::Lit(s) | Part::Quoted(s) => out.push_str(s),
            Part::Dq(inner) => flatten_literal(inner, out),
            _ => {}
        }
    }
}

fn as_assign(w: &Word) -> Option<Assign> {
    let Part::Lit(first) = w.first()? else { return None };
    let eq = first.find('=')?;
    let (mut name, rest) = (&first[..eq], &first[eq + 1..]);
    let append = name.ends_with('+');
    if append {
        name = &name[..name.len() - 1];
    }
    if !valid_name(name) {
        return None;
    }
    let mut value: Word = Vec::new();
    if !rest.is_empty() {
        value.push(Part::Lit(rest.to_string()));
    }
    value.extend(w[1..].iter().cloned());
    Some(Assign { name: name.to_string(), append, value })
}
