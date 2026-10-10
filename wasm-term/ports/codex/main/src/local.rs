//! `codex` for the browser with nothing behind it: the upstream TUI, the
//! embedded app-server and the agent core in one module on one thread. Model
//! requests leave through the host's `fetch` (the reqwest fork's WASI
//! transport), by way of the page's pass-through relay.
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
    let defaults = browser_defaults(&backend)
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
fn browser_defaults(backend: &str) -> anyhow::Result<Vec<String>> {
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
    let default_mock = if backend == "mock-auth" { "https://mock-llm.test" } else { "http://127.0.0.1:4791" };
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
