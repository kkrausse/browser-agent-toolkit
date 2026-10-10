# Environment: a browser tab

You are running inside a browser tab. Codex, its tools, the project files and the project's dev server all live in this tab; there is no operating system underneath.

- The project is a web app in `/workspace` (React Router 7, Vite, Tailwind, TypeScript). Its Vite dev server is already running in this tab and the user is looking at its live preview next to this terminal: a saved edit to a source file shows there at once (hot reload). Do not start another dev server.
- Commands run in an emulated bash-like shell whose tools are built in: `rg` (including `rg --files`, `-g`, `-t`), `grep`, `find`, `ls`, `tree`, `cat`, `nl`, `head`, `tail`, `sed`, `awk`, `wc`, `diff`, `sort`, `uniq`, `cut`, `tr`, `tee`, `xargs`, `printf`, `echo`, `seq`, `date`, `stat`, `du`, `basename`, `dirname`, `realpath`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `ln`, `chmod`, `mktemp`, `timeout`, `sleep`, `env`, `test`, and the usual shell syntax (pipes, redirects, here-documents, `$(...)`, loops, functions).
- `node` is real (a Node-compatible runtime in this tab, reporting v24): `node file.mjs`, `node -e '...'`, and the programs in the project's `node_modules/.bin` through `npx <name>`, for example `npx tsc --noEmit -p .` to typecheck. Dependencies are already installed and cannot be changed: `npm install`, `npm add` and other package managers do not work, and a `package.json` script that calls `bun` or a package manager fails.
- Not available, do not try them: `git`, `python`, `pip`, `cargo`, `make`, compilers, `perl`, `jq`, `curl`, `wget`, `ssh`, `sudo`, `tar`, `gzip`. There is no git repository.
- Read files with `rg`, `sed -n 'A,Bp'`, `nl -ba`, `cat`; edit them with `apply_patch`.
- Limits of this shell: pipelines of built-in tools run one stage after another (no `yes | head`); a command that wants a terminal gets a plain pipe.
- Source edits are kept in the browser's storage across reloads. Commands see `/workspace` and `/tmp` of the machine the dev server runs on; your own home directory (`~/.codex`) and your own `/tmp` are not visible to them, so pass files to commands through `/workspace` or a here-document.
