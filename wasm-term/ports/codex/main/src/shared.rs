//! What the two browser `main`s share: the emulated home and how a run ends.

use codex_tui::AppExitInfo;
use codex_tui::ExitReason;
use std::io::Write;

/// The emulated machine starts every program in `/` with an empty home. The TUI
/// requires `$CODEX_HOME` (default `$HOME/.codex`) to be an existing directory
/// and resolves config layers from the working directory upwards.
pub fn prepare_emulated_home() -> anyhow::Result<()> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    let codex_home = std::env::var("CODEX_HOME").unwrap_or_else(|_| format!("{home}/.codex"));
    std::fs::create_dir_all(&codex_home)?;
    // `dirs::home_dir()` has no WASI arm, so the default (`~/.codex`) cannot be derived.
    // SAFETY: single-threaded, before anything reads the environment concurrently.
    unsafe { std::env::set_var("CODEX_HOME", &codex_home) };
    // `std::env::temp_dir()` panics on WASI ("not supported by WASI yet"); the
    // tempfile crate asks it unless told where to go.
    let _ = tempfile::env::override_temp_dir(std::path::Path::new("/tmp"));
    // The TUI reports its own working directory to the server as the project
    // directory (as the native client does with `codex --remote`). Here that is
    // a path on the server's machine, named by the page; it only has to exist.
    match std::env::var("CODEX_WASM_CWD").ok().filter(|dir| dir.starts_with('/')) {
        Some(dir) => {
            std::fs::create_dir_all(&dir)?;
            std::env::set_current_dir(&dir)?;
        }
        None => {
            if std::env::current_dir().is_ok_and(|cwd| cwd == std::path::Path::new("/")) {
                std::env::set_current_dir(&home)?;
            }
        }
    }
    Ok(())
}

/// Prints what the native binary prints on exit and ends the program.
pub fn finish(exit_info: AppExitInfo) -> anyhow::Result<()> {
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
