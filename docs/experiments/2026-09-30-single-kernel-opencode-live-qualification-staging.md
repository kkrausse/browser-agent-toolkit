# Real pinned OpenCode mounted qualification — offline staging only

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-single-kernel-opencode-live-qualification-staging.md`

## Outcome and scope

A separately built, runnable isolated consumer, rendered actual-controller
qualification page, **actual delivered SK 2.0.3 HttpApi codec executor**, and owned
host supervisor are prepared. **Live mounted qualification is NOT established.**
There were zero browser operations, host launches, guest server launches, native
session creations, prompt/inference/tool/shell RPCs, DELETEs, source replacements,
location resets, or retention transitions during this stage.

`retentionAccepted:false`, `remoteZeroRef:false`. No process-retention speedup or
general safety claim. Parent must assign the next exclusive browser slot first;
chat QA `ses_f0c5f766cffeLB1OeryKn5xwEp` owned the visible slot at assignment, with
cleanup diagnostics queued next. Neither those sessions nor their origins/assets
were accessed. The original four retention preparation files were read/tested,
not edited. Active sibling app/editor/chat/workspace/runtime files are untouched.

Only new `examples/todo-app/tests/sk-opencode-live-*` files and this report belong
to this implementation. No pins, canonical vendor/source, credentials, published
archives or `.runtime` outputs were changed. All generated stage directories were
new/nonexistent. Partial failed stages were retained, not overwritten/deleted.

## Frozen and served identities freshly verified

Final prepared stage (no origin yet):

`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a`

| Identity | Reverified value |
| --- | --- |
| Toolkit committed-source archive | `874e759ae83b26224ae165c14c2e8c2a193d1aed` |
| Archive SHA-256 | `e4307babf53e2eb09aa6148e58b7e9ebeebca02a688fc33bb48b982623f008fa` |
| Chat readiness ancestry | `55ae98c` required ancestor; uncommitted sibling edits excluded |
| Read-only baseline HEAD | `64de522` prefix independently checked |
| Baseline 2.0.3 server SHA-256 | `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929` |
| **Actually delivered frozen SK 2.0.3 server SHA-256** | **`648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`** |
| Runtime revision | `e35eab4af7a53ff08eb70c09df59c40b78bfdd67` |
| Runtime/payload version | `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e` |
| New served consumer SHA-256 | `1643ee95328e6c1b45750108ca049d3f993c8cab858923e3557215dd950c1259` |
| Actual SK extracted codec SHA-256 | `8ae896cd21951fd8370239d0de61b0e61ea470cc9196f32c40df7c72000fca61` |

The important correction is not hidden: **the baseline and frozen SK packaged
server bytes differ**, despite both identifying as published 2.0.3. The first
preflight rejected a supposed shared hash. We did not replace/rebuild either
server. `stage.json` retains both hashes and the actual SK server build receipt.
Its source is registry `@opencode/server` 2.0.3 at the recorded integrity/upstream
tag `d44b52ca66b6bf69626c0384626d1a9cd9555977`. Extraction uses the actual frozen
`prepared/648140f5….bin` asset destined for `/app/server.js`, not baseline bytes.

Frozen input directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3`

Preparation freshly hashes **9,588 receipt-listed frozen files**, all prepared
file assets plus image/bundle byte lengths and SHA-256, and runtime-version
bindings. No relabeling or copying over the frozen consumer. The host supervisor
and server recheck hashes before serving. `stage.json` binds 63 additional
generated/source entries (libraries, declarations, consumer, exact e35 host
snapshot, codec, committed source archive and dedicated served-host scripts).

Installed build dependency versions and package-manifest SHA-256 are recorded:
`@opencode/client` 2.0.3, `@opencode/plugin` 2.0.3, Effect 4.0.0-rc.112, React and
ReactDOM 19.2.4. They are real existing installations, read through stage-only
symlinks; no install/package/linker change. This is **not** a new whole-node_modules
content attestation. The committed package/lock inputs are in the source archive;
the built consumer/library hashes bind the actual bundled code. Delivered guest
dependency identities are the separately verified frozen manifest/image/bundle.
Live config/plugin file hashes are collected from actual workspace bytes before
launch and independently compared again after mounting. No caller verification
callback or mock transport participates in the served qualification.

## How the candidate qualifies the foundation

- `sk-opencode-live-prepare.ts`: `git archive` of committed toolkit source;
  byte-exact e35 host-source extraction; separate Bun workspace/chat library
  builds, emitted declarations, then consumer build against those built exports.
  This solves the missing-built-library consumer problem without editing shared
  dist/package files or consuming current uncommitted source.
- `sk-opencode-live-codec.mjs`: Node executes the actual bundled Effect/HttpApi
  dependency/protocol prefix (`init_client7`, same default API), without server
  bootstrap. It selects the exact endpoint, decodes its success schema, invokes
  `makeSuccessSchema`/`HttpServerResponse.toWeb`, and requires identical status,
  body bytes and every serializer-owned response header. Unknown routes fail.
  Node is necessary for bundled `node:sea`; Bun owns staging/testing/supervision.
- `sk-opencode-live-client.ts`: one fresh origin, explicit click, one owned server
  launch and **one fresh native root via actual `createChatController`/2.0.3 SDK**.
  It verifies empty OPFS/IDB/caches/SW/localStorage before opening, its freshly
  fetched served-consumer digest, frozen runtime/payload identity, immutable A0
  source marker/config/plugins, public model proxy marker/catalog, active real
  plugins and exclusive one-process/one-listener diagnostics. Launch credentials
  are new in-memory values and excluded from identity/evidence. No auth changes.
- All finite guest calls carry `/workspace` routing and the original exposed
  listener query identity. The mounted-controller route fence admits only reviewed
  health/config/project/plugin/model/inventory/fresh-root/message-empty/permission/
  form routes plus global SSE and activation. No arbitrary execution/tool/shell,
  prompt, source-write, interrupt, model-switch or reset routes. Concurrent finite
  bootstrap is allowed and **does not satisfy the previous serial gate**.
- Every normally consumed finite response retains status, full observed Fetch
  header pairs, complete base64 body bytes, SHA-256, and the actual codec result.
  Host `codec-N.json` also retains original record and joined Node exit/stdout/
  stderr. These are Fetch-visible normalized headers/body bytes, **not original
  HTTP header casing/order, TCP bytes or a remote-finalizer receipt**. Serializer
  headers must match exactly; transport-owned extra headers remain recorded.
- Native inventory must initially be empty. Selected root must match the actual
  rendered controller snapshot/project, have `/workspace` and no workspace ID,
  parent, fork, model, metadata or permissions. Messages, permissions, forms and
  execution must hydrate empty/idle. Health PID and process/endpoint identities
  remain stable through admission, including diagnostic PID/PPID/command/cwd.
  Configured and actual-controller resolved default models must match the explicit
  qualified marker; the fresh root still has no inherited model setting.
- UI deliberately renders the **real controller snapshot**, selected session ID
  and empty/idle state. It is not ChatView acceptance: no composer/prompt/tool
  surface is exposed. A separate visible confirmation button gates joined cleanup;
  a click is not itself proof—the client rechecks the rendered session and absence
  of editing inputs plus native/identity facts. Manual visual review is required.
- Successful completion freezes admissions, joins finite tasks and local controller
  disposal/SSE cancellation, stops the owned guest using stdin EOF, joins execution
  and both output drains, requires clean non-forced exit and zero processes,
  listeners and pending HTTP, then closes the workspace. Failures retain uncertain
  ownership; no retry, reset, source replacement, forced kill or replacement server.
- `sk-opencode-live-host-owner.ts` supervises a fresh OS-assigned loopback host.
  Successful evidence capture plus zero guest work permits `/host-join`; failed
  evidence does not. The initiator joins child exit/stdout/stderr, independently
  checks listener `ECONNREFUSED`, writes separate join/absence receipts, then exits.
  Parent must also observe initiator completion; guest cleanup alone is insufficient.

The initial marker/config/plugin installation is **new-origin preparation before
server launch**, not an outgoing→incoming replacement. There is only A0; no B1.

## Offline validation actually run

Final preparation command, from the toolkit root:

```sh
SK_OPENCODE_SOURCE_REVISION=874e759 bun examples/todo-app/tests/sk-opencode-live-prepare.ts
```

Output included the final absolute stage path, source revision above,
`verifiedFrozenFiles:9588`, actual SK `serverHash`, consumer digest above and
`liveRuns:0`. Separate library declaration emit and strict/noUncheckedIndexedAccess consumer TypeScript
check pass as part of preparation, using the snapshot and built declaration paths.

```sh
SK_OPENCODE_STAGE=/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a \
bun test examples/todo-app/tests/sk-opencode-live-staging.test.ts \
  examples/todo-app/tests/sk-opencode-retention-prerequisites.test.ts \
  examples/todo-app/tests/sk-opencode-retention-mounted-candidate.test.ts
```

**29 pass, 0 fail, 138 assertions, 9.72 s**. New positives execute real pinned SK
HttpApi transport serialization on fixture domains and then byte/header/status
round-trip them. Negatives reject wrong status/header/body/shape and DELETE.
Authorization-negative host/initiator subprocesses exit before opening listeners.
Original mounted preparation test remains a mock transport test; it is not counted
as live native-session evidence. No live service/core-finalizer fixture was run.

The same three suites were then run from the **staged committed-source snapshot**,
not the concurrently edited working tree: **29/0, 138 assertions, 9.20 s**. Actual
joined test subprocess stdout/stderr/exit and absolute suite paths are preserved in
the final stage's `offline-tests.json` (`exit:0`, both drains joined, `liveRuns:0`).

Development failures preserved: delivered-hash mismatch on first preparation;
missing React JSX runtime in the first library consumer build; five first-round
codec fixture failures because input JSON property order was not the actual
serializer output and decoded null cursors become undefined. Corrections retain
strict byte equality: positives are generated by actual transport serialization,
and unpaginated policy is checked on original wire cursors before domain decode.
No permissive shape callback or header/body check weakening was introduced.

Current V2 [client](https://opencode.ai/v2/docs/build/client) and
[API](https://opencode.ai/v2/docs/api) documentation were consulted. Their current
`/api/info`/location-reload surface is not substituted for the frozen 2.0.3 bundle's
health/project/activation contracts, and no service discovery/ensure/restart was
invoked. The pinned artifact is the executed contract for this qualification.

## Fresh-origin live handoff — NOT executed; parent slot required

Do not run concurrently with chat/cleanup/workspace-switch QA. Use **only** Bun-
backed Browser Control CLI, no MCP/direct Playwright/relay restart/session adoption.
Installed CLI source was inspected offline: it has extension/relay sessions and
no headless launch option. Consequently this stage does not invent a headless
runner or claim headless coverage. Parent may arrange supported isolated headless
Browser Control infrastructure if available, but manual rendered admission remains
required. Do not switch a shared relay/browser to get headless coverage.

1. Parent assigns the exclusive slot and runs this owned initiator (foreground or
   an owned background command whose eventual completion must be joined):

   ```sh
   SK_OPENCODE_AUTHORIZE_HOST=yes bun examples/todo-app/tests/sk-opencode-live-host-owner.ts \
     /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a
   ```

   It uses the hash-bound **staged** host source, prints the fresh URL, and retains
   ownership until `/host-join` plus child/drain/listener proof. Never rerun it for
   the same stage after an owned-origin receipt appears. New run = new stage.

2. Create a NEW uniquely named Browser Control session; all subsequent commands
   pass that exact session. No old page, profile data clearing or session adoption.

   ```sh
   bun /Users/kkrausse/.nvm/versions/node/v24.7.0/bin/browser-control session new sk-mounted-UNIQUE
   bun /Users/kkrausse/.nvm/versions/node/v24.7.0/bin/browser-control execute --json --session sk-mounted-UNIQUE 'return {url:page.url(),title:await page.title()}'
   ```

   Require `about:blank`. Navigate to the printed URL's `/inspect-empty`, inspect
   empty origin storage using the same checks as the candidate, then navigate to
   `/` and inspect `snapshot()` before choosing the start button. The page has no
   autostart. Click **Start one owned qualification** exactly once.

3. Use short serial read-only polls for
   `window.skOpenCodeQualification.evidence.status`. Do not replay start after
   ambiguous command completion. At `mounted-awaiting-ui-admission`, inspect
   `snapshot()` and capture a new screenshot; manually review the visible native
   selected session, actual controller empty/idle snapshot and no send surface.
   If using Browser Control `handoff`, register it before the confirmation action
   and independently verify native/session facts afterward. The total candidate
   watchdog is 180 s, not extendable; no retries or rearm. Confirm the rendered
   empty idle root with the visible button only after review.

4. Await `mounted-qualification-only` and `evidence.exported===true`; inspect new
   `live-evidence.json` and every `codec-N.json`, including clean guest exit,
   zero-work and local-SSE join facts. This status still says retention/remote-zero
   ref **false**. Failure or expiry = stop, preserve ownership/evidence, escalate;
   do not invoke reset, force shutdown, create replacement origin or clear storage.

5. From this exact page, POST `/host-join` (ordinary **host**, not guest API), then
   join the host-owner initiator's actual completion. Inspect
   `host-process-join.json` and `host-listener-absence.json`; verify both drains,
   child exit and listener absence and retain initiator completion output. Delete
   only the newly owned Browser Control session after successful guest+host joins.

Live runs/manual admissions/native-root proofs at publication: **0**. The commands
are a runnable handoff, not fabricated evidence that they ran.

## Remaining gates and commit notes

General retention remains blocked by missing server-owned generation lease/drain
receipts. Local finite EOF, codec parity, active-empty inventory, controller/SSE
disposal or debug-key disappearance cannot establish remote zero references.
Cancellation, concurrent cancelled readers, session children, plugin callbacks,
tools/finalizers, PTYs/background shells and independently owned clients remain
unqualified. Changed plugin/module/dependency/environment/config needs restart;
no process/location reset is enabled here. No controlled non-inference core
finalizer fixture was fabricated. Restricted inference requires separate parent
review/admission; this concurrent controller foundation is not the serial gate.

Implementation commits: `6e5b3cc`, `82f17d8`, `baaca88`, `eed0950`, `584d853`, `874e759`.
The first commit unintentionally included a concurrently **already staged parent**
status-report update (`docs/experiments/2026-09-30-single-kernel-status-and-direction.md`).
This agent did not edit that file or revert it. The parent was notified immediately;
all later implementation commits used explicit `git commit --only` paths. Nothing
was pushed. This report is a separate own-file commit; it does not change the
frozen final consumer/source identity above.
