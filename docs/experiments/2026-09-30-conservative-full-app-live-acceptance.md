# Conservative full-app live acceptance — stopped at focused observer failure

## Outcome

**One visible original-suite cohort attempted; zero all-green cohorts.** All 19
application stages, five hydrated TODO-add/PDF generations, same-document HMR,
OpenCode SSE handshake/cancellation, orderly application shutdown and durable
reload checks completed. Focused case **0, step 0** failed before its HTTP test
body: `AggregateError: WorkspaceError: Workspace is not open`. No focused step
completed; cases 1–9 were not reached. The suite stopped without retry, timeout
increase, assertion relaxation or production modification. **Editor switching,
pending-reload and startup-503 recovery remain unrun.** No editor host launched.

This is a failed integrated acceptance cohort with useful completed application
coverage, not a runtime regression diagnosis or a full-suite pass. Headless: zero.
Inference/model calls: zero; the original suite prohibits its model route.

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-conservative-full-app-live-acceptance.md`.

## Owned cohort and immutable identity

- Frozen input: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-Yb8T8p/frozen`.
- Fresh run copy: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-live-20260930-once`.
- Evidence: `/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/conservative-full-app-live-evidence-20260930-once`.
- Application origin `http://127.0.0.1:64539/`, host PID **3658**; contracts origin
  `http://127.0.0.1:64538/`, host PID **3659**. Both ports OS-assigned; each host
  launched once. Original origin receipts retained; this failed run copy is retired.
- Bun-backed Browser Control CLI, installed 0.8.2, existing extension-connected
  visible browser; no browser installation, relay replacement, MCP or headless
  substitute. Named sessions `single-kernel-app-85da1b1a` and
  `single-kernel-cases-a6cc76e0`. The original driver creates both explicitly before
  first execute; retained session-new receipts show successful creation. A session
  list was read before launch; no nonexistent-session attempt occurred.
- Driver background job `sh_0f46d4c5f0011ToFJ403ORb07O` joined with exit **1**.
  Its exact command/output is retained. Numeric driver PID was not separately
  captured; final process enumeration found no remaining run-owned initiator,
  CLI/output-reader or host process. Host jobs joined after exact-PID SIGTERM.

Before any listening host/browser operation, `--verify` rechecked **9,677** frozen
files and receipt SHA-256
`9b4d37a89ff57943caa45a222951ba2788a9e5980a1960c1e89e17b8c488f64b`.
The complete preparation parent, isolated sources, archives and provenance remain
retained. Independent read-only source reversal later confirmed both QA adaptations
reverse byte-for-byte to their originals. Archive hashes matched the handoff:
toolkit `35a01cf1f209f378d44d07f49c799ba3c7b79ef54eb3cfca431ca54e9e811914`;
runtime `a76baad09c091b03d7dbc2563dc28b781e4a14e5e7c02888e932796393f5c832`.
The original driver independently checked all receipt hashes and driver-source
hashes before its browser actions. Native artifacts are verified prepared reuse,
not newly compiled in this QA.

Runtime `33fa1359a003ca9c50cb3bc49699b99bc1a063f1`; toolkit
`d0eec346dbc749db1c0cd82dd8aad0b27c1da363`; version
`3debc8095c310192bac6062bb963e0ee09a431246cc8bafb7be2f5a1f2655a62`.
Actual SDK/endpoint/PID-egress matching assets were used, not old e35 relabelled.
Independent HTTP reads from the actual app host matched:

| Served output | SHA-256 |
| --- | --- |
| Full acceptance client | `63f77f41dd2b2cba00a56555024d49ae364e45ebf506763cc807fba7e1a25310` |
| Kernel `kernel-worker-5EzLFeOC.js` | `1901f5b19c06cfea796a84395a7e46d0159690c61deeba4451ffaaf672aeea7c` |
| Process `process-worker-ZQRq3H73.js` | `ea2ac260ff11636b1aa66378eb51d629abd3ddc9b49918dd24702767b688bad7` |

The read-only served-hash helper also queried two **nonpublic** `sdk/assets/`
paths and retained their 404 bodies; those are not served-runtime mismatches.
OpenCode actual-648 artifact is unchanged as receipted in preparation.

## Commands and unchanged acceptance policy

```sh
bun examples/todo-app/tests/conservative-full-app-prepare.ts --verify "$FROZEN"
bun examples/todo-app/tests/conservative-full-app-prepare.ts --run-copy "$FROZEN" "$RUN"
bun "$RUN/qa/serve-single-kernel.js" "$RUN"
bun "$RUN/qa/serve-single-kernel.js" "$RUN" --contracts
SINGLE_KERNEL_AUTHORIZE_RUN=yes bun "$RUN/qa/conservative-full-app-driver-qa.js" "$RUN" "$EVIDENCE"
```

Here FROZEN/RUN/EVIDENCE are the exact absolute paths above. The run-copy path did
not previously exist; neither origin receipt existed before its single launch.
Only pre-existing frozen QA adaptations were used: exact revision/source-root
admission and the guest fetched-body fixture's supported `host.vivari.internal`
host alias. No actions, generations, ordering, assertions or deadlines changed.
Driver stage/read/interactive budgets stayed 120,000/15,000/60,000 ms; retries **0**;
post-close worker census **15 seconds**. No close observer was added; original CDP
censuses and raw diagnostics were retained rather than replaced with registry counts.

## Completed and unrun checks

The 19 app stages in `app-evidence.json`, in original order:

1. `open`
2. `child-sync`
3. `binary-capture-boundaries`
4. `filesystem`
5. `minimal-async-spawn`
6. `minimal-spawnSync`
7. `minimal-execSync`
8. `fetched-body-evicted-pin`
9. `concurrent-watch-flush`
10. `http-backpressure`
11. `persistence-recreate`
12. `apps-1`
13. `hmr`
14. `opencode-sse-abort`
15. `apps-2`
16. `apps-3`
17. `apps-4`
18. `apps-5`
19. `shutdown`

External unchanged Playwright actions qualified hydration/input admission, visible
TODO Add and fixture PDF generation in each generation. Five PDF receipts are
**851 bytes** each (`0134`, `0185`, `0223`, `0261`, `0299.json`). This does not
invent toggle/delete coverage beyond the original actions. A/B/A/B/A generations
had new process groups 1–3, 4–6, 7–9, 10–12, 13–15 with one retained kernel at
each app checkpoint; both services restarted, no process/cache-retention treatment.
HMR checked the same preview document; SSE retained a real `server.connected`
handshake, cancellation and subsequent health/zero-pending-HTTP assertions.

Application close completed through the public controller, then census
`0307.json` showed no scoped workers. Reload restored the exact durable marker;
`reload-evidence.json` retains `persistence-reload` and `shutdown`, and census
`0362.json` again showed no scoped workers within the unchanged 15-second window.
Public activity records retain Vite SIGTERM/143/`forced:true` exits, OpenCode normal
exit 0, stdout/stderr drains and runtime/workspace closes. Intentional guest signal
stop is not failed-page destruction. Final pre-close diagnostics observed zero
processes/listeners/pending HTTP/fetch active/queued/inflight/pins/cache/spills and
lazy inflight; these samples are not global all-writer join proof.

Focused attempted case: **0 / 0**, “HTTP request abort before headers closes the
guest socket.” `failure-contracts.json` has `steps: []`, `topology: []`; startup
events show a real kernel/workspace became durable/open. Its lifecycle observer
failed at both `started` and `stopped`, before the HTTP contract body could spawn
its guest. Cases **1–9 and all their steps** were unrun. No case-0 original
post-close census was reached because the action failed first.

### Concrete observer identity defect, not repaired here

The delivered focused client contains **two independent workspace internals
WeakMaps**. `diagnoseWorkspace` at lines 921–927 reads `workspaceInternals`, while
the frozen test-library `Workspace2.open` stores objects in `workspaceInternals2`
(lines 2134, 2327). `browserCase` opens `Workspace2` (line 2552), then invokes the
observer (2563) which calls the first library's `diagnoseWorkspace` (3325).
Consequently its lookup has no entry and throws `Workspace is not open` despite
the other instance having just opened the workspace. The stopped observer repeats
that mismatch (2570). This source/bundle identity evidence explains the observed
two-error AggregateError without proving a runtime lifecycle failure.

The unchanged harness subsequently awaits `workspace.close()` (2575). The retained
AggregateError contains only those two observer errors, not a close rejection;
however no separate native terminate-call or public case-close join receipt was
instrumented. Post-failure observational census/locks found only the owned page,
zero scoped worker targets and no held/pending locks. That later observation is
**not** a substituted passing case or deadline census. Do not patch the frozen
bundle or retry this failed run copy. A future narrowly repaired focused consumer
would need one consistent built-library identity, new frozen provenance and fresh
independent authorization/origins, with original assertions/actions/deadlines.

## Manual evidence, timings and errors

Three bounded **viewport**, never full-page, screenshots were opened and inspected:
`app-stage-viewport.png` shows actual app `apps-1` in startup with blank preview;
`app-preview-viewport.png` was captured after reload/shutdown, with ready durable
evidence and blank preview; `contracts-failure-viewport.png` shows the failed
focused consumer. The second filename does **not** mean a hydrated-preview manual
capture: the five hydrated previews were qualified by the original driver but
missed by the manual screenshot timing. No extra generation was replayed to obtain
a prettier image, and no manual editor-control qualification is claimed.

Naturally logged Vite listen times for generations 1–5: **9,932 / 1,897 / 1,800 /
1,864 / 1,798 ms**. OpenCode listen times: **2,078 / 2,206 / 2,085 / 2,081 /
2,069 ms**; connect times **510 / 3,853 / 3,650 / 3,637 / 3,663 ms**. These are
descriptive readiness events, not matched baseline performance or a measured
switching speedup. Original action timings/journals remain raw.

Browser warning/error logs retain favicon 404s, native initialization deprecation
warnings and stylesheet-preload warnings; dropped entries **0**, captured pageerror
entries **0**. The actual acceptance error and stack are in `result.json` and
`driver-output.txt`; failure-capture errors **[]**, expired/actionPending/
commandPending all **false**. Auxiliary offline SHA observation initially used an
unsupported ArrayBuffer and was corrected to Uint8Array; both exact reverse/source
checks then passed. An attempted copy of a harness-managed stage stdout file got
ENOENT; primary app evidence, screenshots and CLI journals remain retained.
`observer-helper-errors.txt` preserves both auxiliary failures. Neither was a suite
retry, altered acceptance assertion or hidden browser failure.

## Cleanup and retained limits

Raw numbered commands/receipts, whole app/reload/failure evidence, browser logs,
contract startup events, both CLI journals, screenshots, served/source hashes,
host/driver output and cleanup records are retained. `finite-checkpoints.json`
indexes original PDF/generation/census receipts; `evidence-hashes.json` hashes 799
retained files (excluding its own newly written hash manifest).

Only after evidence retention, both owned sessions/pages were deleted and exact
host PIDs 3658/3659 received SIGTERM. Both background host jobs completed, with
their outputs copied. This is **failed-cohort page removal/host cleanup**, not normal
full-suite acceptance, even though the preceding app closes completed normally.
`cleanup-verification.json` independently records empty `ps` for both PIDs, empty
listener-only `lsof` for ports 64539/64538 (all exit 1), successful session list with
both owned sessions absent, no remaining run-owned processes and removed exact
evidence lock. No user origin/storage, existing session, profile or relay was reset.
**Exclusive visible Browser Control CLI slot released.**

Post-run verification rechecked all **9,677** frozen and all **9,677** run-copy
receipt-listed files: zero mismatches. Frozen receipt stayed
`9b4d37a89ff57943caa45a222951ba2788a9e5980a1960c1e89e17b8c488f64b`;
run-copy receipt `68144a7a4e89f6cd4c2e0ae7b460285d40ffcc0c638fe3c9f26761c535f1b696`
reflects the helper's new output identity, not changed candidate bytes.

No editor cohort was authorized after this failed suite. Read-only source inspection
found real catalog `todo-browser-workspaces-v1` / `catalog` / `current`, with pending
durability before dispose/stop/replace/start, real Recover outgoing controls and
`/editor/prepared/` load requests. No interception checkpoint was tested; no runner
already implements or qualifies pending-reload/503 recovery. Four ordinary UI
switches, native hierarchy/model preservation, durable-pending interruption and
one startup-503 recovery remain pending, separately from this driver's generations.

Full `markAsUncloneable` contract failure, historical case-1 close-census failure
and inherited handshake-disposal flake remain preserved. Lazy loader/planted `/bin`
ancestor symlink is not fixed. A finite pristine-app cohort and sampled zero
registries do not prove global all-writer quiescence, tampered-tree safety, cached
artifact retention or long-lived OpenCode remote release. No pins, master status,
historical driver/report, frozen input, production source, shared dist/generated
outputs or another agent's files changed. This report is the sole owned repository
change; no new tests, no push.
