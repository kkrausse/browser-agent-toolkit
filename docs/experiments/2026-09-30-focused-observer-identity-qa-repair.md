# Focused observer identity — QA-only repair, live pending

## Outcome

**Offline-qualified, separately frozen focused-only handoff; no live acceptance.**
The concrete full-suite `70d8c23` failure was duplicate library identity: the
observer read one workspace internals WeakMap while the harness opened workspaces
through another. The repair changes QA module resolution only. No production
library/runtime change, global WeakMap workaround, skipped observer, weakened
assertion, retry or deadline increase was made.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-focused-observer-identity-qa-repair.md`.

Preparation runner:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/examples/todo-app/tests/focused-observer-identity-prepare.ts`.

**Frozen stage:**
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-identity-yzELv8/frozen`.

Receipt SHA-256:
`0f95c698427333f8d38ac21205511b803d9e368b926b672b6461da4ad1cf4f92`.
All **9,681** receipt-listed files verified, zero mismatches. Keep the entire
`focused-observer-identity-yzELv8` parent: the frozen driver checks source hashes
against its sibling isolated committed archive, not the mutable checkout.

## Narrow repair and original coverage

Inspection confirmed the actual built public `workspace/index.js` already exports
`Workspace`, `Runtime`, `diagnoseWorkspace` **and** `workspaceInternals`. There is
no need to expose a new production API. The new test-only built bridge re-exports
that entry. The focused bundler intentionally resolves both the observer package
import and test harness `../../src/index.js` / `../../src/workspace.js` imports to
the **same exact built entry path**, never to implementation source or another
independently bundled library. `qa/module-identity-evidence.json` retains every
resolver match and final module identity evidence.

The archived focused client, case selector, diagnostic assertions, harness, HTTP,
process and storage cases are byte-for-byte original; their hashes are retained.
The original `test-library.ts` source is also unchanged. Only the new stage's
`workspace/test-library.js` is a canonical built-entry re-export, rather than a
second bundled implementation.

New frozen `qa/focused-observer-identity-driver-qa.js` explicitly runs the original
focused block, **cases 0–9 in original order, every original step**, beginning at
case 0/step 0. The complete block from fresh contracts navigation through final
contract log retention is byte-identical to the original driver. Original request,
ownership, freshness, chunked evidence, failure capture and CDP census helpers are
retained. Post-close census remains **15,000 ms**; policy remains stage/read/
interactive **120,000 / 15,000 / 60,000 ms**, retries **0**.

Driver-only adaptations are explicit, uniquely matched substitutions: exact
33fa135 admission and archive source-check root; one contracts origin/session
instead of two; focused-scope admission/ownership/result labels; omission of the
already completed app phase and app-only failure diagnostics. All substitutions
reverse to the original driver **byte-for-byte**, verified during preparation.
The full original case loop SHA-256 is
`075d1bed181a901b9ec89c6f76315ec878881c2757460811fdd7b5803a9f624e`.
`qa/focused-driver-source.ts` and `qa/focused-driver-substitutions.json` retain the
new wrapper source and exact reversal. Unused original app helpers remain present;
they are not invoked. A passing result would be labelled **focused-only**, with
zero app generations, not an original full-suite pass.

The inherited full-app host-alias adaptation is retained unchanged in the copied
stage, with its existing provenance. The focused client itself needed **no** host
alias or observer source edit. Historical source, failed frozen input/run copy and
evidence are read-only and preserved.

## Offline qualification and exact candidate identity

- Fresh git archives: toolkit `d0eec346dbc749db1c0cd82dd8aad0b27c1da363`, runtime
  `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`. Archive hashes match the owner:
  `35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914` and
  `a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832`.
- Version remains
  `3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
  Reuse of the already separately built matching libraries/SDK/workers is explicit:
  every copied `runtime/`, `sdk/`, `workspace/`, `chat/` byte matches the frozen
  preparation receipt, except the named test-only bridge. All **111** owner candidate
  files verified before/after; candidate input unchanged. No shared build rerun.
- **37 native outputs** rechecked against both retained owner runtime source and
  the verified native baseline. Native compilation was not rerun. Existing native
  provenance is copied unchanged. Actual OpenCode server remains the receipted
  `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.
- Historical negative control imports the *actual old built exports*: Workspace,
  diagnoseWorkspace and internals references are distinct. Historical delivered
  focused bundle contains **two** workspace internals maps, as expected.
- New executable bundled identity probe imports the actual built public entry and
  new test bridge: **Workspace, Runtime, diagnoseWorkspace and workspaceInternals
  reference equality all pass**. Final focused bundle contains **exactly one**
  `workspaceInternals = new WeakMap`, rejecting duplication before browser work.
  This is narrow regression coverage for the observed defect, not a mocked SDK
  workspace lifecycle test. No fake host, synthetic workspace-map insertion or
  public Workspace.open execution is claimed.
- Focused client/wrapper strict consumer typecheck and preparation-runner typecheck
  both passed. Original historical consumer unchecked-index setting stays unchanged.
  Build, negative control, identity probe, source reversal and frozen verification
  passed. Original **9,677** historical files reverified before/after unchanged.
- Offline run-copy helper executed once into sibling `offline-copy-verification`;
  all receipt-listed bytes verified. It was never served. Do not use that verification
  copy as a live cohort; make a newly named copy for independent QA.

Selected hashes:

| Artifact | SHA-256 |
| --- | --- |
| Canonical built public workspace entry | `ebe505d0d5bf992daa3f70ccfb6fd1570b84e4a4311b2b816bec603f6e45c09c` |
| New focused client | `59667eea1e7d56ad5c29a9451e917df0b93af9026de07dc0a8b014052a004b0a` |
| Unchanged kernel worker | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Unchanged process worker | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |

Preparation commands/exit outputs, archive tar files, strict tsconfigs and identity
probes are retained in the frozen parent. Two earlier successful preparation
siblings (`wViXct`, `EUbJno`) are preserved; only `yzELv8` is the final handoff,
adding explicit native/typecheck and historical negative-control evidence. They
were offline builds, not live retries. This work started no browser, listening
host, guest or inference: **live/visible/headless/host/guest/model counts all zero**.

## Exact activation handoff — NOT executed here

Parent must assign independent exclusive live ownership first. Use Bun-backed
Browser Control CLI only; preserve the original first-failure policy. Choose NEW,
nonexisting absolute RUN and EVIDENCE paths; do not serve or write into frozen.
Only **one contracts host** is needed; do not start an app/editor host.

```sh
FROZEN=/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/focused-observer-identity-yzELv8/frozen
RUN=<new-absolute-focused-run-directory>
EVIDENCE=<new-absolute-focused-evidence-directory>
bun examples/todo-app/tests/focused-observer-identity-prepare.ts --verify "$FROZEN"
bun examples/todo-app/tests/focused-observer-identity-prepare.ts --run-copy "$FROZEN" "$RUN"
# Separate owned host job; capture PID/output and launch exactly once.
bun "$RUN/qa/serve-single-kernel.js" "$RUN" --contracts
# Exact driver command, after host receipt exists:
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun "$RUN/qa/focused-observer-identity-driver-qa.js" "$RUN" "$EVIDENCE"
```

No origin receipt may preexist before its single host launch. The driver creates
its named CLI session before first page execution. Capture actual served client/
worker hashes, screenshots/manual observations, raw diagnostics and original
deadline CDP censuses; retain failures without replay or altered checks. Driver
success deletes its owned session and releases its evidence lock but leaves the
parent-owned host running: independently join exact host PID/output and verify
PID/listener absence. On failure, preserve the driver-retained page/lock/evidence
before explicitly labelled owned-resource failure cleanup. Never clear unrelated
storage/session/origin. Verify frozen again after live QA. All inference remains
prohibited; this focused suite needs none.

## Remaining acceptance and limitations

Original `70d8c23` stays **failed**: 19 app stages, five generations, HMR/SSE,
shutdown and durable reload passed, but focused case 0/step 0 failed in its observer
before the body; cases 1–9 unrun. This setup repair is **not** a full-suite green
claim. Fresh focused cases 0–9/14 original steps and their closes/censuses remain
live pending. Editor ordinary switches, pending-reload and startup-503 recovery
also remain separately unrun, with no editor host launched by this work.

Historical case-1 close-census failure, full `markAsUncloneable` contract gap,
inherited handshake-disposal flake and lazy-loader/planted `/bin` ancestor-symlink
limitation remain. No all-writer quiescence, tampered-tree safety, cache retention,
long-lived OpenCode release or performance gain is established. No production,
runtime, pins, shared dist/.runtime, master status, Effect report, historical
reports/drivers or concurrently staged user paths were edited. Only this new
runner/report are owned changes; no push.
