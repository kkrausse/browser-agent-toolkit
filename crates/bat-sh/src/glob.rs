//! Shell patterns (`*`, `?`, `[…]`) and pathname expansion.
use crate::sys;

/// One pattern character and whether it was quoted (a quoted character only matches itself).
pub type Pc = (char, bool);

pub fn pat(s: &str) -> Vec<Pc> {
    s.chars().map(|c| (c, false)).collect()
}

pub fn has_magic(p: &[Pc]) -> bool {
    p.iter().any(|(c, q)| !q && matches!(c, '*' | '?' | '['))
}

/// Parse a bracket expression starting at `p[0] == '['`. Returns (matches c, length consumed).
fn bracket(p: &[Pc], c: char) -> Option<(bool, usize)> {
    let mut i = 1;
    let negate = matches!(p.get(i), Some(('!', false)) | Some(('^', false)));
    if negate {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    loop {
        let (ch, _) = *p.get(i)?;
        if ch == ']' && !first && !p[i].1 {
            i += 1;
            break;
        }
        first = false;
        if ch == '[' && matches!(p.get(i + 1), Some((':', _))) {
            // [:class:]
            let mut j = i + 2;
            let mut name = String::new();
            while let Some((x, _)) = p.get(j) {
                if *x == ':' {
                    break;
                }
                name.push(*x);
                j += 1;
            }
            if matches!(p.get(j + 1), Some((']', _))) {
                matched |= match name.as_str() {
                    "alpha" => c.is_alphabetic(),
                    "digit" => c.is_ascii_digit(),
                    "alnum" => c.is_alphanumeric(),
                    "upper" => c.is_uppercase(),
                    "lower" => c.is_lowercase(),
                    "space" => c.is_whitespace(),
                    "blank" => c == ' ' || c == '\t',
                    "punct" => c.is_ascii_punctuation(),
                    "xdigit" => c.is_ascii_hexdigit(),
                    "print" => !c.is_control(),
                    "cntrl" => c.is_control(),
                    _ => false,
                };
                i = j + 2;
                continue;
            }
        }
        if matches!(p.get(i + 1), Some(('-', false))) && !matches!(p.get(i + 2), Some((']', false)) | None) {
            let hi = p[i + 2].0;
            matched |= ch <= c && c <= hi;
            i += 3;
        } else {
            matched |= ch == c;
            i += 1;
        }
    }
    Some((matched != negate, i))
}

/// Does the whole of `s` match the pattern?
pub fn matches(p: &[Pc], s: &[char]) -> bool {
    let (mut pi, mut si) = (0, 0);
    let (mut star_p, mut star_s) = (usize::MAX, 0);
    loop {
        if pi < p.len() {
            let (c, q) = p[pi];
            if !q && c == '*' {
                star_p = pi;
                star_s = si;
                pi += 1;
                continue;
            }
            if si < s.len() {
                let step = if q {
                    (c == s[si]).then_some(1)
                } else if c == '?' {
                    Some(1)
                } else if c == '[' {
                    match bracket(&p[pi..], s[si]) {
                        Some((true, n)) => Some(n),
                        Some((false, _)) => None,
                        None => (s[si] == '[').then_some(1),
                    }
                } else if c == '\\' && pi + 1 < p.len() {
                    (p[pi + 1].0 == s[si]).then_some(2)
                } else {
                    (c == s[si]).then_some(1)
                };
                if let Some(n) = step {
                    pi += n;
                    si += 1;
                    continue;
                }
            }
        } else if si == s.len() {
            return true;
        }
        if star_p != usize::MAX && star_s < s.len() {
            star_s += 1;
            si = star_s;
            pi = star_p + 1;
            continue;
        }
        return false;
    }
}

pub fn matches_str(p: &[Pc], s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    matches(p, &chars)
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Pathname expansion of one field. `None` when nothing matches (the caller keeps the word).
pub fn expand(field: &[Pc], cwd: &str) -> Option<Vec<String>> {
    if !has_magic(field) {
        return None;
    }
    let absolute = field.first().map(|c| c.0) == Some('/');
    let segs: Vec<&[Pc]> = field.split(|(c, _)| *c == '/').filter(|s| !s.is_empty()).collect();
    let trailing_slash = field.last().map(|c| c.0) == Some('/');
    // (path as written, path to ask the host for)
    let mut cur: Vec<String> = vec![if absolute { "/".to_string() } else { String::new() }];
    let real = |shown: &str| -> String {
        if shown.starts_with('/') {
            shown.to_string()
        } else if shown.is_empty() {
            cwd.to_string()
        } else {
            join(cwd, shown)
        }
    };
    for (n, seg) in segs.iter().enumerate() {
        let last = n + 1 == segs.len();
        let mut next = Vec::new();
        if !has_magic(seg) {
            let name: String = seg.iter().map(|c| c.0).collect();
            for d in &cur {
                let p = join(d, &name);
                if sys::stat(&real(&p), false).is_ok() {
                    next.push(p);
                }
            }
        } else if seg.len() == 2 && seg.iter().all(|c| *c == ('*', false)) {
            // `**`: this directory and every directory below it.
            for d in &cur {
                let mut stack = vec![d.clone()];
                while let Some(dir) = stack.pop() {
                    if let Ok(mut ents) = sys::readdir(&real(&dir)) {
                        ents.sort();
                        for (name, kind) in ents.into_iter().rev() {
                            if name.starts_with('.') || name == "node_modules" {
                                continue;
                            }
                            if kind == sys::K_DIR {
                                stack.push(join(&dir, &name));
                            } else if last {
                                next.push(join(&dir, &name));
                            }
                        }
                    }
                    next.push(dir);
                }
            }
            if last {
                next.retain(|p| !p.is_empty() && p != "/");
            }
        } else {
            let dot = seg[0].0 == '.';
            for d in &cur {
                if let Ok(ents) = sys::readdir(&real(d)) {
                    let mut names: Vec<(String, u8)> =
                        ents.into_iter().filter(|(name, _)| (dot || !name.starts_with('.')) && matches_str(seg, name)).collect();
                    names.sort();
                    for (name, kind) in names {
                        if !last && kind == sys::K_FILE {
                            continue;
                        }
                        next.push(join(d, &name));
                    }
                }
            }
        }
        cur = next;
        if cur.is_empty() {
            return None;
        }
    }
    if trailing_slash {
        cur.retain(|p| sys::stat(&real(p), true).map(|s| s.is_dir()).unwrap_or(false));
        for p in cur.iter_mut() {
            p.push('/');
        }
    }
    cur.sort();
    cur.dedup();
    if cur.is_empty() {
        None
    } else {
        Some(cur)
    }
}
