//! bat-kernel: the library kernel. One Wasm module instantiated in every
//! worker over one shared memory; a syscall is a function call.
//! The export surface is specified in docs/design/kernel-abi.md.

pub mod abi;
pub mod errno;
pub mod fd;
pub mod http;
pub mod image;
pub mod lock;
pub mod module_facts;
pub mod path;
pub mod persist;
pub mod proc;
pub mod resolve;
pub mod spike;
pub mod sys;
pub mod thread;
pub mod vfs;
pub mod ws;

#[cfg(target_arch = "wasm32")]
mod alloc;
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static GLOBAL: alloc::KernelAlloc = alloc::KernelAlloc::new();

/// Run once, by the instance that created the memory, after it has attached.
/// Creates the root directory and the host process (pid 1) and binds the
/// calling thread to it.
#[no_mangle]
pub extern "C" fn bat_kernel_init() -> u32 {
    std::panic::set_hook(Box::new(|info| {
        sys::log(3, &format!("kernel panic: {info}"));
    }));
    vfs::init();
    let host = proc::new_host();
    let _ = proc::attach(host.pid);
    host.pid
}
