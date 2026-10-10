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
//! - the remote endpoint is mandatory: `--remote ws://HOST:PORT[/path]`, or the
//!   `CODEX_REMOTE_ADDR` environment variable;
//! - `CODEX_WASM_CWD` names the working directory (a path on the server).

use clap::Parser;
use codex_arg0::Arg0DispatchPaths;
use codex_config::LoaderOverrides;
use codex_tui::Cli;
use codex_tui::RemoteAppServerEndpoint;
use codex_tui::run_main;
use codex_utils_cli::CliConfigOverrides;

mod shared;

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
    let endpoint = resolve_endpoint(&remote)?;
    let mut inner = top_cli.inner;
    inner
        .config_overrides
        .raw_overrides
        .splice(0..0, top_cli.config_overrides.raw_overrides);

    shared::prepare_emulated_home()
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

    shared::finish(exit_info)
}

/// Upstream only takes `ws://host:port` with nothing after it. A browser never
/// talks to the app-server directly (it rejects requests that carry `Origin`),
/// so here the address is some proxy's, which usually lives at a path:
/// `wss://page.example/proxy/codex`. Any ws/wss URL is passed through as it is.
fn resolve_endpoint(remote: &str) -> anyhow::Result<RemoteAppServerEndpoint> {
    if remote.starts_with("ws://") || remote.starts_with("wss://") {
        return Ok(RemoteAppServerEndpoint::WebSocket {
            websocket_url: remote.to_string(),
            auth_token: None,
        });
    }
    codex_tui::resolve_remote_addr(remote).map_err(|err| anyhow::anyhow!("{err}"))
}
