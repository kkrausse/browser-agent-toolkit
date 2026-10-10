//! Overlay persistence: a physical journal of overlay mutations, drained to
//! OPFS by the supervisor, plus snapshots in the same record format.
//!
//! Records name overlay nodes by number, so replay needs neither path
//! resolution nor the images: it rebuilds the same slab. A snapshot is simply
//! the shortest journal that recreates the current persistent nodes.
//!
//! Record: op u8, payload_len u32, payload. Sequence numbers are byte offsets
//! in the stream of all records ever appended in this origin.

use crate::errno::*;
use crate::lock::WaitQ;
use crate::vfs::{Dir, Kind, Node, Vfs, NONE, VFS, WHITEOUT};
use core::sync::atomic::{AtomicU32, Ordering::*};
use std::collections::BTreeMap;

const OP_NODE: u8 = 1;
const OP_LINK: u8 = 2;
const OP_UNLINK: u8 = 3;
const OP_WRITE: u8 = 4;
const OP_TRUNC: u8 = 5;
const OP_META: u8 = 6;

pub struct Journal {
    pub enabled: bool,
    pub buf: Vec<u8>,
    /// Sequence number of the end of `buf`.
    pub seq: u64,
}

/// Durable state shared with waiters. `BAT_PERSIST_WORD` is bumped whenever
/// the durable sequence advances; the page awaits it with Atomics.waitAsync.
#[no_mangle]
pub static BAT_PERSIST_WORD: AtomicU32 = AtomicU32::new(0);
static DURABLE_WQ: WaitQ = WaitQ::new();
static DURABLE: crate::lock::Mutex<u64> = crate::lock::Mutex::new(0);

impl Journal {
    pub const fn new() -> Self {
        Journal { enabled: false, buf: Vec::new(), seq: 0 }
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
        let s = self.begin(OP_NODE);
        self.u32(ino);
        let (kind, flags, data): (u32, u32, &[u8]) = match &n.kind {
            Kind::File(d) => (0, 0, d),
            Kind::Dir(d) => (1, d.opaque as u32, &[]),
            Kind::Symlink(t) => (2, 0, t),
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
        let s = self.begin(OP_WRITE);
        self.u32(ino);
        self.f64(pos);
        self.f64(mtime);
        self.bytes(data);
        self.end(s);
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
                0 => Kind::File(data.to_vec()),
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

/// Apply a record stream (a snapshot or a journal frame payload). Stops at
/// the first malformed record and returns the number of bytes applied.
pub fn replay(stream: &[u8]) -> usize {
    let mut v = VFS.write();
    let was = core::mem::replace(&mut v.journal.enabled, false);
    let mut off = 0;
    while off + 5 <= stream.len() {
        let op = stream[off];
        let len = u32::from_le_bytes(stream[off + 1..off + 5].try_into().unwrap()) as usize;
        if off + 5 + len > stream.len() || apply(&mut v, op, &stream[off + 5..off + 5 + len]).is_err() {
            break;
        }
        off += 5 + len;
    }
    v.rebuild_free();
    v.journal.enabled = was;
    off
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
    (core::mem::take(&mut v.journal.buf), seq)
}

/// Serialize every persistent node. Pending journal bytes are discarded:
/// the snapshot contains their effect. Returns (records, sequence).
pub fn snapshot() -> (Vec<u8>, u64) {
    let mut v = VFS.write();
    let mut j = Journal::new();
    // Nodes first, then links, so every link target exists at replay.
    for (i, n) in v.nodes.iter().enumerate() {
        if let Some(n) = n {
            if n.persist {
                if i == 0 {
                    j.rec_meta(0, n.mode as u32, n.mtime);
                } else {
                    j.rec_node(i as u32, n);
                }
            }
        }
    }
    for (i, n) in v.nodes.iter().enumerate() {
        if let Some(Node { kind: Kind::Dir(d), persist: true, .. }) = n {
            for (name, &c) in &d.children {
                let keep = c == WHITEOUT || v.try_node(c).map(|n| n.persist).unwrap_or(false);
                if keep {
                    j.rec_link(i as u32, name, c);
                }
            }
        }
    }
    v.journal.buf = Vec::new();
    (j.buf, v.journal.seq)
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
    BAT_PERSIST_WORD.fetch_add(1, SeqCst);
    crate::sys::notify(BAT_PERSIST_WORD.as_ptr(), u32::MAX);
    DURABLE_WQ.wake_all();
}
pub fn durable() -> u64 {
    *DURABLE.lock()
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
