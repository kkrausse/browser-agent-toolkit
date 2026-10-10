//! `rg`: ripgrep's command line as agents use it, over the shell's file calls.
//!
//! Output is what ripgrep prints when stdout is not a terminal (no heading, no
//! colour, line numbers only with `-n`). Files are always visited in path
//! order (`--sort path`). The regex engine is regex-lite: no look-around, no
//! back-references, no `\p{..}` classes, ASCII-only `\w`/`\d`/`\s`/`(?i)`.
//! Unlike ripgrep, `.gitignore` files apply without a `.git` directory
//! (`--no-require-git`): the workspaces this runs in usually have none.
use crate::glob::{self, Pc};
use crate::interp::{Interp, Io, X};
use crate::sys;
use regex_lite::Regex;

// ---- gitignore-style rules (ignore files and -g overrides) ----

enum Seg {
    /// `**`
    Any,
    Pat(Vec<Pc>),
}

struct Rule {
    neg: bool,
    dir_only: bool,
    anchored: bool,
    icase: bool,
    segs: Vec<Seg>,
}

fn rule(line: &str, icase: bool) -> Option<Rule> {
    let mut s = line.trim_end_matches('\r');
    while s.ends_with(' ') && !s.ends_with("\\ ") {
        s = &s[..s.len() - 1];
    }
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    let mut neg = false;
    if let Some(r) = s.strip_prefix('!') {
        neg = true;
        s = r;
    } else if s.starts_with("\\!") || s.starts_with("\\#") {
        s = &s[1..];
    }
    let dir_only = s.ends_with('/');
    let s = s.trim_end_matches('/');
    let anchored = s.contains('/');
    let segs: Vec<Seg> = s
        .split('/')
        .filter(|x| !x.is_empty())
        .map(|x| if x == "**" { Seg::Any } else { Seg::Pat(glob::pat(&if icase { x.to_lowercase() } else { x.to_string() })) })
        .collect();
    if segs.is_empty() {
        return None;
    }
    Some(Rule { neg, dir_only, anchored, icase, segs })
}

fn segs_match(p: &[Seg], s: &[&str]) -> bool {
    match p.first() {
        None => s.is_empty(),
        // A trailing `**` is everything below, not the directory itself.
        Some(Seg::Any) if p.len() == 1 => !s.is_empty(),
        Some(Seg::Any) => (0..=s.len()).any(|k| segs_match(&p[1..], &s[k..])),
        Some(Seg::Pat(g)) => !s.is_empty() && glob::matches_str(g, s[0]) && segs_match(&p[1..], &s[1..]),
    }
}

/// The last rule that matches decides: `Some(true)` when it is a negated (`!`) one.
fn verdict(rules: &[Rule], rel: &[&str], is_dir: bool) -> Option<bool> {
    let lower: Vec<String> = if rules.iter().any(|r| r.icase) { rel.iter().map(|s| s.to_lowercase()).collect() } else { Vec::new() };
    let lower: Vec<&str> = lower.iter().map(String::as_str).collect();
    rules.iter().rev().filter(|r| !r.dir_only || is_dir).find(|r| r.hit(if r.icase { &lower } else { rel })).map(|r| r.neg)
}

impl Rule {
    fn hit(&self, rel: &[&str]) -> bool {
        if self.anchored {
            segs_match(&self.segs, rel)
        } else {
            rel.last().is_some_and(|n| segs_match(&self.segs, &[n]))
        }
    }
}

struct IgnoreFile {
    /// Directory the patterns are relative to, without a trailing slash.
    base: String,
    rules: Vec<Rule>,
}

fn load_ignore(dir: &str, name: &str) -> Option<IgnoreFile> {
    let d = dir.trim_end_matches('/');
    let data = sys::read_file(&format!("{d}/{name}")).ok()?;
    let rules: Vec<Rule> = String::from_utf8_lossy(&data).lines().filter_map(|l| rule(l, false)).collect();
    Some(IgnoreFile { base: d.to_string(), rules })
}

fn rel_segs<'a>(base: &str, abs: &'a str) -> Vec<&'a str> {
    abs.strip_prefix(base).unwrap_or(abs).split('/').filter(|s| !s.is_empty() && *s != "." && *s != "..").collect()
}

/// `{a,b}` alternatives of a `-g` glob.
fn braces(g: &str) -> Vec<String> {
    let b = g.as_bytes();
    let Some(open) = b.iter().position(|c| *c == b'{') else { return vec![g.to_string()] };
    let (mut depth, mut parts, mut start) = (0, Vec::new(), open + 1);
    for i in open..b.len() {
        match b[i] {
            b'{' => depth += 1,
            b',' if depth == 1 => {
                parts.push(&g[start..i]);
                start = i + 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    parts.push(&g[start..i]);
                    let mut out = Vec::new();
                    for p in parts {
                        out.extend(braces(&format!("{}{}{}", &g[..open], p, &g[i + 1..])));
                    }
                    return out;
                }
            }
            _ => {}
        }
    }
    vec![g.to_string()]
}

// ---- file types ----

const TYPES: &[(&str, &str)] = &[
    ("asm", "*.S *.asm *.s"),
    ("c", "*.[chH] *.[chH].in *.cats"),
    ("cmake", "*.cmake CMakeLists.txt"),
    ("config", "*.cfg *.conf *.config *.ini"),
    ("cpp", "*.[ChH] *.[ChH].in *.[ch]pp *.[ch]pp.in *.[ch]xx *.[ch]xx.in *.cc *.cc.in *.hh *.hh.in *.inl"),
    ("cs", "*.cs"),
    ("csharp", "*.cs"),
    ("css", "*.css *.scss"),
    ("csv", "*.csv"),
    ("dart", "*.dart"),
    ("docker", "*Dockerfile*"),
    ("go", "*.go"),
    ("graphql", "*.graphql *.graphqls"),
    ("h", "*.h *.hh *.hpp"),
    ("html", "*.ejs *.htm *.html"),
    ("java", "*.java *.jsp *.jspx *.properties"),
    ("js", "*.cjs *.js *.jsx *.mjs *.vue"),
    ("json", "*.json *.sarif composer.lock"),
    ("jsonl", "*.jsonl"),
    ("kotlin", "*.kt *.kts"),
    ("less", "*.less"),
    ("lock", "*.lock package-lock.json"),
    ("log", "*.log"),
    ("lua", "*.lua"),
    ("make", "*.mak *.mk Makefile.* [Gg][Nn][Uu]makefile [Gg][Nn][Uu]makefile.am [Gg][Nn][Uu]makefile.in [Mm]akefile [Mm]akefile.am [Mm]akefile.in"),
    ("markdown", "*.markdown *.md *.mdown *.mdwn *.mdx *.mkd *.mkdn"),
    ("md", "*.markdown *.md *.mdown *.mdwn *.mdx *.mkd *.mkdn"),
    ("php", "*.php *.php3 *.php4 *.php5 *.php7 *.php8 *.pht *.phtml"),
    ("py", "*.py *.pyi"),
    ("python", "*.py *.pyi"),
    ("readme", "*README README*"),
    ("ruby", "*.gemspec *.rake *.rb *.rbw .irbrc Gemfile Rakefile config.ru"),
    ("rust", "*.rs"),
    ("sass", "*.sass *.scss"),
    ("scala", "*.sbt *.scala"),
    ("sh", "*.bash *.bashrc *.csh *.cshrc *.env *.ksh *.kshrc *.sh *.tcsh *.zsh .bash_login .bash_logout .bash_profile .bashrc .cshrc .env .kshrc .login .logout .profile .tcshrc .zlogin .zlogout .zprofile .zshenv .zshrc bash_login bash_logout bash_profile bashrc profile zlogin zlogout zprofile zshenv zshrc"),
    ("sql", "*.psql *.sql"),
    ("svelte", "*.svelte *.svelte.ts"),
    ("svg", "*.svg"),
    ("swift", "*.swift"),
    ("toml", "*.toml Cargo.lock"),
    ("ts", "*.cts *.mts *.ts *.tsx"),
    ("txt", "*.txt"),
    ("typescript", "*.cts *.mts *.ts *.tsx"),
    ("vue", "*.vue"),
    ("xml", "*.dtd *.rng *.sch *.xhtml *.xjb *.xml *.xml.dist *.xsd *.xsl *.xslt"),
    ("yaml", "*.yaml *.yml"),
    ("zig", "*.zig"),
];

fn type_globs(name: &str) -> Option<Vec<Vec<Pc>>> {
    TYPES.iter().find(|t| t.0 == name).map(|t| t.1.split(' ').map(glob::pat).collect())
}

// ---- options ----

#[derive(Default)]
struct O {
    patterns: Vec<String>,
    has_patterns: bool,
    paths: Vec<String>,
    icase: bool,
    smart: bool,
    fixed: bool,
    word: bool,
    line: bool,
    invert: bool,
    only: bool,
    number: bool,
    column: bool,
    vimgrep: bool,
    heading: bool,
    with_name: Option<bool>,
    count: bool,
    count_matches: bool,
    include_zero: bool,
    list: bool,
    list_without: bool,
    files: bool,
    quiet: bool,
    after: usize,
    before: usize,
    max: Option<usize>,
    max_depth: Option<usize>,
    max_columns: Option<usize>,
    hidden: bool,
    no_ignore: bool,
    no_vcs: bool,
    no_dot: bool,
    text: bool,
    binary: bool,
    follow: bool,
    trim: bool,
    null: bool,
    reverse: bool,
    glob_icase: bool,
    globs: Vec<(String, bool)>,
    types: Vec<Vec<Pc>>,
    not_types: Vec<Vec<Pc>>,
    replace: Option<String>,
    sep: Option<String>,
    info: Option<&'static str>,
}

/// Canonical long name of a short flag.
fn short(c: char) -> Option<&'static str> {
    Some(match c {
        'e' => "regexp",
        'g' => "glob",
        't' => "type",
        'T' => "type-not",
        'A' => "after-context",
        'B' => "before-context",
        'C' => "context",
        'm' => "max-count",
        'j' => "threads",
        'r' => "replace",
        'd' => "max-depth",
        'M' => "max-columns",
        'f' => "file",
        'E' => "encoding",
        'i' => "ignore-case",
        'S' => "smart-case",
        's' => "case-sensitive",
        'F' => "fixed-strings",
        'w' => "word-regexp",
        'x' => "line-regexp",
        'v' => "invert-match",
        'o' => "only-matching",
        'n' => "line-number",
        'N' => "no-line-number",
        'H' => "with-filename",
        'I' => "no-filename",
        'c' => "count",
        'l' => "files-with-matches",
        'q' => "quiet",
        'u' => "unrestricted",
        'a' => "text",
        'L' => "follow",
        '.' => "hidden",
        '0' => "null",
        'p' => "pretty",
        'P' => "pcre2",
        'U' => "multiline",
        'z' => "search-zip",
        'V' => "version",
        'h' => "help",
        _ => return None,
    })
}

const WITH_VALUE: &[&str] = &[
    "regexp", "glob", "iglob", "type", "type-not", "after-context", "before-context", "context", "max-count", "threads", "replace", "max-depth", "maxdepth",
    "max-columns", "file", "encoding", "color", "colors", "sort", "sortr", "max-filesize", "engine", "context-separator", "dfa-size-limit", "regex-size-limit",
    "path-separator", "field-match-separator", "field-context-separator", "pre", "pre-glob", "type-add", "type-clear", "ignore-file", "hyperlink-format",
];

/// Flags that change nothing here.
const IGNORED: &[&str] = &[
    "color", "colors", "threads", "max-filesize", "engine", "dfa-size-limit", "regex-size-limit", "hyperlink-format", "no-config", "no-messages", "messages",
    "no-unicode", "unicode", "line-buffered", "block-buffered", "mmap", "no-mmap", "no-require-git", "require-git", "one-file-system", "pcre2", "no-pcre2",
    "auto-hybrid-regex", "no-ignore-messages", "ignore-messages", "no-ignore-global", "no-ignore-exclude", "no-ignore-parent", "no-json", "no-multiline",
    "no-stats", "no-follow", "no-pre", "no-search-zip", "debug", "trace", "no-max-columns-preview", "no-column", "no-crlf", "no-encoding",
];

fn set(o: &mut O, name: &str, v: Option<String>) -> Result<(), String> {
    let num = |v: &Option<String>| -> Result<usize, String> { v.as_deref().and_then(|s| s.parse().ok()).ok_or_else(|| format!("invalid value for --{name}")) };
    match name {
        "regexp" => {
            o.patterns.push(v.unwrap_or_default());
            o.has_patterns = true;
        }
        "file" => o.has_patterns = true, // read by the caller
        "glob" => o.globs.push((v.unwrap_or_default(), false)),
        "iglob" => o.globs.push((v.unwrap_or_default(), true)),
        "glob-case-insensitive" => o.glob_icase = true,
        "type" | "type-not" => {
            let t = v.unwrap_or_default();
            let globs = type_globs(&t).ok_or_else(|| format!("unrecognized file type: {t}"))?;
            if name == "type" {
                o.types.extend(globs)
            } else {
                o.not_types.extend(globs)
            }
        }
        "after-context" => o.after = num(&v)?,
        "before-context" => o.before = num(&v)?,
        "context" => {
            o.after = num(&v)?;
            o.before = o.after;
        }
        "max-count" => o.max = Some(num(&v)?),
        "max-depth" | "maxdepth" => o.max_depth = Some(num(&v)?),
        "max-columns" => o.max_columns = Some(num(&v)?).filter(|n| *n > 0),
        "replace" => o.replace = v,
        "context-separator" => o.sep = v,
        "no-context-separator" => o.sep = Some(String::new()),
        "encoding" => {
            if !matches!(v.as_deref(), Some("utf-8" | "utf8" | "auto" | "none")) {
                return Err("only UTF-8 text is supported".into());
            }
        }
        "sort" | "sortr" => match v.as_deref() {
            Some("path") => o.reverse = name == "sortr",
            Some("none") => {}
            _ => return Err(format!("--{name} {}: only 'path' is supported (results are always in path order)", v.unwrap_or_default())),
        },
        "ignore-case" => (o.icase, o.smart) = (true, false),
        "smart-case" => (o.icase, o.smart) = (false, true),
        "case-sensitive" => (o.icase, o.smart) = (false, false),
        "fixed-strings" => o.fixed = true,
        "no-fixed-strings" => o.fixed = false,
        "word-regexp" => o.word = true,
        "line-regexp" => o.line = true,
        "invert-match" => o.invert = true,
        "no-invert-match" => o.invert = false,
        "only-matching" => o.only = true,
        "line-number" => o.number = true,
        "no-line-number" => o.number = false,
        "column" => (o.column, o.number) = (true, true),
        "vimgrep" => (o.vimgrep, o.number, o.column) = (true, true, true),
        "heading" => o.heading = true,
        "no-heading" => o.heading = false,
        "pretty" => (o.heading, o.number) = (true, true),
        "with-filename" => o.with_name = Some(true),
        "no-filename" => o.with_name = Some(false),
        "count" => o.count = true,
        "count-matches" => o.count_matches = true,
        "include-zero" => o.include_zero = true,
        "files-with-matches" => o.list = true,
        "files-without-match" => o.list_without = true,
        "files" => o.files = true,
        "quiet" => o.quiet = true,
        "hidden" => o.hidden = true,
        "no-hidden" => o.hidden = false,
        "no-ignore" => o.no_ignore = true,
        "ignore" => o.no_ignore = false,
        "no-ignore-vcs" => o.no_vcs = true,
        "ignore-vcs" => o.no_vcs = false,
        "no-ignore-dot" => o.no_dot = true,
        "no-ignore-files" => {}
        "unrestricted" => {
            if !o.no_ignore {
                o.no_ignore = true
            } else if !o.hidden {
                o.hidden = true
            } else {
                o.binary = true
            }
        }
        "text" => o.text = true,
        "no-text" => o.text = false,
        "binary" => o.binary = true,
        "no-binary" => o.binary = false,
        "follow" => o.follow = true,
        "trim" => o.trim = true,
        "no-trim" => o.trim = false,
        "null" => o.null = true,
        "version" => o.info = Some("ripgrep 15.1.0 (bat-sh builtin, regex-lite engine)\n"),
        "help" => {
            o.info = Some(
                "rg (bat-sh builtin): rg [OPTIONS] PATTERN [PATH...] | rg --files [PATH...]\n\
                 -e PAT -i -S -s -F -w -x -v -o -n -N -H -I -c --count-matches -l --files-without-match -q\n\
                 -A/-B/-C N -m N -g GLOB --iglob GLOB -t/-T TYPE --hidden -u/-uu/-uuu --no-ignore -L -a\n\
                 --max-depth N --heading --column --vimgrep -r TEXT --trim -M N --sort path --sortr path -0 (with -l/--files)\n\
                 not supported: --json, -U (multiline), --pre, -z, look-around and Unicode classes in patterns\n",
            )
        }
        "type-list" => o.info = Some(""),
        n if IGNORED.contains(&n) => {}
        "json" | "multiline" | "multiline-dotall" | "pre" | "pre-glob" | "search-zip" | "stats" | "passthru" | "passthrough" | "null-data" | "crlf" | "type-add" | "type-clear"
        | "ignore-file" | "path-separator" | "field-match-separator" | "field-context-separator" | "byte-offset" | "generate" | "max-columns-preview" => {
            return Err(format!("--{name} is not supported by this rg (bat-sh builtin)"))
        }
        _ => return Err(format!("unrecognized flag --{name}")),
    }
    Ok(())
}

fn parse(sh: &Interp, a: &[String]) -> Result<O, String> {
    let mut o = O::default();
    let mut pos: Vec<String> = Vec::new();
    let mut i = 1;
    let apply = |o: &mut O, name: &str, v: Option<String>| -> Result<(), String> {
        if name == "file" {
            let f = v.clone().unwrap_or_default();
            let data = if f == "-" { Vec::new() } else { sys::read_file(&sh.abs(&f)).map_err(|e| format!("{f}: {}", sys::strerror(e)))? };
            o.patterns.extend(String::from_utf8_lossy(&data).lines().map(str::to_string));
        }
        set(o, name, v)
    };
    while i < a.len() {
        let s = a[i].as_str();
        i += 1;
        if s == "--" {
            pos.extend(a[i..].iter().cloned());
            break;
        }
        if let Some(l) = s.strip_prefix("--") {
            let (name, mut v) = match l.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (l, None),
            };
            if v.is_none() && WITH_VALUE.contains(&name) {
                if i >= a.len() {
                    return Err(format!("missing value for flag --{name}"));
                }
                v = Some(a[i].clone());
                i += 1;
            }
            apply(&mut o, name, v)?;
        } else if s.len() > 1 && s.starts_with('-') {
            let chars: Vec<char> = s[1..].chars().collect();
            let mut k = 0;
            while k < chars.len() {
                let c = chars[k];
                k += 1;
                let name = short(c).ok_or_else(|| format!("unrecognized flag -{c}"))?;
                if WITH_VALUE.contains(&name) {
                    let mut v: String = chars[k..].iter().collect();
                    if let Some(r) = v.strip_prefix('=') {
                        v = r.to_string();
                    }
                    if v.is_empty() {
                        if i >= a.len() {
                            return Err(format!("missing value for flag -{c}"));
                        }
                        v = a[i].clone();
                        i += 1;
                    }
                    apply(&mut o, name, Some(v))?;
                    break;
                }
                apply(&mut o, name, None)?;
            }
        } else {
            pos.push(s.to_string());
        }
    }
    if !o.has_patterns && !o.files && o.info.is_none() {
        if pos.is_empty() {
            return Err("ripgrep requires at least one pattern to execute a search".into());
        }
        o.patterns.push(pos.remove(0));
    }
    o.paths = pos;
    Ok(o)
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn regex(o: &O) -> Result<Regex, String> {
    let alts: Vec<String> = o.patterns.iter().map(|p| if o.fixed { escape(p) } else { p.clone() }).collect();
    let mut src = if alts.len() == 1 { alts[0].clone() } else { alts.iter().map(|a| format!("(?:{a})")).collect::<Vec<_>>().join("|") };
    if o.word {
        src = format!("\\b(?:{src})\\b");
    }
    if o.line {
        src = format!("^(?:{src})$");
    }
    // Smart case: insensitive unless a pattern has an upper-case literal.
    let has_upper = |p: &String| {
        let mut esc = false;
        p.chars().any(|c| {
            let r = !esc && c.is_uppercase();
            esc = !esc && c == '\\';
            r
        })
    };
    if o.icase || (o.smart && !o.patterns.iter().any(has_upper)) {
        src = format!("(?i){src}");
    }
    Regex::new(&src).map_err(|e| format!("regex parse error:\n    {src}\nerror: {e}"))
}

// ---- finding files ----

struct Target {
    shown: String,
    /// `None`: standard input.
    abs: Option<String>,
    explicit: bool,
}

struct Walk<'a> {
    o: &'a O,
    cwd: &'a str,
    globs: Vec<Rule>,
    whitelists: bool,
    out: Vec<Target>,
}

impl Walk<'_> {
    fn keep(&self, abs: &str, name: &str, is_dir: bool, ig: &[IgnoreFile]) -> bool {
        if !self.globs.is_empty() {
            match verdict(&self.globs, &rel_segs(self.cwd, abs), is_dir) {
                Some(true) => return false,
                Some(false) => return true,
                None if self.whitelists && !is_dir => return false,
                None => {}
            }
        }
        let mut white = false;
        for f in ig.iter().rev() {
            if !abs.starts_with(&f.base) {
                continue;
            }
            if let Some(neg) = verdict(&f.rules, &rel_segs(&f.base, abs), is_dir) {
                if !neg {
                    return false;
                }
                white = true;
                break;
            }
        }
        if !is_dir {
            if self.o.not_types.iter().any(|g| glob::matches_str(g, name)) {
                return false;
            }
            if !self.o.types.is_empty() {
                if !self.o.types.iter().any(|g| glob::matches_str(g, name)) {
                    return false;
                }
                white = true;
            }
        }
        white || self.o.hidden || !name.starts_with('.')
    }

    fn dir(&mut self, shown: &str, abs: &str, depth: usize, ig: &mut Vec<IgnoreFile>) {
        if self.o.max_depth.is_some_and(|m| depth >= m) {
            return;
        }
        let Ok(mut ents) = sys::readdir(abs) else { return };
        ents.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
        let before = ig.len();
        if !self.o.no_ignore {
            for name in [".gitignore", ".ignore", ".rgignore"] {
                if (name == ".gitignore" && self.o.no_vcs) || (name != ".gitignore" && self.o.no_dot) {
                    continue;
                }
                if ents.iter().any(|e| e.0 == name && e.1 != sys::K_DIR) {
                    ig.extend(load_ignore(abs, name));
                }
            }
        }
        let base = abs.trim_end_matches('/');
        for (name, mut kind) in ents {
            let p = format!("{base}/{name}");
            if kind == sys::K_SYMLINK {
                if !self.o.follow {
                    continue;
                }
                match sys::stat(&p, true) {
                    Ok(s) => kind = s.kind,
                    Err(_) => continue,
                }
            }
            let is_dir = kind == sys::K_DIR;
            if !self.keep(&p, &name, is_dir, ig) {
                continue;
            }
            let s = if shown.is_empty() {
                name
            } else if shown.ends_with('/') {
                format!("{shown}{name}")
            } else {
                format!("{shown}/{name}")
            };
            if is_dir {
                self.dir(&s, &p, depth + 1, ig);
            } else {
                self.out.push(Target { shown: s, abs: Some(p), explicit: false });
            }
        }
        ig.truncate(before);
    }

    /// Ignore files of the directories above a search root, outermost first, up to the one holding `.git`.
    fn ancestors(&self, abs: &str) -> Vec<IgnoreFile> {
        let mut out = Vec::new();
        if self.o.no_ignore || sys::stat(&format!("{}/.git", abs.trim_end_matches('/')), false).is_ok() {
            return out;
        }
        let mut dir = abs.trim_end_matches('/');
        while let Some(i) = dir.rfind('/') {
            dir = &dir[..i];
            let d = if dir.is_empty() { "/" } else { dir };
            let mut here = Vec::new();
            if !self.o.no_vcs {
                here.extend(load_ignore(d, ".gitignore"));
            }
            if !self.o.no_dot {
                here.extend(load_ignore(d, ".ignore"));
                here.extend(load_ignore(d, ".rgignore"));
            }
            here.reverse();
            out.extend(here);
            if dir.is_empty() || sys::stat(&format!("{dir}/.git"), false).is_ok() {
                break;
            }
        }
        out.reverse();
        out
    }
}

// ---- searching ----

struct Printer<'a> {
    o: &'a O,
    re: &'a Regex,
    out: String,
    printed: bool,
}

impl Printer<'_> {
    fn prefix(&self, body: &mut String, shown: &str, with_name: bool, line: usize, col: Option<usize>, sep: char) {
        if with_name && !self.o.heading {
            body.push_str(shown);
            body.push(sep);
        }
        if self.o.number {
            body.push_str(&(line + 1).to_string());
            body.push(sep);
        }
        if let Some(c) = col.filter(|_| self.o.column) {
            body.push_str(&c.to_string());
            body.push(sep);
        }
    }

    fn text(&self, body: &mut String, text: &str, context: bool) {
        let t = if self.o.trim { text.trim_start() } else { text };
        if self.o.max_columns.is_some_and(|m| t.len() > m) {
            body.push_str(if context { "[Omitted long context line]" } else { "[Omitted long matching line]" });
        } else {
            body.push_str(t);
        }
        body.push('\n');
    }

    /// Search one file's text; returns whether it matched.
    fn search(&mut self, shown: &str, text: &str, with_name: bool, binary_at: Option<usize>) -> bool {
        let o = self.o;
        let mut lines: Vec<&str> = text.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        let ctx = o.before > 0 || o.after > 0;
        let sep = o.sep.as_deref().unwrap_or("--");
        let (mut hits, mut matches) = (0usize, 0usize);
        let mut body = String::new();
        let mut last: Option<usize> = None;
        let mut after_left = 0usize;
        for (i, line) in lines.iter().enumerate() {
            let full = o.max.is_some_and(|m| hits >= m);
            if !full && self.re.is_match(line) != o.invert {
                hits += 1;
                if o.quiet || o.list || o.list_without {
                    break;
                }
                if o.count || o.count_matches {
                    matches += if o.invert { 1 } else { self.re.find_iter(line).count() };
                    continue;
                }
                if let Some(off) = binary_at {
                    if with_name {
                        body.push_str(&format!("{shown}: "));
                    }
                    body.push_str(&format!("binary file matches (found \"\\0\" byte around offset {off})\n"));
                    break;
                }
                if ctx {
                    let from = i.saturating_sub(o.before).max(last.map(|p| p + 1).unwrap_or(0));
                    if last.is_some_and(|p| from > p + 1) {
                        body.push_str(sep);
                        body.push('\n');
                    }
                    for (j, l) in lines.iter().enumerate().take(i).skip(from) {
                        self.prefix(&mut body, shown, with_name, j, None, '-');
                        self.text(&mut body, l, true);
                    }
                }
                if o.invert {
                    self.prefix(&mut body, shown, with_name, i, Some(1), ':');
                    self.text(&mut body, line, false);
                } else if o.only || o.vimgrep {
                    for m in self.re.find_iter(line) {
                        self.prefix(&mut body, shown, with_name, i, Some(m.start() + 1), ':');
                        if o.vimgrep {
                            self.text(&mut body, line, false);
                        } else if let Some(rep) = &o.replace {
                            let t = self.re.replace(m.as_str(), rep.as_str());
                            self.text(&mut body, &t, false);
                        } else {
                            self.text(&mut body, m.as_str(), false);
                        }
                    }
                } else {
                    let col = self.re.find(line).map(|m| m.start() + 1);
                    self.prefix(&mut body, shown, with_name, i, col, ':');
                    match &o.replace {
                        Some(rep) => {
                            let t = self.re.replace_all(line, rep.as_str());
                            self.text(&mut body, &t, false);
                        }
                        None => self.text(&mut body, line, false),
                    }
                }
                last = Some(i);
                after_left = o.after;
            } else if after_left > 0 {
                self.prefix(&mut body, shown, with_name, i, None, '-');
                self.text(&mut body, line, true);
                last = Some(i);
                after_left -= 1;
            } else if full {
                break;
            }
        }
        let end = if o.null { '\0' } else { '\n' };
        if o.quiet {
        } else if o.list || o.list_without {
            if (hits > 0) == o.list {
                self.out.push_str(shown);
                self.out.push(end);
            }
        } else if o.count || o.count_matches {
            if hits > 0 || o.include_zero {
                let n = if o.count_matches { matches } else { hits };
                self.out.push_str(&if with_name { format!("{shown}:{n}\n") } else { format!("{n}\n") });
            }
        } else if !body.is_empty() {
            if o.heading {
                if self.printed {
                    self.out.push('\n');
                }
                if with_name {
                    self.out.push_str(shown);
                    self.out.push('\n');
                }
            } else if ctx && self.printed {
                self.out.push_str(sep);
                self.out.push('\n');
            }
            self.out.push_str(&body);
            self.printed = true;
        }
        // With --files-without-match, success is a file listed.
        (hits > 0) != o.list_without
    }
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let o = match parse(sh, a) {
        Ok(o) => o,
        Err(e) => {
            sh.err(&format!("rg: {e}"));
            return Ok(2);
        }
    };
    if let Some(info) = o.info {
        if info.is_empty() {
            let list: String = TYPES.iter().map(|t| format!("{}: {}\n", t.0, t.1.replace(' ', ", "))).collect();
            sh.outs(&list);
        } else {
            sh.outs(info);
        }
        return Ok(0);
    }
    if o.null && !(o.files || o.list || o.list_without) {
        sh.err("rg: -0/--null is only supported with --files, -l and --files-without-match in this rg (bat-sh builtin)");
        return Ok(2);
    }
    let re = if o.files {
        None
    } else {
        match regex(&o) {
            Ok(r) => Some(r),
            Err(e) => {
                sh.err(&format!("rg: {e}"));
                return Ok(2);
            }
        }
    };
    // Standard input is searched when no path is given and it holds something: a pipe or a redirected file.
    let piped = match sh.fd(0) {
        Io::In(b) => b.pos.get() < b.data.len(),
        Io::Host(h) => h.1,
        _ => false,
    };
    let cwd = sh.s.cwd.clone();
    let mut globs = Vec::new();
    for (g, icase) in &o.globs {
        for alt in braces(g) {
            globs.extend(rule(&alt, *icase || o.glob_icase));
        }
    }
    let whitelists = globs.iter().any(|r| !r.neg);
    let mut w = Walk { o: &o, cwd: &cwd, globs, whitelists, out: Vec::new() };
    let mut errored = false;
    let mut any_dir = false;
    if o.paths.is_empty() {
        if piped && !o.files {
            w.out.push(Target { shown: "<stdin>".into(), abs: None, explicit: true });
        } else {
            any_dir = true;
            let mut ig = w.ancestors(&cwd);
            w.dir("", &cwd, 0, &mut ig);
            if o.reverse {
                w.out.reverse();
            }
        }
    }
    for p in &o.paths {
        if p == "-" && !o.files {
            w.out.push(Target { shown: "<stdin>".into(), abs: None, explicit: true });
            continue;
        }
        let abs = sh.abs(p);
        match sys::stat(&abs, true) {
            Ok(s) if s.is_dir() => {
                any_dir = true;
                let from = w.out.len();
                let mut ig = w.ancestors(&abs);
                let shown = if p.trim_end_matches('/').is_empty() { "/" } else { p.trim_end_matches('/') };
                w.dir(shown, &abs, 0, &mut ig);
                if o.reverse {
                    w.out[from..].reverse();
                }
            }
            Ok(_) => w.out.push(Target { shown: p.clone(), abs: Some(abs), explicit: true }),
            Err(e) => {
                sh.err(&format!("rg: {p}: {} (os error {e})", sys::strerror(e)));
                errored = true;
            }
        }
    }
    let targets = std::mem::take(&mut w.out);
    drop(w);
    if o.files {
        let end = if o.null { "\0" } else { "\n" };
        let mut out = String::new();
        for t in &targets {
            out.push_str(&t.shown);
            out.push_str(end);
        }
        sh.outs(&out);
        return Ok(if errored {
            2
        } else if targets.is_empty() {
            1
        } else {
            0
        });
    }
    let re = re.unwrap();
    if targets.is_empty() && !errored {
        sh.err("rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.");
        return Ok(2);
    }
    let with_name = o.with_name.unwrap_or(o.paths.len() > 1 || any_dir);
    let mut pr = Printer { o: &o, re: &re, out: String::new(), printed: false };
    let mut matched = false;
    for t in &targets {
        let data = match &t.abs {
            None => sh.read_stdin_all(),
            Some(p) => match sys::read_file(p) {
                Ok(d) => d,
                Err(e) => {
                    sh.err(&format!("rg: {}: {} (os error {e})", t.shown, sys::strerror(e)));
                    errored = true;
                    continue;
                }
            },
        };
        let mut nul = if o.text { None } else { data.iter().position(|c| *c == 0) };
        if nul.is_some() && !t.explicit && !o.binary {
            continue;
        }
        let mut text = String::from_utf8_lossy(&data);
        if nul.is_some() {
            text = text.replace('\0', "\n").into();
            if o.count || o.count_matches || o.list || o.list_without {
                nul = None;
            }
        }
        if pr.search(&t.shown, &text, with_name, nul) {
            matched = true;
            if o.quiet {
                return Ok(0);
            }
        }
        if pr.out.len() > 1 << 16 {
            let chunk = std::mem::take(&mut pr.out);
            sh.outs(&chunk);
        }
    }
    let out = std::mem::take(&mut pr.out);
    sh.outs(&out);
    Ok(if errored {
        2
    } else if matched {
        0
    } else {
        1
    })
}
