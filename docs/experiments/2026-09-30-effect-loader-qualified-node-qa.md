# Effect loader — qualified Node 24.18.0 QA

2026-09-30. **All requested loader/PID/endpoint assertions pass on actual qualified
Node. Existing guest `markAsUncloneable` gap remains; cohort stopped at that failure.
Not full pilot acceptance, promotion or authorization for the next migration phase.**

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-qualified-node-qa.md`.

## Exact outcome

| Denominator | Result on Node 24.18.0 |
| --- | --- |
| SAME independently authored expanded loader gates | **10 PASS / 0 FAIL / 0 unrun** |
| SAME preserved loader assertions | **4 PASS / 0 FAIL / 0 unrun** |
| SAME preserved PID-egress/fetch cleanup cases | **6 PASS / 0 FAIL / 0 unrun** |
| SAME preserved endpoint cases | **8 PASS / 0 FAIL / 0 unrun** |
| Bounded `test-single-kernel-routing.mjs` | **PASS** (real guest async/spawnSync/execSync FS-port routing and dispatch-fault release) |
| Bounded `test-single-kernel-close.mjs` | **3 PASS**: abort-before-headers, cancel-after-data, normal-eof |
| Unchanged worker-uncloneable fixture executed directly on native Node | **PASS**, `WORKER_UNCLONEABLE_PASS` |
| `verify-runtime-contracts.mjs worker-uncloneable` in actual guest worker | **FAIL**, exit 1, `TypeError: markAsUncloneable is not a function` |
| Selected `verify-runtime-contracts.mjs vm-import` | **UNRUN**, stopped after first failure |
| Post-run frozen verification gate | **UNRUN**, stopped after first failure |

Top-level runner denominator: **5 PASS / 1 FAIL / 2 unrun** of eight orchestration
gates. These are not eight independent test cases: two gates contain the 28 original
loader/PID/endpoint cases. Supplementary passing observations are one routing suite,
three close cases and one native worker fixture. No test assertion was weakened,
silently skipped, retried or patched. The failed guest contract prevents an all-green
qualification-cohort receipt, but does not erase the 28 qualified-version passes.

Shared-interest preservation, actual native ignored-abort settlement, pre-PID
publication exclusion, real Rust VFS rollback joins, original-plus-rollback failure
aggregation, rejecting SDK stop/cleanupError, and built Runtime attachment/replacement
contracts use **identical assertions and bytes** to accepted `a401707`. The original
fixtures and runner were compared byte-for-byte with that commit. Prior Node 24.7.0
results, baseline expected failures and reports are unchanged. No browser, host/guest
server, live QA, guest compiler, production/build/SDK/pin/plan/master-status changes.

## Qualified executable and official provenance

Read `vivari/DEVELOPMENT.md` first: lines 34–36 explicitly require **Node 24.18.0**
for qualified headless checks; package.json's broad `>=22.15.0` engine is not a
replacement qualification rule. Mac architecture from `uname -m`: **arm64**.
Bounded local search found only NVM 24.7.0, no Homebrew Node paths and no 24.18
entry in approved temporary tooling. Used user-authorized **isolated official
download**, no global installation, package changes, PATH/profile edits or builds.

Toolchain root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930`.

Actual executable (verified BEFORE fixtures):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-toolchain-20260930/node-v24.18.0-darwin-arm64/bin/node`.

| Check | Exact value |
| --- | --- |
| `process.version` | `v24.18.0` |
| `process.platform` / `process.arch` | `darwin` / `arm64` |
| Official archive | `https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz` |
| Official checksums | `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` |
| Archive SHA-256, matched official manifest | `e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1` |
| Downloaded checksums SHA-256 | `3927bab574a00ca0560c9583fe19655ba19603a1c5851414e4325d34ac50e469` |
| Extracted executable SHA-256 | `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a` |

HTTPS-only curl requests, successful response headers, manifest, archive and extracted
binary remain in the toolchain root. Verification is against the official HTTPS
SHA256 manifest; **no independent GPG signature verification claimed**. Full native
`process.versions` is recorded in `executable-verification.json` (V8
`13.6.233.17-node.50`, modules `137`). Native `markAsUncloneable` is a function.
Setup-only initial tar path validation rejected its legitimate top-level directory;
corrected safety check before extraction/execution, recorded in download receipt.
The checksum was already matched. This was not a test failure or retry-to-green.

Both qualification and unchanged expanded runners launch all Node CLI children using
**`spawnSync(process.execPath, ...)`**. Per-case child commands were inspected and
asserted to use the exact absolute qualified binary, not PATH Node 24.7.0. Original
loader/expanded/PID/endpoint fixtures contain no external host-Node spawn fallback.
Supplementary real guest workers are native `worker_threads.Worker` instances in
that same executable process; guest `spawn('node', ...)` is Kernel program dispatch,
not invocation of the machine's PATH Node. Controlled Worker/message leaves in the
expanded cases remain labeled as such, not real-browser execution.

## Frozen candidate unchanged at admission

Input root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-frozen-20260930-v2`.

Verified **106 candidate + 997 freeze entries, zero mismatches**, before each original
runner cohort. Same source archive member comparisons, Effect pin, compiled-core
static identity and SDK/workspace hashes as `a401707`. No rebuilding or frozen edits.

| Identity | Exact value |
| --- | --- |
| Runtime | `5c4b1c5655b54a840370fa6215e51fd661701591` |
| Toolkit archive (bridge `73dbae7`) | `9814c715cfca42309c581440577976833f4326e6` |
| Effect | `4.0.0-rc.118` |
| Distribution | `15da540e2381261aa4d23b4bb8abbb4e27c66ec8943db535c81d4b62856c9c43` |
| Delivery SHA-256 | `52b857effc27289d553d0e39851954b1fb9042a5eb80f01c1b551c4a07e71b47` |
| Candidate receipt SHA-256 | `1ef11f7c30b262b211d43a57f2142697ddf87ac3e086d87fb684640b225e75f9` |
| Compiled core SHA-256 | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Built SDK SHA-256 | `bd8b87d2c6a034955541cbd915240fda1c3838e6e23d1ea014711ad555a41711` |
| Built workspace library SHA-256 | `e76784aebf35ea4ee1e023c73198ea1b4d8fc83a25fcb918ce5a893897bd53cc` |

The unchanged runner's `test-scope.json` has a historical literal
`qualified-Node-24.18.0` pending label. Its actual provenance says
`qualifiedNode24_18: true`, `node: v24.18.0`; summaries say `qualifiedNodePending:
false`. Kept old source intact rather than rewriting metadata to suggest a new
fixture denominator. Qualification here supersedes that literal for the 28 passes;
broader guest compatibility is still red. Planned post-run full-hash verification
was not executed after failure; do not claim a postflight pass.

## First failure classification: existing guest API gap

The **same** `scripts/fixtures/runtime-contracts/worker-uncloneable.cjs` passed
directly on native Node 24.18.0 (including marked object/nested collection/Error
cause, structuredClone, MessagePort and Worker workerData rejection assertions).
Under actual Kernel guest execution it fails at line 4 before those semantics:

```text
TypeError: markAsUncloneable is not a function
at Object.eval (file:///contracts/worker-uncloneable.cjs:4:14)
AssertionError [ERR_ASSERTION]: ... 1 !== 0
```

After stopping, read-only archive comparison found
`packages/runtime/node/lib/worker_threads.js` **byte-identical** in baseline and
pilot committed source archives. Both lack `markAsUncloneable`. Its SHA-256 in both:
`377846162658968413392e4fd062353f4fb4958189e5c95cd40e5b5399d1adf6`.
Pilot imported bytes match that archived member. This classifies the known baseline
guest API omission, **not a new Effect-loader lifecycle regression or missing host
Node API**. Upgrading native Node does not add exports to Vivari's guest module.
No baseline execution rerun; no production fix or incomplete mark stub supplied.
Failure stderr/stack/exit retained; subsequent guest VM contract and postflight
checks are unrun. Existing OPFS main-thread/Atomics.wait warning also retained;
it is not a qualified OPFS/persistence observation.

## Named-suite limits, receipts and remaining work

`verify-node.mjs` has no bounded case selector and creates real host TCP/HTTP and
guest HTTP servers. `test-single-kernel.mjs` likewise starts a guest HTTP server.
Neither was run under the explicit **no host/guest server** constraint; no partial
copy/transformation was invented to call them green. Instead selected existing
single-kernel routing and close suites plus the relevant named runtime contracts.
Close uses a real Node thread fixture in place of the browser Kernel Worker and
mocked fetch/messages, no network listener. It proves its original close assertions,
not browser cancellation. No full `verify-node`, full `test-single-kernel` or full
runtime-contract suite qualification is claimed.

Loader receipts retain the prior scope: successful last-interest stop joins its
actual native work/rollback; failing cleanup retains the public errors and attachment;
shared live interests may continue legitimate work after another owner's stop.
This is not `/bin` symlink path-security repair, all-writer/VFS/SQLite/OPFS durable
quiescence, arbitrary native cancellation, real browser acceptance or performance.
Static browser/Node compiled-core provenance stays established; live browser behavior
remains pending. Full TODO app/editor/close delivery/live QA remains with its separate
owner. Known framework cost +135,365 gzip bytes and unmeasured runtime overhead are
unchanged. Parent review is still required before phase2.

## Reproduction and preserved evidence

New orchestration source only:
`examples/todo-app/tests/effect-loader-qualified-node-runner.ts`.

From `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`:

```sh
TEMP=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode
TOOLS="$TEMP/effect-loader-qualified-node-toolchain-20260930"
"$TOOLS/node-v24.18.0-darwin-arm64/bin/node" \
  examples/todo-app/tests/effect-loader-qualified-node-runner.ts \
  "$TEMP/effect-loader-frozen-20260930-v2" "$TOOLS" \
  "$TEMP/effect-loader-qualified-node-NEW-evidence"
```

Output must be new; runner makes no downloads/builds and rejects a wrong executable,
version, platform, arch, archive/checksums or input artifact identity. It stops on
the first failure and saves stdout/stderr/exit/signal/commands before classification.
Do not use this command as permission to retry this failed cohort to green.

Evidence:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-evidence-20260930`.
Contains original per-case observations/held handshakes under `expanded/` and
`preserved/`, version/executable provenance, source fixture hashes unchanged from
`a401707`, supplementary logs and baseline source comparison. No evidence cleanup.

Archive:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-qualified-node-evidence-20260930.tar.gz`.
SHA-256: `7a7941ea3a3387b9e0046ccc7411cd72ba14305e4eef1850ecf45d44df3f231e`.
Includes failed/passing observations and official download/executable receipts/headers;
the large official archive and executable themselves remain separately in toolchain
root. Commit only this report and the new version-qualification runner; no push.
