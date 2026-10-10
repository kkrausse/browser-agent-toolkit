//! The shell behind codex's process seam (`codex_utils_pty::backend`, NOTES.md
//! "The spawn seam"): every command codex starts, whether it is the model's
//! `exec_command`, the user's `!command` or an app-server `command/exec`, runs
//! as a child process of this program on the wasm-term host (`proc_spawn`,
//! docs/abi.md 3.4). The host runs it in bat-rust's shell (bash-like, the
//! coreutils built in) in its own Worker, on the same filesystem codex's file
//! tools use, and delivers stdout, stderr and the exit status as events on one
//! descriptor that tokio's reactor polls like any other.
//!
//! What codex asks for and what it gets:
//!
//! - `Pipes { stdin: false }` (every `exec_command` without `tty`, `!command`):
//!   stdout and stderr as separate streams, stdin at end of file.
//! - `Pipes { stdin: true }`: the same with stdin fed from `writer_tx`.
//! - `Pty` (`exec_command` with `tty: true`, then `write_stdin`): there is no
//!   terminal to give. The stand-in is pipes with the part of a terminal's line
//!   discipline a model relies on: stdout and stderr merged into one stream,
//!   input echoed, `\r` read as newline, input delivered a line at a time,
//!   Ctrl-C (0x03) interrupts, Ctrl-D (0x04) is end of file. Not there: a
//!   window size (`resize` is accepted and ignored), raw mode, `isatty` being
//!   true in the child, output newlines as `\r\n`.
//! - Termination: the `terminator` is SIGKILL, the wasi-only `interrupter`
//!   (what `write_stdin("\u{3}")` to a pipes process reaches) is SIGINT.
//!   Timeouts stay the caller's.

use codex_utils_pty::ProcessDriver;
use codex_utils_pty::backend::NO_SHELL_MESSAGE;
use codex_utils_pty::backend::ProcessBackend;
use codex_utils_pty::backend::ProcessSpawnRequest;
use codex_utils_pty::backend::ProcessStdio;
use codex_utils_pty::backend::set_process_backend;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use wasm_term_tokio::Child;
use wasm_term_tokio::ChildEvent;
use wasm_term_tokio::SIGINT;
use wasm_term_tokio::SIGKILL;

/// What a login shell would have: codex passes its own environment on, and the
/// emulated machine starts programs without a `PATH`.
pub const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Upstream reads pipes in chunks of this size; the delta events and the
/// output buffers downstream are sized for it.
const CHUNK: usize = 8192;
/// Chunks in flight to codex's readers beyond which the pump waits, so that a
/// command printing faster than codex consumes is slowed down (the host stops
/// answering its writes) instead of losing output in the broadcast channel.
const HIGH_WATER: usize = 256;
const CHANNEL: usize = 1024;

struct PageShell;

async fn publish(tx: &broadcast::Sender<Vec<u8>>, data: Vec<u8>) {
    for chunk in data.chunks(CHUNK) {
        while tx.len() > HIGH_WATER {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        let _ = tx.send(chunk.to_vec());
    }
}

/// The input half of the terminal stand-in: what the "terminal" does with
/// bytes typed at it before the program reads them.
#[derive(Default)]
struct LineDiscipline {
    line: Vec<u8>,
}

enum Typed {
    /// Deliver to the child's stdin.
    Deliver(Vec<u8>),
    Interrupt,
    EndOfFile,
}

impl LineDiscipline {
    /// Returns what to echo and what the bytes amount to, in order.
    fn input(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<Typed>) {
        let mut echo = Vec::new();
        let mut out = Vec::new();
        for &byte in bytes {
            match byte {
                0x03 => {
                    self.line.clear();
                    echo.extend_from_slice(b"^C\n");
                    out.push(Typed::Interrupt);
                }
                0x04 => {
                    // As a terminal: with a partial line, send it without a newline; on an empty line, end of file.
                    if self.line.is_empty() {
                        out.push(Typed::EndOfFile);
                    } else {
                        out.push(Typed::Deliver(std::mem::take(&mut self.line)));
                    }
                }
                0x7f | 0x08 => {
                    if self.line.pop().is_some() {
                        echo.extend_from_slice(b"\x08 \x08");
                    }
                }
                b'\r' | b'\n' => {
                    self.line.push(b'\n');
                    echo.push(b'\n');
                    out.push(Typed::Deliver(std::mem::take(&mut self.line)));
                }
                other => {
                    self.line.push(other);
                    echo.push(other);
                }
            }
        }
        (echo, out)
    }
}

impl ProcessBackend for PageShell {
    fn spawn(&self, request: ProcessSpawnRequest) -> std::io::Result<ProcessDriver> {
        let (pty, stdin) = match request.stdio {
            ProcessStdio::Pty { .. } => (true, true),
            ProcessStdio::Pipes { stdin } => (false, stdin),
        };
        let argv: Vec<String> = std::iter::once(
            request
                .arg0
                .clone()
                .unwrap_or_else(|| request.program.to_string_lossy().into_owned()),
        )
        .chain(request.args.iter().cloned())
        .collect();
        let mut env: Vec<String> = request.env.iter().map(|(name, value)| format!("{name}={value}")).collect();
        if !request.env.contains_key("PATH") {
            env.push(format!("PATH={DEFAULT_PATH}"));
        }
        let cwd = request.cwd.to_string_lossy().into_owned();
        let mut child = Child::spawn(&argv, &cwd, &env, stdin).map_err(|err| {
            if err.kind() == std::io::ErrorKind::Unsupported {
                std::io::Error::new(std::io::ErrorKind::Unsupported, format!("{NO_SHELL_MESSAGE} ({err})"))
            } else {
                err
            }
        })?;

        let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
        let (stdout_tx, stdout_rx) = broadcast::channel::<Vec<u8>>(CHANNEL);
        let (stderr_tx, stderr_rx) = broadcast::channel::<Vec<u8>>(CHANNEL);
        let (exit_tx, exit_rx) = oneshot::channel::<i32>();
        let (signal_tx, mut signal_rx) = mpsc::unbounded_channel::<u32>();

        // One task per child: events out, stdin and signals in. `spawn` itself returns at once.
        tokio::spawn(async move {
            let mut discipline = LineDiscipline::default();
            let mut stdin_open = stdin;
            let mut signals_open = true;
            let code = loop {
                tokio::select! {
                    event = child.recv() => match event {
                        Ok(ChildEvent::Stdout(data)) => publish(&stdout_tx, data).await,
                        Ok(ChildEvent::Stderr(data)) => publish(if pty { &stdout_tx } else { &stderr_tx }, data).await,
                        Ok(ChildEvent::Exit { status, .. }) => break status,
                        Err(_) => break -1,
                    },
                    signo = signal_rx.recv(), if signals_open => match signo {
                        Some(signo) => {
                            let _ = child.signal(signo);
                        }
                        None => signals_open = false,
                    },
                    typed = writer_rx.recv(), if stdin_open => match typed {
                        // The caller closed stdin (dropped its sender).
                        None => {
                            stdin_open = false;
                            let _ = child.close_stdin();
                        }
                        Some(bytes) if !pty => {
                            let _ = child.send(&bytes);
                        }
                        Some(bytes) => {
                            let (echo, actions) = discipline.input(&bytes);
                            if !echo.is_empty() {
                                publish(&stdout_tx, echo).await;
                            }
                            for action in actions {
                                match action {
                                    Typed::Deliver(line) => {
                                        let _ = child.send(&line);
                                    }
                                    Typed::Interrupt => {
                                        let _ = child.signal(SIGINT);
                                    }
                                    Typed::EndOfFile => {
                                        stdin_open = false;
                                        let _ = child.close_stdin();
                                    }
                                }
                            }
                        }
                    },
                }
            };
            // Readers wait for both streams to close, also after the exit code.
            drop(stdout_tx);
            drop(stderr_tx);
            let _ = exit_tx.send(code);
        });

        let interrupt_tx = signal_tx.clone();
        Ok(ProcessDriver {
            writer_tx,
            stdout_rx,
            stderr_rx: if pty { None } else { Some(stderr_rx) },
            exit_rx,
            terminator: Some(Box::new(move || {
                let _ = signal_tx.send(SIGKILL);
            })),
            writer_handle: None,
            resizer: if pty { Some(Box::new(|_size| Ok(()))) } else { None },
            interrupter: Some(Box::new(move || {
                let _ = interrupt_tx.send(SIGINT);
            })),
        })
    }
}

pub fn install() {
    set_process_backend(Arc::new(PageShell));
}
