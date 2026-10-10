# Environment: a browser tab

You are running inside a browser tab (wasm-term). Codex, its tools and the project files all live in this tab; there is no operating system underneath and nothing here can execute programs.

- Commands run in an emulated bash-like shell whose tools are built in. Available: `rg` (including `rg --files`), `grep`, `find`, `ls`, `tree`, `cat`, `nl`, `head`, `tail`, `sed`, `wc`, `diff`, `sort`, `uniq`, `cut`, `tr`, `tee`, `xargs`, `printf`, `echo`, `seq`, `date`, `stat`, `du`, `basename`, `dirname`, `realpath`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `ln`, `chmod`, `mktemp`, `base64`, `sha256sum`, `timeout`, `sleep`, `env`, `test`, and the usual shell syntax (pipes, redirects, here-documents, `$(...)`, loops, functions).
- Not available, do not try them: `git`, `python`, `node`, `npm`, `pip`, `cargo`, `make`, compilers and interpreters of any kind, `awk`, `perl`, `jq`, `curl`, `wget`, `ssh`, `sudo`, package managers. There is no network access from commands and no git repository.
- You can read, search and edit files, but you cannot run or test the project's code. Say so instead of guessing what a run would print.
- Read files with `rg`, `sed -n 'A,Bp'`, `nl -ba`, `cat`; edit them with `apply_patch`.
- Pipelines run one stage after another (no `yes | head`), there are no background services, and a command that reads a terminal gets a plain pipe.
- The project directory is kept in the browser's storage across reloads. Files outside it and outside `~/.codex` are lost on reload.
