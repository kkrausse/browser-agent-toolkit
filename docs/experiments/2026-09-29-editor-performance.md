# Upstream todo editor performance experiments — 2026-09-29

For current implementation state, reproduction and next steps, see the
[full handoff](editor-performance-handoff.md).

Proving ground: [`examples/todo-app`](../../examples/todo-app).
IRS Tools remains unchanged by these experiments; its separately committed autosave remains intact.

## Payload sizes

Repacked the todo dependency/tool image after adding `pdf-lib@1.17.1`:

| Candidate | Image bytes | Entries |
| --- | ---: | ---: |
| Baseline | 44,115,788 | 12,305 |
| Remove source maps | 39,474,830 | 9,875 |
| Remove maps and workspace native `.node`/`.dylib` files | 38,240,609 | 9,872 |

The last candidate saves 13.3% against baseline. OpenCode artifacts, licensing,
provenance, digest validation, and backend receipts remain included. Symlink-chain
resolution avoids dropping valid package/bin links during filtering. Pruning is
benchmark-only, not enabled in preparation or consumers.

## Observations, not controlled statistical comparisons

Initial runs used the prepared todo source plus generation marker and a lazy PDF
workload. Same visible Browser Control session `quiet-walrus-711`, loopback origin
`http://127.0.0.1:43187`, packaged runtime, cached compressed image:

| Variant | Switch total | Delivery/verification | Source replacement |
| --- | ---: | ---: | ---: |
| Full reset + reopen | 31.04 s | 1.40 s | source install 0.011 s |
| Keep kernel, reinstall | 34.36 s | 1.73 s | source install 0.015 s |
| Keep installed tree, fully verify | 57.03 s | 12.26 s | 0.335 s |
| Also replace source incrementally | 51.42 s | 11.97 s | 0.391 s |

Startup totals ranged from 38–51 s. Vite/OpenCode service startup dominated.
Runs drifted, have one sample per arm, and initially measured fresh SSR generation
rather than fully hydrated interactivity. Do not quote these as speedup percentages
or compare them to the final static-PDF run below.

Installed reuse passed full topology, mode, symlink and content verification after
removing Vite's disposable `.vite`/`.vite-temp` paths. Incremental replacement wrote
one changed file, retained 24 unchanged files, and target verification matched all
25 source files including binary bytes. Unit tests cover tampering and failed install
receipt invalidation; no live agent dependency mutation was simulated.

Reload: receipt survived, but verification found `/workspace/node_modules` absent.
Fallback reinstallation succeeded (3.37 s); startup was 51.09 s. Runtime source
confirms `node_modules` is excluded from ordinary OPFS mirroring and has a separate
package-manager snapshot mechanism. Managed delivery does not currently engage that
snapshot path. No runtime source or pins were changed.

## Functional qualification and readiness correction

The maps+native candidate started OpenCode, rendered the todo app, generated a
876-byte PDF and added a todo. A lazy first PDF import caused Vite dependency
reoptimization/reload, losing the button's result marker. The final fixture imports
the PDF workload statically and waits for an explicit hydration marker, fresh
generation, and enabled todo input. That final candidate generated PDFs before
and after a full-reset switch; all 25 target files matched. Startup was 53.38 s,
switch 50.56 s, delivery about 1.50 s. This proves functionality, not a latency win.
The maps-only candidate was size-measured, not independently browser-qualified.

The reusable acceptance script was then run on generation 2 to perform another
full-reset switch. It failed with `Workspace clear failed while removing
/workspace/node_modules: ENOTEMPTY`. The script exposes this failure rather than
retrying blindly or reporting a pass. Repeated-switch qualification remains blocked;
the single successful switch above must not be generalized. No runtime fix was
attempted in this experiment. The harness now marks a failed switch not ready.

Browser Control CLI 0.8.2; long Playwright waits must pass
`null` as the argument before the timeout options. A misplaced second argument
produced a default 30 s timeout. Recovered using the correct signature. Other
timeouts were application PDF-marker loss during Vite reload, not relay failure.
The experiment server needed `Service-Worker-Allowed: /`; the harness needed one
canonical workspace SDK instance to avoid copied-peer WeakMap ownership mismatch.

Evidence: ignored local `.editor/performance/evidence/*.json` under the proving
ground. Reproduction: `tests/performance.ts`, `tests/performance-client.ts`, and
Browser Control execute body `tests/performance-acceptance.js`.

## Decision

Do not integrate the installed-reuse experiment into IRS Tools: it is slower than
cached-image reinstall and cannot reuse installed dependencies across reloads.
Do not trust receipt-only reuse. Next useful work is reusable immutable environment
mounts/snapshots or FS-worker verification with mutation tracking, and profiling
Vite/OpenCode startup. Application integration should remain a small toolkit call
after that path is proven. Exact source replacement also needs saved-workspace
policy and transactional recovery before general production use.

Validation: toolkit build passed; workspace tests 32 passed with `umask 022`
(an existing creation-mode assertion fails under the shell's restrictive umask);
OpenCode tests 121 passed, 2 skipped; todo TypeScript check passed. No push.
