//! The host calls the shell is written against. Every path is absolute.
//! Errors are positive Linux errno values.
//!
//! On wasm32 these are imports from module `sh`, which the runtime maps onto
//! the kernel binding of the process the shell runs in
//! (runtime/src/process/sh.ts). Natively they are std, so the same shell can be
//! run and compared with the machine's own sh.

pub type R<T> = Result<T, i32>;

pub const O_RDONLY: u32 = 0;
pub const O_WRONLY: u32 = 1;
pub const O_RDWR: u32 = 2;
pub const O_CREAT: u32 = 0o100;
pub const O_EXCL: u32 = 0o200;
pub const O_TRUNC: u32 = 0o1000;
pub const O_APPEND: u32 = 0o2000;

pub const K_FILE: u8 = 0;
pub const K_DIR: u8 = 1;
pub const K_SYMLINK: u8 = 2;

pub const ENOENT: i32 = 2;
pub const EEXIST: i32 = 17;
pub const EXDEV: i32 = 18;
pub const ENOTDIR: i32 = 20;
pub const EISDIR: i32 = 21;
pub const ENOTEMPTY: i32 = 39;

#[derive(Clone, Copy, Debug, Default)]
pub struct Stat {
    pub kind: u8,
    pub mode: u32,
    pub size: u64,
    pub mtime_ms: f64,
}
impl Stat {
    pub fn is_dir(&self) -> bool {
        self.kind == K_DIR
    }
    pub fn is_file(&self) -> bool {
        self.kind == K_FILE
    }
    pub fn is_symlink(&self) -> bool {
        self.kind == K_SYMLINK
    }
}

pub fn strerror(e: i32) -> &'static str {
    match e {
        1 => "Operation not permitted",
        2 => "No such file or directory",
        3 => "No such process",
        5 => "Input/output error",
        9 => "Bad file descriptor",
        10 => "No child processes",
        11 => "Resource temporarily unavailable",
        13 => "Permission denied",
        17 => "File exists",
        18 => "Invalid cross-device link",
        20 => "Not a directory",
        21 => "Is a directory",
        22 => "Invalid argument",
        30 => "Read-only file system",
        32 => "Broken pipe",
        36 => "File name too long",
        39 => "Directory not empty",
        40 => "Too many levels of symbolic links",
        _ => "Error",
    }
}

/// stdio slot of a child: a host descriptor, or nothing (reads end, writes vanish).
pub const FD_NULL: i32 = -1;

pub struct Spawn<'a> {
    /// What the runtime should run: `node`, a JavaScript file, or `/bin/sh`.
    pub exec: &'a str,
    pub argv: &'a [String],
    /// `NAME=value` strings.
    pub env: &'a [String],
    pub cwd: &'a str,
    pub stdio: [i32; 3],
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;

    #[link(wasm_import_module = "sh")]
    extern "C" {
        fn sh_open(p: *const u8, n: usize, flags: u32, mode: u32) -> i32;
        fn sh_close(fd: i32) -> i32;
        fn sh_read(fd: i32, p: *mut u8, n: usize) -> i32;
        fn sh_write(fd: i32, p: *const u8, n: usize) -> i32;
        fn sh_stat(p: *const u8, n: usize, follow: u32, out: *mut f64) -> i32;
        fn sh_readdir(p: *const u8, n: usize) -> i32;
        fn sh_readlink(p: *const u8, n: usize) -> i32;
        fn sh_realpath(p: *const u8, n: usize) -> i32;
        fn sh_take(p: *mut u8, cap: usize);
        fn sh_mkdir(p: *const u8, n: usize, mode: u32) -> i32;
        fn sh_rmdir(p: *const u8, n: usize) -> i32;
        fn sh_unlink(p: *const u8, n: usize) -> i32;
        fn sh_rename(p: *const u8, n: usize, q: *const u8, m: usize) -> i32;
        fn sh_symlink(p: *const u8, n: usize, q: *const u8, m: usize) -> i32;
        fn sh_chmod(p: *const u8, n: usize, mode: u32) -> i32;
        fn sh_utimes(p: *const u8, n: usize, ms: f64) -> i32;
        fn sh_pipe(out: *mut i32) -> i32;
        fn sh_spawn(p: *const u8, n: usize) -> i32;
        fn sh_wait(pid: u32) -> i32;
        fn sh_kill(pid: u32, sig: u32) -> i32;
        fn sh_now() -> f64;
        fn sh_sleep(ms: f64);
        fn sh_tz() -> i32;
        fn sh_pid() -> u32;
    }

    fn rc(v: i32) -> R<i32> {
        if v < 0 {
            Err(-v)
        } else {
            Ok(v)
        }
    }
    fn take(n: i32) -> Vec<u8> {
        let mut v = vec![0u8; n as usize];
        unsafe { sh_take(v.as_mut_ptr(), v.len()) };
        v
    }
    pub fn open(path: &str, flags: u32, mode: u32) -> R<i32> {
        rc(unsafe { sh_open(path.as_ptr(), path.len(), flags, mode) })
    }
    pub fn close(fd: i32) {
        unsafe { sh_close(fd) };
    }
    pub fn read(fd: i32, buf: &mut [u8]) -> R<usize> {
        rc(unsafe { sh_read(fd, buf.as_mut_ptr(), buf.len()) }).map(|n| n as usize)
    }
    pub fn write(fd: i32, buf: &[u8]) -> R<usize> {
        rc(unsafe { sh_write(fd, buf.as_ptr(), buf.len()) }).map(|n| n as usize)
    }
    pub fn stat(path: &str, follow: bool) -> R<Stat> {
        let mut out = [0f64; 4];
        rc(unsafe { sh_stat(path.as_ptr(), path.len(), follow as u32, out.as_mut_ptr()) })?;
        Ok(Stat { kind: out[0] as u8, mode: out[1] as u32, size: out[2] as u64, mtime_ms: out[3] })
    }
    pub fn readdir(path: &str) -> R<Vec<(String, u8)>> {
        let n = rc(unsafe { sh_readdir(path.as_ptr(), path.len()) })?;
        let bytes = take(n);
        let mut out = Vec::new();
        for rec in bytes.split(|b| *b == 0) {
            if rec.len() >= 2 {
                out.push((String::from_utf8_lossy(&rec[1..]).into_owned(), rec[0] - b'0'));
            }
        }
        Ok(out)
    }
    pub fn readlink(path: &str) -> R<String> {
        let n = rc(unsafe { sh_readlink(path.as_ptr(), path.len()) })?;
        Ok(String::from_utf8_lossy(&take(n)).into_owned())
    }
    pub fn realpath(path: &str) -> R<String> {
        let n = rc(unsafe { sh_realpath(path.as_ptr(), path.len()) })?;
        Ok(String::from_utf8_lossy(&take(n)).into_owned())
    }
    pub fn mkdir(path: &str, mode: u32) -> R<()> {
        rc(unsafe { sh_mkdir(path.as_ptr(), path.len(), mode) }).map(|_| ())
    }
    pub fn rmdir(path: &str) -> R<()> {
        rc(unsafe { sh_rmdir(path.as_ptr(), path.len()) }).map(|_| ())
    }
    pub fn unlink(path: &str) -> R<()> {
        rc(unsafe { sh_unlink(path.as_ptr(), path.len()) }).map(|_| ())
    }
    pub fn rename(from: &str, to: &str) -> R<()> {
        rc(unsafe { sh_rename(from.as_ptr(), from.len(), to.as_ptr(), to.len()) }).map(|_| ())
    }
    pub fn symlink(target: &str, path: &str) -> R<()> {
        rc(unsafe { sh_symlink(target.as_ptr(), target.len(), path.as_ptr(), path.len()) }).map(|_| ())
    }
    pub fn chmod(path: &str, mode: u32) -> R<()> {
        rc(unsafe { sh_chmod(path.as_ptr(), path.len(), mode) }).map(|_| ())
    }
    pub fn utimes(path: &str, ms: f64) -> R<()> {
        rc(unsafe { sh_utimes(path.as_ptr(), path.len(), ms) }).map(|_| ())
    }
    pub fn pipe() -> R<(i32, i32)> {
        let mut out = [0i32; 2];
        rc(unsafe { sh_pipe(out.as_mut_ptr()) })?;
        Ok((out[0], out[1]))
    }
    pub fn spawn(s: &Spawn) -> R<u32> {
        // u32 stdio x3, u32 argc, u32 envc, then exec, cwd, argv.., env.. each u32 length + bytes.
        let mut b = Vec::new();
        for fd in s.stdio {
            b.extend_from_slice(&fd.to_le_bytes());
        }
        b.extend_from_slice(&(s.argv.len() as u32).to_le_bytes());
        b.extend_from_slice(&(s.env.len() as u32).to_le_bytes());
        let mut put = |x: &str| {
            b.extend_from_slice(&(x.len() as u32).to_le_bytes());
            b.extend_from_slice(x.as_bytes());
        };
        put(s.exec);
        put(s.cwd);
        for a in s.argv {
            put(a);
        }
        for e in s.env {
            put(e);
        }
        rc(unsafe { sh_spawn(b.as_ptr(), b.len()) }).map(|p| p as u32)
    }
    pub fn wait(pid: u32) -> i32 {
        unsafe { sh_wait(pid) }
    }
    pub fn kill(pid: u32, sig: u32) {
        unsafe { sh_kill(pid, sig) };
    }
    pub fn now_ms() -> f64 {
        unsafe { sh_now() }
    }
    pub fn sleep_ms(ms: f64) {
        unsafe { sh_sleep(ms) }
    }
    pub fn tz_offset_min() -> i32 {
        unsafe { sh_tz() }
    }
    pub fn getpid() -> u32 {
        unsafe { sh_pid() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    //! std-backed host for the native comparison binary (Unix only).
    use super::*;
    use std::collections::HashMap;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::mem::ManuallyDrop;
    use std::os::fd::{BorrowedFd, FromRawFd, IntoRawFd};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;

    static CHILDREN: Mutex<Option<HashMap<u32, Child>>> = Mutex::new(None);

    fn e(err: std::io::Error) -> i32 {
        err.raw_os_error().unwrap_or(5)
    }
    fn f(fd: i32) -> ManuallyDrop<File> {
        ManuallyDrop::new(unsafe { File::from_raw_fd(fd) })
    }
    pub fn open(path: &str, flags: u32, mode: u32) -> R<i32> {
        let mut o = OpenOptions::new();
        match flags & 3 {
            O_WRONLY => o.write(true),
            O_RDWR => o.read(true).write(true),
            _ => o.read(true),
        };
        if flags & O_CREAT != 0 {
            o.create(true);
        }
        if flags & O_EXCL != 0 {
            o.create_new(true);
        }
        if flags & O_TRUNC != 0 {
            o.truncate(true);
        }
        if flags & O_APPEND != 0 {
            o.append(true);
        }
        o.mode(mode);
        o.open(path).map(|f| f.into_raw_fd()).map_err(e)
    }
    pub fn close(fd: i32) {
        drop(unsafe { File::from_raw_fd(fd) });
    }
    pub fn read(fd: i32, buf: &mut [u8]) -> R<usize> {
        f(fd).read(buf).map_err(e)
    }
    pub fn write(fd: i32, buf: &[u8]) -> R<usize> {
        f(fd).write(buf).map_err(e)
    }
    pub fn stat(path: &str, follow: bool) -> R<Stat> {
        let m = if follow { fs::metadata(path) } else { fs::symlink_metadata(path) }.map_err(e)?;
        let kind = if m.is_dir() {
            K_DIR
        } else if m.file_type().is_symlink() {
            K_SYMLINK
        } else {
            K_FILE
        };
        Ok(Stat { kind, mode: m.mode() & 0o7777, size: m.len(), mtime_ms: m.mtime() as f64 * 1000.0 })
    }
    pub fn readdir(path: &str) -> R<Vec<(String, u8)>> {
        let mut out = Vec::new();
        for ent in fs::read_dir(path).map_err(e)? {
            let ent = ent.map_err(e)?;
            let t = ent.file_type().map_err(e)?;
            let kind = if t.is_dir() {
                K_DIR
            } else if t.is_symlink() {
                K_SYMLINK
            } else {
                K_FILE
            };
            out.push((ent.file_name().to_string_lossy().into_owned(), kind));
        }
        Ok(out)
    }
    pub fn readlink(path: &str) -> R<String> {
        fs::read_link(path).map(|p| p.to_string_lossy().into_owned()).map_err(e)
    }
    pub fn realpath(path: &str) -> R<String> {
        fs::canonicalize(path).map(|p| p.to_string_lossy().into_owned()).map_err(e)
    }
    pub fn mkdir(path: &str, _mode: u32) -> R<()> {
        fs::create_dir(path).map_err(e)
    }
    pub fn rmdir(path: &str) -> R<()> {
        fs::remove_dir(path).map_err(e)
    }
    pub fn unlink(path: &str) -> R<()> {
        fs::remove_file(path).map_err(e)
    }
    pub fn rename(from: &str, to: &str) -> R<()> {
        fs::rename(from, to).map_err(e)
    }
    pub fn symlink(target: &str, path: &str) -> R<()> {
        std::os::unix::fs::symlink(target, path).map_err(e)
    }
    pub fn chmod(path: &str, mode: u32) -> R<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(e)
    }
    pub fn utimes(path: &str, ms: f64) -> R<()> {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
        File::options().write(true).open(path).and_then(|f| f.set_modified(t)).map_err(e)
    }
    pub fn pipe() -> R<(i32, i32)> {
        let (r, w) = std::io::pipe().map_err(e)?;
        Ok((r.into_raw_fd(), w.into_raw_fd()))
    }
    pub fn spawn(s: &Spawn) -> R<u32> {
        // The native host runs real programs: `node` by name, anything else by path.
        let mut c = if s.exec == "node" {
            let mut c = Command::new("node");
            c.args(&s.argv[1..]);
            c
        } else if s.exec == "/bin/sh" {
            let mut c = Command::new(std::env::current_exe().map_err(e)?);
            c.args(&s.argv[1..]);
            c
        } else {
            let mut c = Command::new(s.exec);
            c.args(&s.argv[1..]);
            c
        };
        c.env_clear();
        for kv in s.env {
            if let Some((k, v)) = kv.split_once('=') {
                c.env(k, v);
            }
        }
        c.current_dir(s.cwd);
        let io = |fd: i32| -> Stdio {
            if fd < 0 {
                Stdio::null()
            } else {
                match unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned() {
                    Ok(o) => Stdio::from(o),
                    Err(_) => Stdio::null(),
                }
            }
        };
        c.stdin(io(s.stdio[0])).stdout(io(s.stdio[1])).stderr(io(s.stdio[2]));
        let child = c.spawn().map_err(e)?;
        let pid = child.id();
        CHILDREN.lock().unwrap().get_or_insert_with(HashMap::new).insert(pid, child);
        Ok(pid)
    }
    pub fn wait(pid: u32) -> i32 {
        let child = CHILDREN.lock().unwrap().as_mut().and_then(|m| m.remove(&pid));
        match child {
            Some(mut c) => match c.wait() {
                Ok(st) => {
                    use std::os::unix::process::ExitStatusExt;
                    st.code().unwrap_or_else(|| 128 + st.signal().unwrap_or(0))
                }
                Err(_) => 127,
            },
            None => 127,
        }
    }
    pub fn kill(pid: u32, _sig: u32) {
        if let Some(c) = CHILDREN.lock().unwrap().as_mut().and_then(|m| m.get_mut(&pid)) {
            let _ = c.kill();
        }
    }
    pub fn now_ms() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
    }
    pub fn sleep_ms(ms: f64) {
        std::thread::sleep(std::time::Duration::from_secs_f64(ms.max(0.0) / 1000.0));
    }
    pub fn tz_offset_min() -> i32 {
        0
    }
    pub fn getpid() -> u32 {
        std::process::id()
    }
}

pub use imp::*;

/// Read a whole file.
pub fn read_file(path: &str) -> R<Vec<u8>> {
    let st = stat(path, true)?;
    if st.is_dir() {
        return Err(EISDIR);
    }
    let fd = open(path, O_RDONLY, 0)?;
    let r = read_fd_all(fd);
    close(fd);
    r
}

pub fn read_fd_all(fd: i32) -> R<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = read(fd, &mut buf)?;
        if n == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&buf[..n]);
    }
}

pub fn write_all(fd: i32, mut data: &[u8]) -> R<()> {
    while !data.is_empty() {
        let n = write(fd, data)?;
        if n == 0 {
            return Err(5);
        }
        data = &data[n..];
    }
    Ok(())
}

pub fn write_file(path: &str, data: &[u8], flags: u32, mode: u32) -> R<()> {
    let fd = open(path, O_WRONLY | O_CREAT | flags, mode)?;
    let r = write_all(fd, data);
    close(fd);
    r
}
