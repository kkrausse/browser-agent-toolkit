//! bat-kernel: the library kernel. See docs/design/kernel-abi.md.

pub mod lock;
pub mod sys;
pub mod thread;
pub mod spike;

#[cfg(target_arch = "wasm32")]
mod alloc;
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static GLOBAL: alloc::KernelAlloc = alloc::KernelAlloc::new();

/// Run once, by the instance that created the memory, after `_initialize`.
#[no_mangle]
pub extern "C" fn bat_kernel_init() -> u32 {
    std::panic::set_hook(Box::new(|info| {
        sys::log(3, &format!("kernel panic: {info}"));
    }));
    1
}
