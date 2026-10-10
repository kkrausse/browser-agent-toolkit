//! Open file descriptions, pipes and sockets.

use crate::errno::*;
use crate::image::ImageMount;
use crate::lock::{Mutex, WaitQ};
use crate::proc::Process;
use crate::vfs;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::*};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

pub const POLLIN: u32 = 1;
pub const POLLOUT: u32 = 4;
pub const POLLERR: u32 = 8;
pub const POLLHUP: u32 = 16;

pub const PIPE_CAP: usize = 64 * 1024;
pub const SOCK_CAP: usize = 256 * 1024;

/// A process's interest in an object becoming ready.
pub struct Sub {
    pub proc: Arc<Process>,
    pub token: u32,
    pub mask: u32,
    /// False for a blocking `poll`: only wake, do not queue an event.
    pub queue: bool,
}

fn post(subs: &[Sub], mask: u32) {
    for s in subs {
        if s.mask & mask != 0 {
            if s.queue {
                s.proc.post(s.token, mask & s.mask);
            } else {
                s.proc.wake();
            }
        }
    }
}

struct PipeInner {
    buf: Box<[u8]>,
    head: usize,
    len: usize,
    readers: u32,
    writers: u32,
    subs: Vec<Sub>,
}

/// A byte ring in shared memory.
pub struct Pipe {
    inner: Mutex<PipeInner>,
    rq: WaitQ,
    wq: WaitQ,
}

impl Pipe {
    pub fn new(cap: usize) -> Arc<Pipe> {
        Arc::new(Pipe {
            inner: Mutex::new(PipeInner {
                buf: vec![0u8; cap].into_boxed_slice(),
                head: 0,
                len: 0,
                readers: 1,
                writers: 1,
                subs: Vec::new(),
            }),
            rq: WaitQ::new(),
            wq: WaitQ::new(),
        })
    }
    pub fn read(&self, dst: &mut [u8], nonblock: bool) -> R<usize> {
        if dst.is_empty() {
            return Ok(0);
        }
        loop {
            let seq;
            {
                let mut p = self.inner.lock();
                if p.len > 0 {
                    let n = dst.len().min(p.len);
                    let cap = p.buf.len();
                    let first = n.min(cap - p.head);
                    dst[..first].copy_from_slice(&p.buf[p.head..p.head + first]);
                    dst[first..n].copy_from_slice(&p.buf[..n - first]);
                    p.head = (p.head + n) % cap;
                    p.len -= n;
                    post(&p.subs, POLLOUT);
                    drop(p);
                    self.wq.wake_all();
                    return Ok(n);
                }
                if p.writers == 0 {
                    return Ok(0);
                }
                seq = self.rq.seq();
            }
            if nonblock || !crate::thread::can_block() {
                return Err(EAGAIN);
            }
            self.rq.wait(seq, -1.0);
        }
    }
    pub fn write(&self, src: &[u8], nonblock: bool) -> R<usize> {
        let mut done = 0;
        loop {
            let seq;
            {
                let mut p = self.inner.lock();
                if p.readers == 0 {
                    return if done > 0 { Ok(done) } else { Err(EPIPE) };
                }
                let cap = p.buf.len();
                let n = (src.len() - done).min(cap - p.len);
                if n > 0 {
                    let tail = (p.head + p.len) % cap;
                    let first = n.min(cap - tail);
                    p.buf[tail..tail + first].copy_from_slice(&src[done..done + first]);
                    p.buf[..n - first].copy_from_slice(&src[done + first..done + n]);
                    p.len += n;
                    done += n;
                    post(&p.subs, POLLIN);
                }
                seq = self.wq.seq();
            }
            if done > 0 {
                self.rq.wake_all();
            }
            if done == src.len() {
                return Ok(done);
            }
            if nonblock || !crate::thread::can_block() {
                return if done > 0 { Ok(done) } else { Err(EAGAIN) };
            }
            self.wq.wait(seq, -1.0);
        }
    }
    fn close_reader(&self) {
        {
            let mut p = self.inner.lock();
            p.readers = p.readers.saturating_sub(1);
            if p.readers == 0 {
                post(&p.subs, POLLOUT | POLLERR | POLLHUP);
            }
        }
        self.wq.wake_all();
    }
    fn close_writer(&self) {
        {
            let mut p = self.inner.lock();
            p.writers = p.writers.saturating_sub(1);
            if p.writers == 0 {
                post(&p.subs, POLLIN | POLLHUP);
            }
        }
        self.rq.wake_all();
    }
    fn rstate(&self) -> u32 {
        let p = self.inner.lock();
        let mut m = 0;
        if p.len > 0 {
            m |= POLLIN;
        }
        if p.writers == 0 {
            m |= POLLHUP | POLLIN;
        }
        m
    }
    fn wstate(&self) -> u32 {
        let p = self.inner.lock();
        let mut m = 0;
        if p.readers == 0 {
            m |= POLLERR | POLLOUT;
        } else if p.len < p.buf.len() {
            m |= POLLOUT;
        }
        m
    }
    pub fn buffered(&self) -> usize {
        self.inner.lock().len
    }
    fn subscribe(&self, s: Sub) {
        let mut p = self.inner.lock();
        p.subs.retain(|x| !(x.proc.pid == s.proc.pid && x.token == s.token && x.queue == s.queue && x.mask & s.mask != 0));
        p.subs.push(s);
    }
    fn unsubscribe(&self, pid: u32, token: u32, queue: bool) {
        let old: Vec<Sub>;
        {
            let mut p = self.inner.lock();
            let (gone, keep): (Vec<Sub>, Vec<Sub>) =
                core::mem::take(&mut p.subs).into_iter().partition(|x| x.proc.pid == pid && x.token == token && x.queue == queue);
            p.subs = keep;
            old = gone;
        }
        drop(old);
    }
}

struct ListenInner {
    queue: VecDeque<Arc<OpenFile>>,
    closed: bool,
    subs: Vec<Sub>,
}
pub struct Listener {
    pub port: u32,
    /// Identity of this listener (ports are reused, identities are not).
    pub id: u32,
    inner: Mutex<ListenInner>,
    wq: WaitQ,
}

static PORTS: Mutex<BTreeMap<u32, Arc<Listener>>> = Mutex::new(BTreeMap::new());
static NEXT_EPHEMERAL: AtomicU32 = AtomicU32::new(49152);
static NEXT_LISTENER: AtomicU32 = AtomicU32::new(1);

pub enum OfKind {
    Ov { ino: u32 },
    Img { m: &'static ImageMount, idx: u32, off: u64, len: u32 },
    Dir,
    PipeR(Arc<Pipe>),
    PipeW(Arc<Pipe>),
    Sock { rx: Arc<Pipe>, tx: Arc<Pipe>, wr_shut: AtomicBool, local: u32, peer: u32 },
    Listener(Arc<Listener>),
    /// Writes go to the host log at this level.
    Console(u32),
    Null,
}

pub struct OpenFile {
    pub kind: OfKind,
    pub flags: AtomicU32,
    pub pos: AtomicU64,
    /// Canonical path at open time (for watch events and fstat-by-path uses).
    pub path: Box<[u8]>,
}

impl Drop for OpenFile {
    fn drop(&mut self) {
        match &self.kind {
            OfKind::Ov { ino } => vfs::release(*ino),
            OfKind::PipeR(p) => p.close_reader(),
            OfKind::PipeW(p) => p.close_writer(),
            OfKind::Sock { rx, tx, wr_shut, .. } => {
                rx.close_reader();
                if !wr_shut.swap(true, SeqCst) {
                    tx.close_writer();
                }
            }
            OfKind::Listener(l) => {
                let mut ports = PORTS.lock();
                if ports.get(&l.port).map(|x| Arc::ptr_eq(x, l)).unwrap_or(false) {
                    ports.remove(&l.port);
                }
                drop(ports);
                let pending: Vec<_>;
                {
                    let mut i = l.inner.lock();
                    i.closed = true;
                    pending = i.queue.drain(..).collect();
                }
                drop(pending);
                l.wq.wake_all();
                ports_changed();
            }
            _ => {}
        }
    }
}

pub fn file(kind: OfKind, flags: u32, path: &[u8]) -> Arc<OpenFile> {
    Arc::new(OpenFile { kind, flags: AtomicU32::new(flags), pos: AtomicU64::new(0), path: path.into() })
}

pub fn pipe() -> (Arc<OpenFile>, Arc<OpenFile>) {
    let p = Pipe::new(PIPE_CAP);
    (file(OfKind::PipeR(p.clone()), 0, b""), file(OfKind::PipeW(p), vfs::O_WRONLY, b""))
}

pub fn listen(port: u32) -> R<Arc<OpenFile>> {
    let mut ports = PORTS.lock();
    let port = if port == 0 {
        loop {
            let p = NEXT_EPHEMERAL.fetch_add(1, Relaxed);
            if !ports.contains_key(&p) {
                break p;
            }
        }
    } else {
        if ports.contains_key(&port) {
            return Err(EADDRINUSE);
        }
        port
    };
    let l = Arc::new(Listener {
        port,
        id: NEXT_LISTENER.fetch_add(1, Relaxed),
        inner: Mutex::new(ListenInner { queue: VecDeque::new(), closed: false, subs: Vec::new() }),
        wq: WaitQ::new(),
    });
    ports.insert(port, l.clone());
    drop(ports);
    ports_changed();
    Ok(file(OfKind::Listener(l), vfs::O_RDWR, b""))
}

pub fn connect(port: u32) -> R<Arc<OpenFile>> {
    let l = PORTS.lock().get(&port).cloned().ok_or(ECONNREFUSED)?;
    let a = Pipe::new(SOCK_CAP); // client -> server
    let b = Pipe::new(SOCK_CAP); // server -> client
    let eph = NEXT_EPHEMERAL.fetch_add(1, Relaxed);
    let server = file(
        OfKind::Sock { rx: a.clone(), tx: b.clone(), wr_shut: AtomicBool::new(false), local: port, peer: eph },
        vfs::O_RDWR,
        b"",
    );
    let client =
        file(OfKind::Sock { rx: b, tx: a, wr_shut: AtomicBool::new(false), local: eph, peer: port }, vfs::O_RDWR, b"");
    {
        let mut i = l.inner.lock();
        if i.closed {
            return Err(ECONNREFUSED);
        }
        i.queue.push_back(server);
        post(&i.subs, POLLIN);
    }
    l.wq.wake_all();
    Ok(client)
}

pub fn socketpair() -> (Arc<OpenFile>, Arc<OpenFile>) {
    let a = Pipe::new(SOCK_CAP);
    let b = Pipe::new(SOCK_CAP);
    (
        file(OfKind::Sock { rx: a.clone(), tx: b.clone(), wr_shut: AtomicBool::new(false), local: 0, peer: 0 }, vfs::O_RDWR, b""),
        file(OfKind::Sock { rx: b, tx: a, wr_shut: AtomicBool::new(false), local: 0, peer: 0 }, vfs::O_RDWR, b""),
    )
}

impl OpenFile {
    fn nonblock(&self) -> bool {
        self.flags.load(Relaxed) & vfs::O_NONBLOCK != 0
    }
    pub fn accept(&self) -> R<Arc<OpenFile>> {
        let OfKind::Listener(l) = &self.kind else { return Err(ENOTSOCK) };
        loop {
            let seq;
            {
                let mut i = l.inner.lock();
                if let Some(s) = i.queue.pop_front() {
                    return Ok(s);
                }
                if i.closed {
                    return Err(EBADF);
                }
                seq = l.wq.seq();
            }
            if self.nonblock() || !crate::thread::can_block() {
                return Err(EAGAIN);
            }
            l.wq.wait(seq, -1.0);
        }
    }
    pub fn shutdown_write(&self) -> R<()> {
        match &self.kind {
            OfKind::Sock { tx, wr_shut, .. } => {
                if !wr_shut.swap(true, SeqCst) {
                    tx.close_writer();
                }
                Ok(())
            }
            _ => Err(ENOTSOCK),
        }
    }
    /// Read at the file position (or `pos` for pread on seekable files).
    pub fn read(&self, dst: &mut [u8], pos: Option<u64>) -> R<usize> {
        match &self.kind {
            OfKind::Ov { ino } => {
                let p = pos.unwrap_or_else(|| self.pos.load(Relaxed));
                let n = vfs::ov_read(*ino, p, dst)?;
                if pos.is_none() {
                    self.pos.store(p + n as u64, Relaxed);
                }
                Ok(n)
            }
            OfKind::Img { m, off, len, .. } => {
                let p = pos.unwrap_or_else(|| self.pos.load(Relaxed));
                if p >= *len as u64 {
                    return Ok(0);
                }
                let n = dst.len().min((*len as u64 - p) as usize);
                m.read_at(off + p, &mut dst[..n])?;
                if pos.is_none() {
                    self.pos.store(p + n as u64, Relaxed);
                }
                Ok(n)
            }
            OfKind::PipeR(p) => p.read(dst, self.nonblock()),
            OfKind::Sock { rx, .. } => rx.read(dst, self.nonblock()),
            OfKind::Dir => Err(EISDIR),
            OfKind::Null | OfKind::Console(_) => Ok(0),
            OfKind::PipeW(_) | OfKind::Listener(_) => Err(EBADF),
        }
    }
    pub fn write(&self, src: &[u8], pos: Option<u64>) -> R<usize> {
        match &self.kind {
            OfKind::Ov { ino } => {
                if self.flags.load(Relaxed) & vfs::O_ACCMODE == 0 {
                    return Err(EBADF);
                }
                let append = self.flags.load(Relaxed) & vfs::O_APPEND != 0;
                let at = if append { None } else { Some(pos.unwrap_or_else(|| self.pos.load(Relaxed))) };
                let end = vfs::ov_write(*ino, at, src, &self.path)?;
                if pos.is_none() {
                    self.pos.store(end, Relaxed);
                }
                Ok(src.len())
            }
            OfKind::PipeW(p) => p.write(src, self.nonblock()),
            OfKind::Sock { tx, wr_shut, .. } => {
                if wr_shut.load(SeqCst) {
                    return Err(EPIPE);
                }
                tx.write(src, self.nonblock())
            }
            OfKind::Console(level) => {
                crate::sys::log(*level, &String::from_utf8_lossy(src));
                Ok(src.len())
            }
            OfKind::Null => Ok(src.len()),
            OfKind::Img { .. } => Err(EBADF),
            OfKind::Dir => Err(EISDIR),
            OfKind::PipeR(_) | OfKind::Listener(_) => Err(EBADF),
        }
    }
    pub fn stat(&self, st: &mut vfs::Stat) -> R<()> {
        match &self.kind {
            OfKind::Ov { ino } => vfs::ov_stat(*ino, st),
            OfKind::Img { m, idx, .. } => {
                vfs::image_stat(m, *idx, st);
                Ok(())
            }
            OfKind::Dir => vfs::stat(&self.path, true, st),
            k => {
                *st = vfs::Stat::default();
                st.kind = match k {
                    OfKind::PipeR(_) | OfKind::PipeW(_) => vfs::K_FIFO,
                    OfKind::Sock { .. } | OfKind::Listener(_) => vfs::K_SOCKET,
                    _ => vfs::K_CHAR,
                };
                st.mode = 0o666;
                st.nlink = 1;
                Ok(())
            }
        }
    }
    pub fn size(&self) -> R<u64> {
        let mut st = vfs::Stat::default();
        self.stat(&mut st)?;
        Ok(st.size as u64)
    }
    pub fn poll_state(&self) -> u32 {
        match &self.kind {
            OfKind::PipeR(p) => p.rstate(),
            OfKind::PipeW(p) => p.wstate(),
            OfKind::Sock { rx, tx, wr_shut, .. } => {
                let mut m = rx.rstate();
                if !wr_shut.load(SeqCst) {
                    m |= tx.wstate();
                }
                m
            }
            OfKind::Listener(l) => {
                let i = l.inner.lock();
                if !i.queue.is_empty() {
                    POLLIN
                } else if i.closed {
                    POLLHUP
                } else {
                    0
                }
            }
            _ => POLLIN | POLLOUT,
        }
    }
    pub fn subscribe(&self, proc: &Arc<Process>, token: u32, mask: u32, queue: bool) {
        let sub = |mask| Sub { proc: proc.clone(), token, mask, queue };
        match &self.kind {
            OfKind::PipeR(p) => p.subscribe(sub(mask & (POLLIN | POLLHUP))),
            OfKind::PipeW(p) => p.subscribe(sub(mask & (POLLOUT | POLLERR))),
            OfKind::Sock { rx, tx, .. } => {
                if mask & (POLLIN | POLLHUP) != 0 {
                    rx.subscribe(sub(mask & (POLLIN | POLLHUP)));
                }
                if mask & (POLLOUT | POLLERR) != 0 {
                    tx.subscribe(sub(mask & (POLLOUT | POLLERR)));
                }
            }
            OfKind::Listener(l) => {
                let mut i = l.inner.lock();
                i.subs.retain(|x| !(x.proc.pid == proc.pid && x.token == token && x.queue == queue));
                i.subs.push(sub(POLLIN));
            }
            _ => {}
        }
    }
    pub fn unsubscribe(&self, pid: u32, token: u32, queue: bool) {
        match &self.kind {
            OfKind::PipeR(p) | OfKind::PipeW(p) => p.unsubscribe(pid, token, queue),
            OfKind::Sock { rx, tx, .. } => {
                rx.unsubscribe(pid, token, queue);
                tx.unsubscribe(pid, token, queue);
            }
            OfKind::Listener(l) => {
                let old: Vec<Sub>;
                {
                    let mut i = l.inner.lock();
                    let (gone, keep): (Vec<Sub>, Vec<Sub>) = core::mem::take(&mut i.subs)
                        .into_iter()
                        .partition(|x| x.proc.pid == pid && x.token == token && x.queue == queue);
                    i.subs = keep;
                    old = gone;
                }
                drop(old);
            }
            _ => {}
        }
    }
    pub fn ports(&self) -> (u32, u32) {
        match &self.kind {
            OfKind::Sock { local, peer, .. } => (*local, *peer),
            OfKind::Listener(l) => (l.port, 0),
            _ => (0, 0),
        }
    }
}

// ---- direct ring access for the HTTP/WebSocket codecs (http.rs, ws.rs) ----
//
// A socket has one reader and one writer per direction, so the codecs parse
// and frame in place: the reader is shown the readable part of the ring (and
// may hand ranges of it to JS before consuming them), the writer is shown the
// free part and commits what it filled. Bytes cross between JS and the ring
// exactly once.

/// Bumped whenever a port starts or stops being listened on (`bat_port_listener`).
#[no_mangle]
pub static BAT_PORTS_WORD: AtomicU32 = AtomicU32::new(0);

pub fn ports_changed() {
    BAT_PORTS_WORD.fetch_add(1, SeqCst);
    crate::sys::notify(BAT_PORTS_WORD.as_ptr(), u32::MAX);
}

/// Identity of whatever listens on `port` now (never 0, never reused), or 0.
pub fn port_listener(port: u32) -> u32 {
    PORTS.lock().get(&port).map(|l| l.id).unwrap_or(0)
}

impl Pipe {
    /// Show the readable bytes as two slices (the second is the wrapped part)
    /// plus "no writer left". `f` returns how many bytes to consume.
    pub fn with_rx<T>(&self, f: impl FnOnce(&mut [u8], &mut [u8], bool) -> (usize, T)) -> T {
        let (n, out);
        {
            let mut p = self.inner.lock();
            let p = &mut *p;
            let cap = p.buf.len();
            let first = p.len.min(cap - p.head);
            let second = p.len - first;
            let eof = p.writers == 0;
            let (lo, hi) = p.buf.split_at_mut(p.head);
            (n, out) = f(&mut hi[..first], &mut lo[..second], eof);
            let n = n.min(p.len);
            if n > 0 {
                p.head = (p.head + n) % cap;
                p.len -= n;
                post(&p.subs, POLLOUT);
            }
        }
        if n > 0 {
            self.wq.wake_all();
        }
        out
    }
    /// Show the free bytes as two slices starting at the write position. `f`
    /// returns how many bytes it filled and wants committed.
    pub fn with_tx<T>(&self, f: impl FnOnce(&mut [u8], &mut [u8]) -> (usize, T)) -> R<T> {
        let (n, out);
        {
            let mut p = self.inner.lock();
            let p = &mut *p;
            if p.readers == 0 {
                return Err(EPIPE);
            }
            let cap = p.buf.len();
            let free = cap - p.len;
            let tail = (p.head + p.len) % cap;
            let first = free.min(cap - tail);
            let second = free - first;
            let (lo, hi) = p.buf.split_at_mut(tail);
            (n, out) = f(&mut hi[..first], &mut lo[..second]);
            let n = n.min(free);
            if n > 0 {
                p.len += n;
                post(&p.subs, POLLIN);
            }
        }
        if n > 0 {
            self.rq.wake_all();
        }
        Ok(out)
    }
}

impl OpenFile {
    /// The receive ring of a socket (or the ring of a pipe's read end).
    pub fn rx_ring(&self) -> R<&Arc<Pipe>> {
        match &self.kind {
            OfKind::Sock { rx, .. } => Ok(rx),
            OfKind::PipeR(p) => Ok(p),
            _ => Err(ENOTSOCK),
        }
    }
    /// The send ring of a socket (or the ring of a pipe's write end).
    pub fn tx_ring(&self) -> R<&Arc<Pipe>> {
        match &self.kind {
            OfKind::Sock { tx, wr_shut, .. } => {
                if wr_shut.load(SeqCst) {
                    Err(EPIPE)
                } else {
                    Ok(tx)
                }
            }
            OfKind::PipeW(p) => Ok(p),
            _ => Err(ENOTSOCK),
        }
    }
}
