// Link arguments for the shared-memory Wasm build. They live here (not in a
// workspace .cargo/config.toml) so that building this crate never changes how
// other crates in the workspace are built.
fn main() {
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if arch != "wasm32" {
        return;
    }
    let args = [
        // 4 GiB ceiling; the memory itself is created by JS and grown on demand.
        "--max-memory=4294967296",
        // The boot stack: used only while holding the boot lock (see thread.rs).
        "-zstack-size=262144",
        // Per-instance stack and TLS are installed by the host binding.
        "--export=__stack_pointer",
        "--export=__tls_base",
        "--export=__wasm_init_tls",
        "--export=__tls_size",
        "--export=__tls_align",
        "--export=__heap_base",
    ];
    for a in args {
        println!("cargo:rustc-cdylib-link-arg={a}");
    }
}
