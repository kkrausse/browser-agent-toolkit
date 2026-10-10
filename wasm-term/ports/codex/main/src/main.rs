//! `codex --remote <addr>` for the browser: the upstream TUI on a
//! current-thread tokio runtime, talking to a remote `codex app-server`.
//!
//! Differences from `codex-rs/tui/src/main.rs` and the `cli` crate's remote
//! path, all forced by the target:
//! - no `arg0` dispatch (it re-execs, makes PATH aliases and starts a thread
//!   with a 16 MiB stack; here the stack size is a linker argument);
//! - a current-thread runtime, because wasm32-wasip1 has one thread. tokio's
//!   I/O driver parks in `poll_oneoff`, which is where the terminal, SIGWINCH
//!   and the WebSocket are all waited on;
//! - the remote endpoint is mandatory: `--remote ws://HOST:PORT`, or the
//!   `CODEX_REMOTE_ADDR` environment variable.

use clap::Parser;
use codex_arg0::Arg0DispatchPaths;
use codex_config::LoaderOverrides;
use codex_tui::Cli;
use codex_tui::ExitReason;
use codex_tui::run_main;
use codex_utils_cli::CliConfigOverrides;
use std::io::Write;

#[derive(Parser, Debug)]
#[command(name = "codex")]
struct TopCli {
    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    /// Remote app server to connect to, `ws://HOST:PORT`. In a browser this is
    /// the proxy in front of `codex app-server` (the server itself rejects
    /// requests that carry an `Origin` header).
    #[arg(long = "remote", value_name = "ADDR")]
    remote: Option<String>,

    #[clap(flatten)]
    inner: Cli,
}

fn main() -> anyhow::Result<()> {
    codex_build_info::initialize!();
    let top_cli = TopCli::parse();
    let remote = top_cli
        .remote
        .or_else(|| std::env::var("CODEX_REMOTE_ADDR").ok())
        .ok_or_else(|| {
            anyhow::anyhow!("no app server to connect to: pass --remote ws://HOST:PORT or set CODEX_REMOTE_ADDR")
        })?;
    let endpoint =
        codex_tui::resolve_remote_addr(&remote).map_err(|err| anyhow::anyhow!("{err}"))?;
    let mut inner = top_cli.inner;
    inner
        .config_overrides
        .raw_overrides
        .splice(0..0, top_cli.config_overrides.raw_overrides);

    prepare_emulated_home()
        .map_err(|err| anyhow::anyhow!("failed to prepare the home directory: {err}"))?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| anyhow::anyhow!("failed to start the tokio runtime: {err}"))?;
    let exit_info = runtime.block_on(run_main(
        inner,
        // There is no executable to re-exec; the path only has to be present,
        // because local-environment setup refuses to run without one.
        Arg0DispatchPaths {
            codex_self_exe: Some(std::path::PathBuf::from("/usr/bin/codex")),
            ..Default::default()
        },
        LoaderOverrides::default(),
        Some(endpoint),
    ))
    .map_err(|err| anyhow::anyhow!("codex TUI failed: {err:?}"))?;

    let is_fatal = match &exit_info.exit_reason {
        ExitReason::Fatal(message) => {
            eprintln!("ERROR: {message}");
            true
        }
        ExitReason::UserRequested
        | ExitReason::Archived(_)
        | ExitReason::TurnInterrupted
        | ExitReason::ThreadRemoved => false,
    };
    for line in exit_info.format_exit_messages(/*color_enabled*/ true) {
        println!("{line}");
    }
    std::io::stdout().flush()?;
    if is_fatal {
        std::process::exit(1);
    }
    Ok(())
}

/// The emulated machine starts every program in `/` with an empty home. The TUI
/// requires `$CODEX_HOME` (default `$HOME/.codex`) to be an existing directory
/// and resolves config layers from the working directory upwards.
fn prepare_emulated_home() -> anyhow::Result<()> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let codex_home = std::env::var("CODEX_HOME").unwrap_or_else(|_| format!("{home}/.codex"));
    std::fs::create_dir_all(&codex_home)?;
    // `dirs::home_dir()` has no WASI arm, so the default (`~/.codex`) cannot be derived.
    // SAFETY: single-threaded, before anything reads the environment concurrently.
    unsafe { std::env::set_var("CODEX_HOME", &codex_home) };
    // `std::env::temp_dir()` panics on WASI ("not supported by WASI yet"); the
    // tempfile crate asks it unless told where to go.
    let _ = tempfile::env::override_temp_dir(std::path::Path::new("/tmp"));
    if std::env::current_dir().is_ok_and(|cwd| cwd == std::path::Path::new("/")) {
        std::env::set_current_dir(&home)?;
    }
    Ok(())
}
