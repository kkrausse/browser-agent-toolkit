//! `jq`: the jaq interpreter (jaq-core, jaq-std, jaq-json) behind jq's command
//! line. Input is read whole (files or stdin), like the other filters here.
use crate::interp::{Interp, Io, X};
use crate::sys;
use jaq_core::load::{self, Arena, File, Loader};
use jaq_core::native::{bome, run as native, v, Filter, Fun};
use jaq_core::{data, Compiler, Ctx, DataT, Lut, RunPtr, ValT, Vars};
use jaq_json::{format_val, read, style, write, write_utf8, write_val, Num, Val};
use jaq_std::input::{self as inputs, HasInputs, Inputs, RcIter};
// jaq-json's writer macros name `alloc`.
extern crate alloc;
use std::cell::{OnceCell, RefCell};
use std::io::{self, Write};

const VERSION: &str = "jq (jaq 3.1.1)";
const USAGE: &str = "Usage: jq [OPTIONS] FILTER [FILES...]
  -n  null input        -R  raw input (lines as strings)   -s  slurp
  -c  compact output    -r  raw output    -j  raw, no newlines    -S  sort keys
  -e  exit status from the last output    -f FILE  filter from a file
  --tab, --indent N, -C, -M, --raw-output0
  --arg NAME VALUE, --argjson NAME JSON, --rawfile NAME FILE, --slurpfile NAME FILE
  --args, --jsonargs";

/// What jq has and jaq's libraries leave out or do differently (`scan` finds every
/// match, `join` takes null as "", dates take broken-down time), in jq's own words.
const DEFS: &str = r#"
def join($x): reduce .[] as $i (null; (if . == null then "" else . + $x end) + ($i | if . == null then "" elif isboolean or isnumber then tojson else . end)) // "";
def scan(re; flags): matches(re; "g" + flags)[] | if length > 1 then .[1:] | map(.string) else .[0].string end;
def scan(re): scan(re; "");
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def INDEX(stream; f): reduce stream as $row ({}; .[$row | f | tostring] |= $row);
def INDEX(f): INDEX(.[]; f);
def tostream: path(def r: (.[]? | r), .; r) as $p | getpath($p) | reduce path(.[]?) as $q ([$p, .]; [$p + $q]);
def truncate_stream(stream): . as $n | null | stream | if (.[0] | length) > $n then setpath([0]; .[0][$n:]) else empty end;
def toarray: if isarray then . else [.] end;
def trimstr($x): ltrimstr($x) | rtrimstr($x);
def jaq_strftime(f): strftime(f);
def strftime(f): if isarray then mktime else . end | jaq_strftime(f);
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def date: todate;
def @csv: map(
    if isstring then "\"" + gsub("\""; "\"\"") + "\""
    elif isnumber or isboolean then tojson
    elif . == null then ""
    else error("\(type) (\(tojson)) is not valid in a csv row") end) | join(",");
def @tsv: map(
    if isstring then gsub("\\\\"; "\\\\") | gsub("\t"; "\\t") | gsub("\n"; "\\n") | gsub("\r"; "\\r")
    elif isnumber or isboolean then tojson
    elif . == null then ""
    else error("\(type) (\(tojson)) is not valid in a tsv row") end) | join("\t");
"#;

struct Kind;
impl DataT for Kind {
    type V<'a> = Val;
    type Data<'a> = &'a Data<'a>;
}
/// What the native filters reach besides their input: the other inputs, the
/// shell's environment, and the bytes `debug`/`stderr` wrote.
struct Data<'a> {
    lut: &'a Lut<Kind>,
    inputs: Inputs<'a, Val>,
    env: &'a Val,
    err: &'a RefCell<Vec<u8>>,
}
impl<'a> data::HasLut<'a, Kind> for &'a Data<'a> {
    fn lut(&self) -> &'a Lut<Kind> {
        self.lut
    }
}
impl<'a> HasInputs<'a, Val> for &'a Data<'a> {
    fn inputs(&self) -> Inputs<'a, Val> {
        self.inputs
    }
}

/// jaq's filters, with the four that would reach the machine (clock,
/// environment, stderr through the `log` crate) replaced by the shell's.
fn funs() -> impl Iterator<Item = Fun<Kind>> {
    let own: [Filter<RunPtr<Kind>>; 4] = [
        ("now", v(0), |_| bome(Ok(Val::from(sys::now_ms() / 1000.0)))),
        ("env", v(0), |cv| bome(Ok(cv.0.data().env.clone()))),
        ("debug_empty", v(0), |cv| {
            let mut e = cv.0.data().err.borrow_mut();
            e.extend_from_slice(b"[\"DEBUG:\",");
            let _ = print(&mut *e, &write::Pp::default(), 0, &cv.1);
            e.extend_from_slice(b"]\n");
            Box::new(core::iter::empty())
        }),
        ("stderr_empty", v(0), |cv| {
            let mut e = cv.0.data().err.borrow_mut();
            match &cv.1 {
                Val::TStr(s) | Val::BStr(s) => e.extend_from_slice(s),
                x => drop(print(&mut *e, &write::Pp::default(), 0, x)),
            }
            Box::new(core::iter::empty())
        }),
    ];
    let std = jaq_std::funs::<Kind>().filter(|f| !matches!(f.0, "now" | "env" | "debug_empty" | "stderr_empty"));
    let inputs = inputs::funs::<Kind>().into_vec().into_iter().map(native::<Kind>);
    jaq_core::funs::<Kind>().chain(std).chain(jaq_json::funs()).chain(inputs).chain(own.into_iter().map(native::<Kind>))
}

#[derive(Default)]
struct Opts {
    null_input: bool,
    raw_input: bool,
    slurp: bool,
    raw: bool,
    join: bool,
    nul: bool,
    exit_status: bool,
    filter: Option<String>,
    files: Vec<String>,
    /// `--arg` and friends, in the order given: name and value.
    vars: Vec<(String, Val)>,
    positional: Vec<Val>,
    pp: write::Pp,
}

enum Usage {
    /// Printed and done (`--help`, `--version`).
    Done,
    Bad(String),
}

fn json(text: &str, what: &str) -> Result<Val, Usage> {
    read::parse_single(text.as_bytes()).map_err(|e| Usage::Bad(format!("invalid JSON text passed to {what}: {e}")))
}

fn options(sh: &mut Interp, a: &[String]) -> Result<Opts, Usage> {
    let mut o = Opts { pp: write::Pp { indent: Some("  ".into()), sep_space: true, ..Default::default() }, ..Default::default() };
    let mut from_file = None;
    // After `--args` / `--jsonargs` the remaining operands are `$ARGS.positional`, not files.
    let mut operands = 0u8;
    let mut i = 1;
    let mut flags_done = false;
    let next = |i: &mut usize, n: usize, opt: &str, what: &str| -> Result<Vec<String>, Usage> {
        if *i + n > a.len() {
            return Err(Usage::Bad(format!("{opt} takes {what}")));
        }
        let r = a[*i..*i + n].to_vec();
        *i += n;
        Ok(r)
    };
    while i < a.len() {
        let s = a[i].as_str();
        i += 1;
        if flags_done || !s.starts_with('-') || s == "-" {
            if o.filter.is_none() && from_file.is_none() {
                o.filter = Some(s.to_string());
            } else {
                match operands {
                    0 => o.files.push(s.to_string()),
                    1 => o.positional.push(Val::from(s.to_string())),
                    _ => o.positional.push(json(s, "--jsonargs")?),
                }
            }
            continue;
        }
        let shorts: Vec<String> = match s.strip_prefix("--") {
            Some("") => {
                flags_done = true;
                continue;
            }
            Some(long) => vec![match long {
                "null-input" => "n",
                "raw-input" => "R",
                "slurp" => "s",
                "compact-output" => "c",
                "raw-output" => "r",
                "join-output" => "j",
                "sort-keys" => "S",
                "exit-status" => "e",
                "color-output" => "C",
                "monochrome-output" => "M",
                "from-file" => "f",
                "help" => "h",
                "version" => "V",
                "ascii-output" => "a",
                "binary" => "b",
                other => other,
            }
            .to_string()],
            None => s[1..].chars().map(String::from).collect(),
        };
        for f in shorts {
            match f.as_str() {
                "n" => o.null_input = true,
                "R" => o.raw_input = true,
                "s" => o.slurp = true,
                "c" => (o.pp.indent, o.pp.sep_space) = (None, false),
                "r" => o.raw = true,
                "j" => (o.raw, o.join) = (true, true),
                "raw-output0" => (o.raw, o.nul) = (true, true),
                "S" => o.pp.sort_keys = true,
                "e" => o.exit_status = true,
                "C" => o.pp.styles = write::Styles::ansi(),
                "M" => o.pp.styles = Default::default(),
                "b" | "unbuffered" => {}
                "tab" => (o.pp.indent, o.pp.sep_space) = (Some("\t".into()), true),
                "indent" => {
                    let n = next(&mut i, 1, "--indent", "one parameter (e.g. --indent 2)")?.remove(0);
                    match n.parse::<usize>() {
                        Ok(n) if n <= 7 => (o.pp.indent, o.pp.sep_space) = (Some(" ".repeat(n)), true),
                        Ok(_) => return Err(Usage::Bad("Cannot indent more than 7 characters".into())),
                        Err(_) => return Err(Usage::Bad("--indent takes a number".into())),
                    }
                }
                "f" => {
                    let file = next(&mut i, 1, "-f", "a file")?.remove(0);
                    match sys::read_file(&sh.abs(&file)) {
                        Ok(d) => from_file = Some(String::from_utf8_lossy(&d).into_owned()),
                        Err(e) => return Err(Usage::Bad(format!("{file}: {}", sys::strerror(e)))),
                    }
                    // A filter already taken from the operands was the first input file.
                    if let Some(first) = o.filter.take() {
                        o.files.insert(0, first);
                    }
                }
                "arg" | "argjson" | "rawfile" | "slurpfile" => {
                    let opt = format!("--{f}");
                    let kv = next(&mut i, 2, &opt, &format!("two parameters (e.g. {opt} varname value)"))?;
                    let val = match f.as_str() {
                        "arg" => Val::from(kv[1].clone()),
                        "argjson" => json(&kv[1], "--argjson")?,
                        _ => {
                            let d = sys::read_file(&sh.abs(&kv[1])).map_err(|e| Usage::Bad(format!("{}: {}", kv[1], sys::strerror(e))))?;
                            if f == "rawfile" {
                                Val::utf8_str(d)
                            } else {
                                let vals: Result<Val, _> = read::parse_many(&d).collect();
                                vals.map_err(|e| Usage::Bad(format!("{}: {e}", kv[1])))?
                            }
                        }
                    };
                    // The first of two with one name is the one jq keeps.
                    if !o.vars.iter().any(|(k, _)| *k == kv[0]) {
                        o.vars.push((kv[0].clone(), val));
                    }
                }
                "args" => operands = 1,
                "jsonargs" => operands = 2,
                "h" => {
                    sh.outs(&format!("{USAGE}\n"));
                    return Err(Usage::Done);
                }
                "V" => {
                    sh.outs(&format!("{VERSION}\n"));
                    return Err(Usage::Done);
                }
                "a" | "seq" | "stream" | "stream-errors" | "L" | "library-path" | "exit-status-exact" | "strip-comments" | "build-configuration" => {
                    return Err(Usage::Bad(format!("{s}: this jq ({VERSION}) does not support that option")))
                }
                _ => return Err(Usage::Bad(format!("Unknown option: {s}"))),
            }
        }
    }
    if let Some(src) = from_file {
        o.filter = Some(src);
    }
    Ok(o)
}

/// The messages of a filter that did not parse or compile, one per line.
fn load_errors(code: &str, errs: load::Errors<&str, ()>) -> Vec<String> {
    let at = |found: &str| {
        let shown: String = found.chars().take(20).collect();
        match shown.is_empty() {
            true => "at the end of the filter".to_string(),
            false => format!("at `{shown}` (offset {})", load::span(code, found).start),
        }
    };
    let mut out = Vec::new();
    for (_, e) in errs {
        match e {
            load::Error::Io(es) => out.extend(es.into_iter().map(|(path, e)| format!("could not load {path}: {e}"))),
            load::Error::Lex(es) => out.extend(es.into_iter().map(|(exp, found)| format!("syntax error: expected {} {}", exp.as_str(), at(found)))),
            load::Error::Parse(es) => out.extend(es.into_iter().map(|(exp, found)| format!("syntax error: expected {} {}", exp.as_str(), at(found)))),
        }
    }
    out
}

/// jaq's JSON writer, except for the numbers jq writes differently: a computed
/// whole number has no `.0`, and what JSON cannot say is null or the largest double.
fn print(w: &mut dyn Write, pp: &write::Pp, level: usize, v: &Val) -> io::Result<()> {
    match v {
        Val::Num(Num::Float(f)) if f.is_nan() => style!(w, pp, null, write!(w, "null")),
        Val::Num(Num::Float(f)) if f.is_infinite() => style!(w, pp, num, write!(w, "{}1.7976931348623157e+308", if *f < 0.0 { "-" } else { "" })),
        Val::Num(Num::Float(f)) if f.fract() == 0.0 && f.abs() < 1e17 => style!(w, pp, num, write!(w, "{f:.0}")),
        _ => write_val!(w, pp, level, v, print),
    }
}

/// The bytes of one input; `None` is stdin, read the first time it is wanted.
fn input<'a>(d: &'a Option<Vec<u8>>, stdin_data: &'a OnceCell<Vec<u8>>, stdin: &Io) -> &'a [u8] {
    match d {
        Some(d) => d,
        None => stdin_data.get_or_init(|| match stdin {
            Io::Host(h) => sys::read_fd_all(h.0).unwrap_or_default(),
            Io::In(b) => b.data[b.pos.replace(b.data.len())..].to_vec(),
            _ => Vec::new(),
        }),
    }
}

/// The values of one input: JSON texts, or with -R its lines as strings.
fn values(d: &[u8], raw: bool) -> Box<dyn Iterator<Item = Result<Val, String>> + '_> {
    match raw {
        true => Box::new(d.strip_suffix(b"\n").unwrap_or(d).split(|c| *c == b'\n').filter(|_| !d.is_empty()).map(|l| Ok(Val::utf8_str(l.to_vec())))),
        false => Box::new(read::parse_many(d).map(|r| r.map_err(|e| e.to_string()))),
    }
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let o = match options(sh, a) {
        Ok(o) => o,
        Err(Usage::Done) => return Ok(0),
        Err(Usage::Bad(m)) => {
            sh.err(&format!("jq: {m}\nUse jq --help for help with command-line options"));
            return Ok(2);
        }
    };
    // Without a filter jq prints its usage only on a terminal; otherwise the filter is `.`.
    let code = o.filter.as_deref().unwrap_or(".");

    // $ENV and `env` are the shell's exported variables; $ARGS is what --arg and --args gave.
    let pairs = |kv: &mut dyn Iterator<Item = (String, Val)>| Val::obj(kv.map(|(k, v)| (Val::from(k), v)).collect());
    let env = pairs(&mut sh.env_list().into_iter().filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), Val::from(v.to_string())))));
    let args = pairs(
        &mut [("positional".to_string(), o.positional.iter().cloned().collect::<Val>()), ("named".to_string(), pairs(&mut o.vars.iter().cloned()))].into_iter(),
    );
    let mut vars = o.vars.clone();
    vars.push(("ENV".into(), env.clone()));
    vars.push(("ARGS".into(), args));
    let names: Vec<String> = vars.iter().map(|(k, _)| format!("${k}")).collect();

    let arena = Arena::default();
    let own = load::parse(DEFS, |p| p.defs()).unwrap_or_default();
    let loader = Loader::new(jaq_core::defs().chain(jaq_std::defs()).chain(jaq_json::defs()).chain(own));
    let compiled = loader.load(&arena, File { code, path: () }).map_err(|e| load_errors(code, e)).and_then(|modules| {
        Compiler::default().with_funs(funs()).with_global_vars(names.iter().map(String::as_str)).compile(modules).map_err(|errs| {
            let each = errs.into_iter().flat_map(|(_, es)| es);
            each.map(|(found, undefined)| format!("{found} is not defined ({})", undefined.as_str())).collect()
        })
    });
    let filter = match compiled {
        Ok(f) => f,
        Err(msgs) => {
            for m in &msgs {
                sh.err(&format!("jq: error: {m}"));
            }
            sh.err(&format!("jq: {} compile error{}", msgs.len(), if msgs.len() == 1 { "" } else { "s" }));
            return Ok(3);
        }
    };

    // Inputs: every file in turn, or stdin, which is read when the first value is asked for (never, for `-n` without `input`).
    let mut unreadable = false;
    let stdin = sh.fd(0);
    let stdin_data = OnceCell::new();
    let mut sources: Vec<Option<Vec<u8>>> = Vec::new();
    if o.files.is_empty() {
        sources.push(None);
    }
    for f in &o.files {
        match if f == "-" { Ok(None) } else { sys::read_file(&sh.abs(f)).map(Some) } {
            Ok(d) => sources.push(d),
            Err(e) => {
                sh.err(&format!("jq: error: Could not open {f}: {}", sys::strerror(e)));
                unreadable = true;
            }
        }
    }
    let bytes = |d| input(d, &stdin_data, &stdin);
    let mut failed = false;
    let stream = sources.iter().flat_map(|d| values(bytes(d), o.raw_input)).take_while(|r| !std::mem::replace(&mut failed, r.is_err()));
    let stream: Box<dyn Iterator<Item = Result<Val, String>> + '_> = match (o.slurp, o.raw_input) {
        (false, _) => Box::new(stream),
        (true, true) => Box::new(std::iter::once_with(|| Ok(Val::utf8_str(sources.iter().flat_map(|d| bytes(d)).copied().collect::<Vec<u8>>())))),
        (true, false) => Box::new(std::iter::once_with(|| stream.collect::<Result<Val, String>>())),
    };

    let inputs = RcIter::new(stream);
    let null = RcIter::new(std::iter::once(Ok(Val::Null)));
    let notes = RefCell::new(Vec::new());
    let data = Data { lut: &filter.lut, inputs: &inputs, env: &env, err: &notes };
    let ctx = Ctx::<Kind>::new(&data, Vars::new(vars.into_iter().map(|(_, v)| v)));
    let mut main: Inputs<Val> = if o.null_input { &null } else { data.inputs };

    let mut out: Vec<u8> = Vec::new();
    // jq's exit status comes from the last input: 5 if it failed, and for -e what its last output was.
    const NO_OUTPUT: i32 = -4;
    let mut ret = NO_OUTPUT;
    let mut last_truthy: Option<bool> = None;
    // Standard output goes out before anything on standard error, so the two keep their order.
    macro_rules! say {
        ($msg:expr) => {{
            sh.out(&std::mem::take(&mut out));
            sh.write_fd(2, &std::mem::take(&mut *notes.borrow_mut()));
            sh.err($msg);
        }};
    }
    while let Some(x) = main.next() {
        let x = match x {
            Ok(x) => x,
            Err(e) => {
                say!(&format!("jq: error: invalid JSON input: {e}"));
                ret = 5;
                break;
            }
        };
        ret = NO_OUTPUT;
        for y in filter.id.run((ctx.clone(), x)) {
            if !notes.borrow().is_empty() {
                sh.out(&std::mem::take(&mut out));
                sh.write_fd(2, &std::mem::take(&mut *notes.borrow_mut()));
            }
            let y = match y {
                Ok(y) => y,
                Err(exn) => match exn.get_err() {
                    Ok(e) => {
                        say!(&format!("jq: error: {e}"));
                        ret = 5;
                        break;
                    }
                    Err(exn) => {
                        sh.out(&out);
                        sh.write_fd(2, &notes.borrow());
                        return Ok(exn.get_halt().unwrap_or(5));
                    }
                },
            };
            ret = if y.as_bool() { 0 } else { -1 };
            match &y {
                Val::TStr(s) | Val::BStr(s) if o.raw => out.extend_from_slice(s),
                _ => drop(print(&mut out, &o.pp, 0, &y)),
            }
            match (o.nul, o.join) {
                (true, _) => out.push(0),
                (_, false) => out.push(b'\n'),
                _ => {}
            }
            if out.len() >= 1 << 16 && !sh.out(&std::mem::take(&mut out)) {
                return Ok(ret.max(0));
            }
        }
        if ret == 0 || ret == -1 {
            last_truthy = Some(ret == 0);
        }
    }
    sh.out(&out);
    sh.write_fd(2, &notes.borrow());
    if unreadable {
        ret = 2;
    }
    Ok(match (o.exit_status, ret, last_truthy) {
        (true, NO_OUTPUT, None) => 4,
        (true, NO_OUTPUT, Some(truthy)) => !truthy as i32,
        (true, r, _) => r.abs(),
        (false, r, _) => r.max(0),
    })
}
