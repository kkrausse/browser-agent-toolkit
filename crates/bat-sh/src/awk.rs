//! `awk`: a tree-walking interpreter for the language as agents write it.
//!
//! Supported: patterns (`BEGIN`, `END`, expressions, `/re/`, ranges), all
//! operators, fields and `NF`/`$0` assignment, associative arrays (`in`,
//! `delete`, `SUBSEP`), `if`/`while`/`do`/`for`/`for (k in a)`, `next`,
//! `nextfile`, `exit`, user functions, `print`/`printf` with `>`, `>>` and
//! `|`, and the functions listed in `builtin`. Numbers and strings follow awk's
//! rules (numeric strings from input compare as numbers, `CONVFMT`/`OFMT`).
//!
//! Not supported, refused when the program is parsed: `getline` in every form,
//! `BEGINFILE`/`ENDFILE`, `@include`, `switch`, indirect calls. `for (k in a)`
//! visits keys in the order they were first assigned (gawk's order is
//! unspecified), or as `PROCINFO["sorted_in"]` says.
use crate::interp::{Interp, Io, X};
use crate::sys;
use regex_lite::Regex;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

// ---- tokens ----

#[derive(Clone, Debug, PartialEq)]
enum T {
    Num(f64),
    Str(String),
    Re(String),
    Name(String),
    /// A name directly followed by `(`: a call of a user function.
    Func(String),
    Kw(&'static str),
    Op(&'static str),
    Nl,
    Eof,
}

const KEYWORDS: &[&str] = &[
    "BEGIN", "END", "BEGINFILE", "ENDFILE", "function", "func", "if", "else", "while", "for", "do", "break", "continue", "next", "nextfile", "exit", "return", "delete", "in",
    "getline", "print", "printf", "switch", "case", "default",
];

const OPS: &[&str] = &[
    "**=", "**", "+=", "-=", "*=", "/=", "%=", "^=", "==", "<=", ">=", "!=", "!~", "++", "--", "&&", "||", ">>", "{", "}", "(", ")", "[", "]", ";", ",", "+", "-", "*", "/", "%",
    "^", "!", ">", "<", "|", "?", ":", "~", "$", "=",
];

fn escape_char(b: &[u8], i: &mut usize, out: &mut String) {
    // `b[*i]` is the character after the backslash.
    let c = b[*i];
    *i += 1;
    match c {
        b'n' => out.push('\n'),
        b't' => out.push('\t'),
        b'r' => out.push('\r'),
        b'a' => out.push('\x07'),
        b'b' => out.push('\x08'),
        b'f' => out.push('\x0c'),
        b'v' => out.push('\x0b'),
        b'\\' => out.push('\\'),
        b'"' => out.push('"'),
        b'/' => out.push('/'),
        b'0'..=b'7' => {
            let mut v = (c - b'0') as u32;
            let mut k = 1;
            while k < 3 && *i < b.len() && (b'0'..=b'7').contains(&b[*i]) {
                v = v * 8 + (b[*i] - b'0') as u32;
                *i += 1;
                k += 1;
            }
            out.push(char::from_u32(v).unwrap_or('?'));
        }
        b'x' if *i < b.len() && b[*i].is_ascii_hexdigit() => {
            let mut v = 0u32;
            let mut k = 0;
            while k < 2 && *i < b.len() && b[*i].is_ascii_hexdigit() {
                v = v * 16 + (b[*i] as char).to_digit(16).unwrap();
                *i += 1;
                k += 1;
            }
            out.push(char::from_u32(v).unwrap_or('?'));
        }
        // gawk: an unknown escape is the character itself.
        _ => {
            *i -= 1;
        }
    }
}

/// Escapes of a string given on the command line (`-v`, `-F`, `var=value`).
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            i += 1;
            let before = out.len();
            let at = i;
            escape_char(b, &mut i, &mut out);
            if i == at && out.len() == before {
                // Unknown escape: keep the backslash (it may be a regex escape, as in -F'\|').
                out.push('\\');
            }
            continue;
        }
        let n = s[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        out.push_str(&s[i..i + n]);
        i += n;
    }
    out
}

fn lex(src: &str) -> Result<Vec<T>, String> {
    let b = src.as_bytes();
    let mut out: Vec<T> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\r' => i += 1,
            b'\\' if b.get(i + 1) == Some(&b'\n') => i += 2,
            b'\\' if b.get(i + 1) == Some(&b'\r') && b.get(i + 2) == Some(&b'\n') => i += 3,
            b'#' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'\n' => {
                out.push(T::Nl);
                i += 1;
            }
            b'"' => {
                i += 1;
                let mut s = String::new();
                loop {
                    match b.get(i) {
                        None | Some(b'\n') => return Err("unterminated string".into()),
                        Some(b'"') => {
                            i += 1;
                            break;
                        }
                        Some(b'\\') if i + 1 < b.len() => {
                            i += 1;
                            if b[i] == b'\n' {
                                i += 1;
                                continue;
                            }
                            escape_char(b, &mut i, &mut s);
                        }
                        Some(_) => {
                            let n = src[i..].chars().next().map(char::len_utf8).unwrap_or(1);
                            s.push_str(&src[i..i + n]);
                            i += n;
                        }
                    }
                }
                out.push(T::Str(s));
            }
            b'0'..=b'9' | b'.' if c != b'.' || b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                let start = i;
                if c == b'0' && matches!(b.get(i + 1), Some(b'x' | b'X')) && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit) {
                    i += 2;
                    while i < b.len() && b[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                    out.push(T::Num(u64::from_str_radix(&src[start + 2..i], 16).unwrap_or(0) as f64));
                    continue;
                }
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                let mut float = false;
                if i < b.len() && b[i] == b'.' {
                    float = true;
                    i += 1;
                    while i < b.len() && b[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
                    let mut j = i + 1;
                    if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
                        j += 1;
                    }
                    if j < b.len() && b[j].is_ascii_digit() {
                        float = true;
                        while j < b.len() && b[j].is_ascii_digit() {
                            j += 1;
                        }
                        i = j;
                    }
                }
                let text = &src[start..i];
                // gawk reads a source constant with a leading zero as octal.
                let v = if !float && text.len() > 1 && text.starts_with('0') && text.bytes().all(|d| (b'0'..=b'7').contains(&d)) {
                    u64::from_str_radix(text, 8).unwrap_or(0) as f64
                } else {
                    text.parse::<f64>().map_err(|_| format!("bad number {text}"))?
                };
                out.push(T::Num(v));
            }
            b'A'..=b'Z' | b'a'..=b'z' | b'_' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                let name = &src[start..i];
                if let Some(k) = KEYWORDS.iter().find(|k| **k == name) {
                    out.push(T::Kw(if *k == "func" { "function" } else { k }));
                } else if b.get(i) == Some(&b'(') && builtin(name).is_none() {
                    out.push(T::Func(name.to_string()));
                } else {
                    out.push(T::Name(name.to_string()));
                }
            }
            b'/' if !matches!(out.last(), Some(T::Num(_) | T::Str(_) | T::Name(_) | T::Op(")" | "]" | "++" | "--"))) => {
                i += 1;
                let mut s = String::new();
                let mut in_class = false;
                loop {
                    match b.get(i) {
                        None | Some(b'\n') => return Err("unterminated regexp".into()),
                        Some(b'/') if !in_class => {
                            i += 1;
                            break;
                        }
                        Some(b'\\') if i + 1 < b.len() => {
                            if b[i + 1] == b'/' {
                                s.push('/');
                            } else {
                                s.push('\\');
                                s.push(b[i + 1] as char);
                            }
                            i += 2;
                        }
                        Some(ch) => {
                            if *ch == b'[' && !in_class {
                                in_class = true;
                                // `]` first in a class is literal.
                                let mut j = i + 1;
                                if b.get(j) == Some(&b'^') {
                                    j += 1;
                                }
                                if b.get(j) == Some(&b']') {
                                    s.push_str(&src[i..=j]);
                                    i = j + 1;
                                    continue;
                                }
                            } else if *ch == b'[' && in_class && b.get(i + 1) == Some(&b':') {
                                // [:class:]
                                if let Some(end) = src[i..].find(":]") {
                                    s.push_str(&src[i..i + end + 2]);
                                    i += end + 2;
                                    continue;
                                }
                            } else if *ch == b']' {
                                in_class = false;
                            }
                            let n = src[i..].chars().next().map(char::len_utf8).unwrap_or(1);
                            s.push_str(&src[i..i + n]);
                            i += n;
                        }
                    }
                }
                out.push(T::Re(s));
            }
            _ => {
                let Some(op) = OPS.iter().find(|op| src[i..].starts_with(**op)) else {
                    return Err(format!("unexpected character '{}'", src[i..].chars().next().unwrap_or('?')));
                };
                i += op.len();
                out.push(T::Op(match *op {
                    "**" => "^",
                    "**=" => "^=",
                    o => o,
                }));
            }
        }
    }
    out.push(T::Eof);
    Ok(out)
}

// ---- syntax tree ----

#[derive(Clone, Copy, PartialEq, Debug)]
enum V {
    G(usize),
    L(usize),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum B {
    Length,
    Substr,
    Index,
    Split,
    Sub,
    Gsub,
    Gensub,
    Match,
    Sprintf,
    Sin,
    Cos,
    Atan2,
    Exp,
    Log,
    Sqrt,
    Int,
    Rand,
    Srand,
    Tolower,
    Toupper,
    System,
    Close,
    Fflush,
    Systime,
    Strftime,
    Strtonum,
    Asort,
    Asorti,
}

fn builtin(name: &str) -> Option<B> {
    Some(match name {
        "length" => B::Length,
        "substr" => B::Substr,
        "index" => B::Index,
        "split" => B::Split,
        "sub" => B::Sub,
        "gsub" => B::Gsub,
        "gensub" => B::Gensub,
        "match" => B::Match,
        "sprintf" => B::Sprintf,
        "sin" => B::Sin,
        "cos" => B::Cos,
        "atan2" => B::Atan2,
        "exp" => B::Exp,
        "log" => B::Log,
        "sqrt" => B::Sqrt,
        "int" => B::Int,
        "rand" => B::Rand,
        "srand" => B::Srand,
        "tolower" => B::Tolower,
        "toupper" => B::Toupper,
        "system" => B::System,
        "close" => B::Close,
        "fflush" => B::Fflush,
        "systime" => B::Systime,
        "strftime" => B::Strftime,
        "strtonum" => B::Strtonum,
        "asort" => B::Asort,
        "asorti" => B::Asorti,
        _ => return None,
    })
}

enum E {
    Num(f64),
    Str(Rc<str>),
    /// `/re/` and its source (compiled again without case when IGNORECASE is set).
    Re(Rc<Regex>, Rc<str>),
    Var(V),
    Field(Box<E>),
    Idx(V, Vec<E>),
    In(Vec<E>, V),
    Assign(Box<E>, Box<E>),
    Aug(Box<E>, u8, Box<E>),
    Cond(Box<E>, Box<E>, Box<E>),
    And(Box<E>, Box<E>),
    Or(Box<E>, Box<E>),
    Not(Box<E>),
    Neg(Box<E>),
    Pos(Box<E>),
    /// `+ - * / % ^`
    Bin(u8, Box<E>, Box<E>),
    /// `<` `l` (<=) `=` `!` (!=) `>` `g` (>=)
    Cmp(u8, Box<E>, Box<E>),
    Match(bool, Box<E>, Box<E>),
    Cat(Box<E>, Box<E>),
    Inc { target: Box<E>, delta: f64, post: bool },
    Call(B, Vec<E>),
    User(usize, Vec<E>),
    /// `(a, b)`: only before `in`, or as the argument list of print.
    Group(Vec<E>),
}

enum S {
    Expr(E),
    /// arguments, `printf`?, destination (`>` `a`ppend `|`)
    Print(Vec<E>, bool, Option<(u8, E)>),
    If(E, Box<S>, Option<Box<S>>),
    While(E, Box<S>),
    Do(Box<S>, E),
    For(Option<Box<S>>, Option<E>, Option<Box<S>>, Box<S>),
    ForIn(V, V, Box<S>),
    Block(Vec<S>),
    Next,
    NextFile,
    Exit(Option<E>),
    Return(Option<E>),
    Break,
    Continue,
    Delete(V, Option<Vec<E>>),
}

enum Pat {
    Begin,
    End,
    Always,
    Expr(E),
    Range(E, E),
}

struct Func {
    name: String,
    nparams: usize,
    body: Option<S>,
}

struct Prog {
    rules: Vec<(Pat, S)>,
    funcs: Vec<Func>,
    globals: HashMap<String, usize>,
}

// Fixed slots of the special variables.
const NR: usize = 0;
const NF: usize = 1;
const FNR: usize = 2;
const FS: usize = 3;
const OFS: usize = 4;
const ORS: usize = 5;
const RS: usize = 6;
const FILENAME: usize = 7;
const SUBSEP: usize = 8;
const RSTART: usize = 9;
const RLENGTH: usize = 10;
const CONVFMT: usize = 11;
const OFMT: usize = 12;
const ENVIRON: usize = 13;
const ARGC: usize = 14;
const ARGV: usize = 15;
const PROCINFO: usize = 16;
const IGNORECASE: usize = 17;
const SPECIALS: &[&str] = &["NR", "NF", "FNR", "FS", "OFS", "ORS", "RS", "FILENAME", "SUBSEP", "RSTART", "RLENGTH", "CONVFMT", "OFMT", "ENVIRON", "ARGC", "ARGV", "PROCINFO", "IGNORECASE"];

// ---- parser ----

struct Parser {
    t: Vec<T>,
    i: usize,
    globals: HashMap<String, usize>,
    locals: Option<HashMap<String, usize>>,
    funcs: Vec<Func>,
    /// Inside the expression list of print: `>` is a redirection.
    no_gt: bool,
    /// Inside the head of `for (`: `in` belongs to the statement.
    no_in: bool,
    /// Inside a BEGIN or END action: `next` is an error.
    in_special: bool,
}

type PR<T> = Result<T, String>;

fn awk_regex(src: &str) -> Result<Regex, String> {
    // The differences between awk's (gawk's) regular expressions and the engine's.
    let (flag, src) = match src.strip_prefix("(?i)") {
        Some(rest) => ("(?i)", rest),
        None => ("", src),
    };
    let b: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() + 4);
    let mut i = 0;
    let mut in_class = false;
    while i < b.len() {
        let c = b[i];
        if c == '\\' && i + 1 < b.len() {
            let n = b[i + 1];
            i += 2;
            match n {
                'y' | '<' | '>' if !in_class => out.push_str("\\b"),
                '/' | '"' | '&' | '\'' | '`' | '%' | '=' | ':' | ',' | ';' | '!' | '@' | '~' | ' ' | '<' | '>' => out.push(n),
                _ => {
                    out.push('\\');
                    out.push(n);
                }
            }
            continue;
        }
        if c == '[' && !in_class {
            in_class = true;
            out.push(c);
            i += 1;
            if i < b.len() && b[i] == '^' {
                out.push('^');
                i += 1;
            }
            if i < b.len() && b[i] == ']' {
                out.push_str("\\]");
                i += 1;
            }
            continue;
        }
        if in_class {
            if c == '[' && i + 1 < b.len() && b[i + 1] == ':' {
                if let Some(end) = b[i..].windows(2).position(|w| w == [':', ']']) {
                    out.extend(&b[i..i + end + 2]);
                    i += end + 2;
                    continue;
                }
            }
            if c == ']' {
                in_class = false;
            } else if c == '[' {
                out.push('\\');
            }
            out.push(c);
            i += 1;
            continue;
        }
        // `{` that does not open an interval is a literal brace.
        if c == '{' {
            let rest: String = b[i + 1..].iter().take_while(|x| **x != '}').collect();
            let interval = !rest.is_empty() && rest.chars().all(|x| x.is_ascii_digit() || x == ',') && rest.starts_with(|x: char| x.is_ascii_digit()) && b.len() > i + 1 + rest.chars().count();
            if !interval || out.is_empty() {
                out.push_str("\\{");
                i += 1;
                continue;
            }
        } else if c == '}' && !out.contains('{') {
            out.push_str("\\}");
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    Regex::new(&format!("{flag}{out}")).map_err(|e| format!("regular expression /{src}/: {e}"))
}

impl Parser {
    fn peek(&self) -> &T {
        &self.t[self.i]
    }
    fn next(&mut self) -> T {
        let t = self.t[self.i].clone();
        if self.i + 1 < self.t.len() {
            self.i += 1;
        }
        t
    }
    fn is_op(&self, op: &str) -> bool {
        matches!(self.peek(), T::Op(o) if *o == op)
    }
    fn is_kw(&self, kw: &str) -> bool {
        matches!(self.peek(), T::Kw(k) if *k == kw)
    }
    fn eat(&mut self, op: &str) -> bool {
        if self.is_op(op) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, op: &str) -> PR<()> {
        if self.eat(op) {
            Ok(())
        } else {
            Err(format!("syntax error: expected '{op}' {}", self.near()))
        }
    }
    fn near(&self) -> String {
        match self.peek() {
            T::Eof => "at the end of the program".into(),
            T::Nl => "at the end of a line".into(),
            T::Num(n) => format!("near {n}"),
            T::Str(s) => format!("near \"{s}\""),
            T::Re(s) => format!("near /{s}/"),
            T::Name(s) | T::Func(s) => format!("near {s}"),
            T::Kw(s) | T::Op(s) => format!("near '{s}'"),
        }
    }
    fn nls(&mut self) {
        while matches!(self.peek(), T::Nl) {
            self.i += 1;
        }
    }
    fn var(&mut self, name: &str) -> V {
        if let Some(l) = self.locals.as_ref().and_then(|l| l.get(name)) {
            return V::L(*l);
        }
        let next = self.globals.len();
        V::G(*self.globals.entry(name.to_string()).or_insert(next))
    }
    fn func(&mut self, name: &str) -> usize {
        match self.funcs.iter().position(|f| f.name == name) {
            Some(i) => i,
            None => {
                self.funcs.push(Func { name: name.to_string(), nparams: 0, body: None });
                self.funcs.len() - 1
            }
        }
    }

    fn program(&mut self) -> PR<Vec<(Pat, S)>> {
        let mut rules = Vec::new();
        loop {
            while matches!(self.peek(), T::Nl) || self.is_op(";") {
                self.i += 1;
            }
            match self.peek().clone() {
                T::Eof => break,
                T::Kw("function") => {
                    self.i += 1;
                    let name = match self.next() {
                        T::Name(n) | T::Func(n) => n,
                        _ => return Err("syntax error: function name expected".into()),
                    };
                    if builtin(&name).is_some() {
                        return Err(format!("function name '{name}' is a built-in function"));
                    }
                    self.expect("(")?;
                    let mut params = HashMap::new();
                    self.nls();
                    while let T::Name(p) = self.peek().clone() {
                        self.i += 1;
                        let n = params.len();
                        params.insert(p, n);
                        self.nls();
                        if !self.eat(",") {
                            break;
                        }
                        self.nls();
                    }
                    self.expect(")")?;
                    self.nls();
                    let nparams = params.len();
                    self.locals = Some(params);
                    let body = self.block()?;
                    self.locals = None;
                    let idx = self.func(&name);
                    if self.funcs[idx].body.is_some() {
                        return Err(format!("function '{name}' is defined twice"));
                    }
                    self.funcs[idx].nparams = nparams;
                    self.funcs[idx].body = Some(body);
                }
                T::Kw("BEGIN") | T::Kw("END") => {
                    let begin = self.is_kw("BEGIN");
                    self.i += 1;
                    self.nls();
                    if !self.is_op("{") {
                        return Err("syntax error: BEGIN and END need an action".into());
                    }
                    self.in_special = true;
                    let body = self.block()?;
                    self.in_special = false;
                    rules.push((if begin { Pat::Begin } else { Pat::End }, body));
                }
                T::Kw(k @ ("BEGINFILE" | "ENDFILE")) => return Err(format!("{k} is not supported by this awk")),
                T::Op("{") => rules.push((Pat::Always, self.block()?)),
                _ => {
                    let first = self.expr()?;
                    let pat = if self.eat(",") {
                        self.nls();
                        Pat::Range(first, self.expr()?)
                    } else {
                        Pat::Expr(first)
                    };
                    let action = if self.is_op("{") { self.block()? } else { S::Print(Vec::new(), false, None) };
                    rules.push((pat, action));
                }
            }
        }
        Ok(rules)
    }

    fn block(&mut self) -> PR<S> {
        self.expect("{")?;
        let mut out = Vec::new();
        loop {
            while matches!(self.peek(), T::Nl) || self.is_op(";") {
                self.i += 1;
            }
            if self.eat("}") {
                return Ok(S::Block(out));
            }
            if matches!(self.peek(), T::Eof) {
                return Err("syntax error: missing '}'".into());
            }
            out.push(self.stmt()?);
        }
    }

    /// A statement that ends at `;`, a newline or `}` (left for the caller).
    fn simple_end(&mut self) -> PR<()> {
        match self.peek() {
            T::Nl | T::Eof | T::Op(";") | T::Op("}") => Ok(()),
            T::Op("|") | T::Op("<") if matches!(self.t.get(self.i + 1), Some(T::Kw("getline"))) || self.t[..self.i].contains(&T::Kw("getline")) => Err("getline is not supported by this awk".into()),
            _ => Err(format!("syntax error {}", self.near())),
        }
    }

    fn stmt(&mut self) -> PR<S> {
        let s = match self.peek().clone() {
            T::Op("{") => return self.block(),
            T::Op(";") => {
                self.i += 1;
                return Ok(S::Block(Vec::new()));
            }
            T::Kw("if") => {
                self.i += 1;
                self.expect("(")?;
                let c = self.expr()?;
                self.expect(")")?;
                self.nls();
                let then = self.stmt()?;
                let save = self.i;
                while matches!(self.peek(), T::Nl) || self.is_op(";") {
                    self.i += 1;
                }
                if self.is_kw("else") {
                    self.i += 1;
                    self.nls();
                    return Ok(S::If(c, Box::new(then), Some(Box::new(self.stmt()?))));
                }
                self.i = save;
                return Ok(S::If(c, Box::new(then), None));
            }
            T::Kw("while") => {
                self.i += 1;
                self.expect("(")?;
                let c = self.expr()?;
                self.expect(")")?;
                if self.is_op(";") {
                    self.i += 1;
                    return Ok(S::While(c, Box::new(S::Block(Vec::new()))));
                }
                self.nls();
                return Ok(S::While(c, Box::new(self.stmt()?)));
            }
            T::Kw("do") => {
                self.i += 1;
                self.nls();
                let body = self.stmt()?;
                while matches!(self.peek(), T::Nl) || self.is_op(";") {
                    self.i += 1;
                }
                if !self.is_kw("while") {
                    return Err(format!("syntax error: 'while' expected after do {}", self.near()));
                }
                self.i += 1;
                self.expect("(")?;
                let c = self.expr()?;
                self.expect(")")?;
                S::Do(Box::new(body), c)
            }
            T::Kw("for") => {
                self.i += 1;
                self.expect("(")?;
                if let (T::Name(k), T::Kw("in"), T::Name(a), T::Op(")")) = (self.t[self.i].clone(), self.t.get(self.i + 1).cloned().unwrap_or(T::Eof), self.t.get(self.i + 2).cloned().unwrap_or(T::Eof), self.t.get(self.i + 3).cloned().unwrap_or(T::Eof)) {
                    self.i += 4;
                    let (k, a) = (self.var(&k), self.var(&a));
                    self.nls();
                    return Ok(S::ForIn(k, a, Box::new(self.stmt()?)));
                }
                let init = if self.is_op(";") { None } else { Some(Box::new(self.simple()?)) };
                self.expect(";")?;
                self.nls();
                let cond = if self.is_op(";") { None } else { Some(self.expr()?) };
                self.expect(";")?;
                self.nls();
                let step = if self.is_op(")") { None } else { Some(Box::new(self.simple()?)) };
                self.expect(")")?;
                if self.is_op(";") {
                    self.i += 1;
                    return Ok(S::For(init, cond, step, Box::new(S::Block(Vec::new()))));
                }
                self.nls();
                return Ok(S::For(init, cond, step, Box::new(self.stmt()?)));
            }
            _ => self.simple()?,
        };
        self.simple_end()?;
        Ok(s)
    }

    fn simple(&mut self) -> PR<S> {
        Ok(match self.peek().clone() {
            T::Kw(k @ ("next" | "nextfile")) => {
                if self.in_special {
                    return Err(format!("`{k}' used in BEGIN or END action"));
                }
                self.i += 1;
                if k == "next" {
                    S::Next
                } else {
                    S::NextFile
                }
            }
            T::Kw("break") => {
                self.i += 1;
                S::Break
            }
            T::Kw("continue") => {
                self.i += 1;
                S::Continue
            }
            T::Kw(k @ ("exit" | "return")) => {
                self.i += 1;
                let v = if matches!(self.peek(), T::Nl | T::Eof | T::Op(";") | T::Op("}")) { None } else { Some(self.expr()?) };
                if k == "exit" {
                    S::Exit(v)
                } else if self.locals.is_none() {
                    return Err("return outside a function".into());
                } else {
                    S::Return(v)
                }
            }
            T::Kw("delete") => {
                self.i += 1;
                let T::Name(name) = self.next() else { return Err("syntax error: array name expected after delete".into()) };
                let v = self.var(&name);
                if self.eat("[") {
                    let keys = self.list("]")?;
                    S::Delete(v, Some(keys))
                } else {
                    S::Delete(v, None)
                }
            }
            T::Kw(k @ ("print" | "printf")) => {
                self.i += 1;
                let saved = (self.no_gt, self.no_in);
                self.no_gt = true;
                self.no_in = false;
                let mut args = Vec::new();
                if !matches!(self.peek(), T::Nl | T::Eof | T::Op(";" | "}" | ">" | ">>" | "|")) {
                    loop {
                        args.push(self.expr()?);
                        if !self.eat(",") {
                            break;
                        }
                        self.nls();
                    }
                }
                if args.len() == 1 && matches!(args[0], E::Group(_)) {
                    let Some(E::Group(list)) = args.pop() else { unreachable!() };
                    args = list;
                }
                let dest = match self.peek() {
                    T::Op(">") => Some(b'>'),
                    T::Op(">>") => Some(b'a'),
                    T::Op("|") => Some(b'|'),
                    _ => None,
                };
                let dest = match dest {
                    Some(kind) => {
                        self.i += 1;
                        if self.is_kw("getline") {
                            return Err("getline is not supported by this awk".into());
                        }
                        Some((kind, self.cat()?))
                    }
                    None => None,
                };
                (self.no_gt, self.no_in) = saved;
                if k == "printf" && args.is_empty() {
                    return Err("syntax error: printf needs a format".into());
                }
                S::Print(args, k == "printf", dest)
            }
            T::Kw("getline") => return Err("getline is not supported by this awk".into()),
            T::Kw(k @ ("switch" | "case" | "default")) => return Err(format!("{k} is not supported by this awk")),
            _ => S::Expr(self.expr()?),
        })
    }

    fn list(&mut self, close: &str) -> PR<Vec<E>> {
        let saved = (self.no_gt, self.no_in);
        (self.no_gt, self.no_in) = (false, false);
        let mut out = Vec::new();
        self.nls();
        if !self.is_op(close) {
            loop {
                out.push(self.expr()?);
                self.nls();
                if !self.eat(",") {
                    break;
                }
                self.nls();
            }
        }
        (self.no_gt, self.no_in) = saved;
        self.expect(close)?;
        Ok(out)
    }

    fn lvalue(e: &E) -> bool {
        matches!(e, E::Var(_) | E::Field(_) | E::Idx(..))
    }

    fn expr(&mut self) -> PR<E> {
        let l = self.ternary()?;
        let op = match self.peek() {
            T::Op("=") => 0u8,
            T::Op("+=") => b'+',
            T::Op("-=") => b'-',
            T::Op("*=") => b'*',
            T::Op("/=") => b'/',
            T::Op("%=") => b'%',
            T::Op("^=") => b'^',
            _ => return Ok(l),
        };
        if !Self::lvalue(&l) {
            return Err("syntax error: assignment to something that is not a variable, field or array element".into());
        }
        self.i += 1;
        self.nls();
        let r = self.expr()?;
        Ok(if op == 0 { E::Assign(Box::new(l), Box::new(r)) } else { E::Aug(Box::new(l), op, Box::new(r)) })
    }

    fn ternary(&mut self) -> PR<E> {
        let c = self.or()?;
        if !self.eat("?") {
            return Ok(c);
        }
        self.nls();
        let a = self.expr()?;
        self.nls();
        self.expect(":")?;
        self.nls();
        let b = self.expr()?;
        Ok(E::Cond(Box::new(c), Box::new(a), Box::new(b)))
    }

    fn or(&mut self) -> PR<E> {
        let mut l = self.and()?;
        while self.eat("||") {
            self.nls();
            l = E::Or(Box::new(l), Box::new(self.and()?));
        }
        Ok(l)
    }

    fn and(&mut self) -> PR<E> {
        let mut l = self.in_()?;
        while self.eat("&&") {
            self.nls();
            l = E::And(Box::new(l), Box::new(self.in_()?));
        }
        Ok(l)
    }

    fn in_(&mut self) -> PR<E> {
        let mut l = self.matching()?;
        while self.is_kw("in") && !self.no_in {
            self.i += 1;
            let T::Name(name) = self.next() else { return Err("syntax error: array name expected after in".into()) };
            let v = self.var(&name);
            l = match l {
                E::Group(keys) => E::In(keys, v),
                key => E::In(vec![key], v),
            };
        }
        Ok(l)
    }

    fn matching(&mut self) -> PR<E> {
        let mut l = self.comparison()?;
        loop {
            let neg = match self.peek() {
                T::Op("~") => false,
                T::Op("!~") => true,
                _ => return Ok(l),
            };
            self.i += 1;
            l = E::Match(neg, Box::new(l), Box::new(self.comparison()?));
        }
    }

    fn comparison(&mut self) -> PR<E> {
        let l = self.cat()?;
        let op = match self.peek() {
            T::Op("<") => b'<',
            T::Op("<=") => b'l',
            T::Op("==") => b'=',
            T::Op("!=") => b'!',
            T::Op(">") if !self.no_gt => b'>',
            T::Op(">=") => b'g',
            _ => return Ok(l),
        };
        self.i += 1;
        Ok(E::Cmp(op, Box::new(l), Box::new(self.cat()?)))
    }

    fn cat(&mut self) -> PR<E> {
        let mut l = self.additive()?;
        // Whatever can start an operand continues a concatenation.
        // (`a -1` is a subtraction: `additive` took it.)
        while matches!(self.peek(), T::Num(_) | T::Str(_) | T::Name(_) | T::Func(_) | T::Op("$" | "(" | "++" | "--")) {
            l = E::Cat(Box::new(l), Box::new(self.additive()?));
        }
        Ok(l)
    }

    fn additive(&mut self) -> PR<E> {
        let mut l = self.multiplicative()?;
        loop {
            let op = match self.peek() {
                T::Op("+") => b'+',
                T::Op("-") => b'-',
                _ => return Ok(l),
            };
            self.i += 1;
            l = E::Bin(op, Box::new(l), Box::new(self.multiplicative()?));
        }
    }

    fn multiplicative(&mut self) -> PR<E> {
        let mut l = self.unary()?;
        loop {
            let op = match self.peek() {
                T::Op("*") => b'*',
                T::Op("/") => b'/',
                T::Op("%") => b'%',
                _ => return Ok(l),
            };
            self.i += 1;
            l = E::Bin(op, Box::new(l), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> PR<E> {
        if self.eat("!") {
            return Ok(E::Not(Box::new(self.unary()?)));
        }
        if self.eat("-") {
            return Ok(E::Neg(Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return Ok(E::Pos(Box::new(self.unary()?)));
        }
        self.power()
    }

    fn power(&mut self) -> PR<E> {
        let base = self.postfix()?;
        if !self.eat("^") {
            return Ok(base);
        }
        // Right associative; the exponent may carry a sign.
        let exp = if self.eat("-") {
            E::Neg(Box::new(self.power()?))
        } else if self.eat("+") {
            self.power()?
        } else if self.eat("!") {
            E::Not(Box::new(self.power()?))
        } else {
            self.power()?
        };
        Ok(E::Bin(b'^', Box::new(base), Box::new(exp)))
    }

    fn postfix(&mut self) -> PR<E> {
        let p = self.primary()?;
        if Self::lvalue(&p) {
            if self.eat("++") {
                return Ok(E::Inc { target: Box::new(p), delta: 1.0, post: true });
            }
            if self.eat("--") {
                return Ok(E::Inc { target: Box::new(p), delta: -1.0, post: true });
            }
        }
        Ok(p)
    }

    fn primary(&mut self) -> PR<E> {
        match self.next() {
            T::Num(n) => Ok(E::Num(n)),
            T::Str(s) => Ok(E::Str(s.into())),
            T::Re(s) => Ok(E::Re(Rc::new(awk_regex(&s)?), s.into())),
            T::Op("$") => {
                let operand = if self.is_op("++") || self.is_op("--") {
                    let delta = if self.is_op("++") { 1.0 } else { -1.0 };
                    self.i += 1;
                    let t = self.primary()?;
                    if !Self::lvalue(&t) {
                        return Err("syntax error: ++ or -- of something that is not a variable".into());
                    }
                    E::Inc { target: Box::new(t), delta, post: false }
                } else if self.eat("-") {
                    E::Neg(Box::new(self.primary()?))
                } else {
                    self.primary()?
                };
                Ok(E::Field(Box::new(operand)))
            }
            T::Op(op @ ("++" | "--")) => {
                let t = self.primary()?;
                if !Self::lvalue(&t) {
                    return Err("syntax error: ++ or -- of something that is not a variable".into());
                }
                Ok(E::Inc { target: Box::new(t), delta: if op == "++" { 1.0 } else { -1.0 }, post: false })
            }
            T::Op("(") => {
                let mut list = self.list(")")?;
                match list.len() {
                    0 => Err("syntax error: empty parentheses".into()),
                    1 => Ok(list.pop().unwrap()),
                    _ => Ok(E::Group(list)),
                }
            }
            T::Op("-") => Ok(E::Neg(Box::new(self.primary()?))),
            T::Op("+") => Ok(E::Pos(Box::new(self.primary()?))),
            T::Op("!") => Ok(E::Not(Box::new(self.primary()?))),
            T::Name(name) => {
                if let Some(b) = builtin(&name) {
                    if self.eat("(") {
                        let args = self.list(")")?;
                        let (min, max) = match b {
                            B::Length | B::Srand | B::Fflush | B::Close | B::Systime => (0, 1),
                            B::Rand => (0, 0),
                            B::Substr => (2, 3),
                            B::Index | B::Atan2 => (2, 2),
                            B::Split => (2, 4),
                            B::Sub | B::Gsub => (2, 3),
                            B::Gensub => (3, 4),
                            B::Match => (2, 3),
                            B::Sprintf => (1, usize::MAX),
                            B::Strftime => (0, 3),
                            B::Asort | B::Asorti => (1, 2),
                            _ => (1, 1),
                        };
                        if args.len() < min || args.len() > max || (b == B::Split && args.len() == 4) {
                            return Err(format!("wrong number of arguments to {name}"));
                        }
                        if matches!(b, B::Sub | B::Gsub) && args.len() == 3 && !Self::lvalue(&args[2]) {
                            return Err(format!("the third argument of {name} must be a variable, field or array element"));
                        }
                        return Ok(E::Call(b, args));
                    }
                    if b == B::Length {
                        return Ok(E::Call(b, Vec::new()));
                    }
                    return Err(format!("syntax error: '(' expected after {name}"));
                }
                let v = self.var(&name);
                if self.eat("[") {
                    let keys = self.list("]")?;
                    if keys.is_empty() {
                        return Err("syntax error: empty subscript".into());
                    }
                    return Ok(E::Idx(v, keys));
                }
                Ok(E::Var(v))
            }
            T::Func(name) => {
                self.expect("(")?;
                let args = self.list(")")?;
                let f = self.func(&name);
                Ok(E::User(f, args))
            }
            T::Kw("getline") => Err("getline is not supported by this awk".into()),
            _ => {
                self.i -= 1;
                Err(format!("syntax error {}", self.near()))
            }
        }
    }
}

/// The program, or (message, exit status): 1 for a syntax error, 2 for what gawk calls fatal.
fn parse(src: &str) -> Result<Prog, (String, i32)> {
    let tokens = lex(src).map_err(|e| (e, 1))?;
    if tokens.contains(&T::Kw("getline")) {
        return Err(("getline is not supported by this awk (read the file as an operand, or use the shell)".into(), 2));
    }
    let mut p = Parser { t: tokens, i: 0, globals: HashMap::new(), locals: None, funcs: Vec::new(), no_gt: false, no_in: false, in_special: false };
    for (i, name) in SPECIALS.iter().enumerate() {
        p.globals.insert(name.to_string(), i);
    }
    let rules = p.program().map_err(|e| (e, 1))?;
    if let Some(f) = p.funcs.iter().find(|f| f.body.is_none()) {
        return Err((format!("function `{}' called but never defined", f.name), 2));
    }
    Ok(Prog { rules, funcs: p.funcs, globals: p.globals })
}

// ---- values ----

#[derive(Clone)]
enum Val {
    Uninit,
    Num(f64),
    Str(Rc<str>),
    /// Text from input that looks like a number.
    StrNum(Rc<str>, f64),
}

#[derive(Default)]
struct Arr {
    map: HashMap<Rc<str>, (u64, Val)>,
    seq: u64,
}

impl Arr {
    fn set(&mut self, k: Rc<str>, v: Val) {
        match self.map.get_mut(&k) {
            Some(slot) => slot.1 = v,
            None => {
                self.seq += 1;
                self.map.insert(k, (self.seq, v));
            }
        }
    }
    fn keys(&self) -> Vec<Rc<str>> {
        let mut k: Vec<(&Rc<str>, u64)> = self.map.iter().map(|(k, v)| (k, v.0)).collect();
        k.sort_by_key(|x| x.1);
        k.into_iter().map(|x| x.0.clone()).collect()
    }
}

type ArrRef = Rc<RefCell<Arr>>;

#[derive(Clone)]
enum Cell {
    Untyped,
    Val(Val),
    Arr(ArrRef),
}

/// The number a string starts with, and whether the whole string (blanks aside) is that number.
fn scan_num(s: &str) -> (f64, bool) {
    let b = s.as_bytes();
    let blank = |c: u8| c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' || c == 0x0b || c == 0x0c;
    let mut i = 0;
    while i < b.len() && blank(b[i]) {
        i += 1;
    }
    let start = i;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_from = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - digits_from;
    if i < b.len() && b[i] == b'.' {
        let dot = i;
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - dot - 1;
        if digits == 0 {
            i = dot;
        }
    }
    if digits == 0 {
        return (0.0, false);
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            i = j;
        }
    }
    let v = s[start..i].parse::<f64>().unwrap_or(0.0);
    while i < b.len() && blank(b[i]) {
        i += 1;
    }
    (v, i == b.len())
}

/// A value read from input: a number when it looks like one.
fn strnum(s: &str) -> Val {
    match scan_num(s) {
        (v, true) => Val::StrNum(s.into(), v),
        _ => Val::Str(s.into()),
    }
}

fn fmt_e(v: f64, prec: usize) -> String {
    let t = format!("{:.*e}", prec, v);
    match t.split_once('e') {
        Some((m, e)) => {
            let n: i32 = e.parse().unwrap_or(0);
            format!("{m}e{}{:02}", if n < 0 { '-' } else { '+' }, n.abs())
        }
        None => t,
    }
}

fn fmt_g(v: f64, prec: usize, alt: bool) -> String {
    let p = prec.max(1);
    if !v.is_finite() {
        return fmt_special(v);
    }
    let exp: i32 = if v == 0.0 { 0 } else { format!("{:.*e}", p - 1, v).split_once('e').and_then(|x| x.1.parse().ok()).unwrap_or(0) };
    let strip = |s: String| -> String {
        if alt || !s.contains('.') {
            s
        } else {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        }
    };
    if exp < -4 || exp >= p as i32 {
        let s = fmt_e(v, p - 1);
        match s.split_once('e') {
            Some((m, e)) => format!("{}e{e}", strip(m.to_string())),
            None => s,
        }
    } else {
        strip(format!("{:.*}", (p as i32 - 1 - exp).max(0) as usize, v))
    }
}

fn fmt_special(v: f64) -> String {
    if v.is_nan() {
        if v.is_sign_negative() { "-nan" } else { "+nan" }.into()
    } else if v > 0.0 {
        "+inf".into()
    } else {
        "-inf".into()
    }
}

fn int_str(v: f64) -> String {
    if v.abs() < 1e16 {
        (v as i64).to_string()
    } else {
        format!("{v:.0}")
    }
}

enum Ctl {
    Break,
    Continue,
    Next,
    NextFile,
    Exit,
    Return(Val),
    Error(String),
}
type R<T> = Result<T, Ctl>;

fn fatal<T>(msg: impl Into<String>) -> R<T> {
    Err(Ctl::Error(msg.into()))
}

enum Lv {
    Var(V),
    Field(usize),
    Elem(ArrRef, Rc<str>),
}

/// How records split into fields.
enum Splitter {
    Blank,
    Char(char),
    Each,
    Re(Rc<Regex>),
}

struct Out {
    kind: u8,
    buf: Vec<u8>,
    /// A file that was already written to (later flushes append).
    started: bool,
}

struct Rt<'a, 'p> {
    sh: &'a mut Interp,
    prog: &'p Prog,
    g: Vec<Cell>,
    frames: Vec<Vec<Cell>>,
    record: Rc<str>,
    fields: Vec<Rc<str>>,
    regexes: HashMap<String, Rc<Regex>>,
    splitter: (String, Rc<Splitter>),
    out: Vec<u8>,
    outputs: Vec<(String, Out)>,
    ranges: Vec<bool>,
    exit_code: i32,
    seed: u64,
    prev_seed: f64,
    depth: usize,
    ticks: u32,
    icase: bool,
}

impl Rt<'_, '_> {
    // ---- conversions ----

    fn sval(&self, i: usize) -> Rc<str> {
        match &self.g[i] {
            Cell::Val(v) => self.to_str(v),
            _ => "".into(),
        }
    }

    fn num_str(&self, v: f64, fmt_slot: usize) -> Rc<str> {
        if v == v.trunc() && v.is_finite() {
            return int_str(v).into();
        }
        if !v.is_finite() {
            return fmt_special(v).into();
        }
        let fmt = self.sval_raw(fmt_slot);
        if &*fmt == "%.6g" {
            return fmt_g(v, 6, false).into();
        }
        match self.sprintf(&fmt, &[Val::Num(v)]) {
            Ok(s) => s.into(),
            Err(_) => fmt_g(v, 6, false).into(),
        }
    }

    /// The string in a special slot without number formatting (it is always text).
    fn sval_raw(&self, i: usize) -> Rc<str> {
        match &self.g[i] {
            Cell::Val(Val::Str(s)) | Cell::Val(Val::StrNum(s, _)) => s.clone(),
            Cell::Val(Val::Num(n)) => int_str(*n).into(),
            _ => "".into(),
        }
    }

    fn to_str(&self, v: &Val) -> Rc<str> {
        match v {
            Val::Uninit => "".into(),
            Val::Str(s) | Val::StrNum(s, _) => s.clone(),
            Val::Num(n) => self.num_str(*n, CONVFMT),
        }
    }

    fn out_str(&self, v: &Val) -> Rc<str> {
        match v {
            Val::Num(n) => self.num_str(*n, OFMT),
            other => self.to_str(other),
        }
    }

    fn num(v: &Val) -> f64 {
        match v {
            Val::Uninit => 0.0,
            Val::Num(n) | Val::StrNum(_, n) => *n,
            Val::Str(s) => scan_num(s).0,
        }
    }

    fn truthy(v: &Val) -> bool {
        match v {
            Val::Uninit => false,
            Val::Num(n) | Val::StrNum(_, n) => *n != 0.0,
            Val::Str(s) => !s.is_empty(),
        }
    }

    fn compare(&self, a: &Val, b: &Val) -> std::cmp::Ordering {
        let numeric = |v: &Val| !matches!(v, Val::Str(_));
        if numeric(a) && numeric(b) {
            let (x, y) = (Self::num(a), Self::num(b));
            return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Less);
        }
        if self.icase {
            return self.to_str(a).to_lowercase().as_bytes().cmp(self.to_str(b).to_lowercase().as_bytes());
        }
        self.to_str(a).as_bytes().cmp(self.to_str(b).as_bytes())
    }

    fn regex(&mut self, src: &str) -> R<Rc<Regex>> {
        let folded;
        let src = if self.icase {
            folded = format!("(?i){src}");
            folded.as_str()
        } else {
            src
        };
        if let Some(r) = self.regexes.get(src) {
            return Ok(r.clone());
        }
        let r = Rc::new(awk_regex(src).map_err(Ctl::Error)?);
        if self.regexes.len() > 500 {
            self.regexes.clear();
        }
        self.regexes.insert(src.to_string(), r.clone());
        Ok(r)
    }

    /// The regular expression an operand stands for: `/re/` itself, or the value as a dynamic one.
    fn regex_of(&mut self, e: &E) -> R<Rc<Regex>> {
        match e {
            E::Re(r, _) if !self.icase => Ok(r.clone()),
            E::Re(_, src) => self.regex(src),
            other => {
                let v = self.eval(other)?;
                let s = self.to_str(&v);
                self.regex(&s)
            }
        }
    }

    // ---- variables, fields, arrays ----

    fn cell(&mut self, v: V) -> &mut Cell {
        match v {
            V::G(i) => &mut self.g[i],
            V::L(i) => {
                let f = self.frames.last_mut().expect("local outside a function");
                &mut f[i]
            }
        }
    }

    fn get_var(&mut self, v: V) -> R<Val> {
        match self.cell(v) {
            Cell::Untyped => Ok(Val::Uninit),
            Cell::Val(x) => Ok(x.clone()),
            Cell::Arr(_) => fatal("attempt to use an array in a scalar context"),
        }
    }

    fn set_var(&mut self, v: V, val: Val) -> R<()> {
        if matches!(self.cell(v), Cell::Arr(_)) {
            return fatal("attempt to assign to an array as if it were a variable");
        }
        if v == V::G(NF) {
            let n = Self::num(&val);
            if n < 0.0 {
                return fatal("NF set to a negative value");
            }
            self.set_nf(n as usize);
            return Ok(());
        }
        if v == V::G(IGNORECASE) {
            self.icase = Self::truthy(&val);
            // The field splitter may be a regular expression compiled the other way.
            self.splitter.0 = "\0".into();
        }
        *self.cell(v) = Cell::Val(val);
        Ok(())
    }

    fn arr(&mut self, v: V) -> R<ArrRef> {
        let c = self.cell(v);
        match c {
            Cell::Arr(a) => Ok(a.clone()),
            Cell::Untyped => {
                let a: ArrRef = Default::default();
                *c = Cell::Arr(a.clone());
                Ok(a)
            }
            Cell::Val(_) => fatal("attempt to use a scalar value as an array"),
        }
    }

    fn key(&mut self, keys: &[E]) -> R<Rc<str>> {
        if keys.len() == 1 {
            let v = self.eval(&keys[0])?;
            return Ok(self.to_str(&v));
        }
        let sep = self.sval(SUBSEP);
        let mut s = String::new();
        for (i, k) in keys.iter().enumerate() {
            if i > 0 {
                s.push_str(&sep);
            }
            let v = self.eval(k)?;
            s.push_str(&self.to_str(&v));
        }
        Ok(s.into())
    }

    fn splitter(&mut self, fs: &str) -> R<Rc<Splitter>> {
        if self.splitter.0 != fs {
            let mut chars = fs.chars();
            let s = match (chars.next(), chars.next()) {
                (None, _) => Splitter::Each,
                (Some(' '), None) => Splitter::Blank,
                (Some(c), None) => Splitter::Char(c),
                _ => Splitter::Re(self.regex(fs)?),
            };
            self.splitter = (fs.to_string(), Rc::new(s));
        }
        Ok(self.splitter.1.clone())
    }

    fn split(&mut self, s: &str, fs: &str) -> R<Vec<Rc<str>>> {
        let sp = self.splitter(fs)?;
        self.split_with(s, &sp)
    }

    fn split_with(&mut self, s: &str, sp: &Splitter) -> R<Vec<Rc<str>>> {
        if s.is_empty() {
            return Ok(Vec::new());
        }
        Ok(match sp {
            Splitter::Blank => s.split([' ', '\t', '\n']).filter(|f| !f.is_empty()).map(Rc::from).collect(),
            Splitter::Char(c) => s.split(*c).map(Rc::from).collect(),
            Splitter::Each => s.chars().map(|c| Rc::from(c.to_string())).collect(),
            Splitter::Re(re) => {
                let mut out: Vec<Rc<str>> = Vec::new();
                let mut last = 0;
                for m in re.find_iter(s) {
                    // A separator never matches the empty string.
                    if m.end() == m.start() {
                        continue;
                    }
                    out.push(Rc::from(&s[last..m.start()]));
                    last = m.end();
                }
                out.push(Rc::from(&s[last..]));
                out
            }
        })
    }

    fn set_record(&mut self, s: &str) -> R<()> {
        self.record = s.into();
        let fs = self.sval_raw(FS);
        self.fields = self.split(s, &fs)?;
        self.g[NF] = Cell::Val(Val::Num(self.fields.len() as f64));
        Ok(())
    }

    fn rebuild(&mut self) {
        let ofs = self.sval(OFS);
        self.record = self.fields.join(&ofs).into();
        self.g[NF] = Cell::Val(Val::Num(self.fields.len() as f64));
    }

    fn set_nf(&mut self, n: usize) {
        self.fields.resize(n, "".into());
        self.rebuild();
    }

    fn field(&self, n: usize) -> Val {
        if n == 0 {
            return strnum(&self.record);
        }
        match self.fields.get(n - 1) {
            Some(f) => strnum(f),
            // A field that is not there is the empty string, not an unset variable: `$9 == 0` is false.
            None => Val::Str("".into()),
        }
    }

    fn set_field(&mut self, n: usize, s: Rc<str>) -> R<()> {
        if n == 0 {
            return self.set_record(&s);
        }
        if n > self.fields.len() {
            self.fields.resize(n, "".into());
        }
        self.fields[n - 1] = s;
        self.rebuild();
        Ok(())
    }

    fn field_index(&mut self, e: &E) -> R<usize> {
        let v = self.eval(e)?;
        let n = Self::num(&v);
        if n < 0.0 {
            return fatal(format!("attempt to access field {n}"));
        }
        Ok(n as usize)
    }

    fn lv(&mut self, e: &E) -> R<Lv> {
        Ok(match e {
            E::Var(v) => Lv::Var(*v),
            E::Field(i) => Lv::Field(self.field_index(i)?),
            E::Idx(v, keys) => {
                let k = self.key(keys)?;
                Lv::Elem(self.arr(*v)?, k)
            }
            _ => return fatal("not something that can be assigned to"),
        })
    }

    fn lv_get(&mut self, lv: &Lv) -> R<Val> {
        Ok(match lv {
            Lv::Var(v) => self.get_var(*v)?,
            Lv::Field(n) => self.field(*n),
            Lv::Elem(a, k) => {
                let mut a = a.borrow_mut();
                match a.map.get(k) {
                    Some(v) => v.1.clone(),
                    None => {
                        // A reference creates the element.
                        a.set(k.clone(), Val::Uninit);
                        Val::Uninit
                    }
                }
            }
        })
    }

    fn lv_set(&mut self, lv: &Lv, val: Val) -> R<()> {
        match lv {
            Lv::Var(v) => self.set_var(*v, val),
            Lv::Field(n) => {
                let s = self.to_str(&val);
                self.set_field(*n, s)
            }
            Lv::Elem(a, k) => {
                a.borrow_mut().set(k.clone(), val);
                Ok(())
            }
        }
    }

    // ---- expressions ----

    fn arith(op: u8, a: f64, b: f64) -> R<f64> {
        Ok(match op {
            b'+' => a + b,
            b'-' => a - b,
            b'*' => a * b,
            b'/' => {
                if b == 0.0 {
                    return fatal("division by zero attempted");
                }
                a / b
            }
            b'%' => {
                if b == 0.0 {
                    return fatal("division by zero attempted in `%'");
                }
                a % b
            }
            _ => {
                // Integer powers by repeated multiplication, as awk implementations do.
                if b == b.trunc() && b.abs() <= 1024.0 {
                    let mut r = 1.0;
                    let mut base = a;
                    let mut n = b.abs() as u32;
                    while n > 0 {
                        if n & 1 == 1 {
                            r *= base;
                        }
                        base *= base;
                        n >>= 1;
                    }
                    if b < 0.0 {
                        1.0 / r
                    } else {
                        r
                    }
                } else {
                    a.powf(b)
                }
            }
        })
    }

    fn eval(&mut self, e: &E) -> R<Val> {
        Ok(match e {
            E::Num(n) => Val::Num(*n),
            E::Str(s) => Val::Str(s.clone()),
            E::Re(..) => {
                let re = self.regex_of(e)?;
                Val::Num(re.is_match(&self.record) as i32 as f64)
            }
            E::Var(v) => self.get_var(*v)?,
            E::Field(i) => {
                let n = self.field_index(i)?;
                self.field(n)
            }
            E::Idx(..) => {
                let lv = self.lv(e)?;
                self.lv_get(&lv)?
            }
            E::In(keys, v) => {
                let k = self.key(keys)?;
                let a = self.arr(*v)?;
                let has = a.borrow().map.contains_key(&k);
                Val::Num(has as i32 as f64)
            }
            E::Assign(target, value) => {
                let v = self.eval(value)?;
                let lv = self.lv(target)?;
                self.lv_set(&lv, v.clone())?;
                v
            }
            E::Aug(target, op, value) => {
                let rhs = self.eval(value)?;
                let lv = self.lv(target)?;
                let cur = self.lv_get(&lv)?;
                let v = Val::Num(Self::arith(*op, Self::num(&cur), Self::num(&rhs))?);
                self.lv_set(&lv, v.clone())?;
                v
            }
            E::Cond(c, a, b) => {
                let c = self.eval(c)?;
                if Self::truthy(&c) {
                    self.eval(a)?
                } else {
                    self.eval(b)?
                }
            }
            E::And(a, b) => {
                let a = self.eval(a)?;
                Val::Num((Self::truthy(&a) && Self::truthy(&self.eval(b)?)) as i32 as f64)
            }
            E::Or(a, b) => {
                let a = self.eval(a)?;
                Val::Num((Self::truthy(&a) || Self::truthy(&self.eval(b)?)) as i32 as f64)
            }
            E::Not(a) => {
                let a = self.eval(a)?;
                Val::Num(!Self::truthy(&a) as i32 as f64)
            }
            E::Neg(a) => {
                let a = self.eval(a)?;
                Val::Num(-Self::num(&a))
            }
            E::Pos(a) => {
                let a = self.eval(a)?;
                Val::Num(Self::num(&a))
            }
            E::Bin(op, a, b) => {
                let a = self.eval(a)?;
                let b = self.eval(b)?;
                Val::Num(Self::arith(*op, Self::num(&a), Self::num(&b))?)
            }
            E::Cmp(op, a, b) => {
                let a = self.eval(a)?;
                let b = self.eval(b)?;
                let o = self.compare(&a, &b);
                Val::Num(match op {
                    b'<' => o.is_lt(),
                    b'l' => o.is_le(),
                    b'=' => o.is_eq(),
                    b'!' => o.is_ne(),
                    b'>' => o.is_gt(),
                    _ => o.is_ge(),
                } as i32 as f64)
            }
            E::Match(neg, a, b) => {
                let a = self.eval(a)?;
                let s = self.to_str(&a);
                let re = self.regex_of(b)?;
                Val::Num((re.is_match(&s) != *neg) as i32 as f64)
            }
            E::Cat(a, b) => {
                let a = self.eval(a)?;
                let b = self.eval(b)?;
                let (a, b) = (self.to_str(&a), self.to_str(&b));
                let mut s = String::with_capacity(a.len() + b.len());
                s.push_str(&a);
                s.push_str(&b);
                Val::Str(s.into())
            }
            E::Inc { target, delta, post } => {
                let lv = self.lv(target)?;
                let old = Self::num(&self.lv_get(&lv)?);
                self.lv_set(&lv, Val::Num(old + delta))?;
                Val::Num(if *post { old } else { old + delta })
            }
            E::Call(b, args) => self.call_builtin(*b, args)?,
            E::User(f, args) => self.call(*f, args)?,
            E::Group(_) => return fatal("a parenthesised list is only valid before `in` or as the arguments of print"),
        })
    }

    fn call(&mut self, f: usize, args: &[E]) -> R<Val> {
        let prog = self.prog;
        let def = &prog.funcs[f];
        let mut frame: Vec<Cell> = Vec::with_capacity(def.nparams);
        // Untyped variables passed along: they become arrays in the caller if the function uses them as one.
        let mut maybe_arrays: Vec<(usize, V)> = Vec::new();
        for (i, a) in args.iter().enumerate() {
            if let E::Var(v) = a {
                match self.cell(*v).clone() {
                    Cell::Arr(rc) => frame.push(Cell::Arr(rc)),
                    Cell::Untyped => {
                        frame.push(Cell::Untyped);
                        maybe_arrays.push((i, *v));
                    }
                    Cell::Val(x) => frame.push(Cell::Val(x)),
                }
            } else {
                let v = self.eval(a)?;
                frame.push(Cell::Val(v));
            }
        }
        // More arguments than parameters: evaluated and dropped, as gawk does.
        frame.resize(def.nparams, Cell::Untyped);
        maybe_arrays.retain(|m| m.0 < def.nparams);
        if self.depth >= 200 {
            return fatal(format!("function `{}': calls nested more than 200 deep", def.name));
        }
        self.depth += 1;
        self.frames.push(frame);
        let r = self.exec(def.body.as_ref().expect("defined"));
        let frame = self.frames.pop().unwrap_or_default();
        self.depth -= 1;
        for (i, v) in maybe_arrays {
            if let Cell::Arr(rc) = &frame[i] {
                if matches!(self.cell(v), Cell::Untyped) {
                    *self.cell(v) = Cell::Arr(rc.clone());
                }
            }
        }
        match r {
            Ok(()) => Ok(Val::Uninit),
            Err(Ctl::Return(v)) => Ok(v),
            Err(e) => Err(e),
        }
    }

    /// `sub`/`gsub` replacement text: `&` is the match, `\&` an ampersand.
    fn replacement(rep: &str, matched: &str, out: &mut String) {
        let mut chars = rep.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\\' if chars.peek() == Some(&'&') => {
                    chars.next();
                    out.push('&');
                }
                '\\' if chars.peek() == Some(&'\\') => {
                    chars.next();
                    out.push('\\');
                }
                '&' => out.push_str(matched),
                c => out.push(c),
            }
        }
    }

    fn substitute(re: &Regex, rep: &str, s: &str, global: bool) -> (String, usize) {
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        let mut n = 0;
        for m in re.find_iter(s) {
            out.push_str(&s[last..m.start()]);
            Self::replacement(rep, m.as_str(), &mut out);
            last = m.end();
            n += 1;
            if !global {
                break;
            }
        }
        out.push_str(&s[last..]);
        (out, n)
    }

    fn str_arg(&mut self, args: &[E], i: usize) -> R<Rc<str>> {
        let v = self.eval(&args[i])?;
        Ok(self.to_str(&v))
    }
    fn num_arg(&mut self, args: &[E], i: usize) -> R<f64> {
        let v = self.eval(&args[i])?;
        Ok(Self::num(&v))
    }

    fn array_arg(&mut self, e: &E) -> R<ArrRef> {
        match e {
            E::Var(v) => self.arr(*v),
            _ => fatal("an array name is expected"),
        }
    }

    fn call_builtin(&mut self, b: B, args: &[E]) -> R<Val> {
        Ok(match b {
            B::Length => {
                if let Some(E::Var(v)) = args.first() {
                    if let Cell::Arr(a) = self.cell(*v) {
                        return Ok(Val::Num(a.borrow().map.len() as f64));
                    }
                }
                let s = if args.is_empty() { self.record.clone() } else { self.str_arg(args, 0)? };
                Val::Num(s.chars().count() as f64)
            }
            B::Substr => {
                let s = self.str_arg(args, 0)?;
                let len = s.chars().count() as f64;
                // gawk: both are truncated; a start before the string is the start of the string.
                let start = self.num_arg(args, 1)?.trunc().max(1.0);
                let count = if args.len() > 2 { self.num_arg(args, 2)?.trunc() } else { f64::INFINITY };
                if !(count >= 1.0) || start > len || start.is_nan() {
                    return Ok(Val::Str("".into()));
                }
                let take = count.min(len - start + 1.0) as usize;
                Val::Str(s.chars().skip(start as usize - 1).take(take).collect::<String>().into())
            }
            B::Index => {
                let (mut s, mut t) = (self.str_arg(args, 0)?, self.str_arg(args, 1)?);
                if self.icase {
                    (s, t) = (s.to_lowercase().into(), t.to_lowercase().into());
                }
                Val::Num(match s.find(&*t) {
                    Some(p) => s[..p].chars().count() as f64 + 1.0,
                    None => 0.0,
                })
            }
            B::Split => {
                let s = self.str_arg(args, 0)?;
                let a = self.array_arg(&args[1])?;
                let parts = match args.get(2) {
                    Some(e @ E::Re(..)) => {
                        let re = self.regex_of(e)?;
                        self.split_with(&s, &Splitter::Re(re))?
                    }
                    Some(e) => {
                        let v = self.eval(e)?;
                        let fs = self.to_str(&v);
                        self.split(&s, &fs)?
                    }
                    None => {
                        let fs = self.sval_raw(FS);
                        self.split(&s, &fs)?
                    }
                };
                let mut a = a.borrow_mut();
                a.map.clear();
                for (i, p) in parts.iter().enumerate() {
                    a.set(int_str((i + 1) as f64).into(), strnum(p));
                }
                Val::Num(parts.len() as f64)
            }
            B::Sub | B::Gsub => {
                let re = self.regex_of(&args[0])?;
                let rep = self.str_arg(args, 1)?;
                let lv = match args.get(2) {
                    Some(t) => self.lv(t)?,
                    None => Lv::Field(0),
                };
                let cur = self.lv_get(&lv)?;
                let s = self.to_str(&cur);
                let (out, n) = Self::substitute(&re, &rep, &s, b == B::Gsub);
                if n > 0 {
                    self.lv_set(&lv, Val::Str(out.into()))?;
                }
                Val::Num(n as f64)
            }
            B::Gensub => {
                let re = self.regex_of(&args[0])?;
                let rep = self.str_arg(args, 1)?;
                let how = self.str_arg(args, 2)?;
                let s = match args.get(3) {
                    Some(_) => self.str_arg(args, 3)?,
                    None => self.record.clone(),
                };
                let which = if how.starts_with(['g', 'G']) { 0 } else { (scan_num(&how).0 as usize).max(1) };
                let mut out = String::with_capacity(s.len());
                let mut last = 0;
                for (n, c) in re.captures_iter(&s).enumerate() {
                    let m = c.get(0).unwrap();
                    if which != 0 && n + 1 != which {
                        continue;
                    }
                    out.push_str(&s[last..m.start()]);
                    let mut chars = rep.chars().peekable();
                    while let Some(ch) = chars.next() {
                        match ch {
                            '\\' => match chars.next() {
                                Some(d @ '0'..='9') => out.push_str(c.get(d as usize - '0' as usize).map(|g| g.as_str()).unwrap_or("")),
                                Some('&') => out.push('&'),
                                Some(o) => out.push(o),
                                None => out.push('\\'),
                            },
                            '&' => out.push_str(m.as_str()),
                            o => out.push(o),
                        }
                    }
                    last = m.end();
                    if which != 0 {
                        break;
                    }
                }
                out.push_str(&s[last..]);
                Val::Str(out.into())
            }
            B::Match => {
                let s = self.str_arg(args, 0)?;
                let re = self.regex_of(&args[1])?;
                let caps = re.captures(&s);
                let (start, len) = match caps.as_ref().and_then(|c| c.get(0)) {
                    Some(m) => (s[..m.start()].chars().count() as f64 + 1.0, m.as_str().chars().count() as f64),
                    None => (0.0, -1.0),
                };
                if let Some(target) = args.get(2) {
                    let a = self.array_arg(target)?;
                    let mut a = a.borrow_mut();
                    a.map.clear();
                    if let Some(c) = &caps {
                        for i in 0..c.len() {
                            if let Some(g) = c.get(i) {
                                a.set(int_str(i as f64).into(), strnum(g.as_str()));
                                let sep = self.sval(SUBSEP);
                                a.set(format!("{i}{sep}start").into(), Val::Num(s[..g.start()].chars().count() as f64 + 1.0));
                                a.set(format!("{i}{sep}length").into(), Val::Num(g.as_str().chars().count() as f64));
                            }
                        }
                    }
                }
                self.g[RSTART] = Cell::Val(Val::Num(start));
                self.g[RLENGTH] = Cell::Val(Val::Num(len));
                Val::Num(start)
            }
            B::Sprintf => {
                let fmt = self.str_arg(args, 0)?;
                let mut vals = Vec::with_capacity(args.len() - 1);
                for a in &args[1..] {
                    vals.push(self.eval(a)?);
                }
                Val::Str(self.sprintf(&fmt, &vals)?.into())
            }
            B::Sin => Val::Num(self.num_arg(args, 0)?.sin()),
            B::Cos => Val::Num(self.num_arg(args, 0)?.cos()),
            B::Atan2 => Val::Num(self.num_arg(args, 0)?.atan2(self.num_arg(args, 1)?)),
            B::Exp => Val::Num(self.num_arg(args, 0)?.exp()),
            B::Log => Val::Num(self.num_arg(args, 0)?.ln()),
            B::Sqrt => Val::Num(self.num_arg(args, 0)?.sqrt()),
            B::Int => Val::Num(self.num_arg(args, 0)?.trunc()),
            B::Strtonum => {
                let v = self.eval(&args[0])?;
                let s = self.to_str(&v);
                let t = s.trim();
                Val::Num(match t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                    Some(h) => u64::from_str_radix(h, 16).unwrap_or(0) as f64,
                    None if t.len() > 1 && t.starts_with('0') && t.bytes().all(|c| (b'0'..=b'7').contains(&c)) => u64::from_str_radix(t, 8).unwrap_or(0) as f64,
                    None => Self::num(&v),
                })
            }
            B::Rand => {
                // xorshift64*; awk only promises a value in [0, 1).
                self.seed ^= self.seed >> 12;
                self.seed ^= self.seed << 25;
                self.seed ^= self.seed >> 27;
                Val::Num((self.seed.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64)
            }
            B::Srand => {
                let prev = self.prev_seed;
                let s = if args.is_empty() { (sys::now_ms() / 1000.0).floor() } else { self.num_arg(args, 0)? };
                self.prev_seed = s;
                self.seed = (s as i64 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
                Val::Num(prev)
            }
            B::Tolower | B::Toupper => {
                // Character for character: one that has no single-character counterpart stays.
                let s = self.str_arg(args, 0)?;
                let map = |c: char| -> char {
                    let mut it: Box<dyn Iterator<Item = char>> = if b == B::Tolower { Box::new(c.to_lowercase()) } else { Box::new(c.to_uppercase()) };
                    match (it.next(), it.next()) {
                        (Some(x), None) => x,
                        _ => c,
                    }
                };
                Val::Str(s.chars().map(map).collect::<String>().into())
            }
            B::System => {
                let cmd = self.str_arg(args, 0)?;
                self.flush(false);
                let st = self.sh.subshell(|sh| sh.run_source(&cmd));
                Val::Num(st as f64)
            }
            B::Close => {
                let name = self.str_arg(args, 0)?;
                Val::Num(match self.outputs.iter().position(|o| o.0 == *name) {
                    Some(i) => {
                        let (name, out) = self.outputs.remove(i);
                        self.finish(&name, out) as f64
                    }
                    None => -1.0,
                })
            }
            B::Fflush => {
                self.flush(false);
                Val::Num(0.0)
            }
            B::Systime => Val::Num((sys::now_ms() / 1000.0).floor()),
            B::Strftime => {
                let fmt = if args.is_empty() { "%a %b %e %H:%M:%S %Z %Y".into() } else { self.str_arg(args, 0)? };
                let when = if args.len() > 1 { self.num_arg(args, 1)? * 1000.0 } else { sys::now_ms() };
                let utc = args.len() > 2 && Self::truthy(&self.eval(&args[2])?);
                Val::Str(crate::text::format_date(&fmt, when, if utc { 0 } else { sys::tz_offset_min() }).into())
            }
            B::Asort | B::Asorti => {
                let src = self.array_arg(&args[0])?;
                let dest = match args.get(1) {
                    Some(d) => self.array_arg(d)?,
                    None => src.clone(),
                };
                let mut items: Vec<Val> =
                    if b == B::Asort { src.borrow().map.values().map(|v| v.1.clone()).collect() } else { src.borrow().map.keys().map(|k| Val::Str(k.clone())).collect() };
                // Numbers before strings, each in ascending order.
                items.sort_by(|x, y| match (matches!(x, Val::Str(_)), matches!(y, Val::Str(_))) {
                    (false, true) => std::cmp::Ordering::Less,
                    (true, false) => std::cmp::Ordering::Greater,
                    _ => self.compare(x, y),
                });
                let mut d = dest.borrow_mut();
                d.map.clear();
                let n = items.len();
                for (i, v) in items.into_iter().enumerate() {
                    d.set(int_str((i + 1) as f64).into(), v);
                }
                Val::Num(n as f64)
            }
        })
    }

    fn sprintf(&self, fmt: &str, args: &[Val]) -> R<String> {
        let f: Vec<char> = fmt.chars().collect();
        let mut out = String::with_capacity(fmt.len() + 16);
        let mut next = 0usize;
        let mut i = 0;
        while i < f.len() {
            if f[i] != '%' {
                out.push(f[i]);
                i += 1;
                continue;
            }
            i += 1;
            if i >= f.len() {
                out.push('%');
                break;
            }
            if f[i] == '%' {
                out.push('%');
                i += 1;
                continue;
            }
            let arg = |next: &mut usize| -> R<Val> {
                let v = args.get(*next).cloned();
                *next += 1;
                v.ok_or_else(|| Ctl::Error("not enough arguments to satisfy format string".into()))
            };
            let (mut left, mut zero, mut plus, mut space, mut alt) = (false, false, false, false, false);
            while i < f.len() && matches!(f[i], '-' | '0' | '+' | ' ' | '#') {
                match f[i] {
                    '-' => left = true,
                    '0' => zero = true,
                    '+' => plus = true,
                    ' ' => space = true,
                    _ => alt = true,
                }
                i += 1;
            }
            let mut width = 0usize;
            if i < f.len() && f[i] == '*' {
                let w = Self::num(&arg(&mut next)?);
                left |= w < 0.0;
                width = w.abs() as usize;
                i += 1;
            }
            while i < f.len() && f[i].is_ascii_digit() {
                width = width * 10 + f[i].to_digit(10).unwrap() as usize;
                i += 1;
            }
            let mut prec: Option<usize> = None;
            if i < f.len() && f[i] == '.' {
                i += 1;
                let mut p = 0usize;
                if i < f.len() && f[i] == '*' {
                    p = Self::num(&arg(&mut next)?).max(0.0) as usize;
                    i += 1;
                }
                while i < f.len() && f[i].is_ascii_digit() {
                    p = p * 10 + f[i].to_digit(10).unwrap() as usize;
                    i += 1;
                }
                prec = Some(p);
            }
            while i < f.len() && matches!(f[i], 'l' | 'h' | 'L' | 'q' | 'j' | 'z' | 't') {
                i += 1;
            }
            let Some(&conv) = f.get(i) else {
                return fatal("a format ends in the middle of a conversion");
            };
            i += 1;
            if conv == '%' {
                out.push('%');
                continue;
            }
            let sign = |neg: bool| {
                if neg {
                    "-"
                } else if plus {
                    "+"
                } else if space {
                    " "
                } else {
                    ""
                }
            };
            // (sign, digits or text, pad with zeros?)
            let (sg, mut body, numeric): (&str, String, bool) = match conv {
                'd' | 'i' => {
                    let v = Self::num(&arg(&mut next)?).trunc();
                    if !v.is_finite() {
                        ("", fmt_special(v), false)
                    } else {
                        let mut s = int_str(v.abs());
                        if let Some(p) = prec {
                            while s.len() < p {
                                s.insert(0, '0');
                            }
                        }
                        (sign(v < 0.0), s, prec.is_none())
                    }
                }
                'o' | 'x' | 'X' | 'u' => {
                    let v = Self::num(&arg(&mut next)?).trunc();
                    let n = if v < 0.0 { v as i64 as u64 } else { v as u64 };
                    let mut s = match conv {
                        'o' => format!("{n:o}"),
                        'x' => format!("{n:x}"),
                        'X' => format!("{n:X}"),
                        _ => n.to_string(),
                    };
                    if let Some(p) = prec {
                        while s.len() < p {
                            s.insert(0, '0');
                        }
                    }
                    if alt && n != 0 {
                        s = match conv {
                            'o' => format!("0{s}"),
                            'x' => format!("0x{s}"),
                            'X' => format!("0X{s}"),
                            _ => s,
                        };
                    }
                    ("", s, prec.is_none())
                }
                'e' | 'E' | 'f' | 'F' | 'g' | 'G' => {
                    let v = Self::num(&arg(&mut next)?);
                    if !v.is_finite() {
                        ("", fmt_special(v), false)
                    } else {
                        let a = v.abs();
                        let mut s = match conv {
                            'e' | 'E' => fmt_e(a, prec.unwrap_or(6)),
                            'f' | 'F' => format!("{:.*}", prec.unwrap_or(6), a),
                            _ => fmt_g(a, prec.unwrap_or(6), alt),
                        };
                        if alt && prec == Some(0) && !s.contains('.') && matches!(conv, 'f' | 'F') {
                            s.push('.');
                        }
                        if conv.is_ascii_uppercase() {
                            s = s.to_uppercase();
                        }
                        (sign(v.is_sign_negative()), s, true)
                    }
                }
                'c' => {
                    let v = arg(&mut next)?;
                    let s = match &v {
                        Val::Num(n) | Val::StrNum(_, n) => char::from_u32(*n as u32).map(|c| c.to_string()).unwrap_or_default(),
                        other => self.to_str(other).chars().next().map(|c| c.to_string()).unwrap_or_default(),
                    };
                    ("", s, false)
                }
                's' => {
                    let v = arg(&mut next)?;
                    let s = self.to_str(&v);
                    (
                        "",
                        match prec {
                            Some(p) => s.chars().take(p).collect(),
                            None => s.to_string(),
                        },
                        false,
                    )
                }
                other => return fatal(format!("unknown format conversion %{other}")),
            };
            let len = body.chars().count() + sg.len();
            if len < width {
                let pad = width - len;
                if left {
                    out.push_str(sg);
                    out.push_str(&body);
                    out.extend(std::iter::repeat_n(' ', pad));
                } else if zero && numeric {
                    out.push_str(sg);
                    out.extend(std::iter::repeat_n('0', pad));
                    out.push_str(&body);
                } else {
                    out.extend(std::iter::repeat_n(' ', pad));
                    out.push_str(sg);
                    out.push_str(&body);
                }
            } else {
                out.push_str(sg);
                out.push_str(&std::mem::take(&mut body));
            }
        }
        Ok(out)
    }

    // ---- output ----

    fn write(&mut self, dest: Option<(u8, Rc<str>)>, data: &[u8]) {
        let Some((kind, name)) = dest else {
            self.out.extend_from_slice(data);
            if self.out.len() > 1 << 16 {
                self.sh.out(&self.out);
                self.out.clear();
            }
            return;
        };
        if kind != b'|' && (&*name == "/dev/stdout" || &*name == "-") {
            return self.write(None, data);
        }
        if kind != b'|' && &*name == "/dev/stderr" {
            self.sh.out(&self.out);
            self.out.clear();
            self.sh.write_fd(2, data);
            return;
        }
        match self.outputs.iter_mut().find(|o| o.0 == *name) {
            Some(o) => o.1.buf.extend_from_slice(data),
            None => {
                if kind == b'|' {
                    // What was printed so far comes before anything the command prints.
                    self.sh.out(&self.out);
                    self.out.clear();
                }
                self.outputs.push((name.to_string(), Out { kind, buf: data.to_vec(), started: false }));
            }
        }
    }

    fn write_file(&mut self, name: &str, o: &mut Out) {
        if o.kind == b'|' {
            return;
        }
        let flags = if o.kind == b'a' || o.started { sys::O_APPEND } else { sys::O_TRUNC };
        if name == "/dev/null" {
            o.buf.clear();
            return;
        }
        if let Err(e) = sys::write_file(&self.sh.abs(name), &o.buf, flags, 0o644) {
            self.sh.err(&format!("awk: cannot write to {name}: {}", sys::strerror(e)));
            self.exit_code = 2;
        }
        o.started = true;
        o.buf.clear();
    }

    /// Close one output: write the file, or run the command on what was printed to it.
    fn finish(&mut self, name: &str, mut o: Out) -> i32 {
        if o.kind != b'|' {
            self.write_file(name, &mut o);
            return 0;
        }
        // What awk itself printed since the command was started stays buffered, as with gawk writing to a pipe or file.
        let input = std::mem::take(&mut o.buf);
        self.sh.subshell(|sh| {
            sh.set_fd(0, Io::input(input));
            sh.run_source(name)
        })
    }

    /// Flush what is buffered; with `close`, also end every file and command.
    fn flush(&mut self, close: bool) {
        let mut outputs = std::mem::take(&mut self.outputs);
        for (name, o) in outputs.iter_mut() {
            self.write_file(name, o);
        }
        if close {
            for (name, o) in outputs.drain(..) {
                self.finish(&name, o);
            }
        }
        self.outputs = outputs;
        self.sh.out(&self.out);
        self.out.clear();
    }

    // ---- statements ----

    fn exec(&mut self, s: &S) -> R<()> {
        match s {
            S::Expr(e) => {
                self.eval(e)?;
            }
            S::Print(args, formatted, dest) => {
                let mut data = String::new();
                if *formatted {
                    let fmt = self.str_arg(args, 0)?;
                    let mut vals = Vec::with_capacity(args.len() - 1);
                    for a in &args[1..] {
                        vals.push(self.eval(a)?);
                    }
                    data = self.sprintf(&fmt, &vals)?;
                } else if args.is_empty() {
                    data.push_str(&self.record);
                    data.push_str(&self.sval(ORS));
                } else {
                    let ofs = self.sval(OFS);
                    for (i, a) in args.iter().enumerate() {
                        if i > 0 {
                            data.push_str(&ofs);
                        }
                        let v = self.eval(a)?;
                        data.push_str(&self.out_str(&v));
                    }
                    data.push_str(&self.sval(ORS));
                }
                let dest = match dest {
                    Some((kind, e)) => {
                        let v = self.eval(e)?;
                        Some((*kind, self.to_str(&v)))
                    }
                    None => None,
                };
                self.write(dest, data.as_bytes());
            }
            S::If(c, a, b) => {
                let c = self.eval(c)?;
                if Self::truthy(&c) {
                    self.exec(a)?;
                } else if let Some(b) = b {
                    self.exec(b)?;
                }
            }
            S::While(c, body) => loop {
                let v = self.eval(c)?;
                if !Self::truthy(&v) {
                    break;
                }
                match self.exec(body) {
                    Err(Ctl::Break) => break,
                    Ok(()) | Err(Ctl::Continue) => {}
                    Err(e) => return Err(e),
                }
                self.tick()?;
            },
            S::Do(body, c) => loop {
                match self.exec(body) {
                    Err(Ctl::Break) => break,
                    Ok(()) | Err(Ctl::Continue) => {}
                    Err(e) => return Err(e),
                }
                let v = self.eval(c)?;
                if !Self::truthy(&v) {
                    break;
                }
                self.tick()?;
            },
            S::For(init, cond, step, body) => {
                if let Some(i) = init {
                    self.exec(i)?;
                }
                loop {
                    if let Some(c) = cond {
                        let v = self.eval(c)?;
                        if !Self::truthy(&v) {
                            break;
                        }
                    }
                    match self.exec(body) {
                        Err(Ctl::Break) => break,
                        Ok(()) | Err(Ctl::Continue) => {}
                        Err(e) => return Err(e),
                    }
                    if let Some(s) = step {
                        self.exec(s)?;
                    }
                    self.tick()?;
                }
            }
            S::ForIn(k, a, body) => {
                let arr = self.arr(*a)?;
                let keys = self.ordered_keys(&arr)?;
                for key in keys {
                    if !arr.borrow().map.contains_key(&key) {
                        continue;
                    }
                    self.set_var(*k, Val::Str(key))?;
                    match self.exec(body) {
                        Err(Ctl::Break) => break,
                        Ok(()) | Err(Ctl::Continue) => {}
                        Err(e) => return Err(e),
                    }
                }
            }
            S::Block(list) => {
                for s in list {
                    self.exec(s)?;
                }
            }
            S::Next => return Err(Ctl::Next),
            S::NextFile => return Err(Ctl::NextFile),
            S::Exit(code) => {
                if let Some(e) = code {
                    let v = self.eval(e)?;
                    self.exit_code = Self::num(&v) as i32 & 255;
                }
                return Err(Ctl::Exit);
            }
            S::Return(v) => {
                let v = match v {
                    Some(e) => self.eval(e)?,
                    None => Val::Uninit,
                };
                return Err(Ctl::Return(v));
            }
            S::Break => return Err(Ctl::Break),
            S::Continue => return Err(Ctl::Continue),
            S::Delete(v, keys) => {
                let a = self.arr(*v)?;
                match keys {
                    Some(keys) => {
                        let k = self.key(keys)?;
                        a.borrow_mut().map.remove(&k);
                    }
                    None => a.borrow_mut().map.clear(),
                }
            }
        }
        Ok(())
    }

    /// Loops check the shell's `timeout` deadline now and then.
    fn tick(&mut self) -> R<()> {
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks % 4096 == 0 && self.sh.check_deadline().is_err() {
            self.exit_code = 124;
            return Err(Ctl::Exit);
        }
        Ok(())
    }

    fn ordered_keys(&mut self, arr: &ArrRef) -> R<Vec<Rc<str>>> {
        let mut keys = arr.borrow().keys();
        let how = match &self.g[PROCINFO] {
            Cell::Arr(p) => p.borrow().map.get("sorted_in").map(|v| self.to_str(&v.1)),
            _ => None,
        };
        let Some(how) = how else { return Ok(keys) };
        let a = arr.borrow();
        let by_num = |x: &Rc<str>, y: &Rc<str>| scan_num(x).0.partial_cmp(&scan_num(y).0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| x.as_bytes().cmp(y.as_bytes()));
        let val = |k: &Rc<str>| a.map.get(k).map(|v| v.1.clone()).unwrap_or(Val::Uninit);
        match how.trim_end_matches("_asc").trim_end_matches("_desc") {
            "@unsorted" => {}
            "@ind_str" => keys.sort_by(|x, y| x.as_bytes().cmp(y.as_bytes())),
            "@ind_num" => keys.sort_by(by_num),
            "@val_num" => keys.sort_by(|x, y| Self::num(&val(x)).partial_cmp(&Self::num(&val(y))).unwrap_or(std::cmp::Ordering::Equal).then_with(|| x.as_bytes().cmp(y.as_bytes()))),
            "@val_str" => keys.sort_by(|x, y| self.to_str(&val(x)).as_bytes().cmp(self.to_str(&val(y)).as_bytes()).then_with(|| x.as_bytes().cmp(y.as_bytes()))),
            other => return fatal(format!("PROCINFO[\"sorted_in\"] = \"{other}\" is not supported by this awk")),
        }
        if how.ends_with("_desc") {
            keys.reverse();
        }
        Ok(keys)
    }

    // ---- the main loop ----

    fn run_rules(&mut self, which: u8) -> R<()> {
        let prog = self.prog;
        for (n, (pat, action)) in prog.rules.iter().enumerate() {
            let hit = match (pat, which) {
                (Pat::Begin, b'B') | (Pat::End, b'E') => true,
                (Pat::Always, b'M') => true,
                (Pat::Expr(e), b'M') => {
                    let v = self.eval(e)?;
                    Self::truthy(&v)
                }
                (Pat::Range(from, to), b'M') => {
                    let mut on = self.ranges[n];
                    let mut hit = on;
                    if !on {
                        let v = self.eval(from)?;
                        on = Self::truthy(&v);
                        hit = on;
                    }
                    if on {
                        let v = self.eval(to)?;
                        if Self::truthy(&v) {
                            on = false;
                        }
                    }
                    self.ranges[n] = on;
                    hit
                }
                _ => false,
            };
            if hit {
                self.exec(action)?;
            }
        }
        Ok(())
    }

    /// Records of one input, as RS says.
    fn records<'t>(&mut self, text: &'t str) -> R<Vec<&'t str>> {
        let rs = self.sval_raw(RS);
        let mut out: Vec<&str> = match &*rs {
            "\n" => text.split('\n').collect(),
            "" => {
                // Paragraphs: blank lines separate records.
                let mut v = Vec::new();
                let mut rest = text.trim_start_matches('\n');
                while !rest.is_empty() {
                    match rest.find("\n\n") {
                        Some(p) => {
                            v.push(&rest[..p]);
                            rest = rest[p..].trim_start_matches('\n');
                        }
                        None => {
                            v.push(rest.trim_end_matches('\n'));
                            rest = "";
                        }
                    }
                }
                return Ok(v);
            }
            s if s.chars().count() == 1 => text.split(s.chars().next().unwrap()).collect(),
            s => {
                let re = self.regex(s)?;
                let mut v = Vec::new();
                let mut last = 0;
                for m in re.find_iter(text) {
                    if m.end() > m.start() {
                        v.push(&text[last..m.start()]);
                        last = m.end();
                    }
                }
                v.push(&text[last..]);
                v
            }
        };
        // The text after the last separator is a record only when there is some.
        if out.last().is_some_and(|l| l.is_empty()) {
            out.pop();
        }
        Ok(out)
    }

    fn input(&mut self, name: &str, data: Vec<u8>) -> R<()> {
        let text = String::from_utf8_lossy(&data);
        self.g[FILENAME] = Cell::Val(Val::Str(name.into()));
        self.g[FNR] = Cell::Val(Val::Num(0.0));
        let records = self.records(&text)?;
        let mut nr = match &self.g[NR] {
            Cell::Val(v) => Self::num(v),
            _ => 0.0,
        };
        for (n, rec) in records.iter().enumerate() {
            // A program may assign NR; count on from what it holds.
            if let Cell::Val(v) = &self.g[NR] {
                nr = Self::num(v);
            }
            nr += 1.0;
            self.g[NR] = Cell::Val(Val::Num(nr));
            let fnr = match &self.g[FNR] {
                Cell::Val(v) => Self::num(v),
                _ => 0.0,
            };
            self.g[FNR] = Cell::Val(Val::Num(fnr + 1.0));
            self.set_record(rec)?;
            match self.run_rules(b'M') {
                Ok(()) | Err(Ctl::Next) => {}
                Err(Ctl::NextFile) => break,
                Err(e) => return Err(e),
            }
            if n % 1024 == 1023 && self.sh.check_deadline().is_err() {
                self.exit_code = 124;
                return Err(Ctl::Exit);
            }
        }
        Ok(())
    }
}

/// `name=value` on the command line.
fn assignment(arg: &str) -> Option<(&str, &str)> {
    let (k, v) = arg.split_once('=')?;
    let mut chars = k.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((k, v))
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let mut fs: Option<String> = None;
    let mut assigns: Vec<(String, String)> = Vec::new();
    let mut program: Option<String> = None;
    let mut i = 1;
    let usage = |sh: &mut Interp, msg: &str| -> X {
        sh.err(&format!("awk: {msg}"));
        Ok(1)
    };
    while i < a.len() {
        let s = a[i].as_str();
        if s == "--" {
            i += 1;
            break;
        }
        if !s.starts_with('-') || s == "-" {
            break;
        }
        i += 1;
        let value = |flag: &str, i: &mut usize| -> Option<String> {
            if s.len() > flag.len() {
                Some(s[flag.len()..].to_string())
            } else {
                *i += 1;
                a.get(*i - 1).cloned()
            }
        };
        if s.starts_with("-F") {
            let Some(v) = value("-F", &mut i) else { return usage(sh, "option -F needs a value") };
            fs = Some(v);
        } else if s.starts_with("-v") {
            let Some(v) = value("-v", &mut i) else { return usage(sh, "option -v needs a value") };
            match assignment(&v) {
                Some((k, val)) => assigns.push((k.to_string(), val.to_string())),
                None => return usage(sh, &format!("`{v}' argument to `-v' not in `var=value' form")),
            }
        } else if s.starts_with("-f") {
            let Some(v) = value("-f", &mut i) else { return usage(sh, "option -f needs a value") };
            match sys::read_file(&sh.abs(&v)) {
                Ok(d) => {
                    let p = program.get_or_insert_with(String::new);
                    p.push_str(&String::from_utf8_lossy(&d));
                    p.push('\n');
                }
                Err(e) => return usage(sh, &format!("cannot open program file {v}: {}", sys::strerror(e))),
            }
        } else if s == "--version" || s == "-V" {
            sh.outs("awk (bat-sh builtin; the gawk subset documented in src/awk.rs, no getline)\n");
            return Ok(0);
        } else if s.starts_with("--field-separator=") {
            fs = Some(s[18..].to_string());
        } else if s.starts_with("--assign=") {
            match assignment(&s[9..]) {
                Some((k, val)) => assigns.push((k.to_string(), val.to_string())),
                None => return usage(sh, "--assign needs var=value"),
            }
        } else {
            return usage(sh, &format!("option {s} is not supported by this awk"));
        }
    }
    let program = match program {
        Some(p) => p,
        None => {
            let Some(p) = a.get(i) else { return usage(sh, "usage: awk [-F fs] [-v var=value] 'program' [file ...]") };
            i += 1;
            p.clone()
        }
    };
    let prog = match parse(&program) {
        Ok(p) => p,
        Err((e, status)) => {
            sh.err(&format!("awk: {e}"));
            return Ok(status);
        }
    };
    let operands: Vec<String> = a[i..].to_vec();
    let mut g = vec![Cell::Untyped; prog.globals.len()];
    let text = |s: &str| Cell::Val(Val::Str(s.into()));
    g[NR] = Cell::Val(Val::Num(0.0));
    g[NF] = Cell::Val(Val::Num(0.0));
    g[FNR] = Cell::Val(Val::Num(0.0));
    g[FS] = text(" ");
    g[OFS] = text(" ");
    g[ORS] = text("\n");
    g[RS] = text("\n");
    g[FILENAME] = text("");
    g[SUBSEP] = text("\x1c");
    g[RSTART] = Cell::Val(Val::Num(0.0));
    g[RLENGTH] = Cell::Val(Val::Num(-1.0));
    g[CONVFMT] = text("%.6g");
    g[OFMT] = text("%.6g");
    let environ: ArrRef = Default::default();
    for kv in sh.env_list() {
        if let Some((k, v)) = kv.split_once('=') {
            environ.borrow_mut().set(k.into(), strnum(v));
        }
    }
    g[ENVIRON] = Cell::Arr(environ);
    let argv: ArrRef = Default::default();
    argv.borrow_mut().set("0".into(), Val::Str("awk".into()));
    for (n, o) in operands.iter().enumerate() {
        argv.borrow_mut().set(int_str((n + 1) as f64).into(), strnum(o));
    }
    g[ARGV] = Cell::Arr(argv);
    g[ARGC] = Cell::Val(Val::Num((operands.len() + 1) as f64));
    g[PROCINFO] = Cell::Arr(Default::default());
    if let Some(f) = fs {
        // `-Ft` is the letter t; `-F '\t'` a tab.
        let f = unescape(&f);
        g[FS] = text(&f);
    }
    let mut rt = Rt {
        sh,
        prog: &prog,
        g,
        frames: Vec::new(),
        record: "".into(),
        fields: Vec::new(),
        regexes: HashMap::new(),
        splitter: (" ".into(), Rc::new(Splitter::Blank)),
        out: Vec::new(),
        outputs: Vec::new(),
        ranges: vec![false; prog.rules.len()],
        exit_code: 0,
        seed: 0x2545_F491_4F6C_DD1D,
        prev_seed: 0.0,
        depth: 0,
        ticks: 0,
        icase: false,
    };
    let assign = |rt: &mut Rt, k: &str, v: &str| -> R<()> {
        match prog.globals.get(k) {
            // A variable the program never mentions cannot be observed.
            None => Ok(()),
            Some(slot) => rt.set_var(V::G(*slot), strnum(&unescape(v))),
        }
    };
    let has_main = prog.rules.iter().any(|r| !matches!(r.0, Pat::Begin));
    let result = (|| -> R<()> {
        for (k, v) in &assigns {
            assign(&mut rt, k, v)?;
        }
        rt.run_rules(b'B')?;
        if !has_main {
            return Ok(());
        }
        // BEGIN may have rewritten ARGV and ARGC.
        let operands: Vec<String> = {
            let argc = match &rt.g[ARGC] {
                Cell::Val(v) => Rt::num(v) as usize,
                _ => 0,
            };
            let argv = rt.arr(V::G(ARGV))?;
            let argv = argv.borrow();
            (1..argc).filter_map(|n| argv.map.get(n.to_string().as_str()).map(|v| rt.to_str(&v.1).to_string())).filter(|o| !o.is_empty()).collect()
        };
        let mut read_any = false;
        for o in &operands {
            if let Some((k, v)) = assignment(o) {
                assign(&mut rt, k, v)?;
                continue;
            }
            read_any = true;
            let data = if o == "-" {
                rt.sh.read_stdin_all()
            } else {
                match sys::read_file(&rt.sh.abs(o)) {
                    Ok(d) => d,
                    Err(e) => return fatal(format!("cannot open file `{o}' for reading: {}", sys::strerror(e))),
                }
            };
            rt.input(o, data)?;
        }
        if !read_any {
            let data = rt.sh.read_stdin_all();
            rt.input("", data)?;
        }
        Ok(())
    })();
    let mut failed = None;
    match result {
        Ok(()) | Err(Ctl::Exit) => {}
        Err(Ctl::Error(e)) => failed = Some(e),
        Err(_) => {}
    }
    // END runs after `exit` in BEGIN or a main rule, not after an error.
    if failed.is_none() && rt.exit_code != 124 {
        match rt.run_rules(b'E') {
            Ok(()) | Err(Ctl::Exit) => {}
            Err(Ctl::Error(e)) => failed = Some(e),
            Err(_) => {}
        }
    }
    rt.flush(true);
    let code = rt.exit_code;
    if let Some(e) = failed {
        sh.err(&format!("awk: fatal: {e}"));
        return Ok(2);
    }
    Ok(code)
}
