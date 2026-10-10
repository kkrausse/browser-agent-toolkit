//! Process table, per-process event queues, signals, and the supervisor's
//! work queue.

use crate::errno::*;
use crate::fd::{self, OfKind, OpenFile};
use crate::lock::{Mutex, RwLock, WaitQ};
use crate::sys;
use crate::thread;
use core::sync::atomic::{AtomicI32, AtomicU32, AtomicUsize, Ordering::*};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

pub const ST_STARTING: u32 = 0;
pub const ST_RUNNING: u32 = 1;
pub const ST_EXITED: u32 = 2;

pub const TOKEN_CHILD: u32 = 0x8000_0000;
pub const TOKEN_WATCH: u32 = 0x4000_0000;
pub const TOKEN_SIGNAL: u32 = 0x4000_0001;

pub const SIGKILL: u32 = 9;
const WATCH_Q_MAX: usize = 4 << 20;

pub struct ProcState {
    pub cwd: Vec<u8>,
    pub fds: Vec<Option<Arc<OpenFile>>>,
    /// exec, cwd, argv, env as given to spawn (see kernel-abi.md).
    pub info: Vec<u8>,
}

pub struct EventQ {
    ready: Vec<(u32, u32)>,
    watch: Vec<u8>,
    last_watch: usize,
    watch_overflow: bool,
}

pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    /// The event word: bumped whenever something this process waits on is ready.
    pub event: AtomicU32,
    pub sig: AtomicU32,
    pub state: AtomicU32,
    pub status: AtomicI32,
    pub exit_wq: WaitQ,
    /// Thread record of the worker running it (for the supervisor).
    pub thread: AtomicUsize,
    pub st: Mutex<ProcState>,
    pub evq: Mutex<EventQ>,
}

static PROCS: RwLock<BTreeMap<u32, Arc<Process>>> = RwLock::new(BTreeMap::new());
static NEXT_PID: AtomicU32 = AtomicU32::new(1);

impl Process {
    fn new(ppid: u32, cwd: Vec<u8>, fds: Vec<Option<Arc<OpenFile>>>, info: Vec<u8>, state: u32) -> Arc<Process> {
        let p = Arc::new(Process {
            pid: NEXT_PID.fetch_add(1, SeqCst),
            ppid,
            event: AtomicU32::new(0),
            sig: AtomicU32::new(0),
            state: AtomicU32::new(state),
            status: AtomicI32::new(0),
            exit_wq: WaitQ::new(),
            thread: AtomicUsize::new(0),
            st: Mutex::new(ProcState { cwd, fds, info }),
            evq: Mutex::new(EventQ { ready: Vec::new(), watch: Vec::new(), last_watch: usize::MAX, watch_overflow: false }),
        });
        PROCS.write().insert(p.pid, p.clone());
        p
    }
    pub fn wake(&self) {
        self.event.fetch_add(1, SeqCst);
        sys::notify(self.event.as_ptr(), u32::MAX);
    }
    pub fn post(&self, token: u32, mask: u32) {
        {
            let mut q = self.evq.lock();
            match q.ready.iter_mut().find(|e| e.0 == token) {
                Some(e) => e.1 |= mask,
                None => q.ready.push((token, mask)),
            }
        }
        self.wake();
    }
    /// Queue a watch event: id u32, kind u32, len u16, relative path.
    pub fn post_watch(&self, id: u32, kind: u32, rel: &[u8]) {
        {
            let mut q = self.evq.lock();
            let mut rec = [0u8; 10];
            rec[..4].copy_from_slice(&id.to_le_bytes());
            rec[4..8].copy_from_slice(&kind.to_le_bytes());
            rec[8..10].copy_from_slice(&(rel.len() as u16).to_le_bytes());
            // Coalesce an event identical to the last one still queued.
            let lw = q.last_watch;
            if lw != usize::MAX && q.watch.len() == lw + 10 + rel.len() && q.watch[lw..lw + 10] == rec && &q.watch[lw + 10..] == rel
            {
                return;
            }
            if q.watch.len() + 10 + rel.len() > WATCH_Q_MAX {
                q.watch_overflow = true;
                return;
            }
            q.last_watch = q.watch.len();
            q.watch.extend_from_slice(&rec);
            q.watch.extend_from_slice(rel);
            if !q.ready.iter().any(|e| e.0 == TOKEN_WATCH) {
                q.ready.push((TOKEN_WATCH, 1));
            }
        }
        self.wake();
    }
    /// Move queued (token, mask) pairs into `out`; returns the count.
    pub fn take_events(&self, out: &mut [u32]) -> usize {
        let mut q = self.evq.lock();
        let n = (out.len() / 2).min(q.ready.len());
        for (i, (t, m)) in q.ready.drain(..n).enumerate() {
            out[i * 2] = t;
            out[i * 2 + 1] = m;
        }
        n
    }
    /// Drain whole watch records into `out`; returns bytes written.
    pub fn take_watch(&self, out: &mut [u8]) -> usize {
        let mut q = self.evq.lock();
        let mut off = 0;
        while off + 10 <= q.watch.len() {
            let len = u16::from_le_bytes([q.watch[off + 8], q.watch[off + 9]]) as usize;
            if off + 10 + len > out.len() {
                break;
            }
            off += 10 + len;
        }
        out[..off].copy_from_slice(&q.watch[..off]);
        q.watch.drain(..off);
        q.last_watch = usize::MAX;
        if !q.watch.is_empty() && !q.ready.iter().any(|e| e.0 == TOKEN_WATCH) {
            q.ready.push((TOKEN_WATCH, 1));
        }
        off
    }
    pub fn fd(&self, fd: i32) -> R<Arc<OpenFile>> {
        let st = self.st.lock();
        st.fds.get(fd as usize).and_then(|f| f.clone()).ok_or(EBADF)
    }
    pub fn install(&self, f: Arc<OpenFile>) -> i32 {
        let mut st = self.st.lock();
        match st.fds.iter().position(|x| x.is_none()) {
            Some(i) => {
                st.fds[i] = Some(f);
                i as i32
            }
            None => {
                st.fds.push(Some(f));
                (st.fds.len() - 1) as i32
            }
        }
    }
    pub fn close(&self, fd: i32) -> R<()> {
        let f = {
            let mut st = self.st.lock();
            st.fds.get_mut(fd as usize).and_then(|f| f.take()).ok_or(EBADF)?
        };
        f.unsubscribe(self.pid, fd as u32, true);
        drop(f);
        Ok(())
    }
}

pub fn get(pid: u32) -> R<Arc<Process>> {
    PROCS.read().get(&pid).cloned().ok_or(ESRCH)
}

/// The calling thread's process.
#[inline]
pub fn cur() -> R<&'static Process> {
    let p = thread::current().map(|t| t.proc.load(Relaxed)).unwrap_or(0);
    if p == 0 {
        Err(ESRCH)
    } else {
        Ok(unsafe { &*(p as *const Process) })
    }
}
pub fn cur_arc() -> R<Arc<Process>> {
    get(cur()?.pid)
}

/// Bind the calling thread to `pid`.
pub fn attach(pid: u32) -> R<()> {
    let p = get(pid)?;
    let t = thread::current().ok_or(EINVAL)?;
    t.pid.store(pid, SeqCst);
    p.thread.compare_exchange(0, t as *const _ as usize, SeqCst, SeqCst).ok();
    p.state.compare_exchange(ST_STARTING, ST_RUNNING, SeqCst, SeqCst).ok();
    let old = t.proc.swap(Arc::into_raw(p) as usize, SeqCst);
    if old != 0 {
        unsafe { drop(Arc::from_raw(old as *const Process)) };
    }
    Ok(())
}

/// A process with no parent and no worker of its own: the page, kerneld.
pub fn new_host() -> Arc<Process> {
    let fds = vec![
        Some(fd::file(OfKind::Null, 0, b"")),
        Some(fd::file(OfKind::Console(1), 1, b"")),
        Some(fd::file(OfKind::Console(3), 1, b"")),
    ];
    Process::new(0, Vec::new(), fds, Vec::new(), ST_RUNNING)
}

fn rd_u32(b: &[u8], off: &mut usize) -> R<u32> {
    let s = b.get(*off..*off + 4).ok_or(EINVAL)?;
    *off += 4;
    Ok(u32::from_le_bytes(s.try_into().unwrap()))
}
fn rd_bytes<'a>(b: &'a [u8], off: &mut usize) -> R<&'a [u8]> {
    let n = rd_u32(b, off)? as usize;
    let s = b.get(*off..*off + n).ok_or(EINVAL)?;
    *off += n;
    Ok(s)
}

pub const STDIO_INHERIT: u32 = 0;
pub const STDIO_PIPE: u32 = 1;
pub const STDIO_NULL: u32 = 2;
pub const STDIO_FD: u32 = 3;

/// Create a process from a spawn request and queue it for the supervisor.
/// Request: flags u32, 3 x (mode u32, arg u32), then the info block
/// (argc u32, envc u32, exec, cwd, argv.., env.. each u32 len + bytes).
pub fn spawn(parent: &Process, req: &[u8], out_fds: &mut [i32; 3]) -> R<u32> {
    let mut off = 0;
    let _flags = rd_u32(req, &mut off)?;
    let mut stdio = [(0u32, 0u32); 3];
    for s in stdio.iter_mut() {
        *s = (rd_u32(req, &mut off)?, rd_u32(req, &mut off)?);
    }
    let info = &req[off..];
    let mut io = 0;
    let _argc = rd_u32(info, &mut io)?;
    let _envc = rd_u32(info, &mut io)?;
    let _exec = rd_bytes(info, &mut io)?;
    let cwd = rd_bytes(info, &mut io)?;
    let cwd = if cwd.is_empty() { parent.st.lock().cwd.clone() } else { cwd.to_vec() };

    let mut child_fds: Vec<Option<Arc<OpenFile>>> = Vec::with_capacity(3);
    let mut parent_ends: [Option<Arc<OpenFile>>; 3] = [None, None, None];
    for (i, (mode, arg)) in stdio.iter().enumerate() {
        let f = match *mode {
            STDIO_PIPE => {
                let (r, w) = fd::pipe();
                if i == 0 {
                    parent_ends[i] = Some(w);
                    r
                } else {
                    parent_ends[i] = Some(r);
                    w
                }
            }
            STDIO_NULL => fd::file(OfKind::Null, 0, b""),
            STDIO_FD => parent.fd(*arg as i32)?,
            _ => parent.fd(i as i32).unwrap_or_else(|_| fd::file(OfKind::Null, 0, b"")),
        };
        child_fds.push(Some(f));
    }
    let child = Process::new(parent.pid, cwd, child_fds, info.to_vec(), ST_STARTING);
    for (i, e) in parent_ends.into_iter().enumerate() {
        out_fds[i] = match e {
            Some(f) => parent.install(f),
            None => -1,
        };
    }
    supervisor_request(Work::Spawn { pid: child.pid });
    Ok(child.pid)
}

/// Record that a process is gone: close its files, publish the status, wake
/// the parent. `status` is exit code, or 128 + signal for a kill.
pub fn finish(p: &Arc<Process>, status: i32) {
    if p.state.swap(ST_EXITED, SeqCst) == ST_EXITED {
        return;
    }
    let fds = core::mem::take(&mut p.st.lock().fds);
    for (i, f) in fds.iter().enumerate() {
        if let Some(f) = f {
            f.unsubscribe(p.pid, i as u32, true);
        }
    }
    drop(fds);
    crate::vfs::watch_remove_all(p.pid);
    p.status.store(status, SeqCst);
    p.exit_wq.wake_all();
    match get(p.ppid) {
        Ok(parent) if parent.state.load(SeqCst) != ST_EXITED => parent.post(TOKEN_CHILD | p.pid, status as u32),
        _ => {
            // Nobody will wait for it.
            PROCS.write().remove(&p.pid);
        }
    }
    // Children of the dead process are reparented to nobody; reap the dead ones.
    let orphans: Vec<u32> =
        PROCS.read().values().filter(|c| c.ppid == p.pid && c.state.load(SeqCst) == ST_EXITED).map(|c| c.pid).collect();
    if !orphans.is_empty() {
        let mut t = PROCS.write();
        for o in orphans {
            t.remove(&o);
        }
    }
    supervisor_request(Work::Exit { pid: p.pid });
}

/// Wait for a child. Returns its status and removes it from the table.
pub fn waitpid(parent: &Process, pid: u32, nohang: bool) -> R<i32> {
    let c = get(pid)?;
    if c.ppid != parent.pid {
        return Err(ECHILD);
    }
    loop {
        let seq = c.exit_wq.seq();
        if c.state.load(SeqCst) == ST_EXITED {
            PROCS.write().remove(&pid);
            return Ok(c.status.load(SeqCst));
        }
        if nohang || !thread::can_block() {
            return Err(EAGAIN);
        }
        c.exit_wq.wait(seq, -1.0);
    }
}

pub fn kill(pid: u32, sig: u32) -> R<()> {
    let p = get(pid)?;
    if p.state.load(SeqCst) == ST_EXITED {
        return Err(ESRCH);
    }
    if sig == 0 {
        return Ok(());
    }
    if sig == SIGKILL {
        supervisor_request(Work::Kill { pid, sig });
        return Ok(());
    }
    p.sig.fetch_or(1 << (sig & 31), SeqCst);
    p.post(TOKEN_SIGNAL, 1 << (sig & 31));
    Ok(())
}

pub fn list(out: &mut [u32]) -> usize {
    let t = PROCS.read();
    let mut n = 0;
    for p in t.values() {
        if n + 4 <= out.len() {
            out[n] = p.pid;
            out[n + 1] = p.ppid;
            out[n + 2] = p.state.load(SeqCst);
            out[n + 3] = p.status.load(SeqCst) as u32;
            n += 4;
        }
    }
    n / 4
}

// ---- supervisor work queue ----

#[derive(Clone, Copy, PartialEq)]
pub enum Work {
    Spawn { pid: u32 },
    Kill { pid: u32, sig: u32 },
    Exit { pid: u32 },
    Fault { image: u32, chunk: u32 },
    Flush,
}

static SUP: Mutex<VecDeque<Work>> = Mutex::new(VecDeque::new());

/// The supervisor's wake word (`Atomics.waitAsync` in kerneld).
#[no_mangle]
pub static BAT_KERNELD_WORD: AtomicU32 = AtomicU32::new(0);

pub fn supervisor_request(w: Work) {
    {
        let mut q = SUP.lock();
        if matches!(w, Work::Flush | Work::Fault { .. }) && q.contains(&w) {
            return;
        }
        q.push_back(w);
    }
    BAT_KERNELD_WORD.fetch_add(1, SeqCst);
    sys::notify(BAT_KERNELD_WORD.as_ptr(), u32::MAX);
}
pub fn supervisor_next() -> Option<Work> {
    SUP.lock().pop_front()
}
