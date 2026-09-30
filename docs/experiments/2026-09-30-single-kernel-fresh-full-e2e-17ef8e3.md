# Fresh full e35eab4 E2E: failed at case 1 post-close census

Harness commit: `17ef8e3`. No second attempt or operation retry occurred.
The full runner completed 19 application stages, five fresh hydrated todo/PDF
generations, same-document HMR, OpenCode SSE handshake/cancellation, and two
reload/shutdown stages. Focused cases 0 and 1 completed their runtime assertions;
only case 0 passed its post-close Chrome census. Cases 2–9 were not reached.

After case 1 (HTTP response reader cancellation), kernel target
`9BA93CF19AC6DE002CABE4D93F10406C` remained throughout 34 bounded read-only
observations over the 15-second close-census deadline. A separately labelled
post-failure read-only capture still found it. All 410 driver CLI commands returned
success; the acceptance failure was the census deadline, not a failed CLI command.
No runtime/application repair was attempted. No model/inference calls occurred.

## Exact identity and reproducibility

- Runtime revision: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Distribution: `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
- Kernel SHA-256: `1316335f08db867e269b43dc324163b5449487ee9ca14588d8b5ca2ff2aead09`.
- Process SHA-256: `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7`.
- All 9,587 frozen inputs verified and copied unchanged; zero consumer/runtime builds.
- Original receipt retained byte-for-byte as `full-source-receipt.json`, SHA-256
  `5519ad68460044edc29640234ab513eb6c6cf623bd2eee5e7368ebc6bba47bee`.
- Fresh receipt separately records current harness sources and original provenance.
- Offline validation: 23 focused tests / 148 assertions; strict consumer typecheck passes.

Executed from `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
bun examples/todo-app/tests/prepare-single-kernel-full.ts .diagnostics/single-kernel-e35eab4-full-attempt1 .diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3
bun examples/todo-app/tests/serve-single-kernel.ts .diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3
bun examples/todo-app/tests/serve-single-kernel.ts .diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3 --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun examples/todo-app/tests/single-kernel-driver.ts .diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3 .diagnostics/single-kernel-live-e35eab4-full-fresh-2026-09-30-independent-17ef8e3
```

## Evidence and cleanup

Artifact directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3`.

Evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-live-e35eab4-full-fresh-2026-09-30-independent-17ef8e3`.
Contains unchanged failed `result.json`, `definitive-summary.json`, app/reload/case-0
evidence, all command receipts, `post-failure-contract-capture.json`, independent
byte verification and failure-cleanup receipts.

Only new servers `127.0.0.1:52828` / PID 78370 and `127.0.0.1:52829` / PID 78371
were SIGTERM-signalled after verifying their exact command identity. Both background
process exits were joined and independently verified absent. Only new sessions
`single-kernel-app-73e1c1cb` and `single-kernel-cases-56a67de5` were deleted after
preserving evidence; the new evidence-scoped lock was released. Page destruction
for failure cleanup is **not** proof of orderly runtime shutdown. Old resources,
receipts, runtime bytes, canonical pins and the historical lock remain untouched.

This is not a complete full-suite pass. Focused storage/SQLite cases, performance,
release certification and deferred model proxy/inference work are unqualified here.
The full runner's reload check proves its durable marker, not the expanded binary
reload fixture from the separately labelled historical remaining-only runner.
