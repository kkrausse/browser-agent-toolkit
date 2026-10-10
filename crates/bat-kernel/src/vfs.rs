//! The filesystem: one read-write overlay over read-only image mounts.
//!
//! The overlay is a slab of nodes. A directory's children map names to node
//! numbers, or to `WHITEOUT` to hide an image entry of that name. An overlay
//! directory can sit on top of an image directory (a "merged" directory): the
//! image supplies whatever the overlay does not name. Images are attached by
//! marking an overlay directory as a mount point.
//!
//! Everything here runs under `VFS` (a reader/writer lock). Lookups take it
//! shared; image indexes are immutable and need no lock at all.

use crate::errno::*;
use crate::image::ImageMount;
use crate::lock::RwLock;
use crate::path::{components, split_parent, PathBuf};
use crate::persist::Journal;
use crate::proc::Process;
use crate::sys;
use bat_image::Kind as IKind;
use core::sync::atomic::{AtomicU32, Ordering::*};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const NONE: u32 = u32::MAX;
pub const WHITEOUT: u32 = u32::MAX - 1;
const MAX_SYMLINKS: u32 = 40;

pub const K_FILE: u32 = 0;
pub const K_DIR: u32 = 1;
pub const K_SYMLINK: u32 = 2;
pub const K_FIFO: u32 = 3;
pub const K_SOCKET: u32 = 4;
pub const K_CHAR: u32 = 5;

pub const O_ACCMODE: u32 = 3;
pub const O_WRONLY: u32 = 1;
pub const O_RDWR: u32 = 2;
pub const O_CREAT: u32 = 0o100;
pub const O_EXCL: u32 = 0o200;
pub const O_TRUNC: u32 = 0o1000;
pub const O_APPEND: u32 = 0o2000;
pub const O_NONBLOCK: u32 = 0o4000;
pub const O_DIRECTORY: u32 = 0o200000;
pub const O_NOFOLLOW: u32 = 0o400000;

pub const WATCH_RENAME: u32 = 1;
pub const WATCH_CHANGE: u32 = 2;

/// Bumped on every change to the overlay's namespace (create, remove, rename,
/// mount). Resolver caches key on it; image contents never change.
#[no_mangle]
pub static BAT_OVERLAY_GEN: AtomicU32 = AtomicU32::new(0);

pub enum Kind {
    File(Vec<u8>),
    Dir(Dir),
    Symlink(Box<[u8]>),
}

pub struct Dir {
    pub children: BTreeMap<Box<[u8]>, u32>,
    /// True for directories created by mkdir: never merged with an image
    /// directory of the same name. False for shadows of image directories.
    pub opaque: bool,
    /// Image id mounted here, or NONE.
    pub mount: u32,
}

pub struct Node {
    pub kind: Kind,
    pub mode: u16,
    /// False under a non-persistent root: never journaled or snapshotted.
    pub persist: bool,
    pub nlink: u32,
    pub opens: AtomicU32,
    pub mtime: f64,
    pub ctime: f64,
    pub btime: f64,
}

/// A resolved position: an overlay node, an image entry, or both (merged dir).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Loc {
    pub ov: u32,
    pub img: u32,
    pub idx: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct Stat {
    pub kind: u32,
    pub mode: u32,
    pub size: f64,
    pub mtime: f64,
    pub ctime: f64,
    pub ino: f64,
    pub nlink: u32,
    pub dev: u32,
    pub facts: u32,
    pub compiled_len: u32,
    pub btime: f64,
}

pub struct Watch {
    pub id: u32,
    pub proc: Arc<Process>,
    pub path: Box<[u8]>,
    pub recursive: bool,
}

pub struct Vfs {
    pub nodes: Vec<Option<Node>>,
    free: Vec<u32>,
    pub images: Vec<Option<&'static ImageMount>>,
    pub journal: Journal,
    pub watches: Vec<Watch>,
    next_watch: u32,
}

pub static VFS: RwLock<Vfs> = RwLock::new(Vfs {
    nodes: Vec::new(),
    free: Vec::new(),
    images: Vec::new(),
    journal: Journal::new(),
    watches: Vec::new(),
    next_watch: 1,
});

fn new_dir(opaque: bool) -> Kind {
    Kind::Dir(Dir { children: BTreeMap::new(), opaque, mount: NONE })
}

pub fn init() {
    let mut v = VFS.write();
    if v.nodes.is_empty() {
        let now = sys::now_ms();
        v.nodes.push(Some(Node {
            kind: new_dir(true),
            mode: 0o755,
            persist: true,
            nlink: 1,
            opens: AtomicU32::new(0),
            mtime: now,
            ctime: now,
            btime: now,
        }));
    }
}

fn ikind(k: IKind) -> u32 {
    match k {
        IKind::File => K_FILE,
        IKind::Dir => K_DIR,
        IKind::Symlink => K_SYMLINK,
    }
}

impl Vfs {
    #[inline]
    pub fn node(&self, ino: u32) -> &Node {
        self.nodes[ino as usize].as_ref().expect("live node")
    }
    #[inline]
    pub fn node_mut(&mut self, ino: u32) -> &mut Node {
        self.nodes[ino as usize].as_mut().expect("live node")
    }
    pub fn try_node(&self, ino: u32) -> Option<&Node> {
        self.nodes.get(ino as usize).and_then(|n| n.as_ref())
    }
    #[inline]
    pub fn image(&self, id: u32) -> &'static ImageMount {
        self.images[id as usize].expect("mounted image")
    }
    fn dir(&self, ino: u32) -> R<&Dir> {
        match &self.node(ino).kind {
            Kind::Dir(d) => Ok(d),
            _ => Err(ENOTDIR),
        }
    }
    fn dir_mut(&mut self, ino: u32) -> &mut Dir {
        match &mut self.node_mut(ino).kind {
            Kind::Dir(d) => d,
            _ => panic!("not a directory"),
        }
    }
    fn root_loc(&self) -> Loc {
        let m = self.dir(0).map(|d| d.mount).unwrap_or(NONE);
        Loc { ov: 0, img: m, idx: 0 }
    }
    pub fn kind_of(&self, l: Loc) -> u32 {
        if l.ov != NONE {
            match self.node(l.ov).kind {
                Kind::File(_) => K_FILE,
                Kind::Dir(_) => K_DIR,
                Kind::Symlink(_) => K_SYMLINK,
            }
        } else {
            ikind(self.image(l.img).image.entry(l.idx).kind)
        }
    }

    /// Does the image side of merged directory `dir` have an entry `name`?
    fn lower_has(&self, dir: Loc, name: &[u8]) -> bool {
        dir.img != NONE && self.image(dir.img).image.lookup_child(dir.idx, name).is_some()
    }

    pub fn lookup_child(&self, dir: Loc, name: &[u8]) -> R<Loc> {
        if dir.ov != NONE {
            let d = self.dir(dir.ov)?;
            if let Some(&c) = d.children.get(name) {
                if c == WHITEOUT {
                    return Err(ENOENT);
                }
                let mut out = Loc { ov: c, img: NONE, idx: 0 };
                if let Kind::Dir(cd) = &self.node(c).kind {
                    if cd.mount != NONE {
                        out.img = cd.mount;
                    } else if !cd.opaque && dir.img != NONE {
                        let im = &self.image(dir.img).image;
                        if let Some(ci) = im.lookup_child(dir.idx, name) {
                            if im.entry(ci).is_dir() {
                                out.img = dir.img;
                                out.idx = ci;
                            }
                        }
                    }
                }
                return Ok(out);
            }
        }
        if dir.img != NONE {
            let im = &self.image(dir.img).image;
            if dir.ov == NONE && !im.entry(dir.idx).is_dir() {
                return Err(ENOTDIR);
            }
            return match im.lookup_child(dir.idx, name) {
                Some(ci) => Ok(Loc { ov: NONE, img: dir.img, idx: ci }),
                None => Err(ENOENT),
            };
        }
        Err(ENOENT)
    }

    fn symlink_target(&self, l: Loc) -> Option<&[u8]> {
        if l.ov != NONE {
            match &self.node(l.ov).kind {
                Kind::Symlink(t) => Some(t),
                _ => None,
            }
        } else {
            self.image(l.img).image.entry(l.idx).target()
        }
    }

    /// Resolve a normalized absolute path. On success `canon` holds the
    /// symlink-free path of the result ("" for the root).
    pub fn walk(&self, path: &[u8], follow: bool, canon: &mut PathBuf) -> R<Loc> {
        let mut cur = PathBuf::new();
        cur.set(path)?;
        let mut next = PathBuf::new();
        let mut links = 0;
        'restart: loop {
            let mut loc = self.root_loc();
            canon.clear();
            let p = cur.as_bytes();
            let mut i = 0;
            while i < p.len() {
                // p[i] == '/'
                let start = i + 1;
                let mut end = start;
                while end < p.len() && p[end] != b'/' {
                    end += 1;
                }
                let name = &p[start..end];
                let child = self.lookup_child(loc, name)?;
                let last = end == p.len();
                if !last || follow {
                    if let Some(t) = self.symlink_target(child) {
                        links += 1;
                        if links > MAX_SYMLINKS {
                            return Err(ELOOP);
                        }
                        next.set(canon.as_bytes())?;
                        next.join(t)?;
                        if end < p.len() {
                            next.join(&p[end + 1..])?;
                        }
                        core::mem::swap(&mut cur, &mut next);
                        continue 'restart;
                    }
                }
                canon.push(b"/")?;
                canon.push(name)?;
                loc = child;
                i = end;
            }
            return Ok(loc);
        }
    }

    /// Resolve the parent directory of `path`; returns (parent, name offset).
    /// `canon` holds the parent's canonical path.
    fn walk_parent<'p>(&self, path: &'p [u8], canon: &mut PathBuf) -> R<(Loc, &'p [u8])> {
        let (parent, name) = split_parent(path).ok_or(EINVAL)?;
        let loc = self.walk(parent, true, canon)?;
        if self.kind_of(loc) != K_DIR {
            return Err(ENOTDIR);
        }
        Ok((loc, name))
    }

    pub fn stat_loc(&self, l: Loc, st: &mut Stat) {
        if l.ov != NONE {
            let n = self.node(l.ov);
            let (kind, size) = match &n.kind {
                Kind::File(d) => (K_FILE, d.len()),
                Kind::Dir(_) => (K_DIR, 0),
                Kind::Symlink(t) => (K_SYMLINK, t.len()),
            };
            *st = Stat {
                kind,
                mode: n.mode as u32,
                size: size as f64,
                mtime: n.mtime,
                ctime: n.ctime,
                ino: l.ov as f64 + 1.0,
                nlink: n.nlink.max(1),
                dev: 0,
                facts: 0,
                compiled_len: 0,
                btime: n.btime,
            };
        } else {
            let m = self.image(l.img);
            image_stat(m, l.idx, st);
        }
    }

    // ---- overlay primitives (journaled) ----

    fn alloc(&mut self, node: Node) -> u32 {
        if let Some(i) = self.free.pop() {
            self.nodes[i as usize] = Some(node);
            i
        } else {
            self.nodes.push(Some(node));
            (self.nodes.len() - 1) as u32
        }
    }
    /// Place a node at a given number (journal replay).
    pub fn place(&mut self, ino: u32, node: Node) {
        let i = ino as usize;
        if self.nodes.len() <= i {
            self.nodes.resize_with(i + 1, || None);
        }
        if self.nodes[i].is_some() {
            self.free_node(ino);
        }
        self.nodes[i] = Some(node);
    }
    /// After replay: rebuild the free list.
    pub fn rebuild_free(&mut self) {
        // Nodes nobody links to (files that were open-but-unlinked at the crash).
        for i in 1..self.nodes.len() as u32 {
            if matches!(&self.nodes[i as usize], Some(n) if n.nlink == 0) {
                self.free_node(i);
            }
        }
        self.free = (1..self.nodes.len() as u32).filter(|&i| self.nodes[i as usize].is_none()).rev().collect();
    }
    fn free_node(&mut self, ino: u32) {
        if let Some(n) = self.nodes[ino as usize].take() {
            // Only replay frees non-empty directories (a subtree that moved
            // out of the persistent area).
            if let Kind::Dir(d) = n.kind {
                for (_, c) in d.children {
                    if c != WHITEOUT && self.try_node(c).is_some() {
                        let cn = self.node_mut(c);
                        cn.nlink = cn.nlink.saturating_sub(1);
                        if cn.nlink == 0 {
                            self.free_node(c);
                        }
                    }
                }
            }
            if ino != 0 {
                self.free.push(ino);
            }
        }
    }
    fn new_node(&mut self, parent: u32, kind: Kind, mode: u16) -> u32 {
        let now = sys::now_ms();
        let persist = self.node(parent).persist;
        let ino = self.alloc(Node {
            kind,
            mode,
            persist,
            nlink: 0,
            opens: AtomicU32::new(0),
            mtime: now,
            ctime: now,
            btime: now,
        });
        if persist && self.journal.enabled {
            let n = self.nodes[ino as usize].as_ref().unwrap();
            self.journal.rec_node(ino, n);
        }
        ino
    }
    /// children[name] = ino (a node number or WHITEOUT).
    pub fn link_raw(&mut self, parent: u32, name: &[u8], ino: u32) {
        let now = sys::now_ms();
        let pn = self.node_mut(parent);
        pn.mtime = now;
        let persist = pn.persist;
        let old = self.dir_mut(parent).children.insert(name.into(), ino);
        if let Some(o) = old {
            if o != WHITEOUT && o != ino {
                self.drop_link(o);
            }
        }
        if ino != WHITEOUT {
            self.node_mut(ino).nlink += 1;
        }
        if persist && self.journal.enabled {
            self.journal.rec_link(parent, name, ino);
        }
        BAT_OVERLAY_GEN.fetch_add(1, Relaxed);
    }
    fn drop_link(&mut self, ino: u32) {
        let n = self.node_mut(ino);
        n.nlink = n.nlink.saturating_sub(1);
        n.ctime = sys::now_ms();
        if n.nlink == 0 && n.opens.load(SeqCst) == 0 {
            self.free_node(ino);
        }
    }
    pub fn unlink_raw(&mut self, parent: u32, name: &[u8]) {
        let now = sys::now_ms();
        let pn = self.node_mut(parent);
        pn.mtime = now;
        let persist = pn.persist;
        if let Some(o) = self.dir_mut(parent).children.remove(name) {
            if o != WHITEOUT {
                self.drop_link(o);
            }
        }
        if persist && self.journal.enabled {
            self.journal.rec_unlink(parent, name);
        }
        BAT_OVERLAY_GEN.fetch_add(1, Relaxed);
    }

    /// Make sure every directory of canonical path `canon` exists in the
    /// overlay (shadowing image directories), and return the last one.
    fn ensure_ov(&mut self, canon: &[u8]) -> R<u32> {
        let mut ino = 0u32;
        let mut loc = self.root_loc();
        for name in components(canon) {
            let child = self.lookup_child(loc, name)?;
            let cino = if child.ov != NONE {
                self.dir(child.ov)?;
                child.ov
            } else {
                let m = self.image(child.img);
                let e = m.image.entry(child.idx);
                if !e.is_dir() {
                    return Err(ENOTDIR);
                }
                let n = self.new_node(ino, new_dir(false), e.mode);
                self.link_raw(ino, name, n);
                n
            };
            ino = cino;
            loc = Loc { ov: cino, img: child.img, idx: child.idx };
        }
        Ok(ino)
    }

    /// Bring an image file or symlink into the overlay. Reads the body first,
    /// so a failure (EAGAIN on the page) leaves nothing changed.
    fn copy_up(&mut self, parent_canon: &[u8], name: &[u8], l: Loc) -> R<u32> {
        if l.ov != NONE {
            return Ok(l.ov);
        }
        let m = self.image(l.img);
        let e = m.image.entry(l.idx);
        let kind = match e.kind {
            IKind::File => {
                let ext = e.body().unwrap();
                let mut data = vec![0u8; ext.len as usize];
                m.read_at(ext.offset, &mut data)?;
                Kind::File(data)
            }
            IKind::Symlink => Kind::Symlink(e.target().unwrap().into()),
            IKind::Dir => return Err(EISDIR),
        };
        let p = self.ensure_ov(parent_canon)?;
        let ino = self.new_node(p, kind, e.mode);
        self.link_raw(p, name, ino);
        Ok(ino)
    }

    /// Remove `name` from merged directory `dir` (overlay entry and/or
    /// whiteout over the image entry).
    fn remove_name(&mut self, dir: Loc, dir_canon: &[u8], name: &[u8]) -> R<()> {
        let lower = self.lower_has(dir, name);
        let p = if dir.ov != NONE { dir.ov } else { self.ensure_ov(dir_canon)? };
        if lower {
            self.link_raw(p, name, WHITEOUT);
        } else {
            self.unlink_raw(p, name);
        }
        Ok(())
    }

    fn dir_is_empty(&self, l: Loc) -> bool {
        let empty_map = BTreeMap::new();
        let ch = if l.ov != NONE { self.dir(l.ov).map(|d| &d.children).unwrap_or(&empty_map) } else { &empty_map };
        if ch.values().any(|&c| c != WHITEOUT) {
            return false;
        }
        if l.img != NONE {
            let im = &self.image(l.img).image;
            for e in im.read_dir(l.idx) {
                if !ch.contains_key(e.name) {
                    return false;
                }
            }
        }
        true
    }

    fn notify(&self, parent_canon: &[u8], name: &[u8], kind: u32) {
        if self.watches.is_empty() {
            return;
        }
        let mut full = PathBuf::new();
        if full.push(parent_canon).is_err() || full.push(b"/").is_err() || full.push(name).is_err() {
            return;
        }
        self.notify_full(full.as_bytes(), kind);
    }
    pub fn notify_full(&self, full: &[u8], kind: u32) {
        for w in &self.watches {
            let wp: &[u8] = &w.path;
            if !crate::path::is_under(full, wp) {
                continue;
            }
            let rel = if full.len() > wp.len() { &full[wp.len() + 1..] } else { &full[..0] };
            if !w.recursive && rel.contains(&b'/') {
                continue;
            }
            w.proc.post_watch(w.id, kind, rel);
        }
    }

    fn set_persist(&mut self, ino: u32, persist: bool) {
        let mut kids = Vec::new();
        {
            let n = self.node_mut(ino);
            if n.persist == persist {
                return;
            }
            n.persist = persist;
            if let Kind::Dir(d) = &n.kind {
                kids.extend(d.children.values().copied().filter(|&c| c != WHITEOUT));
            }
        }
        for k in kids {
            self.set_persist(k, persist);
        }
    }
    /// Journal a whole subtree (it just became persistent).
    pub fn emit_subtree(&mut self, ino: u32) {
        let n = self.nodes[ino as usize].as_ref().unwrap();
        self.journal.rec_node(ino, n);
        let kids: Vec<(Box<[u8]>, u32)> = match &n.kind {
            Kind::Dir(d) => d.children.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            _ => Vec::new(),
        };
        for (name, c) in kids {
            if c != WHITEOUT {
                // A hard link may already have been emitted; emitting twice is harmless
                // only for the first parent, so skip nodes with several links here.
                self.emit_subtree(c);
            }
            self.journal.rec_link(ino, &name, c);
        }
    }

    fn touch(&mut self, ino: u32) {
        let now = sys::now_ms();
        let n = self.node_mut(ino);
        n.mtime = now;
        n.ctime = now;
    }
}

pub fn image_stat(m: &ImageMount, idx: u32, st: &mut Stat) {
    let e = m.image.entry(idx);
    let mt = m.image.mtime() as f64 * 1000.0;
    *st = Stat {
        kind: ikind(e.kind),
        mode: e.mode as u32,
        size: e.size() as f64,
        mtime: mt,
        ctime: mt,
        ino: (m.id as f64 + 1.0) * 4294967296.0 + idx as f64,
        nlink: 1,
        dev: m.id + 1,
        facts: e.facts,
        compiled_len: e.compiled().map(|c| c.len).unwrap_or(0),
        btime: mt,
    };
}

// ---------------------------------------------------------------------------
// Path-level operations. Paths are normalized and absolute ("" is the root).
// ---------------------------------------------------------------------------

pub fn stat(path: &[u8], follow: bool, st: &mut Stat) -> R<()> {
    let v = VFS.read();
    let mut canon = PathBuf::new();
    let l = v.walk(path, follow, &mut canon)?;
    v.stat_loc(l, st);
    Ok(())
}

pub fn readlink(path: &[u8], dst: &mut [u8]) -> R<usize> {
    let v = VFS.read();
    let mut canon = PathBuf::new();
    let l = v.walk(path, false, &mut canon)?;
    let t = v.symlink_target(l).ok_or(EINVAL)?;
    if t.len() > dst.len() {
        return Err(ERANGE);
    }
    dst[..t.len()].copy_from_slice(t);
    Ok(t.len())
}

pub fn realpath(path: &[u8], out: &mut PathBuf) -> R<()> {
    let v = VFS.read();
    v.walk(path, true, out)?;
    if out.len() == 0 {
        out.push(b"/")?;
    }
    Ok(())
}

/// Directory listing in one call. Records: kind u8, name_len u16 LE, name.
/// Returns bytes written; ERANGE (with the needed size in `needed`) if the
/// buffer is too small.
pub fn readdir(path: &[u8], buf: &mut [u8], needed: &mut usize) -> R<usize> {
    let v = VFS.read();
    let mut canon = PathBuf::new();
    let l = v.walk(path, true, &mut canon)?;
    if v.kind_of(l) != K_DIR {
        return Err(ENOTDIR);
    }
    let mut n = 0usize;
    let mut put = |kind: u32, name: &[u8]| {
        let rec = 3 + name.len();
        if n + rec <= buf.len() {
            buf[n] = kind as u8;
            buf[n + 1..n + 3].copy_from_slice(&(name.len() as u16).to_le_bytes());
            buf[n + 3..n + rec].copy_from_slice(name);
        }
        n += rec;
    };
    let empty = BTreeMap::new();
    let ch = if l.ov != NONE { &v.dir(l.ov)?.children } else { &empty };
    for (name, &c) in ch {
        if c != WHITEOUT {
            put(v.kind_of(Loc { ov: c, img: NONE, idx: 0 }), name);
        }
    }
    if l.img != NONE {
        for e in v.image(l.img).image.read_dir(l.idx) {
            if ch.is_empty() || !ch.contains_key(e.name) {
                put(ikind(e.kind), e.name);
            }
        }
    }
    *needed = n;
    if n > buf.len() {
        return Err(ERANGE);
    }
    Ok(n)
}

pub const RF_COMPILED: u32 = 1;

/// Whole-file read in one call. `st` is always filled when the file exists.
/// Returns ERANGE if `dst` is too small (size is in `st`). With RF_COMPILED,
/// an image entry that has a compiled body returns that body instead and
/// `st.size` is its length.
pub fn read_file(path: &[u8], flags: u32, dst: &mut [u8], st: &mut Stat) -> R<usize> {
    let (m, ext) = {
        let v = VFS.read();
        let mut canon = PathBuf::new();
        let l = v.walk(path, true, &mut canon)?;
        v.stat_loc(l, st);
        if st.kind == K_DIR {
            return Err(EISDIR);
        }
        if l.ov != NONE {
            let Kind::File(d) = &v.node(l.ov).kind else { return Err(EINVAL) };
            if d.len() > dst.len() {
                return Err(ERANGE);
            }
            dst[..d.len()].copy_from_slice(d);
            return Ok(d.len());
        }
        let m = v.image(l.img);
        let e = m.image.entry(l.idx);
        let ext = match e.compiled() {
            Some(c) if flags & RF_COMPILED != 0 => {
                st.size = c.len as f64;
                c
            }
            _ => {
                st.compiled_len = if flags & RF_COMPILED != 0 { 0 } else { st.compiled_len };
                e.body().ok_or(EINVAL)?
            }
        };
        (m, ext)
    };
    let len = ext.len as usize;
    if len > dst.len() {
        return Err(ERANGE);
    }
    m.read_at(ext.offset, &mut dst[..len])?;
    Ok(len)
}

pub enum Opened {
    Ov { ino: u32 },
    Img { m: &'static ImageMount, idx: u32, off: u64, len: u32 },
    Dir,
}

/// Open by path. For overlay files the node's open count is taken here.
pub fn open(path: &[u8], flags: u32, mode: u32, canon: &mut PathBuf) -> R<Opened> {
    let acc = flags & O_ACCMODE;
    let writing = acc != 0 || flags & (O_TRUNC | O_APPEND) != 0;
    let follow = flags & O_NOFOLLOW == 0;
    if !writing && flags & O_CREAT == 0 {
        let v = VFS.read();
        let l = v.walk(path, follow, canon)?;
        return open_loc(&v, l, flags);
    }
    let mut v = VFS.write();
    let mut pc = PathBuf::new();
    // Resolve the final symlink (if any) first so creation lands on its target.
    let mut real = PathBuf::new();
    let path = match v.walk(path, follow, &mut real) {
        Ok(_) => real.as_bytes(),
        Err(_) => path,
    };
    let (parent, name) = v.walk_parent(path, &mut pc)?;
    if name.is_empty() {
        return Err(EISDIR);
    }
    let ino = match v.lookup_child(parent, name) {
        Ok(l) => {
            if flags & O_CREAT != 0 && flags & O_EXCL != 0 {
                return Err(EEXIST);
            }
            match v.kind_of(l) {
                K_DIR => return Err(EISDIR),
                K_SYMLINK => return Err(ELOOP),
                _ => {}
            }
            if l.ov == NONE && flags & O_TRUNC != 0 {
                // No need to read a body that is about to be discarded.
                let mode = v.image(l.img).image.entry(l.idx).mode;
                let p = v.ensure_ov(pc.as_bytes())?;
                let ino = v.new_node(p, Kind::File(Vec::new()), mode);
                v.link_raw(p, name, ino);
                ino
            } else {
                let ino = v.copy_up(pc.as_bytes(), name, l)?;
                if flags & O_TRUNC != 0 {
                    v.truncate_ino(ino, 0)?;
                }
                ino
            }
        }
        Err(ENOENT) if flags & O_CREAT != 0 => {
            let p = v.ensure_ov(pc.as_bytes())?;
            let ino = v.new_node(p, Kind::File(Vec::new()), (mode & 0o7777) as u16);
            v.link_raw(p, name, ino);
            v.notify(pc.as_bytes(), name, WATCH_RENAME);
            ino
        }
        Err(e) => return Err(e),
    };
    v.node(ino).opens.fetch_add(1, SeqCst);
    canon.set(pc.as_bytes())?;
    canon.push(b"/")?;
    canon.push(name)?;
    Ok(Opened::Ov { ino })
}

fn open_loc(v: &Vfs, l: Loc, flags: u32) -> R<Opened> {
    match v.kind_of(l) {
        K_DIR => Ok(Opened::Dir),
        K_SYMLINK => Err(ELOOP),
        _ if flags & O_DIRECTORY != 0 => Err(ENOTDIR),
        _ if l.ov != NONE => {
            v.node(l.ov).opens.fetch_add(1, SeqCst);
            Ok(Opened::Ov { ino: l.ov })
        }
        _ => {
            let m = v.image(l.img);
            let ext = m.image.entry(l.idx).body().ok_or(EINVAL)?;
            Ok(Opened::Img { m, idx: l.idx, off: ext.offset, len: ext.len })
        }
    }
}

/// Drop an open reference to an overlay node; frees it if it was unlinked.
pub fn release(ino: u32) {
    let gone = {
        let v = VFS.read();
        match v.try_node(ino) {
            Some(n) => n.opens.fetch_sub(1, SeqCst) == 1 && n.nlink == 0,
            None => false,
        }
    };
    if gone {
        let mut v = VFS.write();
        if let Some(n) = v.try_node(ino) {
            if n.nlink == 0 && n.opens.load(SeqCst) == 0 {
                v.free_node(ino);
            }
        }
    }
}

impl Vfs {
    fn truncate_ino(&mut self, ino: u32, len: usize) -> R<()> {
        let n = self.node_mut(ino);
        let Kind::File(d) = &mut n.kind else { return Err(EINVAL) };
        d.resize(len, 0);
        if len == 0 {
            d.shrink_to_fit();
        }
        self.touch(ino);
        let n = self.node(ino);
        if n.persist && self.journal.enabled {
            let mt = n.mtime;
            self.journal.rec_trunc(ino, len as f64, mt);
        }
        Ok(())
    }
    fn write_ino(&mut self, ino: u32, pos: Option<u64>, src: &[u8]) -> R<u64> {
        let n = self.node_mut(ino);
        let Kind::File(d) = &mut n.kind else { return Err(EINVAL) };
        let pos = pos.unwrap_or(d.len() as u64) as usize;
        let end = pos.checked_add(src.len()).ok_or(EINVAL)?;
        if end > d.len() {
            if end > d.capacity() {
                // Grow geometrically but not absurdly for big files.
                let want = end.max(d.capacity() + d.capacity() / 2);
                d.reserve_exact(want - d.len());
            }
            d.resize(end, 0);
        }
        d[pos..end].copy_from_slice(src);
        self.touch(ino);
        let n = self.node(ino);
        if n.persist && self.journal.enabled {
            let mt = n.mtime;
            self.journal.rec_write(ino, pos as f64, mt, src);
        }
        Ok(end as u64)
    }
}

pub fn ov_read(ino: u32, pos: u64, dst: &mut [u8]) -> R<usize> {
    let v = VFS.read();
    let Kind::File(d) = &v.try_node(ino).ok_or(EBADF)?.kind else { return Err(EINVAL) };
    if pos >= d.len() as u64 {
        return Ok(0);
    }
    let n = dst.len().min(d.len() - pos as usize);
    dst[..n].copy_from_slice(&d[pos as usize..pos as usize + n]);
    Ok(n)
}
/// Returns the file position after the write. `pos` None appends.
pub fn ov_write(ino: u32, pos: Option<u64>, src: &[u8], path: &[u8]) -> R<u64> {
    let mut v = VFS.write();
    v.try_node(ino).ok_or(EBADF)?;
    let end = v.write_ino(ino, pos, src)?;
    v.notify_full(path, WATCH_CHANGE);
    Ok(end)
}
pub fn ov_truncate(ino: u32, len: u64, path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    v.try_node(ino).ok_or(EBADF)?;
    v.truncate_ino(ino, len as usize)?;
    v.notify_full(path, WATCH_CHANGE);
    Ok(())
}
pub fn ov_stat(ino: u32, st: &mut Stat) -> R<()> {
    let v = VFS.read();
    v.try_node(ino).ok_or(EBADF)?;
    v.stat_loc(Loc { ov: ino, img: NONE, idx: 0 }, st);
    Ok(())
}
pub fn ov_set_meta(ino: u32, mode: Option<u32>, mtime: Option<f64>) -> R<()> {
    let mut v = VFS.write();
    v.try_node(ino).ok_or(EBADF)?;
    v.set_meta(ino, mode, mtime);
    Ok(())
}

pub const WF_APPEND: u32 = 1;
pub const WF_EXCL: u32 = 2;

/// Create-or-replace a file in one call.
pub fn write_file(path: &[u8], data: &[u8], mode: u32, flags: u32) -> R<()> {
    let mut v = VFS.write();
    let mut real = PathBuf::new();
    let path = match v.walk(path, true, &mut real) {
        Ok(_) => real.as_bytes(),
        Err(_) => path,
    };
    let mut pc = PathBuf::new();
    let (parent, name) = v.walk_parent(path, &mut pc)?;
    if name.is_empty() {
        return Err(EISDIR);
    }
    let (ino, created) = match v.lookup_child(parent, name) {
        Ok(l) => {
            if flags & WF_EXCL != 0 {
                return Err(EEXIST);
            }
            if v.kind_of(l) == K_DIR {
                return Err(EISDIR);
            }
            if l.ov == NONE && flags & WF_APPEND == 0 {
                let mode = v.image(l.img).image.entry(l.idx).mode;
                let p = v.ensure_ov(pc.as_bytes())?;
                let ino = v.new_node(p, Kind::File(Vec::new()), mode);
                v.link_raw(p, name, ino);
                (ino, false)
            } else {
                (v.copy_up(pc.as_bytes(), name, l)?, false)
            }
        }
        Err(ENOENT) => {
            let p = v.ensure_ov(pc.as_bytes())?;
            let ino = v.new_node(p, Kind::File(Vec::new()), (mode & 0o7777) as u16);
            v.link_raw(p, name, ino);
            (ino, true)
        }
        Err(e) => return Err(e),
    };
    if flags & WF_APPEND != 0 {
        v.write_ino(ino, None, data)?;
    } else {
        let has = matches!(&v.node(ino).kind, Kind::File(d) if !d.is_empty());
        if has {
            v.truncate_ino(ino, 0)?;
        }
        v.write_ino(ino, Some(0), data)?;
    }
    v.notify(pc.as_bytes(), name, if created { WATCH_RENAME } else { WATCH_CHANGE });
    Ok(())
}

pub fn mkdir(path: &[u8], mode: u32, recursive: bool) -> R<()> {
    let mut v = VFS.write();
    v.mkdir(path, mode, recursive)
}

impl Vfs {
    pub fn mkdir(&mut self, path: &[u8], mode: u32, recursive: bool) -> R<()> {
        let mut pc = PathBuf::new();
        if recursive {
            // Create each missing ancestor in turn.
            let mut sofar = PathBuf::new();
            for c in components(path) {
                sofar.push(b"/")?;
                sofar.push(c)?;
                match self.mkdir_one(sofar.as_bytes(), mode, &mut pc) {
                    Ok(()) | Err(EEXIST) => {}
                    Err(e) => return Err(e),
                }
            }
            let mut canon = PathBuf::new();
            let l = self.walk(path, true, &mut canon)?;
            return if self.kind_of(l) == K_DIR { Ok(()) } else { Err(EEXIST) };
        }
        self.mkdir_one(path, mode, &mut pc)
    }
    fn mkdir_one(&mut self, path: &[u8], mode: u32, pc: &mut PathBuf) -> R<()> {
        let (parent, name) = self.walk_parent(path, pc)?;
        if name.is_empty() {
            return Err(EEXIST);
        }
        match self.lookup_child(parent, name) {
            Ok(_) => return Err(EEXIST),
            Err(ENOENT) => {}
            Err(e) => return Err(e),
        }
        let p = self.ensure_ov(pc.as_bytes())?;
        let ino = self.new_node(p, new_dir(true), (mode & 0o7777) as u16);
        self.link_raw(p, name, ino);
        self.notify(pc.as_bytes(), name, WATCH_RENAME);
        Ok(())
    }
    fn set_meta(&mut self, ino: u32, mode: Option<u32>, mtime: Option<f64>) {
        let now = sys::now_ms();
        let n = self.node_mut(ino);
        if let Some(m) = mode {
            n.mode = (m & 0o7777) as u16;
        }
        if let Some(t) = mtime {
            n.mtime = t;
        }
        n.ctime = now;
        let (mode, mt, persist) = (n.mode, n.mtime, n.persist);
        if persist && self.journal.enabled {
            self.journal.rec_meta(ino, mode as u32, mt);
        }
    }
    /// Overlay node for a path, copying an image file up or shadowing an image dir.
    fn materialize(&mut self, path: &[u8], follow: bool) -> R<(u32, PathBuf)> {
        let mut canon = PathBuf::new();
        let l = self.walk(path, follow, &mut canon)?;
        if l.ov != NONE {
            return Ok((l.ov, canon));
        }
        if self.kind_of(l) == K_DIR {
            let ino = self.ensure_ov(canon.as_bytes())?;
            return Ok((ino, canon));
        }
        let (pc, name) = split_parent(canon.as_bytes()).ok_or(EINVAL)?;
        let ino = self.copy_up(pc, name, l)?;
        Ok((ino, canon))
    }
}

pub fn unlink(path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    let mut pc = PathBuf::new();
    let (parent, name) = v.walk_parent(path, &mut pc)?;
    let l = v.lookup_child(parent, name)?;
    if v.kind_of(l) == K_DIR {
        return Err(EISDIR);
    }
    v.remove_name(parent, pc.as_bytes(), name)?;
    v.notify(pc.as_bytes(), name, WATCH_RENAME);
    Ok(())
}

pub fn rmdir(path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    let mut pc = PathBuf::new();
    let (parent, name) = v.walk_parent(path, &mut pc)?;
    if name.is_empty() {
        return Err(EINVAL);
    }
    let l = v.lookup_child(parent, name)?;
    if v.kind_of(l) != K_DIR {
        return Err(ENOTDIR);
    }
    if l.ov != NONE && v.dir(l.ov)?.mount != NONE {
        return Err(EINVAL);
    }
    if !v.dir_is_empty(l) {
        return Err(ENOTEMPTY);
    }
    if l.ov != NONE {
        // Drop the whiteouts so the node is really empty.
        v.dir_mut(l.ov).children.clear();
    }
    v.remove_name(parent, pc.as_bytes(), name)?;
    v.notify(pc.as_bytes(), name, WATCH_RENAME);
    Ok(())
}

pub fn rename(old: &[u8], new: &[u8]) -> R<()> {
    let mut v = VFS.write();
    let mut spc = PathBuf::new();
    let mut dpc = PathBuf::new();
    let (sp, sname) = v.walk_parent(old, &mut spc)?;
    let (dp, dname) = v.walk_parent(new, &mut dpc)?;
    if sname.is_empty() || dname.is_empty() {
        return Err(EINVAL);
    }
    let sl = v.lookup_child(sp, sname)?;
    let sdir = v.kind_of(sl) == K_DIR;
    if sdir {
        // A directory that is (partly) in an image cannot be moved without
        // copying it; like overlayfs, report EXDEV and let the caller copy.
        if sl.img != NONE {
            return Err(EXDEV);
        }
        let mut full = PathBuf::new();
        full.push(spc.as_bytes())?;
        full.push(b"/")?;
        full.push(sname)?;
        if crate::path::is_under(dpc.as_bytes(), full.as_bytes()) {
            return Err(EINVAL);
        }
    }
    if spc.as_bytes() == dpc.as_bytes() && sname == dname {
        return Ok(());
    }
    match v.lookup_child(dp, dname) {
        Ok(dl) => {
            let ddir = v.kind_of(dl) == K_DIR;
            if sdir && !ddir {
                return Err(ENOTDIR);
            }
            if !sdir && ddir {
                return Err(EISDIR);
            }
            if ddir && !v.dir_is_empty(dl) {
                return Err(ENOTEMPTY);
            }
            if dl.ov != NONE && dl.ov == sl.ov {
                return Ok(()); // hard links to the same node
            }
        }
        Err(ENOENT) => {}
        Err(e) => return Err(e),
    }
    let ino = v.copy_up(spc.as_bytes(), sname, sl)?;
    let dparent = v.ensure_ov(dpc.as_bytes())?;
    // Re-resolve the source parent: ensure_ov may have shadowed directories.
    let sparent = v.ensure_ov(spc.as_bytes())?;
    let dpersist = v.node(dparent).persist;
    let was = v.node(ino).persist;
    if dpersist && !was {
        v.set_persist(ino, true);
        if v.journal.enabled {
            v.emit_subtree(ino);
        }
    }
    v.link_raw(dparent, dname, ino);
    let lower = v.lower_has(sp, sname);
    if lower {
        v.link_raw(sparent, sname, WHITEOUT);
    } else {
        v.unlink_raw(sparent, sname);
    }
    if !dpersist && was {
        v.set_persist(ino, false);
    }
    v.notify(spc.as_bytes(), sname, WATCH_RENAME);
    v.notify(dpc.as_bytes(), dname, WATCH_RENAME);
    Ok(())
}

pub fn symlink(target: &[u8], path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    let mut pc = PathBuf::new();
    let (parent, name) = v.walk_parent(path, &mut pc)?;
    match v.lookup_child(parent, name) {
        Ok(_) => return Err(EEXIST),
        Err(ENOENT) => {}
        Err(e) => return Err(e),
    }
    let p = v.ensure_ov(pc.as_bytes())?;
    let ino = v.new_node(p, Kind::Symlink(target.into()), 0o777);
    v.link_raw(p, name, ino);
    v.notify(pc.as_bytes(), name, WATCH_RENAME);
    Ok(())
}

pub fn link(old: &[u8], new: &[u8]) -> R<()> {
    let mut v = VFS.write();
    let (ino, _) = v.materialize(old, false)?;
    if matches!(v.node(ino).kind, Kind::Dir(_)) {
        return Err(EPERM);
    }
    let mut pc = PathBuf::new();
    let (parent, name) = v.walk_parent(new, &mut pc)?;
    match v.lookup_child(parent, name) {
        Ok(_) => return Err(EEXIST),
        Err(ENOENT) => {}
        Err(e) => return Err(e),
    }
    let p = v.ensure_ov(pc.as_bytes())?;
    v.link_raw(p, name, ino);
    v.notify(pc.as_bytes(), name, WATCH_RENAME);
    Ok(())
}

pub fn set_meta(path: &[u8], follow: bool, mode: Option<u32>, mtime: Option<f64>) -> R<()> {
    let mut v = VFS.write();
    let (ino, canon) = v.materialize(path, follow)?;
    v.set_meta(ino, mode, mtime);
    v.notify_full(canon.as_bytes(), WATCH_CHANGE);
    Ok(())
}

pub fn truncate(path: &[u8], len: u64) -> R<()> {
    let mut v = VFS.write();
    let (ino, canon) = v.materialize(path, true)?;
    v.truncate_ino(ino, len as usize)?;
    v.notify_full(canon.as_bytes(), WATCH_CHANGE);
    Ok(())
}

/// Attach image `m` at `path` (created if missing). The mount point is an
/// ordinary (journaled) overlay directory; the mount itself is not persisted,
/// the host mounts again at every boot, after the overlay is restored.
pub fn mount(m: &'static ImageMount, path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    if v.images.len() <= m.id as usize {
        v.images.resize(m.id as usize + 1, None);
    }
    v.images[m.id as usize] = Some(m);
    v.mkdir(path, 0o755, true)?;
    let mut canon = PathBuf::new();
    let l = v.walk(path, true, &mut canon)?;
    let ino = if l.ov != NONE { l.ov } else { v.ensure_ov(canon.as_bytes())? };
    v.dir_mut(ino).mount = m.id;
    BAT_OVERLAY_GEN.fetch_add(1, Relaxed);
    Ok(())
}

/// Mark `path` (created if missing) as a non-persistent root.
pub fn persist_exclude(path: &[u8]) -> R<()> {
    let mut v = VFS.write();
    v.mkdir(path, 0o755, true)?;
    let (ino, _) = v.materialize(path, true)?;
    v.set_persist(ino, false);
    Ok(())
}

pub fn watch_add(proc: Arc<Process>, path: &[u8], recursive: bool) -> R<u32> {
    let mut v = VFS.write();
    let mut canon = PathBuf::new();
    v.walk(path, true, &mut canon)?;
    let id = v.next_watch;
    v.next_watch += 1;
    v.watches.push(Watch { id, proc, path: canon.as_bytes().into(), recursive });
    Ok(id)
}
pub fn watch_remove(pid: u32, id: u32) {
    let mut v = VFS.write();
    v.watches.retain(|w| !(w.id == id && w.proc.pid == pid));
}
pub fn watch_remove_all(pid: u32) {
    let mut v = VFS.write();
    if v.watches.iter().any(|w| w.proc.pid == pid) {
        v.watches.retain(|w| w.proc.pid != pid);
    }
}
