# Isolated recursive-removal diagnostics — 2026-09-29

## Outcome

**Natural dependency-tree `ENOTEMPTY` remains undiagnosed and unqualified.** The
separately identified diagnostic build passed eight full-reset switches with
actual Vite/OpenCode services stopped and drained, and four switches without
starting either service. No natural failure occurred in this bounded run. These
passes neither erase phase 1's failure nor establish a fix: instrumentation changes
timing, and this is not a production artifact.

The newline control failed once, as expected. New diagnostics conclusively show
**skipped entries**, not a concurrent writer, for that control: raw FS-owner names
contain `line\nbreak.txt`; recursive removal instead lstat'd `line` and `break.txt`,
suppressed both `ENOENT` errors, and failed rmdir on the still-populated directory.
That is not evidence that the ordinary residual map in phase 1 had this cause.
No framing correction, retry, suppression change, or deletion fix was made.

## Isolated source and artifacts

Historical pinned checkout remains clean at
`e998de62a10e5382104b51e0b860ee9d4d7a2401`. The toolkit's ignored `vendor/vivari`
symlink still points there. The editable diagnostic source is a separate runtime
worktree/branch:

- `/Users/kkrausse/Documents/repos/kkrausse/vivari-reset-diagnostic`
- Branch `diagnostics/reset-enotempty-20260929`
- Committed source `727af5dc65db29a80e94ff73aa2d6d80a93abfd2`

Source changes are confined to:

- `packages/core/src/workers/kernel-worker.ts`: log swallowed lstat errors and
  exact rmdir/unlink failure paths; preserve existing control flow and error codes.
- `packages/kernel-host/kernel-fs.js`: log invalid lstat JSON, including raw payload.
- `packages/kernel-host/fs-server.js`: bounded 2,048-event metadata history,
  SAB client/opcode/request-state attribution, raw readdir and lstat results;
  report raw remaining entries directly from the VFS on relevant failures.
- `roadmap.md`: diagnostic-only scope and limitations.

`wasm-pack` is absent. The JS-only build reused native outputs **after checking
native crate input bytes against the exact pinned source and all native output
hashes against its build receipt**. It did not rebuild native code or edit generated
workers. Frozen npm dependencies and the existing core Vite build were used;
the standard distribution packager verified the resulting assets/protocol/backend
policy. The diagnostic receipt explicitly records native reuse, recipe hash and
its originating receipt hash
`040783387f795f1c6bc86ef29bbd06c9f44f8380e51a25e365d272749ea3d390`.
An initial Bun invocation mishandled npm's workspace build syntax; the documented
npm core command was then used successfully. This was build setup, not a reset retry.

| Identity | Diagnostic value |
| --- | --- |
| Distribution version | `ae4f3bb1fed458486d3670f77c50b412ea557965c29690bb48b8f9edc6878672` |
| Distribution SHA-256 | `ab585eec8bfd7e4ead8bd9269ab02eaccb2386fb75c738ca3174776c87666eb8` |
| FS worker | `fs-worker-V4-8K19T.js`, `c641857a7b28dd5bcb87e76ae3d88bc956c3286f13b476fe6fe57ab1a7b09529` |
| Kernel worker | `kernel-worker-BZeiM-G9.js`, `9cfbf470201774617be2d6290b77f46b86b3a51fe92f97a7fc3c04102b791345` |
| Prepared manifest SHA-256 | `740db976149d892921b9a99a076563bdef25266bbca93b8b2afbbc2575e51cf1` |
| Prepared image | 44,124,263 bytes, `0956cbb05c3ddf859fcc0e6dd71dbbda020e7c662ba73cd1d4743d2432affe20` |

Preparation ran afresh into a separate private directory with the diagnostic
runtime identity, existing verified Tailwind backend and the same qualified
OpenCode application receipt. Both manifest identity fields match the diagnostic
distribution. There are 12,305 entries and zero newline destinations. Compared to
phase 1 preparation, three file bodies changed: the workspace dependency's
`index.js`, source map and `workspace.d.ts` now include phase 1's read-only entry
helper. Every other prepared entry is unchanged, including the residual Babel map.
The image is therefore explicitly **not byte-identical** to phase 1's image.
Full diff is retained privately as `preparation-diff.json`.

The delivered service worker remains byte-identical to the exact archive's adapter
(`68cb2b42e086c0bce03ba8f3a96344d5b1fba66ad3d295c84a098c700f89075d`).
No toolkit runtime pin, IRS file, published archive, license or production package
was changed. No push, deployment, model request or application save occurred.

## Browser results and controls

Fresh diagnostic origins were `http://127.0.0.1:43221` and
`http://localhost:43221`, separate from phase 1 and application storage.

| Cohort | Result |
| --- | --- |
| Actual services, fully stopped | Startup plus eight A/B full-reset switches passed; exact bytes for 26 source files and hydrated-preview PDF generation checked before/after each switch |
| Services never started | Startup plus four A/B full-reset switches passed; install-only checks, not editor-readiness qualification |
| Directory + dangling symlinks | Removal passed; both links classified by lstat; external target sentinel remained unchanged |
| Plain filename | Removal passed; later exact lstat returned `ENOENT` |
| Newline filename | First removal failed `ENOTEMPTY`; exact original file remained, inode 12439, size 13 |

All service-reset before-clear observations showed empty process/listener tables,
zero pending HTTP, and both owned service drains joined. This says nothing about
untracked host writes. OpenCode checks remain server readiness, not mounted usable
chat or model/session-isolation qualification. No performance claim is made.

Controls ran after closing/reopening the healthy no-service kernel. The symlink
fixture used one short guest process, which exited 0 and was drained before removal;
its process/listener tables were empty. The first helper invocation had a harness
mistake (`pipeTo` on async-iterable output); it failed before removal, and a fresh
healthy kernel was used after correcting the drain. This was not retrying a deletion
failure, and does not belong in the full-reset pass count.

For the newline failure, independent raw evidence at the failing operation is:

- FS worker client 0, opcode 9 (rmdir), request state 1.
- Exact failing path `/workspace/reset-newline-control`.
- Raw names `["line\nbreak.txt"]`; raw lstat still reports the original regular file.
- Raw readdir in the history contained that one exact name. The kernel's two
  suppressed lstat paths instead end in `/line` and `/break.txt`.
- Only registered client was 0. The history shows the host/direct file creation
  before the deletion walk and no subsequent write to this control subtree.

This validates worker console capture and the diagnostic path/remaining-name
instrumentation. Console receipts are written in full before summarization; browser
aftermath display truncation is not used as the evidence store.

History is bounded, records successful mutations routed through `notifyWatch`,
and labels direct host work generically rather than attributing every asynchronous
installer/persistence source. It is not an exhaustive all-time VFS mutation audit.
Natural-error discrimination is still missing because none occurred in this build.

## Validation and retained state

- Todo typecheck passed.
- Diagnostic runtime `npm run verify` and focused `vm-import` contract passed.
- Full runtime contracts failed at `worker-uncloneable`: `markAsUncloneable is not
  a function`. The unchanged exact pinned source failed identically. Full-suite
  green is **not** claimed. Headless checks used installed Node 24.7.0, not the
  documented qualified Node 24.18.0; Bun 1.4.0 and Browser Control CLI 0.8.2.
- Runtime and manifest asset hashes were rechecked; runtime worktree is clean.
- The healthy service kernel was closed and its browser session deleted. The owned
  loopback diagnostic server was stopped.
- Diagnostic newline-failure page **`amber-badger-702` is retained** with no services.
  Do not reload, switch or close it before capturing any further live evidence.
- Original baseline pages **`calm-otter-581` and `gentle-otter-722` were not touched**.

Private evidence/build recipes (absolute):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/phase2/`.
Includes `summary.json`, native-reuse build receipt, preparation diff,
`services/` and `no-services/` receipts, complete filename-control diagnostics,
build/test logs and private reproduction scripts. Ignored evidence does not travel
with commits. The only toolkit harness code change adds the symlink control to
`examples/todo-app/tests/performance-client.ts`.

## Next decision

Keep the natural dependency reset gate red. Prefer another **bounded, lower-overhead
natural reproduction** with the diagnostic source identity retained (for example,
failure-only metadata plus efficient circular mutation history), rather than broad
retries or treating these passes as a repair. Separately decide whether to correct
the proven newline framing defect on a distinct candidate branch; that still owes
repeated dependency resets, newline/dangling-symlink controls and the existing
browser OPFS recreation contract before any production pin changes. No fix is
promoted by this report.
