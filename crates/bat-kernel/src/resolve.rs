//! Node module resolution over the kernel VFS (docs/design/kernel-abi.md,
//! section 14). The node-runtime agent's addition to the kernel crate: this
//! file holds the algorithm, its caches and its three exports.
//!
//! One call resolves a specifier completely (relative / absolute / `file://`
//! / `#imports` / bare, `exports` and `imports` maps with conditions and
//! patterns, self-reference, the `node_modules` walk, realpath, package scope
//! type) so a guest pays one boundary crossing instead of dozens of stats.
//!
//! Two caches, shared by every process, behind kernel locks:
//!   * package.json summaries (and "no package.json here"), keyed by directory;
//!   * final results, keyed by (flags, conditions, importer directory, specifier).
//! Both are tied to `BAT_OVERLAY_GEN`. A summary read from an image survives a
//! generation change if one stat shows the same image entry is still there.
//!
//! Lock rule: no resolver lock is ever held across a call into `vfs`.

use crate::errno::*;
use crate::lock::RwLock;
use crate::path::PathBuf;
use crate::proc;
use crate::sys;
use crate::vfs::{self, Stat, BAT_OVERLAY_GEN, K_DIR};
use core::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

pub const RESOLVE_IMPORT: u32 = 1;
pub const RESOLVE_IMPORTER_IS_DIR: u32 = 2;
pub const RESOLVE_PRESERVE_SYMLINKS: u32 = 4;

/// Extensions appended to an extensionless request, in order.
const EXTS: [&[u8]; 10] = [b".js", b".json", b".node", b".mjs", b".cjs", b".ts", b".tsx", b".mts", b".cts", b".jsx"];
const INDEXES: [&[u8]; 7] =
    [b"/index.js", b"/index.json", b"/index.node", b"/index.mjs", b"/index.cjs", b"/index.ts", b"/index.tsx"];
/// Result cache is dropped whole when it grows past this many entries.
const RESULT_CAP: usize = 1 << 16;

// ---------------------------------------------------------------------------
// JSON (just enough for package.json)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(Box<[u8]>),
    Arr(Vec<Json>),
    /// Insertion order is kept: condition order is significant.
    Obj(Vec<(Box<[u8]>, Json)>),
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while let Some(&c) = self.s.get(self.i) {
            if c == b' ' || c == b'\n' || c == b'\r' || c == b'\t' {
                self.i += 1;
            } else {
                break;
            }
        }
    }
    fn eat(&mut self, c: u8) -> Option<()> {
        self.ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            Some(())
        } else {
            None
        }
    }
    fn hex4(&mut self) -> Option<u32> {
        let h = self.s.get(self.i..self.i + 4)?;
        let mut v = 0u32;
        for &c in h {
            v = v * 16 + (c as char).to_digit(16)?;
        }
        self.i += 4;
        Some(v)
    }
    /// After the opening quote. With `keep` false nothing is allocated.
    fn string(&mut self, keep: bool) -> Option<Box<[u8]>> {
        let mut out = Vec::new();
        loop {
            let start = self.i;
            while let Some(&c) = self.s.get(self.i) {
                if c == b'"' || c == b'\\' {
                    break;
                }
                self.i += 1;
            }
            if keep {
                out.extend_from_slice(&self.s[start..self.i]);
            }
            let c = *self.s.get(self.i)?;
            self.i += 1;
            if c == b'"' {
                return Some(out.into_boxed_slice());
            }
            let e = *self.s.get(self.i)?;
            self.i += 1;
            let ch = match e {
                b'n' => '\n',
                b't' => '\t',
                b'r' => '\r',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'"' | b'\\' | b'/' => e as char,
                b'u' => {
                    let mut v = self.hex4()?;
                    if (0xD800..0xDC00).contains(&v) && self.s.get(self.i..self.i + 2) == Some(b"\\u") {
                        let save = self.i;
                        self.i += 2;
                        let lo = self.hex4()?;
                        if (0xDC00..0xE000).contains(&lo) {
                            v = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00);
                        } else {
                            self.i = save;
                        }
                    }
                    char::from_u32(v).unwrap_or('\u{FFFD}')
                }
                _ => return None,
            };
            if keep {
                let mut b = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
            }
        }
    }
    fn lit(&mut self, word: &[u8], v: Json) -> Option<Json> {
        if self.s.get(self.i..self.i + word.len()) == Some(word) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }
    /// With `keep` false the value is validated and skipped; the result is `Null`.
    fn value(&mut self, keep: bool, depth: u32) -> Option<Json> {
        if depth > 64 {
            return None;
        }
        self.ws();
        match *self.s.get(self.i)? {
            b'"' => {
                self.i += 1;
                let s = self.string(keep)?;
                Some(if keep { Json::Str(s) } else { Json::Null })
            }
            b'{' => {
                self.i += 1;
                let mut o: Vec<(Box<[u8]>, Json)> = Vec::new();
                if self.eat(b'}').is_some() {
                    return Some(if keep { Json::Obj(o) } else { Json::Null });
                }
                loop {
                    self.eat(b'"')?;
                    let k = self.string(keep)?;
                    self.eat(b':')?;
                    let v = self.value(keep, depth + 1)?;
                    if keep {
                        // A repeated key keeps its first position and takes the last value.
                        match o.iter_mut().find(|(ek, _)| *ek == k) {
                            Some(e) => e.1 = v,
                            None => o.push((k, v)),
                        }
                    }
                    if self.eat(b',').is_some() {
                        continue;
                    }
                    self.eat(b'}')?;
                    return Some(if keep { Json::Obj(o) } else { Json::Null });
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                if self.eat(b']').is_some() {
                    return Some(if keep { Json::Arr(a) } else { Json::Null });
                }
                loop {
                    let v = self.value(keep, depth + 1)?;
                    if keep {
                        a.push(v);
                    }
                    if self.eat(b',').is_some() {
                        continue;
                    }
                    self.eat(b']')?;
                    return Some(if keep { Json::Arr(a) } else { Json::Null });
                }
            }
            b't' => self.lit(b"true", Json::Bool(true)),
            b'f' => self.lit(b"false", Json::Bool(false)),
            b'n' => self.lit(b"null", Json::Null),
            b'-' | b'0'..=b'9' => {
                let start = self.i;
                while let Some(&c) = self.s.get(self.i) {
                    if matches!(c, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                let n = core::str::from_utf8(&self.s[start..self.i]).ok()?.parse::<f64>().ok()?;
                Some(Json::Num(n))
            }
            _ => None,
        }
    }
}

/// Parse one complete JSON document.
pub fn parse_json(s: &[u8]) -> Option<Json> {
    let mut p = Parser { s, i: 0 };
    let v = p.value(true, 0)?;
    p.ws();
    if p.i == s.len() {
        Some(v)
    } else {
        None
    }
}

/// What the resolver keeps of one package.json.
#[derive(Debug, Default)]
pub struct Pkg {
    pub name: Option<Box<[u8]>>,
    pub main: Option<Box<[u8]>>,
    /// 0 no (valid) `type`, 1 "commonjs", 2 "module".
    pub ty: u8,
    /// `None` when absent or `null`.
    pub exports: Option<Json>,
    pub imports: Option<Json>,
}

/// Summarize a package.json. Only the five fields are materialized; the rest
/// is skipped without allocating. A file that does not parse yields what was
/// read before the error (an unreadable package.json is an empty one here;
/// Node would throw ERR_INVALID_PACKAGE_CONFIG).
pub fn parse_package(s: &[u8]) -> Pkg {
    let mut pkg = Pkg::default();
    let s = s.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(s);
    let mut p = Parser { s, i: 0 };
    let _ = (|| -> Option<()> {
        p.eat(b'{')?;
        if p.eat(b'}').is_some() {
            return Some(());
        }
        loop {
            p.eat(b'"')?;
            let k = p.string(true)?;
            p.eat(b':')?;
            let field = matches!(&*k, b"name" | b"main" | b"type" | b"exports" | b"imports");
            let v = p.value(field, 1)?;
            match &*k {
                b"name" => pkg.name = if let Json::Str(s) = v { Some(s) } else { None },
                b"main" => pkg.main = if let Json::Str(s) = v { Some(s) } else { None },
                b"type" => {
                    pkg.ty = match &v {
                        Json::Str(s) if &**s == b"commonjs" => 1,
                        Json::Str(s) if &**s == b"module" => 2,
                        _ => 0,
                    }
                }
                b"exports" => pkg.exports = if v == Json::Null { None } else { Some(v) },
                b"imports" => pkg.imports = if v == Json::Null { None } else { Some(v) },
                _ => {}
            }
            if p.eat(b',').is_some() {
                continue;
            }
            return p.eat(b'}');
        }
    })();
    pkg
}

// ---------------------------------------------------------------------------
// `exports` / `imports` matching (pure)
// ---------------------------------------------------------------------------

/// The active condition set: "node", "import" or "require", the caller's
/// extras, and "default".
pub struct Conds<'a> {
    pub esm: bool,
    /// Comma separated extra names.
    pub extra: &'a [u8],
}

impl Conds<'_> {
    fn has(&self, k: &[u8]) -> bool {
        k == b"default"
            || k == b"node"
            || k == (if self.esm { &b"import"[..] } else { &b"require"[..] })
            || self.extra.split(|&c| c == b',').any(|e| e.trim_ascii() == k && !k.is_empty())
    }
}

/// Result of resolving one target value.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// Package-relative path, starts with `./`, pattern already substituted.
    Path(Vec<u8>),
    /// `imports` only: a bare specifier to resolve from the package directory.
    Bare(Vec<u8>),
    /// An explicit `null`: the subpath is excluded.
    Null,
    /// Nothing matched.
    Undef,
}

/// A `.`, `..` or `node_modules` path segment (Node rejects these in targets
/// and in pattern matches).
fn bad_segments(p: &[u8]) -> bool {
    p.split(|&c| c == b'/' || c == b'\\').any(|s| s == b"." || s == b".." || s.eq_ignore_ascii_case(b"node_modules"))
}

fn subst(t: &[u8], pat: Option<&[u8]>) -> Vec<u8> {
    let Some(pat) = pat else { return t.to_vec() };
    let mut out = Vec::with_capacity(t.len() + pat.len());
    for &c in t {
        if c == b'*' {
            out.extend_from_slice(pat);
        } else {
            out.push(c);
        }
    }
    out
}

/// Node's PACKAGE_TARGET_RESOLVE, without touching the filesystem.
/// `Err(EINVAL)` is an invalid target.
pub fn target_resolve(t: &Json, pat: Option<&[u8]>, imports: bool, c: &Conds, depth: u32) -> R<Target> {
    if depth > 64 {
        return Err(EINVAL);
    }
    match t {
        Json::Str(s) => {
            if !s.starts_with(b"./") {
                if imports && !s.is_empty() && !s.starts_with(b"../") && !s.starts_with(b"/") {
                    return Ok(Target::Bare(subst(s, pat)));
                }
                return Err(EINVAL);
            }
            if bad_segments(&s[2..]) || pat.is_some_and(bad_segments) {
                return Err(EINVAL);
            }
            Ok(Target::Path(subst(s, pat)))
        }
        Json::Arr(a) => {
            if a.is_empty() {
                return Ok(Target::Null);
            }
            let mut last = Ok(Target::Undef);
            for it in a {
                match target_resolve(it, pat, imports, c, depth + 1) {
                    Err(EINVAL) => last = Err(EINVAL),
                    Err(e) => return Err(e),
                    Ok(Target::Undef) => {}
                    Ok(Target::Null) => last = Ok(Target::Null),
                    ok => return ok,
                }
            }
            last
        }
        Json::Obj(o) => {
            for (k, v) in o {
                if c.has(k) {
                    match target_resolve(v, pat, imports, c, depth + 1)? {
                        Target::Undef => {}
                        r => return Ok(r),
                    }
                }
            }
            Ok(Target::Undef)
        }
        Json::Null => Ok(Target::Null),
        _ => Err(EINVAL),
    }
}

/// Node's patternKeyCompare: true when `b` should replace `a` as best match.
fn better_pattern(a: &[u8], b: &[u8]) -> bool {
    let base = |k: &[u8]| k.iter().position(|&c| c == b'*').map(|i| i + 1).unwrap_or(k.len());
    let (ba, bb) = (base(a), base(b));
    if ba != bb {
        return bb > ba;
    }
    b.len() > a.len()
}

/// Node's PACKAGE_IMPORTS_EXPORTS_RESOLVE: exact key, else the best single-`*`
/// pattern (longest prefix, then longest key).
pub fn match_map(key: &[u8], obj: &[(Box<[u8]>, Json)], imports: bool, c: &Conds) -> R<Target> {
    // (Node no longer honours an `exports` key ending in "/".)
    if !key.contains(&b'*') && (imports || !key.ends_with(b"/")) {
        if let Some((_, t)) = obj.iter().find(|(k, _)| &**k == key) {
            return target_resolve(t, None, imports, c, 0);
        }
    }
    let mut best: Option<(&[u8], &Json, &[u8])> = None;
    for (k, t) in obj {
        let Some(star) = k.iter().position(|&ch| ch == b'*') else { continue };
        let (pre, post) = (&k[..star], &k[star + 1..]);
        if post.contains(&b'*') || key.len() < k.len() || !key.starts_with(pre) || !key.ends_with(post) {
            continue;
        }
        if best.is_none_or(|(bk, _, _)| better_pattern(bk, k)) {
            best = Some((k, t, &key[star..key.len() - post.len()]));
        }
    }
    match best {
        Some((_, t, m)) => target_resolve(t, Some(m), imports, c, 0),
        None => Ok(Target::Undef),
    }
}

/// Node's PACKAGE_EXPORTS_RESOLVE. `subpath` is `.` or `./x`. Returns the
/// package-relative target (`./...`); `Err(EACCES)` when not exported.
pub fn exports_resolve(exports: &Json, subpath: &[u8], c: &Conds) -> R<Vec<u8>> {
    let t = match exports {
        Json::Obj(o) if o.first().is_some_and(|(k, _)| k.starts_with(b".")) => {
            if o.iter().any(|(k, _)| !k.starts_with(b".")) {
                return Err(EINVAL);
            }
            match_map(subpath, o, false, c)?
        }
        Json::Obj(o) if o.iter().any(|(k, _)| k.starts_with(b".")) => return Err(EINVAL),
        _ if subpath == b"." => target_resolve(exports, None, false, c, 0)?,
        _ => Target::Undef,
    };
    match t {
        Target::Path(p) => Ok(p),
        _ => Err(EACCES),
    }
}

/// Split a bare specifier into (package name, rest); rest is empty or starts
/// with `/`.
pub fn split_bare(spec: &[u8]) -> R<(&[u8], &[u8])> {
    let mut end = spec.iter().position(|&c| c == b'/').unwrap_or(spec.len());
    if spec.first() == Some(&b'@') {
        if end == spec.len() {
            return Err(EINVAL);
        }
        end = spec[end + 1..].iter().position(|&c| c == b'/').map(|i| end + 1 + i).unwrap_or(spec.len());
    }
    let name = &spec[..end];
    if name.ends_with(b"/") {
        // `@scope/`: a well-formed name that no directory can have.
        return Err(ENOENT);
    }
    if name.is_empty() || name[0] == b'.' || name.contains(&b'\\') || name.contains(&b'%') {
        return Err(EINVAL);
    }
    Ok((name, &spec[end..]))
}

/// Path of a `file://` URL (query and fragment dropped, escapes decoded).
pub fn file_url_path(url: &[u8]) -> R<Vec<u8>> {
    let rest = url.strip_prefix(b"file://").ok_or(EINVAL)?;
    let rest = rest.strip_prefix(b"localhost").unwrap_or(rest);
    if rest.first() != Some(&b'/') {
        return Err(EINVAL);
    }
    let end = rest.iter().position(|&c| c == b'?' || c == b'#').unwrap_or(rest.len());
    let rest = &rest[..end];
    let mut out = Vec::with_capacity(rest.len());
    let mut i = 0;
    while i < rest.len() {
        if rest[i] == b'%' {
            let hex = |c: Option<&u8>| c.and_then(|&c| (c as char).to_digit(16));
            let (Some(h), Some(l)) = (hex(rest.get(i + 1)), hex(rest.get(i + 2))) else { return Err(EINVAL) };
            let b = (h * 16 + l) as u8;
            if b == b'/' || b == 0 {
                return Err(EINVAL);
            }
            out.push(b);
            i += 3;
        } else {
            out.push(rest[i]);
            i += 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Paths (heap strings; "" is the root, like the rest of the kernel)
// ---------------------------------------------------------------------------

fn pop(p: &mut Vec<u8>) {
    let i = p.iter().rposition(|&c| c == b'/').unwrap_or(0);
    p.truncate(i);
}

/// Lexical join; an absolute `rel` replaces `base`.
fn join(base: &[u8], rel: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(base.len() + rel.len() + 1);
    if rel.first() != Some(&b'/') {
        out.extend_from_slice(base);
    }
    for c in rel.split(|&b| b == b'/') {
        match c {
            b"" | b"." => {}
            b".." => pop(&mut out),
            _ => {
                out.push(b'/');
                out.extend_from_slice(c);
            }
        }
    }
    out
}

fn basename(p: &[u8]) -> &[u8] {
    &p[p.iter().rposition(|&c| c == b'/').map(|i| i + 1).unwrap_or(0)..]
}

/// A caller path made absolute and normalized (relative ones against the
/// calling process's working directory).
fn abs(p: &[u8]) -> R<Vec<u8>> {
    if p.is_empty() || p.contains(&0) {
        return Err(EINVAL);
    }
    if p[0] == b'/' {
        return Ok(join(b"", p));
    }
    let cwd = proc::cur()?.st.lock().cwd.clone();
    Ok(join(&cwd, p))
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

static N_CALLS: AtomicU64 = AtomicU64::new(0);
static N_HITS: AtomicU64 = AtomicU64::new(0);
static N_STATS: AtomicU64 = AtomicU64::new(0);
static N_PKG_READS: AtomicU64 = AtomicU64::new(0);
static N_PKG_HITS: AtomicU64 = AtomicU64::new(0);
/// Nanoseconds spent in resolutions that missed the result cache.
static NANOS: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Filesystem probes
// ---------------------------------------------------------------------------

/// 0 file (anything that is not a directory, as Node), 1 directory, -1 absent.
fn kind(p: &[u8]) -> i32 {
    N_STATS.fetch_add(1, Relaxed);
    let mut st = Stat::default();
    match vfs::stat(p, true, &mut st) {
        Ok(()) => (st.kind == K_DIR) as i32,
        Err(_) => -1,
    }
}
#[inline]
fn is_file(p: &[u8]) -> bool {
    !p.is_empty() && kind(p) == 0
}

// ---------------------------------------------------------------------------
// package.json cache
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Fx(u64);
impl Hasher for Fx {
    #[inline]
    fn write(&mut self, b: &[u8]) {
        const K: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut h = self.0 ^ (b.len() as u64).wrapping_mul(K);
        let mut chunks = b.chunks_exact(8);
        for c in &mut chunks {
            h = (h ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(K);
            h ^= h >> 32;
        }
        let r = chunks.remainder();
        if !r.is_empty() {
            let mut w = [0u8; 8];
            w[..r.len()].copy_from_slice(r);
            h = (h ^ u64::from_le_bytes(w)).wrapping_mul(K);
            h ^= h >> 32;
        }
        self.0 = h;
    }
    #[inline]
    fn write_u64(&mut self, v: u64) {
        self.0 ^= v;
    }
    #[inline]
    fn write_usize(&mut self, _: usize) {}
    #[inline]
    fn finish(&self) -> u64 {
        let h = self.0.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        h ^ (h >> 29)
    }
}
type Bh = BuildHasherDefault<Fx>;

struct PkgEnt {
    gen: u32,
    /// Image identity of the file the summary was read from (dev 0: overlay).
    dev: u32,
    ino: f64,
    pkg: Option<Arc<Pkg>>,
}

/// Keyed by the directory that holds (or lacks) the package.json.
static PKGS: RwLock<HashMap<Box<[u8]>, PkgEnt, Bh>> = RwLock::new(HashMap::with_hasher(Bh::new()));

/// The package.json of `dir`, if there is one. `Err` only for failures that
/// say nothing about existence (EAGAIN: this thread cannot read the image
/// yet; EIO), which are never cached.
fn read_pkg(dir: &[u8]) -> R<Option<Arc<Pkg>>> {
    let gen = BAT_OVERLAY_GEN.load(Relaxed);
    let mut stale: Option<(u32, f64, Arc<Pkg>)> = None;
    {
        let m = PKGS.read();
        if let Some(e) = m.get(dir) {
            if e.gen == gen {
                N_PKG_HITS.fetch_add(1, Relaxed);
                return Ok(e.pkg.clone());
            }
            if let (true, Some(p)) = (e.dev != 0, &e.pkg) {
                stale = Some((e.dev, e.ino, p.clone()));
            }
        }
    }
    let mut path = Vec::with_capacity(dir.len() + 13);
    path.extend_from_slice(dir);
    path.extend_from_slice(b"/package.json");
    let mut st = Stat::default();
    N_STATS.fetch_add(1, Relaxed);
    let mut found = vfs::stat(&path, true, &mut st).is_ok() && st.kind != K_DIR;
    let mut ent = PkgEnt { gen, dev: st.dev, ino: st.ino, pkg: None };
    if found {
        match stale {
            // Same entry of the same immutable image: the summary still holds.
            Some((dev, ino, p)) if dev == st.dev && ino == st.ino => {
                N_PKG_HITS.fetch_add(1, Relaxed);
                ent.pkg = Some(p);
            }
            _ => {
                let mut buf = vec![0u8; st.size as usize];
                loop {
                    match vfs::read_file(&path, 0, &mut buf, &mut st) {
                        Ok(n) => {
                            N_PKG_READS.fetch_add(1, Relaxed);
                            ent.dev = st.dev;
                            ent.ino = st.ino;
                            ent.pkg = Some(Arc::new(parse_package(&buf[..n])));
                            break;
                        }
                        // Replaced by a larger file between the stat and the read.
                        Err(ERANGE) if st.size as usize > buf.len() => buf.resize(st.size as usize, 0),
                        Err(e @ (EAGAIN | EIO | ENOMEM)) => return Err(e),
                        Err(_) => {
                            found = false;
                            break;
                        }
                    }
                }
            }
        }
    }
    if !found {
        ent.dev = 0;
    }
    let out = ent.pkg.clone();
    if BAT_OVERLAY_GEN.load(Relaxed) == gen {
        PKGS.write().insert(dir.into(), ent);
    }
    Ok(out)
}

/// Nearest package.json at or above `dir`, not crossing a `node_modules`
/// directory (Node's package scope).
fn find_scope(dir: &[u8]) -> R<Option<(Vec<u8>, Arc<Pkg>)>> {
    let mut cur = dir.to_vec();
    loop {
        if basename(&cur) == b"node_modules" {
            return Ok(None);
        }
        if let Some(p) = read_pkg(&cur)? {
            return Ok(Some((cur, p)));
        }
        if cur.is_empty() {
            return Ok(None);
        }
        pop(&mut cur);
    }
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

/// LOAD_AS_FILE: `x` itself, a TypeScript source standing behind a JavaScript
/// name, then the extension list. On success `x` holds the file.
fn load_as_file(x: &mut Vec<u8>) -> bool {
    if x.is_empty() {
        return false;
    }
    if is_file(x) {
        return true;
    }
    let n = x.len();
    let alts: (&[u8], &[&[u8]]) = if x.ends_with(b".js") {
        (b".js", &[b".ts", b".tsx"])
    } else if x.ends_with(b".mjs") {
        (b".mjs", &[b".mts"])
    } else if x.ends_with(b".cjs") {
        (b".cjs", &[b".cts"])
    } else if x.ends_with(b".jsx") {
        (b".jsx", &[b".tsx"])
    } else {
        (b"", &[])
    };
    for a in alts.1 {
        x.truncate(n - alts.0.len());
        x.extend_from_slice(a);
        if is_file(x) {
            return true;
        }
    }
    x.truncate(n - alts.0.len());
    x.extend_from_slice(alts.0);
    for e in EXTS {
        x.truncate(n);
        x.extend_from_slice(e);
        if is_file(x) {
            return true;
        }
    }
    x.truncate(n);
    false
}

fn load_index(x: &mut Vec<u8>) -> bool {
    let n = x.len();
    for i in INDEXES {
        x.truncate(n);
        x.extend_from_slice(i);
        if is_file(x) {
            return true;
        }
    }
    x.truncate(n);
    false
}

/// LOAD_AS_DIRECTORY: package.json `main` (file, extensions, index), then index.
/// `Ok(false)`: not a directory or nothing to load, the caller may look elsewhere.
fn load_as_dir(x: &mut Vec<u8>) -> R<bool> {
    match read_pkg(x)? {
        Some(pkg) => {
            if let Some(main) = pkg.main.as_deref().filter(|m| !m.is_empty()) {
                let mut m = join(x, main);
                if load_as_file(&mut m) || load_index(&mut m) {
                    *x = m;
                    return Ok(true);
                }
                // A `main` that leads nowhere falls back to the index, and
                // without one Node gives up here (it does not try the next
                // `node_modules` up).
                return if load_index(x) { Ok(true) } else { Err(ENOENT) };
            }
        }
        None => {
            if kind(x) != 1 {
                return Ok(false);
            }
        }
    }
    Ok(load_index(x))
}

/// A request path: file then directory; directory only when `dir_only`.
fn load_path(x: &mut Vec<u8>, dir_only: bool) -> R<bool> {
    if !dir_only && load_as_file(x) {
        return Ok(true);
    }
    load_as_dir(x)
}

fn is_dir_request(spec: &[u8]) -> bool {
    spec.ends_with(b"/") || spec == b"." || spec == b".." || spec.ends_with(b"/.") || spec.ends_with(b"/..")
}

/// A subpath of a package that has `exports`. The target must be an existing
/// file as written: no probing.
fn via_exports(pkgdir: &[u8], exports: &Json, rest: &[u8], c: &Conds) -> R<Vec<u8>> {
    let mut sub = Vec::with_capacity(1 + rest.len());
    sub.push(b'.');
    sub.extend_from_slice(rest);
    let rel = exports_resolve(exports, &sub, c)?;
    let p = join(pkgdir, &rel);
    if is_file(&p) {
        Ok(p)
    } else {
        Err(ENOENT)
    }
}

fn resolve_bare(spec: &[u8], dir: &[u8], c: &Conds) -> R<Vec<u8>> {
    // `require` reports a malformed name as not found; `import` as invalid.
    let (name, rest) = split_bare(spec).map_err(|e| if c.esm { e } else { ENOENT })?;
    // Self-reference.
    if let Some((sdir, pkg)) = find_scope(dir)? {
        if let (Some(ex), true) = (&pkg.exports, pkg.name.as_deref() == Some(name)) {
            return via_exports(&sdir, ex, rest, c);
        }
    }
    let mut cur = dir.to_vec();
    loop {
        if basename(&cur) != b"node_modules" {
            let mut cand = Vec::with_capacity(cur.len() + 14 + spec.len() + 12);
            cand.extend_from_slice(&cur);
            cand.extend_from_slice(b"/node_modules/");
            cand.extend_from_slice(name);
            if kind(&cand) == 1 {
                let pkg = read_pkg(&cand)?;
                if let Some(ex) = pkg.as_ref().and_then(|p| p.exports.as_ref()) {
                    return via_exports(&cand, ex, rest, c);
                }
                let found = if rest.is_empty() {
                    load_as_dir(&mut cand)?
                } else {
                    cand = join(&cand, &rest[1..]);
                    load_path(&mut cand, is_dir_request(rest))?
                };
                if found {
                    return Ok(cand);
                }
                // `import` settles on the first package directory it finds;
                // `require` keeps walking up.
                if c.esm {
                    return Err(ENOENT);
                }
            }
        }
        if cur.is_empty() {
            return Err(ENOENT);
        }
        pop(&mut cur);
    }
}

fn resolve_imports(spec: &[u8], dir: &[u8], c: &Conds) -> R<Vec<u8>> {
    let scope = find_scope(dir)?;
    let imports = scope.as_ref().and_then(|(_, p)| p.imports.as_ref());
    if !c.esm && imports.is_none() {
        // `require` only consults `imports` when the scope has the field;
        // otherwise the name is looked up like any other and never found.
        return Err(ENOENT);
    }
    if spec == b"#" {
        return Err(EINVAL);
    }
    let (Some((sdir, _)), Some(Json::Obj(o))) = (&scope, imports) else { return Err(EACCES) };
    match match_map(spec, o, true, c)? {
        Target::Path(rel) => {
            let p = join(sdir, &rel);
            if is_file(&p) {
                Ok(p)
            } else {
                Err(ENOENT)
            }
        }
        // A builtin target is handed back as written; the caller owns builtins.
        Target::Bare(t) if t.starts_with(b"node:") => Ok(t),
        Target::Bare(t) if t.starts_with(b"#") => Err(EINVAL),
        Target::Bare(t) => resolve_bare(&t, sdir, c),
        Target::Null | Target::Undef => Err(EACCES),
    }
}

/// Package scope type (0/1/2) for a file in `dir`.
fn scope_type(dir: &[u8]) -> R<u8> {
    Ok(find_scope(dir)?.map(|(_, p)| p.ty).unwrap_or(0))
}

/// Resolve without the result cache. Returns the type byte followed by the path.
fn resolve_uncached(spec: &[u8], importer: &[u8], flags: u32, conds: &[u8]) -> R<Vec<u8>> {
    if spec.is_empty() || spec.contains(&0) {
        return Err(EINVAL);
    }
    let c = Conds { esm: flags & RESOLVE_IMPORT != 0, extra: conds };
    let url;
    let (spec, absolute) = if spec.starts_with(b"file:") {
        url = file_url_path(spec)?;
        (&url[..], true)
    } else {
        (spec, spec[0] == b'/')
    };
    let relative = spec == b"." || spec == b".." || spec.starts_with(b"./") || spec.starts_with(b"../");
    let dir = if absolute {
        Vec::new()
    } else {
        let mut d = abs(importer)?;
        if flags & RESOLVE_IMPORTER_IS_DIR == 0 {
            pop(&mut d);
        }
        d
    };
    let mut path = if absolute || relative {
        let mut x = join(&dir, spec);
        if !load_path(&mut x, is_dir_request(spec))? {
            return Err(ENOENT);
        }
        x
    } else if spec[0] == b'#' {
        resolve_imports(spec, &dir, &c)?
    } else {
        resolve_bare(spec, &dir, &c)?
    };
    let mut out = Vec::with_capacity(path.len() + 1);
    out.push(0);
    if path.first() != Some(&b'/') {
        // `node:` target of an `imports` entry.
        out.extend_from_slice(&path);
        return Ok(out);
    }
    if flags & RESOLVE_PRESERVE_SYMLINKS == 0 {
        let mut real = PathBuf::new();
        vfs::realpath(&path, &mut real)?;
        path.clear();
        path.extend_from_slice(real.as_bytes());
    }
    out.extend_from_slice(&path);
    pop(&mut path);
    out[0] = scope_type(&path)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Result cache
// ---------------------------------------------------------------------------

struct REnt {
    key: Box<[u8]>,
    /// 0, or the errno of a cached failure.
    err: i32,
    /// Type byte + path.
    out: Box<[u8]>,
}
struct Results {
    gen: u32,
    map: HashMap<u64, REnt, Bh>,
}
static RESULTS: RwLock<Results> = RwLock::new(Results { gen: 0, map: HashMap::with_hasher(Bh::new()) });

/// Key layout: flags u8, conds len u16, conds, dir len u16, dir, spec.
struct Key<'a> {
    flags: u8,
    conds: &'a [u8],
    dir: &'a [u8],
    spec: &'a [u8],
}
impl Key<'_> {
    fn hash(&self) -> u64 {
        let mut h = Fx(self.flags as u64);
        h.write(self.conds);
        h.write(self.dir);
        h.write(self.spec);
        h.finish()
    }
    fn len(&self) -> usize {
        5 + self.conds.len() + self.dir.len() + self.spec.len()
    }
    fn matches(&self, k: &[u8]) -> bool {
        let (c, d) = (self.conds.len(), self.dir.len());
        k.len() == self.len()
            && k[0] == self.flags
            && k[1..3] == (c as u16).to_le_bytes()
            && &k[3..3 + c] == self.conds
            && k[3 + c..5 + c] == (d as u16).to_le_bytes()
            && &k[5 + c..5 + c + d] == self.dir
            && &k[5 + c + d..] == self.spec
    }
    fn to_box(&self) -> Box<[u8]> {
        let mut k = Vec::with_capacity(self.len());
        k.push(self.flags);
        k.extend_from_slice(&(self.conds.len() as u16).to_le_bytes());
        k.extend_from_slice(self.conds);
        k.extend_from_slice(&(self.dir.len() as u16).to_le_bytes());
        k.extend_from_slice(self.dir);
        k.extend_from_slice(self.spec);
        k.into_boxed_slice()
    }
}

fn deliver(err: i32, src: &[u8], out: &mut [u8]) -> i32 {
    if err != 0 {
        return -err;
    }
    if src.len() > out.len() {
        return -ERANGE;
    }
    out[..src.len()].copy_from_slice(src);
    src.len() as i32
}

/// Resolve `spec` as imported by `importer`. Writes the type byte and the
/// path to `out`; returns their length or `-errno`.
pub fn resolve(spec: &[u8], importer: &[u8], flags: u32, conds: &[u8], out: &mut [u8]) -> i32 {
    N_CALLS.fetch_add(1, Relaxed);
    let flags = flags & 7;
    if spec.len() > 0xFFFF || importer.len() > 0xFFFF || conds.len() > 0xFFFF {
        return -ENAMETOOLONG;
    }
    // Only the importer's directory matters, and not even that for an
    // absolute request.
    let absolute = spec.first() == Some(&b'/') || spec.starts_with(b"file:");
    // (An importer relative to a working directory is resolved, not cached.)
    let cacheable = absolute || importer.first() == Some(&b'/');
    let dir = if absolute {
        &[][..]
    } else if flags & RESOLVE_IMPORTER_IS_DIR != 0 {
        importer
    } else {
        &importer[..importer.iter().rposition(|&c| c == b'/').unwrap_or(0)]
    };
    let key = Key { flags: flags as u8, conds, dir, spec };
    let h = key.hash();
    let gen = BAT_OVERLAY_GEN.load(Relaxed);
    {
        let r = RESULTS.read();
        if r.gen == gen && cacheable {
            if let Some(e) = r.map.get(&h).filter(|e| key.matches(&e.key)) {
                N_HITS.fetch_add(1, Relaxed);
                return deliver(e.err, &e.out, out);
            }
        }
    }
    let t0 = sys::now_ms();
    let res = resolve_uncached(spec, importer, flags, conds);
    NANOS.fetch_add(((sys::now_ms() - t0).max(0.0) * 1e6) as u64, Relaxed);
    let (err, bytes): (i32, Box<[u8]>) = match res {
        Ok(v) => (0, v.into_boxed_slice()),
        Err(e) => (e, Box::default()),
    };
    let rc = deliver(err, &bytes, out);
    // Answers about the tree are cached, failures of the machinery are not.
    if cacheable && matches!(err, 0 | ENOENT | EACCES | EINVAL) {
        let ent = REnt { key: key.to_box(), err, out: bytes };
        let old = {
            let mut r = RESULTS.write();
            let cur = BAT_OVERLAY_GEN.load(Relaxed);
            let old = if r.gen != cur || r.map.len() >= RESULT_CAP {
                r.gen = cur;
                Some(core::mem::replace(&mut r.map, HashMap::with_hasher(Bh::new())))
            } else {
                None
            };
            if cur == gen {
                r.map.insert(h, ent);
            }
            old
        };
        // Freed after the lock is released.
        drop(old);
    }
    rc
}

/// Nearest package.json for a file or directory path. Writes the type byte
/// and the package.json path.
pub fn package_scope(path: &[u8], out: &mut [u8]) -> i32 {
    let r = (|| -> R<Vec<u8>> {
        let mut dir = abs(path)?;
        if kind(&dir) != 1 {
            pop(&mut dir);
        }
        let (sdir, pkg) = find_scope(&dir)?.ok_or(ENOENT)?;
        let mut v = Vec::with_capacity(sdir.len() + 14);
        v.push(pkg.ty);
        v.extend_from_slice(&sdir);
        v.extend_from_slice(b"/package.json");
        Ok(v)
    })();
    match r {
        Ok(v) => deliver(0, &v, out),
        Err(e) => -e,
    }
}

// ---------------------------------------------------------------------------
// Exports (docs/design/kernel-abi.md, section 14)
// ---------------------------------------------------------------------------

#[inline]
unsafe fn sl<'a>(p: *const u8, n: usize) -> &'a [u8] {
    if n == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(p, n)
    }
}
#[inline]
unsafe fn slm<'a>(p: *mut u8, n: usize) -> &'a mut [u8] {
    if n == 0 {
        &mut []
    } else {
        core::slice::from_raw_parts_mut(p, n)
    }
}

#[no_mangle]
pub unsafe extern "C" fn bat_resolve(
    spec: *const u8,
    slen: usize,
    importer: *const u8,
    ilen: usize,
    flags: u32,
    conds: *const u8,
    clen: usize,
    out: *mut u8,
    cap: usize,
) -> i32 {
    resolve(sl(spec, slen), sl(importer, ilen), flags, sl(conds, clen), slm(out, cap))
}

#[no_mangle]
pub unsafe extern "C" fn bat_package_scope(path: *const u8, plen: usize, out: *mut u8, cap: usize) -> i32 {
    package_scope(sl(path, plen), slm(out, cap))
}

/// out: 8 × f64: resolve calls, result-cache hits, vfs stat calls,
/// package.json reads, package.json cache hits, nanoseconds spent in
/// resolutions that missed the result cache, result-cache entries,
/// package-cache entries.
#[no_mangle]
pub unsafe extern "C" fn bat_resolve_stats(out: *mut f64) -> i32 {
    let results = {
        let r = RESULTS.read();
        if r.gen == BAT_OVERLAY_GEN.load(Relaxed) {
            r.map.len()
        } else {
            0
        }
    };
    let pkgs = PKGS.read().len();
    let v = [
        N_CALLS.load(Relaxed) as f64,
        N_HITS.load(Relaxed) as f64,
        N_STATS.load(Relaxed) as f64,
        N_PKG_READS.load(Relaxed) as f64,
        N_PKG_HITS.load(Relaxed) as f64,
        NANOS.load(Relaxed) as f64,
        results as f64,
        pkgs as f64,
    ];
    for (i, x) in v.iter().enumerate() {
        out.add(i).write_unaligned(*x);
    }
    0
}

// ---------------------------------------------------------------------------
// Tests: the pure parts (JSON, target matching) against Node's documented
// behaviour, and an opt-in run against a real tree (see `real_tree`).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> Json {
        Json::Str(x.as_bytes().into())
    }
    fn obj(kv: Vec<(&str, Json)>) -> Json {
        Json::Obj(kv.into_iter().map(|(k, v)| (k.as_bytes().into(), v)).collect())
    }

    #[test]
    fn resolve_json() {
        assert_eq!(parse_json(b" null "), Some(Json::Null));
        assert_eq!(parse_json(b"[true,false,-1.5e2,\"a\"]"), Some(Json::Arr(vec![Json::Bool(true), Json::Bool(false), Json::Num(-150.0), s("a")])));
        assert_eq!(parse_json(br#""a\n\"\\\/\u00e9\ud83d\ude00\u0041""#), Some(s("a\n\"\\/\u{e9}\u{1F600}A")));
        assert_eq!(
            parse_json(br#"{ "b" : {"x":[ ]} , "a":{}, "b": 1 }"#),
            Some(obj(vec![("b", Json::Num(1.0)), ("a", obj(vec![]))]))
        );
        for bad in [&b"{"[..], b"[1,]", b"{\"a\":}", b"\"abc", b"{} x", b"tru", b"{a:1}", b"\"\\x\""] {
            assert_eq!(parse_json(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn resolve_package_summary() {
        let p = parse_package(
            br##"{"version":"1","scripts":{"a":["x",{"y":null}]},"name":"@s/p","main":"./lib/i.js",
                "type":"module","exports":{".":{"import":"./e.mjs","default":"./c.js"}},"imports":{"#a":"./a.js"},"x":1.5}"##,
        );
        assert_eq!(p.name.as_deref(), Some(&b"@s/p"[..]));
        assert_eq!(p.main.as_deref(), Some(&b"./lib/i.js"[..]));
        assert_eq!(p.ty, 2);
        assert_eq!(p.exports, Some(obj(vec![(".", obj(vec![("import", s("./e.mjs")), ("default", s("./c.js"))]))])));
        assert_eq!(p.imports, Some(obj(vec![("#a", s("./a.js"))])));
        let p = parse_package(b"\xEF\xBB\xBF{\"type\":\"commonjs\",\"exports\":null,\"main\":3}");
        assert_eq!((p.ty, p.exports.is_none(), p.main.is_none()), (1, true, true));
        assert_eq!(parse_package(b"{\"type\":\"other\"}").ty, 0);
        assert!(parse_package(b"not json").name.is_none());
    }

    const REQ: Conds = Conds { esm: false, extra: b"" };
    const IMP: Conds = Conds { esm: true, extra: b"" };

    fn ex(json: &str, sub: &str, c: &Conds) -> Result<String, i32> {
        let j = parse_json(json.as_bytes()).expect("test json");
        exports_resolve(&j, sub.as_bytes(), c).map(|v| String::from_utf8(v).unwrap())
    }

    #[test]
    fn resolve_exports_table() {
        let ok = |p: &str| Ok(p.to_string());
        // sugar
        assert_eq!(ex(r#""./main.js""#, ".", &REQ), ok("./main.js"));
        assert_eq!(ex(r#""./main.js""#, "./x", &REQ), Err(EACCES));
        assert_eq!(ex(r#"{"import":"./m.mjs","require":"./m.cjs"}"#, ".", &IMP), ok("./m.mjs"));
        assert_eq!(ex(r#"{"import":"./m.mjs","require":"./m.cjs"}"#, ".", &REQ), ok("./m.cjs"));
        // order of keys decides, not order of conditions
        assert_eq!(ex(r#"{"default":"./d.js","require":"./m.cjs"}"#, ".", &REQ), ok("./d.js"));
        // nesting, and falling through a branch that matches nothing
        let nested = r#"{".":{"browser":{"import":"./b.mjs"},"node":{"types":"./t.d.ts","import":"./n.mjs"},"default":"./d.js"}}"#;
        assert_eq!(ex(nested, ".", &IMP), ok("./n.mjs"));
        assert_eq!(ex(nested, ".", &REQ), ok("./d.js"));
        assert_eq!(ex(nested, ".", &Conds { esm: true, extra: b"development, browser" }), ok("./b.mjs"));
        // arrays: first valid target; invalid ones are skipped
        assert_eq!(ex(r#"{".":["not-relative",{"import":"./i.mjs"},"./f.js"]}"#, ".", &REQ), ok("./f.js"));
        assert_eq!(ex(r#"{".":["not-relative"]}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{".":[]}"#, ".", &REQ), Err(EACCES));
        // subpaths, exact before pattern
        let subs = r#"{".":"./i.js","./package.json":"./package.json","./f/*":"./src/f/*.js","./f/*.css":"./css/*.css",
            "./f/internal/*":null,"./f/x":"./exact.js","./a/*/b":"./lib/*/*.js","./dir/":"./dir/"}"#;
        assert_eq!(ex(subs, ".", &REQ), ok("./i.js"));
        assert_eq!(ex(subs, "./package.json", &IMP), ok("./package.json"));
        assert_eq!(ex(subs, "./f/x", &REQ), ok("./exact.js"));
        assert_eq!(ex(subs, "./f/y", &REQ), ok("./src/f/y.js"));
        assert_eq!(ex(subs, "./f/deep/y", &REQ), ok("./src/f/deep/y.js"));
        // same prefix: the longer key (with a trailer) wins
        assert_eq!(ex(subs, "./f/y.css", &REQ), ok("./css/y.css"));
        // longest prefix wins, and null excludes
        assert_eq!(ex(subs, "./f/internal/z", &REQ), Err(EACCES));
        // every * in the target is replaced
        assert_eq!(ex(subs, "./a/q/b", &REQ), ok("./lib/q/q.js"));
        assert_eq!(ex(subs, "./nope", &REQ), Err(EACCES));
        // a pattern needs at least one character to stand for the *
        assert_eq!(ex(subs, "./f/", &REQ), Err(EACCES));
        // no folder mappings: a key ending in "/" only matches itself
        assert_eq!(ex(subs, "./dir/x", &REQ), Err(EACCES));
        assert_eq!(ex(subs, "./dir/", &REQ), Err(EACCES));
        // a pattern match may not smuggle in path segments
        assert_eq!(ex(subs, "./f/../../x", &REQ), Err(EINVAL));
        assert_eq!(ex(subs, "./f/node_modules/x", &REQ), Err(EINVAL));
        // invalid targets and configs
        assert_eq!(ex(r#"{".":"./a/../b.js"}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{".":"./node_modules/x.js"}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{".":"/abs.js"}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{".":3}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{".":"./a.js","import":"./b.js"}"#, ".", &REQ), Err(EINVAL));
        assert_eq!(ex(r#"{"import":"./b.js",".":"./a.js"}"#, ".", &REQ), Err(EINVAL));
        // condition present but nothing for this mode
        assert_eq!(ex(r#"{".":{"import":"./m.mjs"}}"#, ".", &REQ), Err(EACCES));
        assert_eq!(ex(r#"{".":{"require":null,"default":"./d.js"}}"#, ".", &REQ), Err(EACCES));
    }

    #[test]
    fn resolve_imports_table() {
        let j = parse_json(
            br##"{"#a":"./a.js","#dep":"dep/sub","#c":{"node":"./n.js","default":"./d.js"},"#int/*":"./src/*.js",
                 "#ext/*":"pkg/lib/*","#fs":"node:fs","#no":null,"#up":"../x.js"}"##,
        )
        .unwrap();
        let Json::Obj(o) = &j else { panic!() };
        let m = |k: &str| match_map(k.as_bytes(), o, true, &IMP);
        assert_eq!(m("#a"), Ok(Target::Path(b"./a.js".to_vec())));
        assert_eq!(m("#dep"), Ok(Target::Bare(b"dep/sub".to_vec())));
        assert_eq!(m("#c"), Ok(Target::Path(b"./n.js".to_vec())));
        assert_eq!(m("#int/x/y"), Ok(Target::Path(b"./src/x/y.js".to_vec())));
        assert_eq!(m("#ext/z.js"), Ok(Target::Bare(b"pkg/lib/z.js".to_vec())));
        assert_eq!(m("#fs"), Ok(Target::Bare(b"node:fs".to_vec())));
        assert_eq!(m("#no"), Ok(Target::Null));
        assert_eq!(m("#missing"), Ok(Target::Undef));
        assert_eq!(m("#up"), Err(EINVAL));
    }

    #[test]
    fn resolve_specifiers() {
        assert_eq!(split_bare(b"pkg"), Ok((&b"pkg"[..], &b""[..])));
        assert_eq!(split_bare(b"pkg/sub/x.js"), Ok((&b"pkg"[..], &b"/sub/x.js"[..])));
        assert_eq!(split_bare(b"@s/pkg"), Ok((&b"@s/pkg"[..], &b""[..])));
        assert_eq!(split_bare(b"@s/pkg/sub"), Ok((&b"@s/pkg"[..], &b"/sub"[..])));
        assert_eq!(split_bare(b"@s"), Err(EINVAL));
        assert_eq!(split_bare(b"@s/"), Err(ENOENT));
        assert_eq!(file_url_path(b"file:///a/b%20c/%C3%A9.js?x#y"), Ok("/a/b c/\u{e9}.js".as_bytes().to_vec()));
        assert_eq!(file_url_path(b"file://localhost/a"), Ok(b"/a".to_vec()));
        assert_eq!(file_url_path(b"file:///a%2Fb"), Err(EINVAL));
        assert_eq!(file_url_path(b"file://host/a"), Err(EINVAL));
        assert_eq!(join(b"/a/b", b"../c/./d/"), b"/a/c/d");
        assert_eq!(join(b"/a/b", b"/x"), b"/x");
        assert_eq!(join(b"", b"../.."), b"");
    }

    fn call(spec: &str, importer: &str, flags: u32, conds: &str) -> Result<(u8, String), i32> {
        let mut out = vec![0u8; 8192];
        let n = unsafe {
            bat_resolve(spec.as_ptr(), spec.len(), importer.as_ptr(), importer.len(), flags, conds.as_ptr(), conds.len(), out.as_mut_ptr(), out.len())
        };
        if n < 0 {
            Err(-n)
        } else {
            Ok((out[0], String::from_utf8_lossy(&out[1..n as usize]).into_owned()))
        }
    }
    fn stats() -> [f64; 8] {
        let mut v = [0f64; 8];
        unsafe { bat_resolve_stats(v.as_mut_ptr()) };
        v
    }

    /// Opt-in comparison with real Node over a real dependency tree:
    ///
    ///   BAT_RESOLVE_IMAGE=<image.batimg, mounted at /> BAT_RESOLVE_CASES=<cases.tsv> \
    ///     cargo test -p bat-kernel --release resolve::tests::real_tree -- --ignored --nocapture
    ///
    /// Each case line is `flags \t conds \t importer \t specifier \t expected
    /// [\t type \t package.json]`, where expected is an absolute path or an
    /// errno name, as real Node answered for the same tree, and the optional
    /// columns are the scope type digit and nearest package.json of the result. Optional `BAT_RESOLVE_OVERLAY` names a
    /// file of `F \t path \t contents-file` / `L \t path \t link-target`
    /// lines created in the overlay first.
    #[test]
    #[ignore]
    fn real_tree() {
        let image = std::env::var("BAT_RESOLVE_IMAGE").expect("BAT_RESOLVE_IMAGE");
        let cases = std::fs::read_to_string(std::env::var("BAT_RESOLVE_CASES").expect("BAT_RESOLVE_CASES")).unwrap();
        let t = crate::thread::bat_thread_alloc(1 << 16, 0, 16);
        crate::thread::bat_thread_start(t, 1);
        crate::bat_kernel_init();
        let img = std::fs::read(&image).unwrap();
        sys::set_image_reader(Box::new(move |_id, off, buf| {
            let off = off as usize;
            buf.copy_from_slice(&img[off..off + buf.len()]);
            buf.len() as i32
        }));
        let id = crate::abi::bat_image_reserve();
        assert!(unsafe { crate::abi::bat_image_mount(id, b"i".as_ptr(), 1, b"/".as_ptr(), 1) } > 0);
        if let Ok(f) = std::env::var("BAT_RESOLVE_OVERLAY") {
            for l in std::fs::read_to_string(f).unwrap().lines() {
                let f: Vec<&str> = l.split('\t').collect();
                let p = f[1];
                vfs::mkdir(p[..p.rfind('/').unwrap()].as_bytes(), 0o755, true).unwrap();
                if f[0] == "L" {
                    vfs::symlink(f[2].as_bytes(), p.as_bytes()).unwrap();
                } else {
                    vfs::write_file(p.as_bytes(), &std::fs::read(f[2]).unwrap(), 0o644, 0).unwrap();
                }
            }
        }
        let errname = |e: i32| match e {
            ENOENT => "ENOENT".to_string(),
            EACCES => "EACCES".to_string(),
            EINVAL => "EINVAL".to_string(),
            e => format!("E{e}"),
        };
        let rows: Vec<Vec<&str>> = cases.lines().filter(|l| !l.is_empty()).map(|l| l.split('\t').collect()).collect();
        let run = |report: bool| -> (usize, std::time::Duration) {
            let t0 = std::time::Instant::now();
            let mut bad = 0;
            for r in &rows {
                let res = call(r[3], r[2], r[0].parse().unwrap(), r[1]);
                let mut got = match &res {
                    Ok((_, p)) => p.clone(),
                    Err(e) => errname(*e),
                };
                // Optional columns: the type byte and the nearest package.json
                // (also asked of bat_package_scope).
                if let (Ok((ty, p)), true) = (&res, r.len() >= 7) {
                    let mut out = vec![0u8; 8192];
                    let n = unsafe { bat_package_scope(p.as_ptr(), p.len(), out.as_mut_ptr(), out.len()) };
                    let (sty, sp) = if n < 0 { (0, errname(-n)) } else { (out[0], String::from_utf8_lossy(&out[1..n as usize]).into_owned()) };
                    if ty.to_string() != r[5] || sty != *ty || sp != r[6] {
                        got = format!("{got} type {ty}, scope {sp} type {sty} (node: type {} scope {})", r[5], r[6]);
                    }
                }
                if got != r[4] {
                    bad += 1;
                    if report {
                        println!("MISMATCH flags={} conds={:?} importer={} spec={}\n   node: {}\n   ours: {}", r[0], r[1], r[2], r[3], r[4], got);
                    }
                }
            }
            (bad, t0.elapsed())
        };
        let s0 = stats();
        let (bad, cold) = run(true);
        let s1 = stats();
        let (_, warm) = run(false);
        let s2 = stats();
        let n = rows.len() as f64;
        println!(
            "cases {} mismatches {bad}\ncold: {:.2} us/resolve, {:.1} stats/resolve, {} package.json reads, {} package cache hits, kernel-timed {:.2} us/resolve\nwarm: {:.3} us/resolve, {} of {} from the result cache\nentries: results {} packages {}",
            rows.len(),
            cold.as_secs_f64() * 1e6 / n,
            (s1[2] - s0[2]) / n,
            s1[3] - s0[3],
            s1[4] - s0[4],
            (s1[5] - s0[5]) / 1e3 / n,
            warm.as_secs_f64() * 1e6 / n,
            s2[1] - s1[1],
            rows.len(),
            s2[6],
            s2[7]
        );
        // A namespace change invalidates results; image summaries survive it.
        vfs::write_file(b"/__resolve_gen_probe", b"x", 0o644, 0).unwrap();
        let (bad2, regen) = run(false);
        let s3 = stats();
        println!(
            "after an overlay change: {:.2} us/resolve, {} package.json reads, mismatches {bad2}",
            regen.as_secs_f64() * 1e6 / n,
            s3[3] - s2[3]
        );
        assert_eq!(bad, 0);
        assert_eq!(bad2, 0);
    }
}
