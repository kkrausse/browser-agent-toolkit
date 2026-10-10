//! The C-ABI export surface. Every function is documented in
//! docs/design/kernel-abi.md; keep the two in step.
//!
//! Conventions: pointers are offsets in the shared memory; strings are
//! (ptr, len) UTF-8 without terminator; results are `>= 0` on success and
//! `-errno` on failure; 64-bit quantities cross as f64.

use crate::errno::*;
use crate::fd::{self, OfKind};
use crate::image::ImageMount;
use crate::path::PathBuf;
use crate::proc::{self, Work};
use crate::vfs::{self, Stat};
use crate::{persist, sys};
use core::sync::atomic::{AtomicU32, Ordering::*};

pub const ABI_VERSION: u32 = 1;

#[inline]
fn ret(r: R<i32>) -> i32 {
    match r {
        Ok(v) => v,
        Err(e) => -e,
    }
}
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
/// Normalize a caller path against the process's working directory. An
/// absolute path that is already normalized (the common case) is used in
/// place, without a copy.
#[inline]
unsafe fn abs<'a>(p: *const u8, n: usize, out: &'a mut PathBuf) -> R<&'a [u8]> {
    let s: &'a [u8] = sl(p, n);
    if crate::path::is_normalized(s) {
        return Ok(s);
    }
    if s.first() != Some(&b'/') {
        if s.is_empty() {
            return Err(ENOENT);
        }
        let pr = proc::cur()?;
        let st = pr.st.lock();
        out.set(&st.cwd)?;
    }
    out.join(s)?;
    Ok(out.as_bytes())
}
fn copy_out(src: &[u8], buf: *mut u8, cap: usize) -> R<i32> {
    if src.len() > cap {
        return Err(ERANGE);
    }
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), buf, src.len()) };
    Ok(src.len() as i32)
}

#[no_mangle]
pub extern "C" fn bat_abi_version() -> u32 {
    ABI_VERSION
}
#[no_mangle]
pub extern "C" fn bat_alloc(size: usize) -> *mut u8 {
    unsafe { std::alloc::alloc(std::alloc::Layout::from_size_align_unchecked(size.max(1), 16)) }
}
#[no_mangle]
pub unsafe extern "C" fn bat_free(p: *mut u8, size: usize) {
    if !p.is_null() {
        std::alloc::dealloc(p, std::alloc::Layout::from_size_align_unchecked(size.max(1), 16))
    }
}

// ---- paths ----

#[no_mangle]
pub unsafe extern "C" fn bat_stat(p: *const u8, n: usize, flags: u32, out: *mut Stat) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::stat(pp, flags & 1 == 0, &mut *out)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_readlink(p: *const u8, n: usize, buf: *mut u8, cap: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::readlink(pp, slm(buf, cap))).map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_realpath(p: *const u8, n: usize, buf: *mut u8, cap: usize) -> i32 {
    let mut pb = PathBuf::new();
    let mut out = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::realpath(pp, &mut out)).and_then(|_| copy_out(out.as_bytes(), buf, cap)))
}
/// On ERANGE the needed size is stored in the first 4 bytes of `buf`.
#[no_mangle]
pub unsafe extern "C" fn bat_readdir(p: *const u8, n: usize, buf: *mut u8, cap: usize) -> i32 {
    let mut pb = PathBuf::new();
    let mut needed = 0usize;
    let r = abs(p, n, &mut pb).and_then(|pp| vfs::readdir(pp, slm(buf, cap), &mut needed));
    if r == Err(ERANGE) && cap >= 4 {
        (buf as *mut u32).write_unaligned(needed as u32);
    }
    ret(r.map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_read_file(p: *const u8, n: usize, flags: u32, buf: *mut u8, cap: usize, st: *mut Stat) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::read_file(pp, flags, slm(buf, cap), &mut *st)).map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_write_file(p: *const u8, n: usize, data: *const u8, len: usize, mode: u32, flags: u32) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::write_file(pp, sl(data, len), mode, flags)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_mkdir(p: *const u8, n: usize, mode: u32, recursive: u32) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::mkdir(pp, mode, recursive != 0)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_rmdir(p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::rmdir(pp)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_unlink(p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::unlink(pp)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_rename(p: *const u8, n: usize, q: *const u8, m: usize) -> i32 {
    let mut a = PathBuf::new();
    let mut b = PathBuf::new();
    ret(abs(p, n, &mut a).and_then(|x| abs(q, m, &mut b).and_then(|y| vfs::rename(x, y))).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_symlink(t: *const u8, tn: usize, p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::symlink(sl(t, tn), pp)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_link(p: *const u8, n: usize, q: *const u8, m: usize) -> i32 {
    let mut a = PathBuf::new();
    let mut b = PathBuf::new();
    ret(abs(p, n, &mut a).and_then(|x| abs(q, m, &mut b).and_then(|y| vfs::link(x, y))).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_chmod(p: *const u8, n: usize, mode: u32, flags: u32) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::set_meta(pp, flags & 1 == 0, Some(mode), None)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_utimes(p: *const u8, n: usize, mtime_ms: f64, flags: u32) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::set_meta(pp, flags & 1 == 0, None, Some(mtime_ms))).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_truncate(p: *const u8, n: usize, size: f64) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::truncate(pp, size as u64)).map(|_| 0))
}

// ---- file descriptors ----

#[no_mangle]
pub unsafe extern "C" fn bat_open(p: *const u8, n: usize, flags: u32, mode: u32) -> i32 {
    let mut pb = PathBuf::new();
    let mut canon = PathBuf::new();
    ret((|| {
        let pr = proc::cur()?;
        let pp = abs(p, n, &mut pb)?;
        let kind = match vfs::open(pp, flags, mode, &mut canon)? {
            vfs::Opened::Ov { ino } => OfKind::Ov { ino },
            vfs::Opened::Img { m, idx, off, len } => OfKind::Img { m, idx, off, len },
            vfs::Opened::Dir => OfKind::Dir,
        };
        Ok(pr.install(fd::file(kind, flags, canon.as_bytes())))
    })())
}
#[no_mangle]
pub extern "C" fn bat_close(fd: i32) -> i32 {
    ret(proc::cur().and_then(|p| p.close(fd)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_read(fd: i32, buf: *mut u8, len: usize) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.read(slm(buf, len), None)).map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_pread(fd: i32, buf: *mut u8, len: usize, pos: f64) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.read(slm(buf, len), Some(pos as u64))).map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_write(fd: i32, buf: *const u8, len: usize) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.write(sl(buf, len), None)).map(|n| n as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_pwrite(fd: i32, buf: *const u8, len: usize, pos: f64) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.write(sl(buf, len), Some(pos as u64))).map(|n| n as i32))
}
/// whence: 0 set, 1 cur, 2 end. Returns the new position, or -errno.
#[no_mangle]
pub extern "C" fn bat_seek(fd: i32, off: f64, whence: u32) -> f64 {
    let r = (|| {
        let f = proc::cur()?.fd(fd)?;
        if !matches!(f.kind, OfKind::Ov { .. } | OfKind::Img { .. }) {
            return Err(ESPIPE);
        }
        let base = match whence {
            0 => 0.0,
            1 => f.pos.load(Relaxed) as f64,
            2 => f.size()? as f64,
            _ => return Err(EINVAL),
        };
        let np = base + off;
        if np < 0.0 {
            return Err(EINVAL);
        }
        f.pos.store(np as u64, Relaxed);
        Ok(np)
    })();
    match r {
        Ok(v) => v,
        Err(e) => -(e as f64),
    }
}
#[no_mangle]
pub unsafe extern "C" fn bat_fstat(fd: i32, out: *mut Stat) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.stat(&mut *out)).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn bat_ftruncate(fd: i32, size: f64) -> i32 {
    ret((|| {
        let f = proc::cur()?.fd(fd)?;
        match &f.kind {
            OfKind::Ov { ino } => vfs::ov_truncate(*ino, size as u64, &f.path).map(|_| 0),
            _ => Err(EINVAL),
        }
    })())
}
/// mode < 0 leaves the mode alone; mtime_ms < 0 leaves the time alone.
#[no_mangle]
pub extern "C" fn bat_fsetmeta(fd: i32, mode: i32, mtime_ms: f64) -> i32 {
    ret((|| {
        let f = proc::cur()?.fd(fd)?;
        match &f.kind {
            OfKind::Ov { ino } => vfs::ov_set_meta(
                *ino,
                if mode < 0 { None } else { Some(mode as u32) },
                if mtime_ms < 0.0 { None } else { Some(mtime_ms) },
            )
            .map(|_| 0),
            OfKind::Img { .. } => Err(EROFS),
            _ => Err(EINVAL),
        }
    })())
}
#[no_mangle]
pub extern "C" fn bat_set_nonblock(fd: i32, on: u32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).map(|f| {
        if on != 0 {
            f.flags.fetch_or(vfs::O_NONBLOCK, SeqCst);
        } else {
            f.flags.fetch_and(!vfs::O_NONBLOCK, SeqCst);
        }
        0
    }))
}
#[no_mangle]
pub extern "C" fn bat_dup(fd: i32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd).map(|f| p.install(f))))
}
#[no_mangle]
pub unsafe extern "C" fn bat_fd_path(fd: i32, buf: *mut u8, cap: usize) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| copy_out(&f.path, buf, cap)))
}
/// out[0] = read end, out[1] = write end.
#[no_mangle]
pub unsafe extern "C" fn bat_pipe(out: *mut i32) -> i32 {
    ret(proc::cur().map(|p| {
        let (r, w) = fd::pipe();
        *out = p.install(r);
        *out.add(1) = p.install(w);
        0
    }))
}

// ---- sockets ----

#[no_mangle]
pub extern "C" fn bat_listen(port: u32) -> i32 {
    ret(proc::cur().and_then(|p| fd::listen(port).map(|f| p.install(f))))
}
#[no_mangle]
pub extern "C" fn bat_connect(port: u32) -> i32 {
    ret(proc::cur().and_then(|p| fd::connect(port).map(|f| p.install(f))))
}
#[no_mangle]
pub extern "C" fn bat_accept(fd: i32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd).and_then(|l| l.accept()).map(|f| p.install(f))))
}
/// Half-close: no more writes from this end; the peer reads EOF.
#[no_mangle]
pub extern "C" fn bat_shutdown(fd: i32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).and_then(|f| f.shutdown_write()).map(|_| 0))
}
/// out[0] = local port, out[1] = peer port.
#[no_mangle]
pub unsafe extern "C" fn bat_sock_ports(fd: i32, out: *mut u32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).map(|f| {
        let (a, b) = f.ports();
        *out = a;
        *out.add(1) = b;
        0
    }))
}
#[no_mangle]
pub unsafe extern "C" fn bat_socketpair(out: *mut i32) -> i32 {
    ret(proc::cur().map(|p| {
        let (a, b) = fd::socketpair();
        *out = p.install(a);
        *out.add(1) = p.install(b);
        0
    }))
}

// ---- readiness ----

#[no_mangle]
pub extern "C" fn bat_fd_subscribe(fd: i32, mask: u32) -> i32 {
    ret((|| {
        let p = proc::cur_arc()?;
        let f = p.fd(fd)?;
        f.unsubscribe(p.pid, fd as u32, true);
        if mask != 0 {
            f.subscribe(&p, fd as u32, mask, true);
            // Level check so a subscriber never misses what is already there.
            let now = f.poll_state() & mask;
            if now != 0 {
                p.post(fd as u32, now);
            }
        }
        Ok(0)
    })())
}
#[no_mangle]
pub extern "C" fn bat_fd_poll(fd: i32) -> i32 {
    ret(proc::cur().and_then(|p| p.fd(fd)).map(|f| f.poll_state() as i32))
}
#[repr(C)]
pub struct PollFd {
    fd: i32,
    events: u32,
    revents: u32,
}
/// Blocking poll. timeout_ms < 0 waits forever; 0 never blocks. On a thread
/// that cannot block it behaves as timeout 0.
#[no_mangle]
pub unsafe extern "C" fn bat_poll(fds: *mut PollFd, n: usize, timeout_ms: f64) -> i32 {
    ret((|| {
        let p = proc::cur_arc()?;
        let fds = core::slice::from_raw_parts_mut(fds, n);
        let mut files = Vec::with_capacity(n);
        for pf in fds.iter() {
            files.push(p.fd(pf.fd).ok());
        }
        let deadline = if timeout_ms < 0.0 { f64::INFINITY } else { sys::now_ms() + timeout_ms };
        let mut subscribed = false;
        let count = loop {
            let seq = p.event.load(SeqCst);
            let mut count = 0;
            for (pf, f) in fds.iter_mut().zip(&files) {
                pf.revents = match f {
                    Some(f) => f.poll_state() & (pf.events | fd::POLLERR | fd::POLLHUP),
                    None => 32, // POLLNVAL
                };
                if pf.revents != 0 {
                    count += 1;
                }
            }
            if count > 0 || timeout_ms == 0.0 || !crate::thread::can_block() {
                break count;
            }
            if !subscribed {
                subscribed = true;
                for (pf, f) in fds.iter().zip(&files) {
                    if let Some(f) = f {
                        f.subscribe(&p, pf.fd as u32, pf.events | fd::POLLERR | fd::POLLHUP, false);
                    }
                }
                continue; // re-check after subscribing
            }
            let left = deadline - sys::now_ms();
            if left <= 0.0 {
                break 0;
            }
            sys::wait(p.event.as_ptr(), seq, if left.is_finite() { left } else { -1.0 });
        };
        if subscribed {
            for (pf, f) in fds.iter().zip(&files) {
                if let Some(f) = f {
                    f.unsubscribe(p.pid, pf.fd as u32, false);
                }
            }
        }
        Ok(count)
    })())
}
/// Address of the calling process's event word.
#[no_mangle]
pub extern "C" fn bat_event_word() -> u32 {
    proc::cur().map(|p| p.event.as_ptr() as u32).unwrap_or(0)
}
/// Fill `buf` with up to `cap_pairs` (token u32, mask u32) pairs.
#[no_mangle]
pub unsafe extern "C" fn bat_events_take(buf: *mut u32, cap_pairs: usize) -> i32 {
    ret(proc::cur().map(|p| p.take_events(core::slice::from_raw_parts_mut(buf, cap_pairs * 2)) as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_watch_add(p: *const u8, n: usize, recursive: u32) -> i32 {
    let mut pb = PathBuf::new();
    ret((|| {
        let pp = abs(p, n, &mut pb)?;
        vfs::watch_add(proc::cur_arc()?, pp, recursive != 0).map(|id| id as i32)
    })())
}
#[no_mangle]
pub extern "C" fn bat_watch_remove(id: u32) -> i32 {
    ret(proc::cur().map(|p| {
        vfs::watch_remove(p.pid, id);
        0
    }))
}
/// Drain watch records (id u32, kind u32, len u16, relative path).
#[no_mangle]
pub unsafe extern "C" fn bat_watch_read(buf: *mut u8, cap: usize) -> i32 {
    ret(proc::cur().map(|p| p.take_watch(slm(buf, cap)) as i32))
}

// ---- processes ----

#[no_mangle]
pub extern "C" fn bat_host_proc_new() -> i32 {
    let p = proc::new_host();
    ret(proc::attach(p.pid).map(|_| p.pid as i32))
}
#[no_mangle]
pub extern "C" fn bat_proc_attach(pid: u32) -> i32 {
    ret(proc::attach(pid).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn bat_getpid() -> i32 {
    ret(proc::cur().map(|p| p.pid as i32))
}
#[no_mangle]
pub extern "C" fn bat_getppid() -> i32 {
    ret(proc::cur().map(|p| p.ppid as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_chdir(p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    let mut canon = PathBuf::new();
    ret((|| {
        let pp = abs(p, n, &mut pb)?;
        let mut st = Stat::default();
        vfs::stat(pp, true, &mut st)?;
        if st.kind != vfs::K_DIR {
            return Err(ENOTDIR);
        }
        vfs::realpath(pp, &mut canon)?;
        let pr = proc::cur()?;
        let c = canon.as_bytes();
        pr.st.lock().cwd = if c == b"/" { Vec::new() } else { c.to_vec() };
        Ok(0)
    })())
}
#[no_mangle]
pub unsafe extern "C" fn bat_getcwd(buf: *mut u8, cap: usize) -> i32 {
    ret(proc::cur().and_then(|p| {
        let st = p.st.lock();
        if st.cwd.is_empty() {
            copy_out(b"/", buf, cap)
        } else {
            copy_out(&st.cwd, buf, cap)
        }
    }))
}
/// Returns the child's pid; out_fds[0..3] receive the parent's pipe ends (or -1).
#[no_mangle]
pub unsafe extern "C" fn bat_spawn(req: *const u8, len: usize, out_fds: *mut i32) -> i32 {
    ret(proc::cur().and_then(|p| proc::spawn(p, sl(req, len), &mut *(out_fds as *mut [i32; 3]))).map(|pid| pid as i32))
}
#[no_mangle]
pub unsafe extern "C" fn bat_proc_info(pid: u32, buf: *mut u8, cap: usize) -> i32 {
    ret(proc::get(pid).and_then(|p| {
        let st = p.st.lock();
        if st.info.len() > cap && cap >= 4 {
            (buf as *mut u32).write_unaligned(st.info.len() as u32);
        }
        copy_out(&st.info, buf, cap)
    }))
}
#[no_mangle]
pub extern "C" fn bat_proc_exit(code: i32) -> i32 {
    ret(proc::cur_arc().map(|p| {
        proc::finish(&p, code & 0xff);
        0
    }))
}
/// flags bit 0: do not block. Returns the exit status (0..255, or 128+signal).
#[no_mangle]
pub extern "C" fn bat_waitpid(pid: u32, flags: u32) -> i32 {
    ret(proc::cur().and_then(|p| proc::waitpid(p, pid, flags & 1 != 0)))
}
#[no_mangle]
pub extern "C" fn bat_kill(pid: u32, sig: u32) -> i32 {
    ret(proc::kill(pid, sig).map(|_| 0))
}
/// Take (and clear) the calling process's pending signal mask.
#[no_mangle]
pub extern "C" fn bat_sig_take() -> u32 {
    proc::cur().map(|p| p.sig.swap(0, SeqCst)).unwrap_or(0)
}
/// Records of 4 u32: pid, ppid, state, status. Returns the record count.
#[no_mangle]
pub unsafe extern "C" fn bat_proc_list(buf: *mut u32, cap_records: usize) -> i32 {
    proc::list(core::slice::from_raw_parts_mut(buf, cap_records * 4)) as i32
}

// ---- supervisor ----

/// Next unit of supervisor work. Returns 0 when idle, else the kind:
/// 1 spawn(pid) 2 kill(pid, sig) 3 exited(pid) 4 fault(image, chunk) 5 flush.
#[no_mangle]
pub unsafe extern "C" fn bat_kerneld_next(out: *mut u32) -> u32 {
    match proc::supervisor_next() {
        None => 0,
        Some(Work::Spawn { pid }) => {
            *out = pid;
            1
        }
        Some(Work::Kill { pid, sig }) => {
            *out = pid;
            *out.add(1) = sig;
            2
        }
        Some(Work::Exit { pid }) => {
            *out = pid;
            3
        }
        Some(Work::Fault { image, chunk }) => {
            *out = image;
            *out.add(1) = chunk;
            4
        }
        Some(Work::Flush) => 5,
    }
}
#[no_mangle]
pub extern "C" fn bat_proc_mark_exited(pid: u32, status: i32) -> i32 {
    ret(proc::get(pid).map(|p| {
        proc::finish(&p, status);
        0
    }))
}
/// Thread record of the worker attached to `pid` (0 if none yet).
#[no_mangle]
pub extern "C" fn bat_proc_thread(pid: u32) -> u32 {
    proc::get(pid).map(|p| p.thread.load(SeqCst) as u32).unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn bat_image_fault(image: u32, chunk: u32) -> i32 {
    let m = {
        let v = vfs::VFS.read();
        v.images.get(image as usize).copied().flatten()
    };
    let r = match m {
        Some(m) => m.load(chunk as usize).map(|_| 0),
        None => Err(EINVAL),
    };
    crate::image::BAT_FAULT_WORD.fetch_add(1, SeqCst);
    sys::notify(crate::image::BAT_FAULT_WORD.as_ptr(), u32::MAX);
    ret(r)
}

// ---- images ----

static NEXT_IMAGE: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn bat_image_reserve() -> u32 {
    NEXT_IMAGE.fetch_add(1, SeqCst)
}
/// Read the image head through the calling thread's handle for `id` and
/// attach it at `path`.
#[no_mangle]
pub unsafe extern "C" fn bat_image_mount(id: u32, name: *const u8, nlen: usize, p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret((|| {
        let pp = abs(p, n, &mut pb)?;
        let m = ImageMount::open(id, sl(name, nlen))?;
        vfs::mount(m, pp)?;
        Ok(m.image.len() as i32)
    })())
}
#[no_mangle]
pub extern "C" fn bat_image_count() -> u32 {
    NEXT_IMAGE.load(SeqCst)
}
/// Name of image `id`; ENOENT if the id is reserved but not mounted.
#[no_mangle]
pub unsafe extern "C" fn bat_image_name(id: u32, buf: *mut u8, cap: usize) -> i32 {
    let v = vfs::VFS.read();
    ret(v.images.get(id as usize).copied().flatten().ok_or(ENOENT).and_then(|m| copy_out(&m.name, buf, cap)))
}
/// out: entries f64, file_len f64, cached_bytes f64, host_reads f64.
#[no_mangle]
pub unsafe extern "C" fn bat_image_stats(id: u32, out: *mut f64) -> i32 {
    let v = vfs::VFS.read();
    ret(v.images.get(id as usize).copied().flatten().ok_or(ENOENT).map(|m| {
        *out = m.image.len() as f64;
        *out.add(1) = m.file_len as f64;
        *out.add(2) = m.cached_bytes.load(Relaxed) as f64;
        *out.add(3) = m.host_reads.load(Relaxed) as f64;
        0
    }))
}
/// In-head section payload of an image: out[0] = ptr, out[1] = len.
#[no_mangle]
pub unsafe extern "C" fn bat_image_section(id: u32, section: u32, out: *mut u32) -> i32 {
    let v = vfs::VFS.read();
    ret(v.images.get(id as usize).copied().flatten().ok_or(ENOENT).and_then(|m| {
        let b = m.image.section_bytes(section).ok_or(ENOENT)?;
        *out = b.as_ptr() as u32;
        *out.add(1) = b.len() as u32;
        Ok(0)
    }))
}

// ---- persistence ----

#[no_mangle]
pub unsafe extern "C" fn bat_persist_exclude(p: *const u8, n: usize) -> i32 {
    let mut pb = PathBuf::new();
    ret(abs(p, n, &mut pb).and_then(|pp| vfs::persist_exclude(pp)).map(|_| 0))
}
#[no_mangle]
pub unsafe extern "C" fn bat_persist_replay(p: *const u8, n: usize) -> i32 {
    persist::replay(sl(p, n)) as i32
}
#[no_mangle]
pub extern "C" fn bat_persist_enable(seq: f64) {
    persist::enable(seq as u64)
}
#[repr(C)]
pub struct Blob {
    ptr: u32,
    len: u32,
    seq: f64,
}
unsafe fn give(v: Vec<u8>, seq: u64, out: *mut Blob) {
    let b = v.into_boxed_slice();
    (*out).len = b.len() as u32;
    (*out).seq = seq as f64;
    (*out).ptr = if b.is_empty() { 0 } else { Box::into_raw(b) as *mut u8 as u32 };
}
/// Detach pending journal bytes. Free with `bat_blob_free`.
#[no_mangle]
pub unsafe extern "C" fn bat_journal_take(out: *mut Blob) -> i32 {
    let (v, seq) = persist::take();
    give(v, seq, out);
    0
}
#[no_mangle]
pub unsafe extern "C" fn bat_persist_snapshot(out: *mut Blob) -> i32 {
    let (v, seq) = persist::snapshot();
    give(v, seq, out);
    0
}
#[no_mangle]
pub unsafe extern "C" fn bat_blob_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
#[no_mangle]
pub extern "C" fn bat_persist_set_durable(seq: f64) {
    persist::set_durable(seq as u64)
}
#[no_mangle]
pub extern "C" fn bat_persist_durable() -> f64 {
    persist::durable() as f64
}
#[no_mangle]
pub extern "C" fn bat_persist_pending() -> u32 {
    persist::pending_bytes() as u32
}
/// Ask the supervisor to drain the journal. Returns the sequence number to
/// wait for, or -1 if persistence is not enabled (nothing to wait for).
#[no_mangle]
pub extern "C" fn bat_flush_begin() -> f64 {
    if !persist::is_enabled() {
        return -1.0;
    }
    let seq = persist::current_seq();
    if persist::durable() < seq {
        proc::supervisor_request(Work::Flush);
    }
    seq as f64
}
/// Block until `seq` is durable. Workers only.
#[no_mangle]
pub extern "C" fn bat_flush_wait(seq: f64, timeout_ms: f64) -> i32 {
    if !crate::thread::can_block() {
        return if persist::durable() >= seq as u64 { 0 } else { -EAGAIN };
    }
    if persist::wait_durable(seq as u64, timeout_ms) {
        0
    } else {
        -ETIMEDOUT
    }
}
