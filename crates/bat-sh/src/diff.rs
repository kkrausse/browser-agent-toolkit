//! `diff`: normal and unified output, directories, the whitespace options.
//!
//! The comparison follows GNU diff step by step so hunks land where GNU diff
//! puts them: identical ends are dropped, confusing lines discarded, the
//! shortest edit script found from both ends (gnulib's diffseq), and each run
//! of changes slid to its usual place.
use crate::interp::{basename, Interp, X};
use crate::sys;
use std::collections::HashMap;

#[derive(Default)]
struct Opts {
    unified: Option<usize>,
    brief: bool,
    report_same: bool,
    recursive: bool,
    new_file: bool,
    ws_all: bool,
    ws_change: bool,
    ws_trailing: bool,
    icase: bool,
    blank: bool,
    text: bool,
    minimal: bool,
    strip_cr: bool,
    labels: Vec<String>,
    exclude: Vec<Vec<crate::glob::Pc>>,
    /// The option words as given, for the `diff -r a b` line.
    given: Vec<String>,
}

struct File {
    shown: String,
    data: Vec<u8>,
    mtime_ms: f64,
}

/// Lines without their newline; whether the last one had none.
fn split(data: &[u8]) -> (Vec<&[u8]>, bool) {
    let mut v: Vec<&[u8]> = data.split(|c| *c == b'\n').collect();
    let open = !v.last().is_some_and(|l| l.is_empty());
    if !open {
        v.pop();
    }
    (v, open && !data.is_empty())
}

fn key(o: &Opts, line: &[u8]) -> Vec<u8> {
    let mut l = line;
    if o.strip_cr && l.last() == Some(&b'\r') {
        l = &l[..l.len() - 1];
    }
    let blank = |c: u8| c == b' ' || c == b'\t' || c == b'\r' || c == 11 || c == 12;
    let mut out = Vec::with_capacity(l.len());
    if o.ws_all {
        out.extend(l.iter().filter(|c| !blank(**c)));
    } else if o.ws_change {
        let mut pending = false;
        for &c in l {
            if blank(c) {
                pending = true;
            } else {
                if pending {
                    out.push(b' ');
                }
                pending = false;
                out.push(c);
            }
        }
    } else if o.ws_trailing {
        let end = l.iter().rposition(|c| !blank(*c)).map(|p| p + 1).unwrap_or(0);
        out.extend_from_slice(&l[..end]);
    } else {
        out.extend_from_slice(l);
    }
    if o.icase {
        out.make_ascii_lowercase();
    }
    out
}

/// The comparison proper, after GNU diff (gnulib's `diffseq`): a divide and
/// conquer search from both ends for the middle of a shortest edit script.
/// `x` and `y` are the lines left after `discard`; `changed_*` are indexed by
/// those positions.
struct Seq<'a> {
    x: &'a [u32],
    y: &'a [u32],
    /// Furthest reaching forward and backward paths per diagonal (offset by `off`).
    fd: Vec<isize>,
    bd: Vec<isize>,
    off: isize,
    too_expensive: isize,
    changed_x: Vec<bool>,
    changed_y: Vec<bool>,
}

impl Seq<'_> {
    /// Returns (xmid, ymid, lo_minimal, hi_minimal).
    fn diag(&mut self, xoff: isize, xlim: isize, yoff: isize, ylim: isize, find_minimal: bool) -> (isize, isize, bool, bool) {
        let (xv, yv) = (self.x, self.y);
        let off = self.off;
        let (dmin, dmax) = (xoff - ylim, xlim - yoff);
        let (fmid, bmid) = (xoff - yoff, xlim - ylim);
        let (mut fmin, mut fmax) = (fmid, fmid);
        let (mut bmin, mut bmax) = (bmid, bmid);
        let odd = (fmid - bmid) & 1 != 0;
        self.fd[(off + fmid) as usize] = xoff;
        self.bd[(off + bmid) as usize] = xlim;
        let mut c = 1isize;
        loop {
            // Extend the top-down search by an edit step in each diagonal.
            if fmin > dmin {
                fmin -= 1;
                self.fd[(off + fmin - 1) as usize] = -1;
            } else {
                fmin += 1;
            }
            if fmax < dmax {
                fmax += 1;
                self.fd[(off + fmax + 1) as usize] = -1;
            } else {
                fmax -= 1;
            }
            let mut d = fmax;
            while d >= fmin {
                let (tlo, thi) = (self.fd[(off + d - 1) as usize], self.fd[(off + d + 1) as usize]);
                let mut x = if tlo < thi { thi } else { tlo + 1 };
                let mut y = x - d;
                while x < xlim && y < ylim && xv[x as usize] == yv[y as usize] {
                    x += 1;
                    y += 1;
                }
                self.fd[(off + d) as usize] = x;
                if odd && bmin <= d && d <= bmax && self.bd[(off + d) as usize] <= x {
                    return (x, y, true, true);
                }
                d -= 2;
            }
            // Similarly extend the bottom-up search.
            if bmin > dmin {
                bmin -= 1;
                self.bd[(off + bmin - 1) as usize] = isize::MAX;
            } else {
                bmin += 1;
            }
            if bmax < dmax {
                bmax += 1;
                self.bd[(off + bmax + 1) as usize] = isize::MAX;
            } else {
                bmax -= 1;
            }
            let mut d = bmax;
            while d >= bmin {
                let (tlo, thi) = (self.bd[(off + d - 1) as usize], self.bd[(off + d + 1) as usize]);
                let mut x = if tlo < thi { tlo } else { thi - 1 };
                let mut y = x - d;
                while xoff < x && yoff < y && xv[(x - 1) as usize] == yv[(y - 1) as usize] {
                    x -= 1;
                    y -= 1;
                }
                self.bd[(off + d) as usize] = x;
                if !odd && fmin <= d && d <= fmax && x <= self.fd[(off + d) as usize] {
                    return (x, y, true, true);
                }
                d -= 2;
            }
            if !find_minimal && c >= self.too_expensive {
                // Give up on the shortest script: split at the diagonal that got furthest.
                let (mut fxybest, mut fxbest) = (-1isize, 0isize);
                let mut d = fmax;
                while d >= fmin {
                    let mut x = self.fd[(off + d) as usize].min(xlim);
                    let mut y = x - d;
                    if ylim < y {
                        x = ylim + d;
                        y = ylim;
                    }
                    if fxybest < x + y {
                        fxybest = x + y;
                        fxbest = x;
                    }
                    d -= 2;
                }
                let (mut bxybest, mut bxbest) = (isize::MAX, 0isize);
                let mut d = bmax;
                while d >= bmin {
                    let mut x = xoff.max(self.bd[(off + d) as usize]);
                    let mut y = x - d;
                    if y < yoff {
                        x = yoff + d;
                        y = yoff;
                    }
                    if x + y < bxybest {
                        bxybest = x + y;
                        bxbest = x;
                    }
                    d -= 2;
                }
                return if (xlim + ylim) - bxybest < fxybest - (xoff + yoff) { (fxbest, fxybest - fxbest, true, false) } else { (bxbest, bxybest - bxbest, false, true) };
            }
            c += 1;
        }
    }

    fn compare(&mut self, mut xoff: isize, mut xlim: isize, mut yoff: isize, mut ylim: isize, mut find_minimal: bool) {
        loop {
            while xoff < xlim && yoff < ylim && self.x[xoff as usize] == self.y[yoff as usize] {
                xoff += 1;
                yoff += 1;
            }
            while xoff < xlim && yoff < ylim && self.x[(xlim - 1) as usize] == self.y[(ylim - 1) as usize] {
                xlim -= 1;
                ylim -= 1;
            }
            if xoff == xlim {
                (yoff..ylim).for_each(|y| self.changed_y[y as usize] = true);
                return;
            }
            if yoff == ylim {
                (xoff..xlim).for_each(|x| self.changed_x[x as usize] = true);
                return;
            }
            let (xmid, ymid, lo, hi) = self.diag(xoff, xlim, yoff, ylim, find_minimal);
            self.compare(xoff, xmid, yoff, ymid, lo);
            (xoff, yoff, find_minimal) = (xmid, ymid, hi);
        }
    }
}

/// GNU diff's `discard_confusing_lines`: lines with no match in the other file
/// are changed for certain; lines with very many matches are set aside too
/// when they sit inside a run of such lines. Returns per file which lines to
/// leave out of the comparison (they count as changed).
fn discard(eq: [&[u32]; 2], classes: usize) -> [Vec<bool>; 2] {
    let mut counts = [vec![0usize; classes], vec![0usize; classes]];
    for f in 0..2 {
        eq[f].iter().for_each(|e| counts[f][*e as usize] += 1);
    }
    let mut result = [Vec::new(), Vec::new()];
    for f in 0..2 {
        let end = eq[f].len();
        let mut many = 5;
        let mut tem = end / 64;
        loop {
            tem >>= 2;
            if tem == 0 {
                break;
            }
            many *= 2;
        }
        // 1: no match, 2: provisionally (many matches)
        let mut d: Vec<u8> = eq[f]
            .iter()
            .map(|e| match counts[1 - f][*e as usize] {
                0 => 1,
                n if n > many => 2,
                _ => 0,
            })
            .collect();
        let mut i = 0;
        while i < end {
            if d[i] == 2 {
                d[i] = 0;
            } else if d[i] != 0 {
                let mut provisional = 0usize;
                let mut j = i;
                while j < end && d[j] != 0 {
                    provisional += (d[j] == 2) as usize;
                    j += 1;
                }
                while j > i && d[j - 1] == 2 {
                    j -= 1;
                    d[j] = 0;
                    provisional -= 1;
                }
                let length = j - i;
                if provisional * 4 > length {
                    while j > i {
                        j -= 1;
                        if d[j] == 2 {
                            d[j] = 0;
                        }
                    }
                } else {
                    let mut minimum = 1usize;
                    let mut tem = length >> 2;
                    loop {
                        tem >>= 2;
                        if tem == 0 {
                            break;
                        }
                        minimum <<= 1;
                    }
                    minimum += 1;
                    // Cancel any subrun of `minimum` or more provisionals.
                    let (mut j, mut consec) = (0isize, 0usize);
                    while j < length as isize {
                        let at = i + j as usize;
                        if d[at] != 2 {
                            consec = 0;
                        } else {
                            consec += 1;
                            if minimum == consec {
                                j -= consec as isize;
                            } else if minimum < consec {
                                d[at] = 0;
                            }
                        }
                        j += 1;
                    }
                    // From each end: cancel provisionals until 3 certain ones in a row, or the first certain one 8 lines in.
                    let scan = |d: &mut Vec<u8>, at: &dyn Fn(usize) -> usize| {
                        let mut consec = 0;
                        for j in 0..length {
                            let p = at(j);
                            if j >= 8 && d[p] == 1 {
                                break;
                            }
                            if d[p] == 2 {
                                consec = 0;
                                d[p] = 0;
                            } else if d[p] == 0 {
                                consec = 0;
                            } else {
                                consec += 1;
                            }
                            if consec == 3 {
                                break;
                            }
                        }
                    };
                    scan(&mut d, &|j| i + j);
                    i += length - 1;
                    scan(&mut d, &|j| i - j);
                }
            }
            i += 1;
        }
        result[f] = d.iter().map(|x| *x != 0).collect();
    }
    result
}

/// GNU diff's `shift_boundaries`: slide each run of changes so that it ends as
/// late as it can and lines up with a run in the other file. `ch` and `oc`
/// have one guard element at each end (line `i` is index `i + 1`).
fn shift(ch: &mut [bool], oc: &[bool], eq: &[u32]) {
    let n = eq.len() as isize;
    let o = |j: isize| -> bool { j >= -1 && ((j + 1) as usize) < oc.len() && oc[(j + 1) as usize] };
    macro_rules! c {
        ($i:expr) => {
            ch[($i + 1) as usize]
        };
    }
    let (mut i, mut j) = (0isize, 0isize);
    loop {
        while i < n && !c!(i) {
            while o(j) {
                j += 1;
            }
            j += 1;
            i += 1;
        }
        if i >= n {
            break;
        }
        let mut start = i;
        i += 1;
        while c!(i) {
            i += 1;
        }
        while o(j) {
            j += 1;
        }
        let mut corresponding;
        loop {
            let run = i - start;
            while start > 0 && eq[(start - 1) as usize] == eq[(i - 1) as usize] {
                start -= 1;
                c!(start) = true;
                i -= 1;
                c!(i) = false;
                while c!(start - 1) {
                    start -= 1;
                }
                j -= 1;
                while o(j) {
                    j -= 1;
                }
            }
            corresponding = if o(j - 1) { i } else { n };
            while i != n && eq[start as usize] == eq[i as usize] {
                c!(start) = false;
                start += 1;
                c!(i) = true;
                i += 1;
                while c!(i) {
                    i += 1;
                }
                j += 1;
                while o(j) {
                    corresponding = i;
                    j += 1;
                }
            }
            if run == i - start {
                break;
            }
        }
        while corresponding < i {
            start -= 1;
            c!(start) = true;
            i -= 1;
            c!(i) = false;
            j -= 1;
            while o(j) {
                j -= 1;
            }
        }
    }
}

/// One run of differing lines: `a[a0..a1]` is replaced by `b[b0..b1]`.
struct Change {
    a0: usize,
    a1: usize,
    b0: usize,
    b1: usize,
    /// Only blank lines, under -B.
    ignored: bool,
}

fn changes(o: &Opts, a: &[&[u8]], a_open: bool, b: &[&[u8]], b_open: bool) -> Vec<Change> {
    // Number the distinct lines.
    let mut ids: HashMap<Vec<u8>, u32> = HashMap::new();
    let mut number = |line: &[u8], open: bool| -> u32 {
        let mut k = key(o, line);
        if open {
            k.extend_from_slice(b"\n\\");
        }
        let next = ids.len() as u32;
        *ids.entry(k).or_insert(next)
    };
    let ea: Vec<u32> = a.iter().enumerate().map(|(i, l)| number(l, a_open && i + 1 == a.len())).collect();
    let eb: Vec<u32> = b.iter().enumerate().map(|(i, l)| number(l, b_open && i + 1 == b.len())).collect();
    // Identical lines at the start, then at the end, take no part (and bound where a change may slide to).
    let same = |i: usize, j: usize| a[i] == b[j] && (a_open && i + 1 == a.len()) == (b_open && j + 1 == b.len());
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && same(pre, pre) {
        pre += 1;
    }
    // GNU diff leaves as many of them in as there are lines of context ("horizon"), so the first and last change may still slide.
    let horizon = o.unified.unwrap_or(0);
    pre = pre.saturating_sub(horizon);
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && same(a.len() - 1 - suf, b.len() - 1 - suf) {
        suf += 1;
    }
    suf = suf.saturating_sub(horizon);
    let (ma, mb) = (&ea[pre..ea.len() - suf], &eb[pre..eb.len() - suf]);
    let out_of = if o.minimal { [vec![false; ma.len()], vec![false; mb.len()]] } else { discard([ma, mb], ids.len()) };
    let keep_a: Vec<usize> = (0..ma.len()).filter(|i| !out_of[0][*i]).collect();
    let keep_b: Vec<usize> = (0..mb.len()).filter(|i| !out_of[1][*i]).collect();
    let sa: Vec<u32> = keep_a.iter().map(|i| ma[*i]).collect();
    let sb: Vec<u32> = keep_b.iter().map(|i| mb[*i]).collect();
    let diags = sa.len() + sb.len() + 3;
    let mut too_expensive = 1isize;
    let mut t = diags;
    while t != 0 {
        too_expensive <<= 1;
        t >>= 2;
    }
    let mut seq = Seq {
        x: &sa,
        y: &sb,
        fd: vec![0; diags],
        bd: vec![0; diags],
        off: sb.len() as isize + 1,
        too_expensive: too_expensive.max(4096),
        changed_x: vec![false; sa.len()],
        changed_y: vec![false; sb.len()],
    };
    seq.compare(0, sa.len() as isize, 0, sb.len() as isize, o.minimal);
    // Marks for the middle, with a guard element at each end.
    let mut mca: Vec<bool> = std::iter::once(false).chain(out_of[0].iter().copied()).chain(std::iter::once(false)).collect();
    let mut mcb: Vec<bool> = std::iter::once(false).chain(out_of[1].iter().copied()).chain(std::iter::once(false)).collect();
    for (n, i) in keep_a.iter().enumerate() {
        mca[i + 1] = seq.changed_x[n];
    }
    for (n, i) in keep_b.iter().enumerate() {
        mcb[i + 1] = seq.changed_y[n];
    }
    shift(&mut mca, &mcb, ma);
    shift(&mut mcb, &mca, mb);
    let mut ca = vec![false; a.len() + 2];
    let mut cb = vec![false; b.len() + 2];
    ca[pre + 1..pre + 1 + ma.len()].copy_from_slice(&mca[1..=ma.len()]);
    cb[pre + 1..pre + 1 + mb.len()].copy_from_slice(&mcb[1..=mb.len()]);
    let blank = |l: &[u8]| l.iter().all(|c| (o.ws_all || o.ws_change) && (*c == b' ' || *c == b'\t') || *c == b'\r' && o.strip_cr);
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && !ca[i + 1] && !cb[j + 1] {
            i += 1;
            j += 1;
            continue;
        }
        let (a0, b0) = (i, j);
        while i < a.len() && ca[i + 1] {
            i += 1;
        }
        while j < b.len() && cb[j + 1] {
            j += 1;
        }
        if i == a0 && j == b0 {
            // Marks out of step (cannot happen with a consistent script): take the rest as one change.
            i = a.len();
            j = b.len();
        }
        let ignored = o.blank && a[a0..i].iter().all(|l| blank(l)) && b[b0..j].iter().all(|l| blank(l));
        out.push(Change { a0, a1: i, b0, b1: j, ignored });
    }
    out
}

struct Diff<'a> {
    o: &'a Opts,
    out: Vec<u8>,
}

impl Diff<'_> {
    fn line(&mut self, mark: &str, lines: &[&[u8]], i: usize, open: bool) {
        self.out.extend_from_slice(mark.as_bytes());
        self.out.extend_from_slice(lines[i]);
        self.out.push(b'\n');
        if open && i + 1 == lines.len() {
            self.out.extend_from_slice(b"\\ No newline at end of file\n");
        }
    }

    /// Print the differences of two files; 0 when there are none to report.
    fn compare(&mut self, fa: &File, fb: &File, header: Option<&str>) -> i32 {
        let o = self.o;
        let same = fa.data == fb.data;
        let report = |d: &mut Diff, st: i32| -> i32 {
            if st == 0 && o.report_same {
                d.out.extend_from_slice(format!("Files {} and {} are identical\n", fa.shown, fb.shown).as_bytes());
            }
            st
        };
        if same {
            return report(self, 0);
        }
        let binary = |d: &[u8]| !o.text && d.iter().take(32768).any(|c| *c == 0);
        if binary(&fa.data) || binary(&fb.data) {
            self.out.extend_from_slice(format!("Binary files {} and {} differ\n", fa.shown, fb.shown).as_bytes());
            return 1;
        }
        let (a, a_open) = split(&fa.data);
        let (b, b_open) = split(&fb.data);
        let all = changes(o, &a, a_open, &b, b_open);
        if !all.iter().any(|c| !c.ignored) {
            return report(self, 0);
        }
        if o.brief {
            self.out.extend_from_slice(format!("Files {} and {} differ\n", fa.shown, fb.shown).as_bytes());
            return 1;
        }
        if let Some(h) = header {
            self.out.extend_from_slice(h.as_bytes());
            self.out.push(b'\n');
        }
        let range = |lo: usize, hi: usize, unified: bool| -> String {
            // `lo..hi` zero-based; printed one-based and inclusive.
            match hi - lo {
                0 if unified => format!("{lo},0"),
                0 => lo.to_string(),
                1 => (lo + 1).to_string(),
                n if unified => format!("{},{n}", lo + 1),
                _ => format!("{},{hi}", lo + 1),
            }
        };
        let Some(ctx) = o.unified else {
            for c in all.iter().filter(|c| !c.ignored) {
                let op = if c.a0 == c.a1 {
                    'a'
                } else if c.b0 == c.b1 {
                    'd'
                } else {
                    'c'
                };
                self.out.extend_from_slice(format!("{}{op}{}\n", range(c.a0, c.a1, false), range(c.b0, c.b1, false)).as_bytes());
                for i in c.a0..c.a1 {
                    self.line("< ", &a, i, a_open);
                }
                if op == 'c' {
                    self.out.extend_from_slice(b"---\n");
                }
                for i in c.b0..c.b1 {
                    self.line("> ", &b, i, b_open);
                }
            }
            return 1;
        };
        let stamp = |f: &File, label: Option<&String>| match label {
            Some(l) => l.clone(),
            None => format!("{}\t{}", f.shown, crate::text::format_date("%Y-%m-%d %H:%M:%S.%N %z", f.mtime_ms, sys::tz_offset_min())),
        };
        self.out.extend_from_slice(format!("--- {}\n+++ {}\n", stamp(fa, o.labels.first()), stamp(fb, o.labels.get(1))).as_bytes());
        let live: Vec<usize> = (0..all.len()).filter(|k| !all[*k].ignored).collect();
        let mut h = 0;
        while h < live.len() {
            // A hunk: this change and those after it that its context reaches.
            let first = live[h];
            let mut last = first;
            while h + 1 < live.len() && all[live[h + 1]].a0 - all[last].a1 <= 2 * ctx {
                h += 1;
                last = live[h];
            }
            h += 1;
            let lo = all[first].a0.saturating_sub(ctx);
            let hi = (all[last].a1 + ctx).min(a.len());
            // Ignored changes inside the context are still printed as changes.
            let mut from = first;
            while from > 0 && all[from - 1].a1 > lo {
                from -= 1;
            }
            let mut to = last;
            while to + 1 < all.len() && all[to + 1].a0 < hi {
                to += 1;
            }
            let lo = lo.min(all[from].a0);
            let hi = hi.max(all[to].a1);
            let b_lo = all[from].b0 - (all[from].a0 - lo);
            let b_hi = all[to].b1 + (hi - all[to].a1);
            self.out.extend_from_slice(format!("@@ -{} +{} @@\n", range(lo, hi, true), range(b_lo, b_hi, true)).as_bytes());
            let mut cur = lo;
            for c in &all[from..=to] {
                for i in cur..c.a0 {
                    self.line(" ", &a, i, a_open);
                }
                for i in c.a0..c.a1 {
                    self.line("-", &a, i, a_open);
                }
                for i in c.b0..c.b1 {
                    self.line("+", &b, i, b_open);
                }
                cur = c.a1;
            }
            for i in cur..hi {
                self.line(" ", &a, i, a_open);
            }
            while h < live.len() && live[h] <= to {
                h += 1;
            }
        }
        1
    }
}

fn load(sh: &mut Interp, shown: &str, path: Option<&str>) -> Result<File, i32> {
    let now = sys::now_ms();
    let Some(path) = path else { return Ok(File { shown: shown.to_string(), data: Vec::new(), mtime_ms: 0.0 }) };
    if shown == "-" {
        return Ok(File { shown: "-".into(), data: sh.read_stdin_all(), mtime_ms: now });
    }
    if path == "/dev/null" {
        return Ok(File { shown: shown.to_string(), data: Vec::new(), mtime_ms: now });
    }
    match sys::read_file(path) {
        Ok(data) => Ok(File { shown: shown.to_string(), data, mtime_ms: sys::stat(path, true).map(|s| s.mtime_ms).unwrap_or(now) }),
        Err(e) => {
            sh.err(&format!("diff: {shown}: {}", sys::strerror(e)));
            Err(2)
        }
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Compare two directories (`None`: absent, under -N).
fn dirs(sh: &mut Interp, d: &mut Diff, a: (&str, Option<&str>), b: (&str, Option<&str>)) -> i32 {
    let o = d.o;
    let list = |p: Option<&str>| -> Vec<(String, u8)> {
        let mut v = p.and_then(|p| sys::readdir(p).ok()).unwrap_or_default();
        v.retain(|e| !o.exclude.iter().any(|g| crate::glob::matches_str(g, &e.0)));
        v.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
        v
    };
    let (la, lb) = (list(a.1), list(b.1));
    let mut names: Vec<&String> = la.iter().chain(&lb).map(|e| &e.0).collect();
    names.sort_by(|x, y| x.as_bytes().cmp(y.as_bytes()));
    names.dedup();
    let mut st = 0;
    for name in names {
        let kind = |l: &[(String, u8)], dir: Option<&str>| -> Option<bool> {
            l.iter().find(|e| &e.0 == name).map(|e| e.1 == sys::K_DIR || (e.1 == sys::K_SYMLINK && dir.is_some_and(|d| sys::stat(&join(d, name), true).map(|s| s.is_dir()).unwrap_or(false))))
        };
        let (ka, kb) = (kind(&la, a.1), kind(&lb, b.1));
        let (sa, sb) = (join(a.0, name), join(b.0, name));
        let pa = a.1.filter(|_| ka.is_some()).map(|p| join(p, name));
        let pb = b.1.filter(|_| kb.is_some()).map(|p| join(p, name));
        let r = match (ka, kb) {
            (Some(true), Some(true)) | (Some(true), None) | (None, Some(true)) if ka.is_some() && kb.is_some() || o.new_file => {
                if o.recursive {
                    dirs(sh, d, (&sa, pa.as_deref()), (&sb, pb.as_deref()))
                } else {
                    if ka.is_some() && kb.is_some() {
                        d.out.extend_from_slice(format!("Common subdirectories: {sa} and {sb}\n").as_bytes());
                    }
                    0
                }
            }
            (Some(x), Some(y)) if x != y => {
                let what = |dir: bool| if dir { "directory" } else { "regular file" };
                d.out.extend_from_slice(format!("File {sa} is a {} while file {sb} is a {}\n", what(x), what(y)).as_bytes());
                1
            }
            (Some(_), None) | (None, Some(_)) if !o.new_file => {
                let dir = if ka.is_some() { a.0 } else { b.0 };
                d.out.extend_from_slice(format!("Only in {}: {name}\n", if dir.len() > 1 { dir.trim_end_matches('/') } else { dir }).as_bytes());
                1
            }
            _ => {
                let header = format!("diff {}{}{sa} {sb}", o.given.join(" "), if o.given.is_empty() { "" } else { " " });
                match (load(sh, &sa, pa.as_deref()), load(sh, &sb, pb.as_deref())) {
                    (Ok(fa), Ok(fb)) => d.compare(&fa, &fb, Some(&header)),
                    _ => 2,
                }
            }
        };
        st = st.max(r);
        if d.out.len() > 1 << 16 {
            sh.out(&d.out);
            d.out.clear();
        }
    }
    st
}

pub fn run(sh: &mut Interp, a: &[String]) -> X {
    let mut o = Opts::default();
    let mut rest: Vec<String> = Vec::new();
    let mut unified = false;
    let mut context: Option<usize> = None;
    let bad = |sh: &mut Interp, msg: String| -> X {
        sh.err(&format!("diff: {msg}"));
        Ok(2)
    };
    let mut i = 1;
    while i < a.len() {
        let s = a[i].as_str();
        i += 1;
        if s == "--" {
            rest.extend(a[i..].iter().cloned());
            break;
        }
        if s == "-" || !s.starts_with('-') {
            rest.push(s.to_string());
            continue;
        }
        o.given.push(s.to_string());
        if let Some(l) = s.strip_prefix("--") {
            let (name, mut v) = match l.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (l, None),
            };
            if v.is_none() && matches!(name, "label" | "exclude") {
                v = a.get(i).cloned();
                o.given.extend(v.clone());
                i += 1;
            }
            match name {
                "unified" => {
                    unified = true;
                    if let Some(n) = v {
                        match n.parse() {
                            Ok(n) => context = Some(n),
                            Err(_) => return bad(sh, format!("invalid context length '{n}'")),
                        }
                    }
                }
                "brief" => o.brief = true,
                "report-identical-files" => o.report_same = true,
                "recursive" => o.recursive = true,
                "new-file" | "unidirectional-new-file" => o.new_file = true,
                "ignore-all-space" => o.ws_all = true,
                "ignore-space-change" => o.ws_change = true,
                "ignore-trailing-space" => o.ws_trailing = true,
                "ignore-case" => o.icase = true,
                "ignore-blank-lines" => o.blank = true,
                "text" => o.text = true,
                "strip-trailing-cr" => o.strip_cr = true,
                "label" => o.labels.extend(v),
                "exclude" => o.exclude.extend(v.map(|p| crate::glob::pat(&p))),
                "minimal" => o.minimal = true,
                "normal" | "color" | "no-color" | "speed-large-files" | "no-dereference" => {}
                _ => return bad(sh, format!("option '--{name}' is not supported by this diff (normal and unified output only)")),
            }
            continue;
        }
        let chars: Vec<char> = s[1..].chars().collect();
        let mut k = 0;
        while k < chars.len() {
            let c = chars[k];
            k += 1;
            match c {
                'u' => unified = true,
                'q' => o.brief = true,
                's' => o.report_same = true,
                'r' => o.recursive = true,
                'N' | 'P' => o.new_file = true,
                'w' => o.ws_all = true,
                'b' => o.ws_change = true,
                'Z' => o.ws_trailing = true,
                'i' => o.icase = true,
                'B' => o.blank = true,
                'a' => o.text = true,
                'd' => o.minimal = true,
                '0'..='9' => context = Some(context.filter(|_| k > 1 && chars[k - 2].is_ascii_digit()).unwrap_or(0) * 10 + c as usize - '0' as usize),
                'U' | 'L' | 'x' => {
                    let mut v: String = chars[k..].iter().collect();
                    if v.is_empty() {
                        v = a.get(i).cloned().unwrap_or_default();
                        o.given.push(v.clone());
                        i += 1;
                    }
                    match c {
                        'U' => match v.parse() {
                            Ok(n) => {
                                unified = true;
                                context = Some(n);
                            }
                            Err(_) => return bad(sh, format!("invalid context length '{v}'")),
                        },
                        'L' => o.labels.push(v),
                        _ => o.exclude.push(crate::glob::pat(&v)),
                    }
                    break;
                }
                _ => return bad(sh, format!("option '-{c}' is not supported by this diff (normal and unified output only)")),
            }
        }
    }
    if unified {
        o.unified = Some(context.unwrap_or(3));
    }
    if rest.len() < 2 {
        return bad(sh, match rest.first() {
            Some(f) => format!("missing operand after '{f}'"),
            None => "missing operand".into(),
        });
    }
    if rest.len() > 2 {
        return bad(sh, format!("extra operand '{}'", rest[2]));
    }
    let is_dir = |sh: &Interp, p: &str| p != "-" && sys::stat(&sh.abs(p), true).map(|s| s.is_dir()).unwrap_or(false);
    let (mut sa, mut sb) = (rest[0].clone(), rest[1].clone());
    let (da, db) = (is_dir(sh, &sa), is_dir(sh, &sb));
    let mut d = Diff { o: &o, out: Vec::new() };
    let st = if sa == "-" && sb == "-" {
        0
    } else if da && db {
        let (pa, pb) = (sh.abs(&sa), sh.abs(&sb));
        dirs(sh, &mut d, (&sa, Some(&pa)), (&sb, Some(&pb)))
    } else {
        // A directory and a file: the file of that name in the directory.
        if da && sb != "-" {
            sa = join(&sa, basename(&sb));
        } else if db && sa != "-" {
            sb = join(&sb, basename(&sa));
        }
        let exists = |sh: &Interp, p: &str| p == "-" || p == "/dev/null" || sys::stat(&sh.abs(p), true).is_ok();
        let (xa, xb) = (exists(sh, &sa), exists(sh, &sb));
        // Under -N a missing file is an empty one, as long as the other exists.
        let (pa, pb) = (sh.abs(&sa), sh.abs(&sb));
        let fa = load(sh, &sa, if !xa && xb && o.new_file { None } else { Some(&pa) });
        let fb = load(sh, &sb, if !xb && xa && o.new_file { None } else { Some(&pb) });
        match (fa, fb) {
            (Ok(fa), Ok(fb)) => d.compare(&fa, &fb, None),
            _ => 2,
        }
    };
    sh.out(&d.out);
    Ok(st)
}
