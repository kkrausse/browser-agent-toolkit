//! Smaller utilities an agent reaches for: `nl`, `base64`, the checksum
//! programs, `tree`, `cmp`, `paste`, `comm`, `expr`, `fold`, `column -t`,
//! `od`, `xxd`, `hexdump -C`.
use crate::builtins::Args;
use crate::files::fail;
use crate::interp::{Interp, X};
use crate::sys;
use regex_lite::Regex;

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    Ok(match a[0].as_str() {
        "nl" => nl(sh, a),
        "base64" => base64(sh, a),
        "sha256sum" | "sha1sum" | "md5sum" | "shasum" => sums(sh, a),
        "tree" => tree(sh, a),
        "cmp" => cmp(sh, a),
        "paste" => paste(sh, a),
        "comm" => comm(sh, a),
        "expr" => expr(sh, a),
        "fold" => fold(sh, a),
        "column" => column(sh, a),
        "od" | "xxd" | "hexdump" => dump(sh, a),
        _ => 127,
    })
}

/// One operand's bytes (`-` is standard input); an error is reported the usual way.
fn slurp(sh: &mut Interp, cmd: &str, f: &str) -> Option<Vec<u8>> {
    if f == "-" {
        return Some(sh.read_stdin_all());
    }
    match sys::read_file(&sh.abs(f)) {
        Ok(d) => Some(d),
        Err(e) => {
            sh.err(&format!("{cmd}: {f}: {}", sys::strerror(e)));
            None
        }
    }
}

fn lines_of(data: &[u8]) -> Vec<&[u8]> {
    let mut v: Vec<&[u8]> = data.split(|c| *c == b'\n').collect();
    if v.last().is_some_and(|l| l.is_empty()) {
        v.pop();
    }
    v
}

// ---- nl ----

fn nl(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "bwsvinhfdl");
    let opt = |c: char, long: &str| args.val(c).or(args.long_val(long)).map(str::to_string);
    let body = opt('b', "body-numbering").unwrap_or_else(|| "t".into());
    let width: usize = opt('w', "number-width").and_then(|v| v.parse().ok()).unwrap_or(6);
    let sep = opt('s', "number-separator").unwrap_or_else(|| "\t".into());
    let mut n: i64 = opt('v', "starting-line-number").and_then(|v| v.parse().ok()).unwrap_or(1);
    let incr: i64 = opt('i', "line-increment").and_then(|v| v.parse().ok()).unwrap_or(1);
    let format = opt('n', "number-format").unwrap_or_else(|| "rn".into());
    let re = match body.strip_prefix('p') {
        Some(p) => match Regex::new(&crate::text::posix_regex(p, false)) {
            Ok(r) => Some(r),
            Err(e) => return fail(sh, "nl", &format!("invalid regular expression: {e}")),
        },
        None => None,
    };
    if !(matches!(body.as_str(), "a" | "t" | "n") || re.is_some()) || !matches!(format.as_str(), "ln" | "rn" | "rz") {
        return fail(sh, "nl", "invalid numbering style or format");
    }
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    let mut st = 0;
    for f in &files {
        let Some(data) = slurp(sh, "nl", f) else {
            st = 1;
            continue;
        };
        let mut out = Vec::with_capacity(data.len() + data.len() / 4);
        for line in lines_of(&data) {
            let numbered = match body.as_str() {
                "a" => true,
                "t" => !line.is_empty(),
                "n" => false,
                _ => re.as_ref().is_some_and(|r| r.is_match(&String::from_utf8_lossy(line))),
            };
            if numbered {
                let num = match format.as_str() {
                    "ln" => format!("{n:<width$}"),
                    "rz" if n < 0 => format!("-{:0w$}", -n, w = width.saturating_sub(1)),
                    "rz" => format!("{n:0width$}"),
                    _ => format!("{n:>width$}"),
                };
                out.extend_from_slice(num.as_bytes());
                out.extend_from_slice(sep.as_bytes());
                n += incr;
            } else {
                out.resize(out.len() + width + sep.len(), b' ');
            }
            out.extend_from_slice(line);
            out.push(b'\n');
        }
        sh.out(&out);
    }
    st
}

// ---- base64 ----

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 3 * 4 + 4);
    for c in data.chunks(3) {
        let v = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(B64[(v >> 18) as usize & 63]);
        out.push(B64[(v >> 12) as usize & 63]);
        out.push(if c.len() > 1 { B64[(v >> 6) as usize & 63] } else { b'=' });
        out.push(if c.len() > 2 { B64[v as usize & 63] } else { b'=' });
    }
    out
}

fn base64(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "w");
    let decode = args.has('d') || args.has('D') || args.long("decode");
    let garbage = args.has('i') || args.long("ignore-garbage");
    let wrap: usize = match args.val('w').or(args.long_val("wrap")) {
        Some(v) => match v.parse() {
            Ok(n) => n,
            Err(_) => return fail(sh, "base64", &format!("invalid wrap size: '{v}'")),
        },
        None => 76,
    };
    if args.rest.len() > 1 {
        return fail(sh, "base64", &format!("extra operand '{}'", args.rest[1]));
    }
    let Some(data) = slurp(sh, "base64", args.rest.first().map(String::as_str).unwrap_or("-")) else { return 1 };
    if !decode {
        let enc = b64_encode(&data);
        if wrap == 0 {
            sh.out(&enc);
        } else {
            let mut out = Vec::with_capacity(enc.len() + enc.len() / wrap + 1);
            for c in enc.chunks(wrap) {
                out.extend_from_slice(c);
                out.push(b'\n');
            }
            sh.out(&out);
        }
        return 0;
    }
    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let (mut acc, mut bits, mut bad) = (0u32, 0u32, false);
    for &c in &data {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => {
                // Padding closes a group; another group may follow.
                bits = 0;
                acc = 0;
                continue;
            }
            b'\n' | b'\r' => continue,
            _ if garbage => continue,
            _ => {
                bad = true;
                break;
            }
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    sh.out(&out);
    if bad {
        return fail(sh, "base64", "invalid input");
    }
    0
}

// ---- checksums ----

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Message padding shared by the three digests: 0x80, zeros, the bit length in 8 bytes.
fn padded(data: &[u8], big_endian: bool) -> Vec<u8> {
    let mut m = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend_from_slice(&if big_endian { bits.to_be_bytes() } else { bits.to_le_bytes() });
    m
}

pub fn sha256(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
        0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
        0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
        0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for block in padded(data, true).chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let bytes: Vec<u8> = h.iter().flat_map(|x| x.to_be_bytes()).collect();
    hex(&bytes)
}

fn sha1(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    for block in padded(data, true).chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i / 20 {
                0 => ((b & c) | (!b & d), 0x5A827999),
                1 => (b ^ c ^ d, 0x6ED9EBA1),
                2 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, t);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let bytes: Vec<u8> = h.iter().flat_map(|x| x.to_be_bytes()).collect();
    hex(&bytes)
}

fn md5(data: &[u8]) -> String {
    const S: [u32; 16] = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let mut h: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for block in padded(data, false).chunks(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64usize {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            // K[i] = floor(2^32 * |sin(i + 1)|)
            let k = (((i + 1) as f64).sin().abs() * 4294967296.0) as u32;
            let f = f.wrapping_add(a).wrapping_add(k).wrapping_add(m[g]);
            (a, d, c) = (d, c, b);
            b = b.wrapping_add(f.rotate_left(S[i / 16 * 4 + i % 4]));
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d]) {
            *x = x.wrapping_add(y);
        }
    }
    let bytes: Vec<u8> = h.iter().flat_map(|x| x.to_le_bytes()).collect();
    hex(&bytes)
}

fn sums(sh: &mut Interp, a: &[String]) -> i32 {
    let cmd = a[0].as_str();
    let args = Args::parse(a, "a");
    let algo = match cmd {
        "sha1sum" => "1",
        "md5sum" => "md5",
        "shasum" => args.val('a').or(args.long_val("algorithm")).unwrap_or("1"),
        _ => "256",
    };
    let digest: fn(&[u8]) -> String = match algo {
        "256" => sha256,
        "1" => sha1,
        "md5" => md5,
        other => return fail(sh, cmd, &format!("algorithm {other} is not available in this environment (1 and 256 are)")),
    };
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    let mut st = 0;
    if args.has('c') || args.long("check") {
        let (quiet, status) = (args.long("quiet"), args.long("status"));
        for f in &files {
            let Some(list) = slurp(sh, cmd, f) else {
                st = 1;
                continue;
            };
            let (mut good_lines, mut failed, mut unreadable) = (0, 0, 0);
            for line in String::from_utf8_lossy(&list).lines() {
                let Some((sum, name)) = line.split_once(' ') else { continue };
                let name = name.strip_prefix([' ', '*']).unwrap_or(name);
                if sum.len() < 32 || !sum.bytes().all(|c| c.is_ascii_hexdigit()) || name.is_empty() {
                    continue;
                }
                good_lines += 1;
                let verdict = match slurp(sh, cmd, name) {
                    Some(d) if digest(&d).eq_ignore_ascii_case(sum) => "OK",
                    Some(_) => {
                        failed += 1;
                        "FAILED"
                    }
                    None => {
                        unreadable += 1;
                        "FAILED open or read"
                    }
                };
                if !status && !(quiet && verdict == "OK") {
                    sh.outs(&format!("{name}: {verdict}\n"));
                }
            }
            if good_lines == 0 {
                sh.err(&format!("{cmd}: {f}: no properly formatted checksum lines found"));
                st = 1;
            }
            if unreadable > 0 {
                sh.err(&format!("{cmd}: WARNING: {unreadable} listed file{} could not be read", if unreadable == 1 { "" } else { "s" }));
                st = 1;
            }
            if failed > 0 {
                sh.err(&format!("{cmd}: WARNING: {failed} computed checksum{} did NOT match", if failed == 1 { "" } else { "s" }));
                st = 1;
            }
        }
        return st;
    }
    for f in &files {
        match slurp(sh, cmd, f) {
            Some(d) => {
                sh.outs(&format!("{}  {f}\n", digest(&d)));
            }
            None => st = 1,
        }
    }
    st
}

// ---- tree ----

struct Tree {
    all: bool,
    dirs_only: bool,
    level: usize,
    full: bool,
    classify: bool,
    no_indent: bool,
    dirs_first: bool,
    ascii: bool,
    ignore: Vec<Vec<crate::glob::Pc>>,
    only: Vec<Vec<crate::glob::Pc>>,
    out: String,
    dirs: usize,
    files: usize,
}

impl Tree {
    fn dir(&mut self, shown: &str, path: &str, prefix: &str, depth: usize) {
        if depth >= self.level {
            return;
        }
        let Ok(ents) = sys::readdir(path) else { return };
        let base = path.trim_end_matches('/');
        // (name, is a directory to list, link target)
        let mut list: Vec<(String, bool, Option<String>)> = Vec::new();
        for (name, kind) in ents {
            if (!self.all && name.starts_with('.')) || self.ignore.iter().any(|g| crate::glob::matches_str(g, &name)) {
                continue;
            }
            let p = format!("{base}/{name}");
            let link = if kind == sys::K_SYMLINK { sys::readlink(&p).ok() } else { None };
            let is_dir = kind == sys::K_DIR || (link.is_some() && sys::stat(&p, true).map(|s| s.is_dir()).unwrap_or(false));
            if !is_dir && (self.dirs_only || (!self.only.is_empty() && !self.only.iter().any(|g| crate::glob::matches_str(g, &name)))) {
                continue;
            }
            list.push((name, is_dir, link));
        }
        list.sort_by(|x, y| (self.dirs_first && y.1).cmp(&(self.dirs_first && x.1)).then_with(|| x.0.as_bytes().cmp(y.0.as_bytes())));
        let n = list.len();
        for (i, (name, is_dir, link)) in list.into_iter().enumerate() {
            let last = i + 1 == n;
            let child_shown = format!("{}/{name}", shown.trim_end_matches('/'));
            self.out.push_str(prefix);
            if !self.no_indent {
                self.out.push_str(match (self.ascii, last) {
                    (false, false) => "├── ",
                    (false, true) => "└── ",
                    (true, false) => "|-- ",
                    (true, true) => "`-- ",
                });
            }
            self.out.push_str(if self.full { &child_shown } else { &name });
            if let Some(t) = &link {
                self.out.push_str(" -> ");
                self.out.push_str(t);
            } else if self.classify && is_dir {
                self.out.push('/');
            }
            self.out.push('\n');
            if is_dir {
                self.dirs += 1;
                if link.is_none() {
                    let deeper = if self.no_indent {
                        String::new()
                    } else {
                        format!("{prefix}{}", match (self.ascii, last) {
                            (_, true) => "    ",
                            (false, false) => "│\u{a0}\u{a0} ",
                            (true, false) => "|   ",
                        })
                    };
                    self.dir(&child_shown, &format!("{base}/{name}"), &deeper, depth + 1);
                }
            } else {
                self.files += 1;
            }
        }
    }
}

fn tree(sh: &mut Interp, a: &[String]) -> i32 {
    let mut t = Tree {
        all: false,
        dirs_only: false,
        level: usize::MAX,
        full: false,
        classify: false,
        no_indent: false,
        dirs_first: false,
        ascii: false,
        ignore: Vec::new(),
        only: Vec::new(),
        out: String::new(),
        dirs: 0,
        files: 0,
    };
    let mut report = true;
    let mut roots: Vec<String> = Vec::new();
    let pats = |v: &str| -> Vec<Vec<crate::glob::Pc>> { v.split('|').map(crate::glob::pat).collect() };
    let mut i = 1;
    while i < a.len() {
        let s = a[i].as_str();
        i += 1;
        let value = |i: &mut usize| -> Option<String> {
            let v = a.get(*i).cloned();
            *i += 1;
            v
        };
        match s {
            "--noreport" => report = false,
            "--dirsfirst" => t.dirs_first = true,
            "--charset" => t.ascii = value(&mut i).is_some_and(|v| !v.to_lowercase().starts_with("utf")),
            "--" => {
                roots.extend(a[i..].iter().cloned());
                break;
            }
            _ if s.starts_with("--charset=") => t.ascii = !s[10..].to_lowercase().starts_with("utf"),
            _ if s.starts_with("--") => return fail(sh, "tree", &format!("Invalid argument `{s}' (not supported by this tree)")),
            _ if s.len() > 1 && s.starts_with('-') => {
                for c in s[1..].chars() {
                    match c {
                        'a' => t.all = true,
                        'd' => t.dirs_only = true,
                        'f' => t.full = true,
                        'F' => t.classify = true,
                        'i' => t.no_indent = true,
                        'n' | 'N' | 'v' | 'A' | 'S' => {}
                        'L' => match value(&mut i).and_then(|v| v.parse::<usize>().ok()) {
                            Some(n) if n > 0 => t.level = n,
                            _ => return fail(sh, "tree", "Invalid level, must be greater than 0."),
                        },
                        'I' => t.ignore.extend(pats(&value(&mut i).unwrap_or_default())),
                        'P' => t.only.extend(pats(&value(&mut i).unwrap_or_default())),
                        other => return fail(sh, "tree", &format!("Invalid argument -`{other}' (not supported by this tree)")),
                    }
                }
            }
            _ => roots.push(s.to_string()),
        }
    }
    if roots.is_empty() {
        roots.push(".".into());
    }
    let mut st = 0;
    for r in &roots {
        let path = sh.abs(r);
        t.out.push_str(r);
        match sys::stat(&path, true) {
            Ok(s) if s.is_dir() => {
                if t.classify && !r.ends_with('/') {
                    t.out.push('/');
                }
                t.out.push('\n');
                // tree counts the starting directory only when it lists something in it.
                let before = t.out.len();
                t.dir(r, &path, "", 0);
                t.dirs += (t.out.len() > before) as usize;
            }
            Ok(_) => {
                t.out.push_str("  [error opening dir]\n");
                t.files += 1;
            }
            Err(_) => {
                t.out.push_str("  [error opening dir]\n");
                st = 2;
            }
        }
    }
    if report {
        let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        t.out.push('\n');
        t.out.push_str(&plural(t.dirs, "directory", "directories"));
        if !t.dirs_only {
            t.out.push_str(", ");
            t.out.push_str(&plural(t.files, "file", "files"));
        }
        t.out.push('\n');
    }
    sh.outs(&t.out);
    st
}

// ---- cmp, paste, comm ----

fn cmp(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "n");
    if args.rest.is_empty() || args.rest.len() > 2 {
        sh.err("cmp: expected two files");
        return 2;
    }
    let second = args.rest.get(1).map(String::as_str).unwrap_or("-");
    let (Some(x), Some(y)) = (slurp(sh, "cmp", &args.rest[0]), slurp(sh, "cmp", second)) else { return 2 };
    let silent = args.has('s') || args.long("silent") || args.long("quiet");
    let common = x.len().min(y.len());
    let at = (0..common).find(|i| x[*i] != y[*i]);
    match at {
        Some(i) => {
            if !silent {
                let line = 1 + x[..i].iter().filter(|c| **c == b'\n').count();
                sh.outs(&format!("{} {} differ: byte {}, line {line}\n", args.rest[0], second, i + 1));
            }
            1
        }
        None if x.len() == y.len() => 0,
        None => {
            if !silent {
                let short = if x.len() < y.len() { &args.rest[0] } else { second };
                let lines = x[..common].iter().filter(|c| **c == b'\n').count();
                let tail = if common > 0 && x[common - 1] != b'\n' { format!(", in line {}", lines + 1) } else if common > 0 { format!(", line {lines}") } else { String::new() };
                sh.err(&format!("cmp: EOF on {short} after byte {common}{tail}"));
            }
            1
        }
    }
}

fn paste(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "d");
    let mut delims = Vec::new();
    crate::builtins::unescape(args.val('d').or(args.long_val("delimiters")).unwrap_or("\t"), &mut delims);
    let delim = |i: usize| -> &[u8] {
        if delims.is_empty() || delims[i % delims.len()] == 0 {
            &[]
        } else {
            std::slice::from_ref(&delims[i % delims.len()])
        }
    };
    let files: Vec<String> = if args.rest.is_empty() { vec!["-".into()] } else { args.rest.clone() };
    let stdin = if files.iter().any(|f| f == "-") { sh.read_stdin_all() } else { Vec::new() };
    let mut stdin_lines = lines_of(&stdin).into_iter();
    let mut st = 0;
    let mut data: Vec<Option<Vec<u8>>> = Vec::new();
    for f in &files {
        data.push(if f == "-" {
            None
        } else {
            let d = slurp(sh, "paste", f);
            st |= d.is_none() as i32;
            Some(d.unwrap_or_default())
        });
    }
    let mut out = Vec::new();
    if args.has('s') || args.long("serial") {
        for d in &data {
            let lines: Vec<&[u8]> = match d {
                Some(d) => lines_of(d),
                None => stdin_lines.by_ref().collect(),
            };
            for (i, l) in lines.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(delim(i - 1));
                }
                out.extend_from_slice(l);
            }
            out.push(b'\n');
        }
    } else {
        let mut iters: Vec<Option<std::vec::IntoIter<&[u8]>>> = data.iter().map(|d| d.as_ref().map(|d| lines_of(d).into_iter())).collect();
        loop {
            let row: Vec<Option<&[u8]>> = iters.iter_mut().map(|it| match it {
                Some(it) => it.next(),
                None => stdin_lines.next(),
            }).collect();
            if row.iter().all(Option::is_none) {
                break;
            }
            for (i, cell) in row.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(delim(i - 1));
                }
                out.extend_from_slice(cell.unwrap_or(b""));
            }
            out.push(b'\n');
        }
    }
    sh.out(&out);
    st
}

fn comm(sh: &mut Interp, a: &[String]) -> i32 {
    let mut args = Args::parse(a, "");
    // `-12` is two flags here, not a count.
    if let Some(digits) = args.val('#').map(str::to_string) {
        args.flags.extend(digits.chars().map(|c| (c, None)));
    }
    if args.rest.len() != 2 {
        return fail(sh, "comm", "expected two files");
    }
    let (Some(x), Some(y)) = (slurp(sh, "comm", &args.rest[0]), slurp(sh, "comm", &args.rest[1])) else { return 1 };
    let (x, y) = (lines_of(&x), lines_of(&y));
    let show = [!args.has('1'), !args.has('2'), !args.has('3')];
    let mut out = Vec::new();
    let mut put = |col: usize, line: &[u8]| {
        if show[col] {
            for _ in 0..show[..col].iter().filter(|s| **s).count() {
                out.push(b'\t');
            }
            out.extend_from_slice(line);
            out.push(b'\n');
        }
    };
    let (mut i, mut j) = (0, 0);
    while i < x.len() || j < y.len() {
        let ord = if i >= x.len() {
            std::cmp::Ordering::Greater
        } else if j >= y.len() {
            std::cmp::Ordering::Less
        } else {
            x[i].cmp(y[j])
        };
        match ord {
            std::cmp::Ordering::Less => {
                put(0, x[i]);
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                put(1, y[j]);
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                put(2, x[i]);
                i += 1;
                j += 1;
            }
        }
    }
    sh.out(&out);
    0
}

// ---- expr ----

struct Expr<'a> {
    t: &'a [String],
    i: usize,
}

type E = Result<String, String>;

fn int(s: &str) -> Option<i64> {
    let d = s.strip_prefix('-').unwrap_or(s);
    if d.is_empty() || !d.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

impl Expr<'_> {
    fn peek(&self) -> Option<&str> {
        self.t.get(self.i).map(String::as_str)
    }
    fn next(&mut self, after: &str) -> E {
        let v = self.t.get(self.i).cloned().ok_or_else(|| format!("syntax error: missing argument after '{after}'"))?;
        self.i += 1;
        Ok(v)
    }
    fn or(&mut self) -> E {
        let mut l = self.and()?;
        while self.peek() == Some("|") {
            self.i += 1;
            let r = self.and()?;
            if l.is_empty() || int(&l) == Some(0) {
                l = if r.is_empty() { "0".into() } else { r };
            }
        }
        Ok(l)
    }
    fn and(&mut self) -> E {
        let mut l = self.cmp()?;
        while self.peek() == Some("&") {
            self.i += 1;
            let r = self.cmp()?;
            if l.is_empty() || int(&l) == Some(0) || r.is_empty() || int(&r) == Some(0) {
                l = "0".into();
            }
        }
        Ok(l)
    }
    fn cmp(&mut self) -> E {
        let mut l = self.add()?;
        while let Some(op) = self.peek().filter(|o| matches!(*o, "=" | "==" | "!=" | "<" | "<=" | ">" | ">=")).map(str::to_string) {
            self.i += 1;
            let r = self.add()?;
            let ord = match (int(&l), int(&r)) {
                (Some(x), Some(y)) => x.cmp(&y),
                _ => l.as_str().cmp(r.as_str()),
            };
            let yes = match op.as_str() {
                "=" | "==" => ord.is_eq(),
                "!=" => ord.is_ne(),
                "<" => ord.is_lt(),
                "<=" => ord.is_le(),
                ">" => ord.is_gt(),
                _ => ord.is_ge(),
            };
            l = (yes as i32).to_string();
        }
        Ok(l)
    }
    fn arith(&mut self, level: u8) -> E {
        let ops: &[&str] = if level == 0 { &["+", "-"] } else { &["*", "/", "%"] };
        let mut l = if level == 0 { self.arith(1)? } else { self.matching()? };
        while let Some(op) = self.peek().filter(|o| ops.contains(o)).map(str::to_string) {
            self.i += 1;
            let r = if level == 0 { self.arith(1)? } else { self.matching()? };
            let (Some(x), Some(y)) = (int(&l), int(&r)) else { return Err("non-integer argument".into()) };
            let v = match op.as_str() {
                "+" => x.checked_add(y),
                "-" => x.checked_sub(y),
                "*" => x.checked_mul(y),
                _ if y == 0 => return Err("division by zero".into()),
                "/" => x.checked_div(y),
                _ => x.checked_rem(y),
            };
            l = v.ok_or("integer result too large")?.to_string();
        }
        Ok(l)
    }
    fn add(&mut self) -> E {
        self.arith(0)
    }
    fn regex(s: &str, pat: &str) -> E {
        let re = Regex::new(&format!("^(?:{})", crate::text::posix_regex(pat, false))).map_err(|e| format!("invalid regular expression: {e}"))?;
        Ok(match re.captures(s) {
            Some(c) if re.captures_len() > 1 => c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            Some(c) => c.get(0).map(|m| m.as_str().chars().count()).unwrap_or(0).to_string(),
            None if re.captures_len() > 1 => String::new(),
            None => "0".into(),
        })
    }
    fn matching(&mut self) -> E {
        let mut l = self.primary()?;
        while self.peek() == Some(":") {
            self.i += 1;
            let r = self.primary()?;
            l = Self::regex(&l, &r)?;
        }
        Ok(l)
    }
    fn primary(&mut self) -> E {
        let tok = self.next(if self.i > 0 { &self.t[self.i - 1] } else { "" })?;
        let more = self.i < self.t.len();
        match tok.as_str() {
            "(" => {
                let v = self.or()?;
                if self.peek() != Some(")") {
                    return Err("syntax error: expecting ')'".into());
                }
                self.i += 1;
                Ok(v)
            }
            "length" if more => Ok(self.primary()?.chars().count().to_string()),
            "match" if more => {
                let s = self.primary()?;
                let p = self.primary()?;
                Self::regex(&s, &p)
            }
            "index" if more => {
                let s = self.primary()?;
                let set = self.primary()?;
                Ok(s.chars().position(|c| set.contains(c)).map(|p| p + 1).unwrap_or(0).to_string())
            }
            "substr" if more => {
                let s = self.primary()?;
                let (p, n) = (self.primary()?, self.primary()?);
                let (Some(p), Some(n)) = (int(&p), int(&n)) else { return Err("non-integer argument".into()) };
                if p <= 0 || n <= 0 {
                    return Ok(String::new());
                }
                Ok(s.chars().skip(p as usize - 1).take(n as usize).collect())
            }
            _ => Ok(tok),
        }
    }
}

fn expr(sh: &mut Interp, a: &[String]) -> i32 {
    let toks = if a.get(1).map(String::as_str) == Some("--") { &a[2..] } else { &a[1..] };
    if toks.is_empty() {
        sh.err("expr: missing operand");
        return 2;
    }
    let mut e = Expr { t: toks, i: 0 };
    let r = e.or().and_then(|v| if e.i < toks.len() { Err(format!("syntax error: unexpected argument '{}'", toks[e.i])) } else { Ok(v) });
    match r {
        Ok(v) => {
            sh.outs(&format!("{v}\n"));
            (v.is_empty() || int(&v) == Some(0)) as i32
        }
        Err(msg) => {
            sh.err(&format!("expr: {msg}"));
            2
        }
    }
}

// ---- fold, column ----

fn fold(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "w");
    let width: usize = args.val('w').or(args.long_val("width")).or(args.val('#')).and_then(|v| v.parse().ok()).unwrap_or(80).max(1);
    let (spaces, bytes) = (args.has('s'), args.has('b'));
    let (data, st) = crate::text::input(sh, "fold", &args.rest);
    let mut out = Vec::with_capacity(data.len() + data.len() / width + 1);
    // The current output line and its width in columns.
    let mut line: Vec<u8> = Vec::new();
    let mut col = 0usize;
    let width_of = |line: &[u8]| -> usize {
        let mut c = 0;
        for &b in line {
            c = advance(c, b, bytes);
        }
        c
    };
    fn advance(col: usize, b: u8, bytes: bool) -> usize {
        match b {
            _ if bytes => col + 1,
            b'\t' => col / 8 * 8 + 8,
            8 => col.saturating_sub(1),
            b'\r' => 0,
            // Continuation bytes of a UTF-8 character take no column.
            0x80..=0xbf => col,
            _ => col + 1,
        }
    }
    for &b in &data {
        if b == b'\n' {
            out.extend_from_slice(&line);
            out.push(b'\n');
            line.clear();
            col = 0;
            continue;
        }
        loop {
            let next = advance(col, b, bytes);
            if next <= width || line.is_empty() {
                col = next;
                break;
            }
            let cut = if spaces { line.iter().rposition(|c| *c == b' ' || *c == b'\t').map(|p| p + 1) } else { None };
            match cut {
                Some(p) => {
                    out.extend_from_slice(&line[..p]);
                    out.push(b'\n');
                    line.drain(..p);
                    col = width_of(&line);
                }
                None => {
                    out.extend_from_slice(&line);
                    out.push(b'\n');
                    line.clear();
                    col = 0;
                }
            }
        }
        line.push(b);
    }
    out.extend_from_slice(&line);
    sh.out(&out);
    st
}

fn column(sh: &mut Interp, a: &[String]) -> i32 {
    let args = Args::parse(a, "soc");
    if !(args.has('t') || args.long("table")) {
        return fail(sh, "column", "only the table form (-t, with -s and -o) is available in this environment");
    }
    let seps = args.val('s').or(args.long_val("separator"));
    let osep = args.val('o').or(args.long_val("output-separator")).unwrap_or("  ").to_string();
    let (data, st) = crate::text::input(sh, "column", &args.rest);
    let text = String::from_utf8_lossy(&data);
    let rows: Vec<Vec<&str>> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| match seps {
            Some(s) => l.split(|c| s.contains(c)).collect(),
            None => l.split_whitespace().collect(),
        })
        .collect();
    let ncols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0usize; ncols];
    for r in &rows {
        for (i, c) in r.iter().enumerate() {
            widths[i] = widths[i].max(c.chars().count());
        }
    }
    let mut out = String::new();
    for r in &rows {
        for (i, c) in r.iter().enumerate() {
            out.push_str(c);
            if i + 1 < ncols {
                for _ in c.chars().count()..widths[i] {
                    out.push(' ');
                }
                out.push_str(&osep);
            }
        }
        out.push('\n');
    }
    sh.outs(&out);
    st
}

// ---- od, xxd, hexdump -C ----

fn printable(b: u8) -> char {
    if (0x20..0x7f).contains(&b) {
        b as char
    } else {
        '.'
    }
}

fn dump(sh: &mut Interp, a: &[String]) -> i32 {
    let cmd = a[0].as_str();
    let args = Args::parse(a, match cmd {
        "od" => "AtNjwS",
        "xxd" => "lscgo",
        _ => "ns",
    });
    let unsupported = |sh: &mut Interp, what: &str| fail(sh, cmd, &format!("{what} is not available in this environment"));
    let num = |c: char| args.val(c).and_then(|v| v.parse::<usize>().ok());
    let (mut data, st) = crate::text::input(sh, cmd, &args.rest);
    let skip = if cmd == "xxd" { num('s') } else if cmd == "od" { num('j') } else { num('s') }.unwrap_or(0).min(data.len());
    data.drain(..skip);
    if let Some(n) = if cmd == "od" { num('N') } else if cmd == "xxd" { num('l') } else { num('n') } {
        data.truncate(n);
    }
    let mut out = String::new();
    match cmd {
        "xxd" => {
            if args.has('r') || args.has('i') || args.has('b') || args.has('e') {
                return unsupported(sh, "xxd -r/-i/-b/-e");
            }
            if args.has('p') || args.long("ps") || args.long("plain") {
                for row in data.chunks(num('c').unwrap_or(30).max(1)) {
                    out.push_str(&hex(row));
                    out.push('\n');
                }
            } else {
                let cols = num('c').unwrap_or(16).max(1);
                let group = num('g').unwrap_or(2);
                let cell = |i: usize| 2 + (group > 0 && (i + 1) % group == 0) as usize;
                let area: usize = (0..cols).map(cell).sum::<usize>() + (group == 0 || cols % group != 0) as usize;
                for (n, row) in data.chunks(cols).enumerate() {
                    out.push_str(&format!("{:08x}: ", skip + n * cols));
                    let mut used = 0;
                    for (i, b) in row.iter().enumerate() {
                        out.push_str(&format!("{b:02x}"));
                        if cell(i) == 3 {
                            out.push(' ');
                        }
                        used += cell(i);
                    }
                    for _ in used..area {
                        out.push(' ');
                    }
                    out.push(' ');
                    out.extend(row.iter().map(|b| printable(*b)));
                    out.push('\n');
                }
            }
        }
        "hexdump" => {
            if !args.has('C') {
                return unsupported(sh, "hexdump without -C");
            }
            let mut prev: Option<&[u8]> = None;
            let mut starred = false;
            for (n, row) in data.chunks(16).enumerate() {
                if prev == Some(row) && row.len() == 16 && !args.has('v') {
                    if !starred {
                        out.push_str("*\n");
                        starred = true;
                    }
                    continue;
                }
                starred = false;
                prev = Some(row);
                out.push_str(&format!("{:08x}  ", skip + n * 16));
                for i in 0..16 {
                    match row.get(i) {
                        Some(b) => out.push_str(&format!("{b:02x} ")),
                        None => out.push_str("   "),
                    }
                    if i == 7 {
                        out.push(' ');
                    }
                }
                out.push_str(" |");
                out.extend(row.iter().map(|b| printable(*b)));
                out.push_str("|\n");
            }
            if !data.is_empty() || skip > 0 {
                out.push_str(&format!("{:08x}\n", skip + data.len()));
            }
        }
        _ => {
            let mut kind = if args.has('c') {
                "c"
            } else if args.has('x') {
                "x2"
            } else if args.has('b') {
                "o1"
            } else {
                "o2"
            };
            if let Some(t) = args.val('t').or(args.long_val("format")) {
                kind = match t {
                    "c" => "c",
                    "x1" | "xC" => "x1",
                    "x2" | "x" => "x2",
                    "o1" | "oC" => "o1",
                    "o2" | "o" => "o2",
                    "u1" | "uC" => "u1",
                    other => return unsupported(sh, &format!("od -t {other}")),
                };
            }
            let radix = args.val('A').or(args.long_val("address-radix")).unwrap_or("o");
            let addr = |n: usize| match radix {
                "x" => format!("{n:06x}"),
                "d" => format!("{n:07}"),
                "n" => String::new(),
                _ => format!("{n:07o}"),
            };
            let mut prev: Option<&[u8]> = None;
            let mut starred = false;
            for (n, row) in data.chunks(16).enumerate() {
                if prev == Some(row) && row.len() == 16 && !args.has('v') {
                    if !starred {
                        out.push_str("*\n");
                        starred = true;
                    }
                    continue;
                }
                starred = false;
                prev = Some(row);
                out.push_str(&addr(skip + n * 16));
                match kind {
                    "c" => {
                        for b in row {
                            out.push_str(&match b {
                                0 => "  \\0".to_string(),
                                7 => "  \\a".into(),
                                8 => "  \\b".into(),
                                9 => "  \\t".into(),
                                10 => "  \\n".into(),
                                11 => "  \\v".into(),
                                12 => "  \\f".into(),
                                13 => "  \\r".into(),
                                0x20..=0x7e => format!("   {}", *b as char),
                                _ => format!(" {b:03o}"),
                            });
                        }
                    }
                    "x1" => row.iter().for_each(|b| out.push_str(&format!(" {b:02x}"))),
                    "o1" => row.iter().for_each(|b| out.push_str(&format!(" {b:03o}"))),
                    "u1" => row.iter().for_each(|b| out.push_str(&format!(" {b:3}"))),
                    _ => {
                        for w in row.chunks(2) {
                            let v = w[0] as u32 | (*w.get(1).unwrap_or(&0) as u32) << 8;
                            out.push_str(&if kind == "x2" { format!(" {v:04x}") } else { format!(" {v:06o}") });
                        }
                    }
                }
                out.push('\n');
            }
            if radix != "n" {
                out.push_str(&addr(skip + data.len()));
                out.push('\n');
            }
        }
    }
    sh.outs(&out);
    st
}
