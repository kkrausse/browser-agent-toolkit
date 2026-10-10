//! Native smoke run of the kernel logic (the same code that runs in Wasm).
//! One test, because the kernel is one set of process-wide statics.

use bat_image::writer::Builder;
use bat_kernel::errno::*;
use bat_kernel::vfs::{self, Stat};
use bat_kernel::{abi, fd, persist, proc, sys, thread};
use std::sync::Arc;

fn attach() {
    let t = thread::bat_thread_alloc(1 << 16, 0, 16);
    thread::bat_thread_start(t, 1);
}

fn build_image() -> Arc<Vec<u8>> {
    let mut b = Builder::new();
    b.dir("pkg", 0o755).unwrap();
    let files = [
        ("pkg/index.js", b"module.exports = 1\n".to_vec()),
        ("pkg/package.json", b"{\"name\":\"pkg\"}".to_vec()),
        ("pkg/lib/deep/a.txt", vec![b'a'; 300_000]),
        (".store/real@1/node_modules/real/main.js", b"real".to_vec()),
    ];
    let ids: Vec<_> = files.iter().map(|(p, d)| b.file(p, 0o644, d.len() as u64).unwrap()).collect();
    b.symlink("real", ".store/real@1/node_modules/real").unwrap();
    let plan = b.plan().unwrap();
    let mut img = vec![0u8; plan.file_len as usize];
    img[..plan.head.len()].copy_from_slice(&plan.head);
    for (id, (_, d)) in ids.iter().zip(&files) {
        let e = plan.files[id.0].body;
        img[e.offset as usize..e.offset as usize + d.len()].copy_from_slice(d);
    }
    Arc::new(img)
}

fn st(p: &str) -> Result<Stat, i32> {
    let mut s = Stat::default();
    vfs::stat(p.as_bytes(), true, &mut s).map(|_| s)
}
fn read(p: &str) -> Result<Vec<u8>, i32> {
    let mut s = Stat::default();
    let mut buf = vec![0u8; 1 << 20];
    let n = vfs::read_file(p.as_bytes(), 0, &mut buf, &mut s)?;
    buf.truncate(n);
    Ok(buf)
}
fn ls(p: &str) -> Vec<String> {
    let mut buf = vec![0u8; 1 << 16];
    let mut needed = 0;
    let n = vfs::readdir(p.as_bytes(), &mut buf, &mut needed).unwrap();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let len = u16::from_le_bytes([buf[i + 1], buf[i + 2]]) as usize;
        out.push(format!("{}{}", String::from_utf8_lossy(&buf[i + 3..i + 3 + len]), if buf[i] == 1 { "/" } else { "" }));
        i += 3 + len;
    }
    out.sort();
    out
}

#[test]
fn kernel_smoke() {
    attach();
    bat_kernel::bat_kernel_init();
    let img = build_image();
    let img2 = img.clone();
    sys::set_image_reader(Box::new(move |_id, off, buf| {
        let off = off as usize;
        buf.copy_from_slice(&img2[off..off + buf.len()]);
        buf.len() as i32
    }));

    // overlay basics
    vfs::mkdir(b"/workspace/src", 0o755, true).unwrap();
    vfs::write_file(b"/workspace/src/a.ts", b"hello", 0o644, 0).unwrap();
    assert_eq!(read("/workspace/src/a.ts").unwrap(), b"hello");
    assert_eq!(st("/workspace/nope").err(), Some(ENOENT));
    assert_eq!(st("/workspace/src/a.ts/x").err(), Some(ENOTDIR));

    // image mount, merged view
    let id = abi::bat_image_reserve();
    let name = b"test.batimg";
    let mp = b"/workspace/node_modules";
    assert!(unsafe { abi::bat_image_mount(id, name.as_ptr(), name.len(), mp.as_ptr(), mp.len()) } > 0);
    assert_eq!(read("/workspace/node_modules/pkg/index.js").unwrap(), b"module.exports = 1\n");
    assert_eq!(read("/workspace/node_modules/pkg/lib/deep/a.txt").unwrap().len(), 300_000);
    // symlink with a relative target inside the image
    assert_eq!(read("/workspace/node_modules/real/main.js").unwrap(), b"real");
    let mut rp = bat_kernel::path::PathBuf::new();
    vfs::realpath(b"/workspace/node_modules/real/main.js", &mut rp).unwrap();
    assert_eq!(rp.as_bytes(), b"/workspace/node_modules/.store/real@1/node_modules/real/main.js");
    assert_eq!(ls("/workspace/node_modules"), [".store/", "pkg/", "real"]);

    // writes over the image: create beside, replace, delete, whiteout
    vfs::write_file(b"/workspace/node_modules/pkg/new.js", b"new", 0o644, 0).unwrap();
    vfs::write_file(b"/workspace/node_modules/pkg/index.js", b"patched", 0o644, 0).unwrap();
    assert_eq!(read("/workspace/node_modules/pkg/index.js").unwrap(), b"patched");
    assert_eq!(ls("/workspace/node_modules/pkg"), ["index.js", "lib/", "new.js", "package.json"]);
    vfs::unlink(b"/workspace/node_modules/pkg/package.json").unwrap();
    assert_eq!(st("/workspace/node_modules/pkg/package.json").err(), Some(ENOENT));
    assert_eq!(ls("/workspace/node_modules/pkg"), ["index.js", "lib/", "new.js"]);
    assert_eq!(vfs::rmdir(b"/workspace/node_modules/pkg/lib").err(), Some(ENOTEMPTY));
    assert_eq!(vfs::rename(b"/workspace/node_modules/pkg/lib", b"/workspace/lib2").err(), Some(EXDEV));
    // append to an image file copies it up
    vfs::write_file(b"/workspace/node_modules/.store/real@1/node_modules/real/main.js", b"+x", 0o644, vfs::WF_APPEND).unwrap();
    assert_eq!(read("/workspace/node_modules/real/main.js").unwrap(), b"real+x");
    // rename an image file out; the source name is whited out
    vfs::rename(b"/workspace/node_modules/pkg/lib/deep/a.txt", b"/workspace/a.txt").unwrap();
    assert_eq!(st("/workspace/a.txt").unwrap().size, 300_000.0);
    assert_eq!(st("/workspace/node_modules/pkg/lib/deep/a.txt").err(), Some(ENOENT));
    vfs::rmdir(b"/workspace/node_modules/pkg/lib/deep").unwrap();
    vfs::rmdir(b"/workspace/node_modules/pkg/lib").unwrap();
    // a directory recreated over a removed image directory starts empty
    vfs::mkdir(b"/workspace/node_modules/pkg/lib", 0o755, false).unwrap();
    assert!(ls("/workspace/node_modules/pkg/lib").is_empty());

    // overlay symlinks, rename, hard link, open/unlink
    vfs::symlink(b"src/a.ts", b"/workspace/link").unwrap();
    assert_eq!(read("/workspace/link").unwrap(), b"hello");
    vfs::rename(b"/workspace/src", b"/workspace/source").unwrap();
    assert_eq!(read("/workspace/link").err(), Some(ENOENT));
    vfs::link(b"/workspace/source/a.ts", b"/workspace/hard").unwrap();
    assert_eq!(st("/workspace/hard").unwrap().nlink, 2);

    // fds, pipes, sockets
    let me = proc::cur().unwrap();
    let p = b"/workspace/f.bin";
    let f = unsafe { abi::bat_open(p.as_ptr(), p.len(), vfs::O_CREAT | vfs::O_RDWR, 0o644) };
    assert!(f >= 3, "fd {f}");
    assert_eq!(unsafe { abi::bat_write(f, b"0123456789".as_ptr(), 10) }, 10);
    vfs::unlink(p).unwrap();
    let mut b4 = [0u8; 4];
    assert_eq!(unsafe { abi::bat_pread(f, b4.as_mut_ptr(), 4, 3.0) }, 4);
    assert_eq!(&b4, b"3456");
    assert_eq!(abi::bat_close(f), 0);

    let l = abi::bat_listen(5173);
    assert!(l >= 0);
    assert_eq!(abi::bat_listen(5173), -EADDRINUSE);
    assert_eq!(abi::bat_connect(1), -ECONNREFUSED);
    let c = abi::bat_connect(5173);
    let s = abi::bat_accept(l);
    assert!(c >= 0 && s >= 0);
    let server = std::thread::spawn(move || {
        attach();
        proc::attach(1).unwrap();
        let mut buf = [0u8; 64];
        let n = unsafe { abi::bat_read(s, buf.as_mut_ptr(), 64) }; // blocks
        assert_eq!(&buf[..n as usize], b"GET /");
        unsafe { abi::bat_write(s, b"200".as_ptr(), 3) };
        abi::bat_close(s);
    });
    std::thread::sleep(std::time::Duration::from_millis(30));
    unsafe { abi::bat_write(c, b"GET /".as_ptr(), 5) };
    let mut buf = [0u8; 64];
    assert_eq!(unsafe { abi::bat_read(c, buf.as_mut_ptr(), 64) }, 3);
    server.join().unwrap();
    assert_eq!(unsafe { abi::bat_read(c, buf.as_mut_ptr(), 64) }, 0, "EOF after peer close");
    abi::bat_close(c);
    abi::bat_close(l);
    assert_eq!(abi::bat_connect(5173), -ECONNREFUSED);

    // spawn bookkeeping: request, stdio pipe, exit, waitpid
    let mut req = Vec::new();
    let put = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
    put(&mut req, 0);
    for m in [proc::STDIO_NULL, proc::STDIO_PIPE, proc::STDIO_INHERIT] {
        put(&mut req, m);
        put(&mut req, 0);
    }
    put(&mut req, 1);
    put(&mut req, 0);
    for s in ["/bin/node", "/workspace", "node"] {
        put(&mut req, s.len() as u32);
        req.extend_from_slice(s.as_bytes());
    }
    let mut fds = [0i32; 3];
    let pid = unsafe { abi::bat_spawn(req.as_ptr(), req.len(), fds.as_mut_ptr()) };
    assert!(pid > 1 && fds[1] >= 0 && fds[0] == -1);
    let mut work = [0u32; 3];
    let mut saw_spawn = false;
    loop {
        match unsafe { abi::bat_kerneld_next(work.as_mut_ptr()) } {
            0 => break,
            1 if work[0] == pid as u32 => saw_spawn = true,
            _ => {}
        }
    }
    assert!(saw_spawn);
    let child = std::thread::spawn(move || {
        attach();
        proc::attach(pid as u32).unwrap();
        unsafe { abi::bat_write(1, b"out".as_ptr(), 3) };
        abi::bat_proc_exit(7);
    });
    assert_eq!(unsafe { abi::bat_read(fds[1], buf.as_mut_ptr(), 64) }, 3);
    assert_eq!(abi::bat_waitpid(pid as u32, 0), 7);
    child.join().unwrap();
    assert_eq!(unsafe { abi::bat_read(fds[1], buf.as_mut_ptr(), 64) }, 0);
    let _ = me;

    // watch
    let w = vfs::watch_add(proc::cur_arc().unwrap(), b"/workspace", true).unwrap();
    vfs::write_file(b"/workspace/source/a.ts", b"changed", 0o644, 0).unwrap();
    let mut wb = [0u8; 256];
    let n = proc::cur().unwrap().take_watch(&mut wb);
    assert!(n > 10);
    assert_eq!(u32::from_le_bytes(wb[..4].try_into().unwrap()), w);
    assert_eq!(&wb[10..n], b"source/a.ts");

    // persistence: snapshot + journal replay reproduce the overlay
    vfs::persist_exclude(b"/workspace/.cache").unwrap();
    persist::enable(0);
    let (snap, s0) = persist::snapshot();
    vfs::write_file(b"/workspace/after.txt", b"journaled", 0o644, 0).unwrap();
    vfs::write_file(b"/workspace/.cache/x", b"volatile", 0o644, 0).unwrap();
    vfs::unlink(b"/workspace/hard").unwrap();
    vfs::rename(b"/workspace/.cache/x", b"/workspace/kept").unwrap();
    let (journal, s1) = persist::take();
    assert!(s1 > s0 && !journal.is_empty());
    let before = (ls("/workspace"), ls("/workspace/node_modules/pkg"), read("/workspace/after.txt").unwrap());
    // wipe the overlay by replaying into a fresh root: simulate with unlink of everything
    {
        let mut v = vfs::VFS.write();
        v.nodes.truncate(1);
        if let Some(Some(root)) = v.nodes.get_mut(0) {
            if let vfs::Kind::Dir(d) = &mut root.kind {
                d.children.clear();
            }
        }
        v.rebuild_free();
    }
    assert_eq!(st("/workspace").err(), Some(ENOENT));
    assert_eq!(persist::replay(&snap), snap.len());
    assert_eq!(persist::replay(&journal), journal.len());
    // mounts are not persisted; the host mounts again at boot
    assert!(unsafe { abi::bat_image_mount(id, name.as_ptr(), name.len(), mp.as_ptr(), mp.len()) } > 0);
    // ...and declares the non-persistent roots again; they come back empty
    assert_eq!(st("/workspace/.cache").err(), Some(ENOENT));
    vfs::persist_exclude(b"/workspace/.cache").unwrap();
    let after = (ls("/workspace"), ls("/workspace/node_modules/pkg"), read("/workspace/after.txt").unwrap());
    assert_eq!(before, after);
    assert_eq!(read("/workspace/kept").unwrap(), b"volatile");
    assert_eq!(st("/workspace/hard").err(), Some(ENOENT));
    assert_eq!(read("/workspace/node_modules/pkg/index.js").unwrap(), b"patched");
    assert!(ls("/workspace/.cache").is_empty());
    let _ = fd::POLLIN;
}
