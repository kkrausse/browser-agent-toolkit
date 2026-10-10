//! A stand-in "shell" for exercising the process seam (`CODEX_WASM_DEMO_SHELL=1`):
//! it runs nothing, it answers every command with one line on stdout that
//! repeats the request, one line on stderr, and exit code 0 (or 3 when the
//! command line contains `demo-fail`). It exists to show the whole path a real
//! emulated shell will use (`codex_utils_pty::backend`): request in, output
//! chunks streamed, exit code, termination. See NOTES.md, "The spawn seam".

use codex_utils_pty::ProcessDriver;
use codex_utils_pty::backend::ProcessBackend;
use codex_utils_pty::backend::ProcessSpawnRequest;
use codex_utils_pty::backend::set_process_backend;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

struct DemoShell;

impl ProcessBackend for DemoShell {
    fn spawn(&self, request: ProcessSpawnRequest) -> std::io::Result<ProcessDriver> {
        let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(16);
        let (stdout_tx, stdout_rx) = broadcast::channel::<Vec<u8>>(64);
        let (stderr_tx, stderr_rx) = broadcast::channel::<Vec<u8>>(64);
        let (exit_tx, exit_rx) = oneshot::channel::<i32>();
        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);
        let command_line = format!("{} {}", request.program.to_string_lossy(), request.args.join(" "));
        let fail = command_line.contains("demo-fail");
        let line = format!(
            "demo-shell: argv={:?} cwd={} env={} vars stdio={:?}\n",
            std::iter::once(request.program.to_string_lossy().into_owned())
                .chain(request.args.iter().cloned())
                .collect::<Vec<_>>(),
            request.cwd.display(),
            request.env.len(),
            request.stdio,
        );
        // Output is produced by a task, as a real shell's would be: `spawn` itself
        // must return at once.
        tokio::spawn(async move {
            let run = async {
                let _ = stdout_tx.send(line.into_bytes());
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = stderr_tx.send(b"demo-shell: nothing was executed\n".to_vec());
                if fail { 3 } else { 0 }
            };
            let code = tokio::select! {
                code = run => code,
                _ = kill_rx.recv() => 137,
            };
            // Senders drop here: the readers see the end of both streams.
            let _ = exit_tx.send(code);
        });
        // Stdin is accepted and discarded.
        let writer_handle = tokio::spawn(async move { while writer_rx.recv().await.is_some() {} });
        Ok(ProcessDriver {
            writer_tx,
            stdout_rx,
            stderr_rx: Some(stderr_rx),
            exit_rx,
            terminator: Some(Box::new(move || {
                let _ = kill_tx.try_send(());
            })),
            writer_handle: Some(writer_handle),
            resizer: None,
        })
    }
}

pub fn install() {
    set_process_backend(Arc::new(DemoShell));
}
