//! Overlay persistence: a physical journal of overlay mutations, drained to
//! OPFS by the supervisor, plus snapshots in the same record format.
//!
//! Records name overlay nodes by number, so replay needs neither path
//! resolution nor the images: it rebuilds the same slab. A snapshot is simply
//! the shortest journal that recreates the current persistent nodes.
//!
//! Record: op u8, payload_len u32, payload. Sequence numbers are byte offsets
//! in the stream of all records ever appended in this origin.
//!
//! Nothing here may run the kernel out of memory while the filesystem lock is
//! held (an allocation that fails aborts, and the lock would stay held for
//! good): the journal is given its room before an operation changes anything
//! (`Journal::reserve`), and a snapshot is handed to the host piece by piece
//! instead of being built in memory (`snapshot`).

use crate::errno::*;
use crate::lock::WaitQ;
use crate::proc::{supervisor_request, Work};
use crate::vfs::{Dir, Kind, Node, Vfs, NONE, VFS, WHITEOUT};
use core::sync::atomic::{AtomicU32, Ordering::*};
use std::collections::BTreeMap;

const OP_NODE: u8 = 1;
const OP_LINK: u8 = 2;
const OP_UNLINK: u8 = 3;
const OP_WRITE: u8 = 4;
const OP_TRUNC: u8 = 5;
const OP_META: u8 = 6;

/// Room the journal has before any operation that changes the overlay: more than the
/// records of one operation's nodes and links take.
pub const SMALL: usize = 64 << 10;
/// Pending bytes at which the supervisor is asked to drain without waiting for its next
/// round: what is pending is held twice, in the files and here.
const DRAIN_AT: usize = 4 << 20;
/// A snapshot leaves the kernel in pieces of at most this size...
const SNAP_BUF: usize = 256 << 10;
/// ...a file larger than this is not copied into a piece: the host is given its bytes where
/// they are...
const SNAP_INLINE: usize = 64 << 10;
/// ...and in write records of this size, so that reading a snapshot back needs no more room
/// than one of them beside the file itself.
const SNAP_CHUNK: usize = 1 << 20;

pub struct Journal {
    pub enabled: bool,
    pub buf: Vec<u8>,
    /// Sequence number of the end of `buf`.
    pub seq: u64,
    /// The supervisor has been asked to drain what is pending.
    asked: bool,
}

/// Durable state shared with waiters. `BAT_PERSIST_WORD` is bumped whenever
/// the durable sequence advances; the page awaits it with Atomics.waitAsync.
#[no_mangle]
pub static BAT_PERSIST_WORD: AtomicU32 = AtomicU32::new(0);
static DURABLE_WQ: WaitQ = WaitQ::new();
static DURABLE: crate::lock::Mutex<u64> = crate::lock::Mutex::new(0);
/// When the supervisor last wrote the journal out or finished a snapshot (epoch ms, 0: never).
static DURABLE_AT: crate::lock::Mutex<[f64; 2]> = crate::lock::Mutex::new([0.0; 2]);

impl Journal {
    pub const fn new() -> Self {
        Journal { enabled: false, buf: Vec::new(), seq: 0, asked: false }
    }
    /// Room for `bytes` more of records, or ENOSPC. Asked for before an operation changes
    /// anything, so that recording what it then did cannot fail. The buffer doubles while
    /// the memory has room for that, and takes exactly what is needed when it has not.
    pub fn reserve(&mut self, bytes: usize) -> R<()> {
        if !self.enabled {
            return Ok(());
        }
        if self.buf.len() >= DRAIN_AT && !self.asked {
            self.asked = true;
            supervisor_request(Work::Flush);
        }
        let (len, cap) = (self.buf.len(), self.buf.capacity());
        if cap - len >= bytes {
            return Ok(());
        }
        let want = (len + bytes).max(cap * 2);
        if want > len + bytes && crate::mem::can_take(want - cap) && self.buf.try_reserve_exact(want - len).is_ok() {
            return Ok(());
        }
        crate::mem::reserve(&mut self.buf, bytes, ENOSPC)
    }
    fn begin(&mut self, op: u8) -> usize {
        self.buf.push(op);
        self.buf.extend_from_slice(&[0; 4]);
        self.buf.len()
    }
    fn end(&mut self, start: usize) {
        let len = (self.buf.len() - start) as u32;
        self.buf[start - 4..start].copy_from_slice(&len.to_le_bytes());
        self.seq += (len + 5) as u64;
    }
    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.buf.extend_from_slice(b);
    }
    pub fn rec_node(&mut self, ino: u32, n: &Node) {
        let data: &[u8] = match &n.kind {
            Kind::File(d) => d,
            Kind::Dir(_) => &[],
            Kind::Symlink(t) => t,
        };
        self.rec_node_with(ino, n, data)
    }
    /// The node's record with `data` for its contents (a snapshot writes a large file's
    /// contents after an empty node, as write records).
    fn rec_node_with(&mut self, ino: u32, n: &Node, data: &[u8]) {
        let s = self.begin(OP_NODE);
        self.u32(ino);
        let (kind, flags): (u32, u32) = match &n.kind {
            Kind::File(_) => (0, 0),
            Kind::Dir(d) => (1, d.opaque as u32),
            Kind::Symlink(_) => (2, 0),
        };
        self.u32(kind);
        self.u32(n.mode as u32);
        self.u32(flags);
        self.f64(n.mtime);
        self.bytes(data);
        self.end(s);
    }
    pub fn rec_link(&mut self, parent: u32, name: &[u8], ino: u32) {
        let s = self.begin(OP_LINK);
        self.u32(parent);
        self.u32(ino);
        self.bytes(name);
        self.end(s);
    }
    pub fn rec_unlink(&mut self, parent: u32, name: &[u8]) {
        let s = self.begin(OP_UNLINK);
        self.u32(parent);
        self.bytes(name);
        self.end(s);
    }
    pub fn rec_write(&mut self, ino: u32, pos: f64, mtime: f64, data: &[u8]) {
        self.write_head(ino, pos, mtime, data.len());
        self.buf.extend_from_slice(data);
        self.seq += (WRITE_HEAD + data.len()) as u64;
    }
    /// A write record up to its data, which the caller supplies.
    fn write_head(&mut self, ino: u32, pos: f64, mtime: f64, data_len: usize) {
        self.buf.push(OP_WRITE);
        self.u32((WRITE_HEAD - 5 + data_len) as u32);
        self.u32(ino);
        self.f64(pos);
        self.f64(mtime);
        self.u32(data_len as u32);
    }
    pub fn rec_trunc(&mut self, ino: u32, len: f64, mtime: f64) {
        let s = self.begin(OP_TRUNC);
        self.u32(ino);
        self.f64(len);
        self.f64(mtime);
        self.end(s);
    }
    pub fn rec_meta(&mut self, ino: u32, mode: u32, mtime: f64) {
        let s = self.begin(OP_META);
        self.u32(ino);
        self.u32(mode);
        self.f64(mtime);
        self.end(s);
    }
}

/// Sizes of the records, without a name or contents.
pub const NODE_HEAD: usize = 33;
pub const LINK_HEAD: usize = 17;
pub const WRITE_HEAD: usize = 29;
const TRUNC_LEN: usize = 25;
const META_LEN: usize = 21;

struct Rd<'a>(&'a [u8]);
impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> R<&'a [u8]> {
        if self.0.len() < n {
            return Err(EINVAL);
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u32(&mut self) -> R<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> R<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> R<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }
}

fn apply(v: &mut Vfs, op: u8, p: &[u8]) -> R<()> {
    let mut r = Rd(p);
    match op {
        OP_NODE => {
            let ino = r.u32()?;
            let kind = r.u32()?;
            let mode = r.u32()? as u16;
            let flags = r.u32()?;
            let mtime = r.f64()?;
            let data = r.bytes()?;
            let kind = match kind {
                0 => {
                    let mut d = Vec::new();
                    crate::mem::reserve(&mut d, data.len(), ENOMEM)?;
                    d.extend_from_slice(data);
                    Kind::File(d)
                }
                1 => Kind::Dir(Dir { children: BTreeMap::new(), opaque: flags & 1 != 0, mount: NONE }),
                _ => Kind::Symlink(data.into()),
            };
            if ino == 0 {
                return Ok(()); // the root always exists
            }
            v.place(
                ino,
                Node { kind, mode, persist: true, nlink: 0, opens: AtomicU32::new(0), mtime, ctime: mtime, btime: mtime },
            );
        }
        OP_LINK => {
            let parent = r.u32()?;
            let ino = r.u32()?;
            let name = r.bytes()?;
            let ok_parent = matches!(v.try_node(parent).map(|n| &n.kind), Some(Kind::Dir(_)));
            if ok_parent && (ino == WHITEOUT || v.try_node(ino).is_some()) {
                v.link_raw(parent, name, ino);
            }
        }
        OP_UNLINK => {
            let parent = r.u32()?;
            let name = r.bytes()?;
            if matches!(v.try_node(parent).map(|n| &n.kind), Some(Kind::Dir(_))) {
                v.unlink_raw(parent, name);
            }
        }
        OP_WRITE => {
            let ino = r.u32()?;
            let pos = r.f64()? as usize;
            let mtime = r.f64()?;
            let data = r.bytes()?;
            if let Some(Some(n)) = v.nodes.get_mut(ino as usize) {
                if let Kind::File(d) = &mut n.kind {
                    if d.len() < pos + data.len() {
                        crate::mem::grow(d, pos + data.len(), ENOMEM)?;
                        d.resize(pos + data.len(), 0);
                    }
                    d[pos..pos + data.len()].copy_from_slice(data);
                    n.mtime = mtime;
                }
            }
        }
        OP_TRUNC => {
            let ino = r.u32()?;
            let len = r.f64()? as usize;
            let mtime = r.f64()?;
            if let Some(Some(n)) = v.nodes.get_mut(ino as usize) {
                if let Kind::File(d) = &mut n.kind {
                    if len > d.len() {
                        crate::mem::reserve(d, len - d.len(), ENOMEM)?;
                    }
                    d.resize(len, 0);
                    n.mtime = mtime;
                }
            }
        }
        OP_META => {
            let ino = r.u32()?;
            let mode = r.u32()?;
            let mtime = r.f64()?;
            if let Some(Some(n)) = v.nodes.get_mut(ino as usize) {
                n.mode = mode as u16;
                n.mtime = mtime;
            }
        }
        _ => return Err(EINVAL),
    }
    Ok(())
}

/// Apply a record stream (a piece of a snapshot, or a journal frame payload). Stops at the
/// first record that is malformed or not all there and returns the number of bytes applied;
/// ENOMEM when the kernel memory has no room for what a record holds. `more`: further
/// pieces of the same stream follow (a snapshot's links come after all of its nodes, so
/// the nodes nobody links to are only collected after the last piece).
pub fn replay(stream: &[u8], more: bool) -> R<usize> {
    let mut v = VFS.write();
    let was = core::mem::replace(&mut v.journal.enabled, false);
    let mut off = 0;
    let mut failed = None;
    while off + 5 <= stream.len() {
        let op = stream[off];
        let len = u32::from_le_bytes(stream[off + 1..off + 5].try_into().unwrap()) as usize;
        if off + 5 + len > stream.len() {
            break;
        }
        match apply(&mut v, op, &stream[off + 5..off + 5 + len]) {
            Ok(()) => off += 5 + len,
            Err(ENOMEM) => {
                failed = Some(ENOMEM);
                break;
            }
            Err(_) => break,
        }
    }
    if !more {
        v.rebuild_free();
    }
    v.journal.enabled = was;
    match failed {
        Some(e) => Err(e),
        None => Ok(off),
    }
}

/// Start journaling. `seq` is the sequence number restored from storage.
pub fn enable(seq: u64) {
    let mut v = VFS.write();
    v.journal.enabled = true;
    v.journal.seq = seq;
    v.journal.buf = Vec::new();
    *DURABLE.lock() = seq;
}

/// Detach the pending journal bytes. Returns (buffer, end sequence).
pub fn take() -> (Vec<u8>, u64) {
    let mut v = VFS.write();
    let seq = v.journal.seq;
    v.journal.asked = false;
    (core::mem::take(&mut v.journal.buf), seq)
}

/// The pieces of a snapshot on their way to `sink`: small records gathered in a buffer of
/// fixed size, large contents passed as they lie.
struct Out<'a> {
    j: Journal,
    sink: &'a mut dyn FnMut(&[u8]) -> R<()>,
    bytes: u64,
}
impl Out<'_> {
    fn flush(&mut self) -> R<()> {
        if !self.j.buf.is_empty() {
            (self.sink)(&self.j.buf)?;
            self.bytes += self.j.buf.len() as u64;
            self.j.buf.clear();
        }
        Ok(())
    }
    /// Room for a record of `bytes` in the buffer, which never grows with the lock held
    /// (a name or a link target is far smaller than it).
    fn room(&mut self, bytes: usize) -> R<()> {
        if self.j.buf.len() + bytes > self.j.buf.capacity() {
            self.flush()?;
        }
        if bytes > self.j.buf.capacity() {
            return Err(ENOMEM);
        }
        Ok(())
    }
    fn raw(&mut self, data: &[u8]) -> R<()> {
        self.flush()?;
        (self.sink)(data)?;
        self.bytes += data.len() as u64;
        Ok(())
    }
}

/// Write every persistent node to `sink` as the shortest record stream that recreates
/// them, in pieces. Returns (bytes written, sequence): the stream holds the effect of every
/// record up to that sequence number.
///
/// The overlay is not copied: the filesystem is held for reading throughout (lookups and
/// reads go on, changes wait), small records pass through one buffer of `SNAP_BUF` bytes
/// taken before the lock, and file contents go to the sink from where they are. So a
/// snapshot needs no memory to speak of and cannot fail for want of it; what the sink
/// refuses (the disk is full) comes back as its error, with nothing changed.
/// `snapshot_done` follows once the host has made the snapshot durable.
pub fn snapshot(sink: &mut dyn FnMut(&[u8]) -> R<()>) -> R<(u64, u64)> {
    let mut out = Out { j: Journal::new(), sink, bytes: 0 };
    out.j.buf.try_reserve_exact(SNAP_BUF).map_err(|_| ENOMEM)?;
    let v = VFS.read();
    // Nodes first, then links, so every link target exists at replay.
    for (i, n) in v.nodes.iter().enumerate() {
        let Some(n) = n else { continue };
        if !n.persist {
            continue;
        }
        let ino = i as u32;
        match &n.kind {
            _ if i == 0 => {
                out.room(META_LEN)?;
                out.j.rec_meta(0, n.mode as u32, n.mtime);
            }
            Kind::File(d) if d.len() > SNAP_INLINE => {
                out.room(NODE_HEAD + TRUNC_LEN)?;
                out.j.rec_node_with(ino, n, &[]);
                if d.len() > SNAP_CHUNK {
                    // The reader takes the file's room once, not as it grows.
                    out.j.rec_trunc(ino, d.len() as f64, n.mtime);
                }
                for (c, chunk) in d.chunks(SNAP_CHUNK).enumerate() {
                    out.room(WRITE_HEAD)?;
                    out.j.write_head(ino, (c * SNAP_CHUNK) as f64, n.mtime, chunk.len());
                    out.raw(chunk)?;
                }
            }
            Kind::File(d) => {
                out.room(NODE_HEAD + d.len())?;
                out.j.rec_node(ino, n);
            }
            Kind::Symlink(t) => {
                out.room(NODE_HEAD + t.len())?;
                out.j.rec_node(ino, n);
            }
            Kind::Dir(_) => {
                out.room(NODE_HEAD)?;
                out.j.rec_node(ino, n);
            }
        }
    }
    for (i, n) in v.nodes.iter().enumerate() {
        if let Some(Node { kind: Kind::Dir(d), persist: true, .. }) = n {
            for (name, &c) in &d.children {
                let keep = c == WHITEOUT || v.try_node(c).map(|n| n.persist).unwrap_or(false);
                if keep {
                    out.room(LINK_HEAD + name.len())?;
                    out.j.rec_link(i as u32, name, c);
                }
            }
        }
    }
    out.flush()?;
    Ok((out.bytes, v.journal.seq))
}

/// The snapshot taken at `seq` is durable: pending journal bytes up to there are dropped,
/// the snapshot holds their effect. (Not before: a snapshot that fails on its way to the
/// disk must leave the journal whole.)
pub fn snapshot_done(seq: u64) {
    let mut v = VFS.write();
    let newer = v.journal.seq.saturating_sub(seq) as usize;
    let covered = v.journal.buf.len().saturating_sub(newer);
    if covered == v.journal.buf.len() {
        v.journal.buf = Vec::new();
    } else {
        v.journal.buf.drain(..covered);
    }
}

pub fn current_seq() -> u64 {
    VFS.read().journal.seq
}
pub fn is_enabled() -> bool {
    VFS.read().journal.enabled
}
pub fn pending_bytes() -> usize {
    VFS.read().journal.buf.len()
}

pub fn set_durable(seq: u64) {
    {
        let mut d = DURABLE.lock();
        if seq > *d {
            *d = seq;
        }
    }
    DURABLE_AT.lock()[0] = crate::sys::now_ms();
    BAT_PERSIST_WORD.fetch_add(1, SeqCst);
    crate::sys::notify(BAT_PERSIST_WORD.as_ptr(), u32::MAX);
    DURABLE_WQ.wake_all();
}
pub fn durable() -> u64 {
    *DURABLE.lock()
}
/// A snapshot was completed now.
pub fn note_snapshot() {
    DURABLE_AT.lock()[1] = crate::sys::now_ms();
}
/// out: journaling on (0/1), sequence number now, durable sequence number, pending journal
/// bytes in memory, when the journal was last written out and when a snapshot was last
/// completed (epoch ms, 0: never).
pub fn stats(out: &mut [f64; 6]) {
    {
        let v = VFS.read();
        out[0] = v.journal.enabled as u32 as f64;
        out[1] = v.journal.seq as f64;
        out[3] = v.journal.buf.len() as f64;
    }
    out[2] = durable() as f64;
    let at = DURABLE_AT.lock();
    out[4] = at[0];
    out[5] = at[1];
}
/// Block until the durable sequence reaches `seq`. False on timeout.
pub fn wait_durable(seq: u64, timeout_ms: f64) -> bool {
    let deadline = if timeout_ms < 0.0 { f64::INFINITY } else { crate::sys::now_ms() + timeout_ms };
    loop {
        let s = DURABLE_WQ.seq();
        if durable() >= seq {
            return true;
        }
        let left = deadline - crate::sys::now_ms();
        if left <= 0.0 {
            return false;
        }
        DURABLE_WQ.wait(s, if left.is_finite() { left } else { -1.0 });
    }
}
