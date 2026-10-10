//! `codex` for the browser with nothing behind it: the upstream TUI, the
//! embedded app-server and the agent core in one module on one thread. Model
//! and sign-in requests leave one of two ways (`WASM_TERM_NET`, the page's `net=`):
//! - `tunnel`: codex's own HTTP stack (reqwest, hyper, rustls) and WebSocket dialer over a
//!   TCP stream the page's relay carries. TLS ends in this module, so the relay sees
//!   ciphertext only;
//! - `fetch`: the host's `fetch` (the reqwest fork's WASI transport) by way of the page's
//!   pass-through HTTP relay, which terminates TLS and so can read everything.
//!
//! Differences from the native binary, all forced by the target:
//! - no `arg0` dispatch, a current-thread runtime (see `main.rs`);
//! - `enable_in_process_app_server()` is what links the embedded server in;
//! - `CODEX_WASM_CWD` names the project directory, a path in the emulated
//!   filesystem that the page keeps across reloads;
//! - there are no processes: commands (the model's `exec_command`, the user's
//!   `!command`) run in the page's emulated shell (`shell.rs`; NOTES.md, "The
//!   spawn seam"). `CODEX_WASM_SHELL=0` leaves the "no shell in this build"
//!   default in place.

use clap::Parser;
use codex_arg0::Arg0DispatchPaths;
use codex_config::LoaderOverrides;
use codex_tui::Cli;
use codex_tui::run_main;
use codex_utils_cli::CliConfigOverrides;

mod shared;
mod shell;

#[derive(Parser, Debug)]
#[command(name = "codex")]
struct TopCli {
    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    #[clap(flatten)]
    inner: Cli,
}

fn main() -> anyhow::Result<()> {
    codex_build_info::initialize!();
    let top_cli = TopCli::parse();
    let mut inner = top_cli.inner;
    inner
        .config_overrides
        .raw_overrides
        .splice(0..0, top_cli.config_overrides.raw_overrides);

    shared::prepare_emulated_home()
        .map_err(|err| anyhow::anyhow!("failed to prepare the home directory: {err}"))?;
    let backend = std::env::var("CODEX_WASM_BACKEND").unwrap_or_else(|_| "mock".to_string());
    let tunnel = match std::env::var("WASM_TERM_NET").as_deref() {
        Ok("tunnel") => true,
        Ok("fetch") | Ok("") | Err(_) => false,
        Ok(other) => anyhow::bail!("unknown WASM_TERM_NET {other:?} (tunnel or fetch)"),
    };
    trust_policy(&backend);
    if tunnel {
        // What tokio's `TcpStream::connect` does from here on: hyper-util's connector and the
        // WebSocket dialer both end up there, with the host name still a name.
        tokio::net::set_wasi_tcp_connector(|host, port| {
            Box::pin(async move {
                wasm_term_tokio::TcpStream::connect(&host, port)
                    .await
                    .map(wasm_term_tokio::TcpStream::into_inner)
            })
        });
        reqwest::wasi_use_native_transport(true);
    }
    if let Ok(url) = std::env::var("CODEX_WASM_TLS_PROBE") {
        return tls_probe(&url);
    }
    let defaults = browser_defaults(&backend, tunnel)
        .map_err(|err| anyhow::anyhow!("failed to set up the {backend} backend: {err}"))?;
    // In front, so that `-c` on the command line (the page's `?arg=`) wins.
    inner.config_overrides.raw_overrides.splice(0..0, defaults);
    if std::env::var("CODEX_WASM_SEED").is_ok_and(|seed| seed != "0") {
        seed_sample_project()
            .map_err(|err| anyhow::anyhow!("failed to seed the sample project: {err}"))?;
    }
    if std::env::var("CODEX_WASM_SHELL").map_or(true, |shell| shell != "0") {
        // codex finds the shell by path (the page plants /bin/bash and /bin/sh). PATH is NOT set
        // for codex itself: std::env::split_paths panics on WASI, and every PATH lookup calls it.
        // Commands get a PATH from the backend.
        shell::install();
    }
    codex_app_server_client::enable_in_process_app_server();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| anyhow::anyhow!("failed to start the tokio runtime: {err}"))?;
    let exit_info = runtime
        .block_on(run_main(
            inner,
            Arg0DispatchPaths {
                codex_self_exe: Some(std::path::PathBuf::from("/usr/bin/codex")),
                ..Default::default()
            },
            LoaderOverrides::default(),
            /*explicit_remote_endpoint*/ None,
        ))
        .map_err(|err| anyhow::anyhow!("codex TUI failed: {err:?}"))?;
    shared::finish(exit_info)
}

/// Configuration this build cannot do without, as `-c key=value` overrides, plus
/// what the chosen backend needs. `$CODEX_HOME/config.toml` stays the user's.
///
/// - `mock`: the scripted model server from wasm-term/mock-llm; no sign-in.
/// - `mock-auth`: codex's own OpenAI provider and sign-in flow, with the model
///   API, the ChatGPT backend and the auth server all pointed at mock-llm's fakes.
/// - `openai`: the real thing. Sign in with ChatGPT (device code) or an API key.
fn browser_defaults(backend: &str, tunnel: bool) -> anyhow::Result<Vec<String>> {
    let mut overrides: Vec<String> = [
        // No sandbox exists here and none is needed: the "machine" is the tab. With
        // any other mode codex routes file writes to a sandbox helper process.
        r#"sandbox_mode="danger-full-access""#,
        r#"approval_policy="never""#,
        r#"cli_auth_credentials_store="file""#,
        "check_for_update_on_startup=false",
        // Each of these starts a process, a thread or a listener at start-up.
        "features.daemon_auto_start=false",
        "features.shell_snapshot=false",
        "features.plugins=false",
        "features.remote_plugin=false",
        "features.plugin_sharing=false",
        "features.apps=false",
        "analytics.enabled=false",
        "feedback.enabled=false",
    ]
    .map(str::to_string)
    .to_vec();
    // `mock-llm.test` is the relay's https name for the same server: codex only
    // accepts an https ChatGPT backend, and sign-in is only testable through the relay.
    // Through the tunnel it is always that name: the mock's TLS front has a certificate for it, and
    // the tunnel's relay would otherwise carry plain HTTP, which is what the tunnel is there to avoid.
    let default_mock = if backend == "mock-auth" || tunnel { "https://mock-llm.test" } else { "http://127.0.0.1:4791" };
    let mock = std::env::var("CODEX_WASM_MOCK_URL").unwrap_or_else(|_| default_mock.to_string());
    let mock = mock.trim_end_matches('/');
    // What this machine is, for the model: codex's own slot for it (`developer_instructions`
    // is sent as a developer message with every thread). `?arg=-c&arg=developer_instructions=...` replaces it.
    if std::env::var("CODEX_WASM_SHELL").map_or(true, |shell| shell != "0") {
        overrides.push(format!(
            "developer_instructions={}",
            toml_string(include_str!("environment.md").trim())
        ));
    }
    let codex_home = std::env::var("CODEX_HOME")?;
    let mock_model = |overrides: &mut Vec<String>| -> anyhow::Result<()> {
        // Without metadata codex treats an unknown model as one without `apply_patch`.
        let catalog = format!("{codex_home}/mock-catalog.json");
        std::fs::write(&catalog, include_str!("mock-catalog.json"))?;
        overrides.push(r#"model="mock-model""#.to_string());
        overrides.push(format!("model_catalog_json={catalog:?}"));
        Ok(())
    };
    match backend {
        "mock" => {
            mock_model(&mut overrides)?;
            overrides.push(r#"model_provider="mock""#.to_string());
            overrides.push(format!(
                r#"model_providers.mock={{name="Mock LLM",base_url="{mock}/v1",wire_api="responses",requires_openai_auth=false}}"#
            ));
        }
        "mock-auth" => {
            mock_model(&mut overrides)?;
            overrides.push(format!(r#"openai_base_url="{mock}/v1""#));
            overrides.push(format!(r#"chatgpt_base_url="{mock}/backend-api/""#));
            // SAFETY: single-threaded, before anything reads the environment concurrently.
            unsafe {
                std::env::set_var("CODEX_APP_SERVER_LOGIN_ISSUER", format!("{mock}/auth"));
                std::env::set_var("CODEX_REFRESH_TOKEN_URL_OVERRIDE", format!("{mock}/auth/oauth/token"));
                std::env::set_var("CODEX_REVOKE_TOKEN_URL_OVERRIDE", format!("{mock}/auth/oauth/revoke"));
            }
        }
        "openai" => {}
        other => anyhow::bail!("unknown CODEX_WASM_BACKEND {other:?} (mock, mock-auth or openai)"),
    }
    Ok(overrides)
}

/// Which certificate authorities this program trusts, decided here and nowhere else.
///
/// The baseline is the Mozilla root set compiled into the module (webpki-roots): there is no
/// platform store on WASI. codex also honours `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` /
/// `SSL_CERT_DIR` (extra roots from a PEM file), which here would let a URL parameter
/// (`?env=`) point the real backend at a root of someone's choosing. So all three are removed
/// from the environment for every backend, and one is set again only for the two mock
/// backends, from `WASM_TERM_TEST_CA`: the private CA of mock-llm's TLS front, which the page
/// supplies together with the file, and only for those backends. With `backend=openai`
/// nothing can add a root.
fn trust_policy(backend: &str) {
    let test_ca = std::env::var("WASM_TERM_TEST_CA").ok();
    // SAFETY: single-threaded, before anything reads the environment concurrently.
    unsafe {
        for name in ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "SSL_CERT_DIR", "WASM_TERM_TEST_CA"] {
            std::env::remove_var(name);
        }
        if matches!(backend, "mock" | "mock-auth") {
            if let Some(path) = test_ca.filter(|path| std::path::Path::new(path).is_file()) {
                std::env::set_var("CODEX_CA_CERTIFICATE", path);
            }
        }
    }
}

/// `CODEX_WASM_TLS_PROBE=<url>`: instead of starting codex, make one GET with the HTTP client
/// codex builds (same reqwest, same TLS configuration, same trust policy as above for the
/// chosen backend and transport), print what came of it and exit: 0 for any HTTP response,
/// 1 for a failure, whose error chain (certificate errors included) is printed.
/// `CODEX_WASM_TLS_PROBE_REPEAT=n` repeats it on the same client, which shows what a new
/// connection costs next to a reused one. For checking the transport and certificate
/// verification without a conversation around it (web/verify/codex-local.js).
fn tls_probe(url: &str) -> anyhow::Result<()> {
    let repeat: usize = std::env::var("CODEX_WASM_TLS_PROBE_REPEAT").ok().and_then(|n| n.parse().ok()).unwrap_or(1);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let outcome = runtime.block_on(async {
        let client = codex_http_client::build_reqwest_client_with_custom_ca(
            reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)),
        )?;
        for round in 1..=repeat.max(1) {
            let started = std::time::Instant::now();
            let response = client.get(url).send().await?;
            let head_ms = started.elapsed().as_secs_f64() * 1000.0;
            let (status, version) = (response.status(), response.version());
            let body = response.bytes().await?;
            println!(
                "tls-probe: {round} {url} -> {} {version:?} head {head_ms:.1} ms, body {} bytes after {:.1} ms",
                status.as_u16(),
                body.len(),
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
        anyhow::Ok(())
    });
    match outcome {
        Ok(()) => {
            println!("tls-probe: ok");
            Ok(())
        }
        Err(error) => {
            println!("tls-probe: failed: {error:#}");
            let mut source = error.source();
            while let Some(cause) = source {
                println!("tls-probe:   caused by: {cause}");
                source = cause.source();
            }
            std::process::exit(1);
        }
    }
}

/// A TOML basic string.
fn toml_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// A small project in the working directory, written once: only when the
/// directory holds nothing yet.
fn seed_sample_project() -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    if std::fs::read_dir(&cwd)?.next().is_some() {
        return Ok(());
    }
    let files = [
        ("README.md", include_str!("../sample/README.md")),
        ("hello.txt", include_str!("../sample/hello.txt")),
        ("src/main.py", include_str!("../sample/src/main.py")),
        ("src/inventory.py", include_str!("../sample/src/inventory.py")),
        ("src/report.py", include_str!("../sample/src/report.py")),
        ("tests/test_inventory.py", include_str!("../sample/tests/test_inventory.py")),
        ("data/items.csv", include_str!("../sample/data/items.csv")),
        ("notes/todo.md", include_str!("../sample/notes/todo.md")),
        (".gitignore", include_str!("../sample/gitignore")),
    ];
    for (path, contents) in files {
        let path = cwd.join(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
    }
    Ok(())
}
