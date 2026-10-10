# Environment: a browser tab

You are running inside a browser tab (wasm-term). Codex, its tools and the project files all live in this tab; there is no operating system underneath and nothing here can execute programs.

- Commands run in an emulated bash-like shell whose tools are built in. Available: `rg` (including `rg --files`, `-g`, `-t`), `grep`, `find`, `ls`, `tree`, `cat`, `nl`, `head`, `tail`, `sed`, `awk`, `wc`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `tr`, `paste`, `comm`, `column -t`, `tee`, `xargs`, `printf`, `echo`, `seq`, `expr`, `date`, `stat`, `du`, `basename`, `dirname`, `realpath`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `ln`, `chmod`, `mktemp`, `base64`, `sha256sum`, `md5sum`, `xxd`, `od`, `timeout`, `sleep`, `env`, `test`, and the usual shell syntax (pipes, redirects, here-documents, `$(...)`, `<(...)`, arrays, loops, functions).
- Not available, do not try them: `git`, `python`, `node`, `npm install`, `pip`, `cargo`, `make`, compilers and interpreters of any kind, `perl`, `jq`, `curl`, `wget`, `ssh`, `sudo`, `tar`, `gzip`, package managers. There is no network access from commands and no git repository.
- You can read, search and edit files, but you cannot run or test the project's code. Say so instead of guessing what a run would print.
- Read files with `rg`, `sed -n 'A,Bp'`, `nl -ba`, `cat`; edit them with `apply_patch`.
- Limits of this shell: `rg` has no `-U`, `--json` or look-around; `awk` has no `getline`; pipelines run one stage after another (no `yes | head`); there are no background services; a command that wants a terminal gets a plain pipe.
- The project directory is kept in the browser's storage across reloads. Files outside it and outside `~/.codex` are lost on reload.
