# Independent root-repair live QA — stopped at browser harness setup

Absolute report: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-opencode-root-repair-live-qa.md`.

## Outcome

**FAILED QA setup; zero mounted qualifications, zero guest launches, zero Start
clicks.** One archived host launch established a new OS-assigned origin. The first
Browser Control execute failed before creating a browser session. Under the
first-harness-failure stop rule, no recovery execute, new session, navigation,
cohort restart or wait-to-green followed. This is an operator/QA invocation error,
**not a demonstrated candidate root-contract failure**.

**EXCLUSIVE SLOT RELEASED.** Exact owned host-only forced failure cleanup is
positively verified below. No guest normal EOF/zero-work/workspace-close
qualification is claimed. `retentionAccepted:false`, `remoteZeroRef:false`.
The stage is **no longer runnable**: its immutable `owned-origin.json` exists.
Do not reopen or relaunch it; a future attempt needs a new separately authorized
stage/cohort after parent review.

Read root qualification repair (`6f88410` source / `a6e17ac` report), original
FAILED foundation live QA (`b5daa94` / `53948b5`) and delivered lifetime audit
`4b3738d`. Original failed cohort and prior evidence were not modified.

## Frozen identity and independent verification

Stage/evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf`.

| Item | Identity |
| --- | --- |
| Archived source | `6f88410877d1027bb5fb7bbd9851a82de431356b` |
| Archive SHA-256 | `fdf775fb7578669c99fb4648dd885cca852412843cc21ef5760dd055b0f1915b` |
| Frozen consumer SHA-256 | `1b4e7e5a98b586033a08691cac9f74833d536cf3c8a9a64343d2bf175e1878d7` |
| Actual delivered server asset SHA-256 | `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5` |
| Extracted actual codec SHA-256 | `8ae896cd21951fd8370239d0de61b0e61ea470cc9196f32c40df7c72000fca61` |
| Runtime revision | `e35eab4af7a53ff08eb70c09df59c40b78bfdd67` |
| Runtime/payload version | `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e` |
| Owned host origin | `http://127.0.0.1:51662/` |
| Initiator / host OS PIDs | `31836` / `31839` |
| Attempted session (never created) | `sk-root-repair-qa-20260930` |
| Bun / Browser Control | `1.4.0` / `0.8.2` |

New QA-only script:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/examples/todo-app/tests/sk-opencode-root-repair-live-qa.ts`.
Before host launch and after terminal cleanup it independently verified **66
staged/source entries, 9,588 frozen inputs**, frozen receipt, every prepared
manifest file/image/bundle hash and byte length, and re-created the exact committed
source archive in memory. Both successful receipts are retained. No frozen bytes
were changed. Consumer hash is a verified **on-disk candidate hash**, not a live
browser-observed served-byte hash: no page loaded it.

Pre-launch QA-script error is disclosed: its initial `git archive REV` wrongly
archived the entire repository, producing `Archive parity failed` (exit 1).
Reading frozen preparation identified the exact three path arguments:
`workspace-api opencode-chat examples/todo-app/tests`. Only the new QA script was
corrected, before any host launch. Correct reconstruction then matched the
recorded digest. No validation was weakened and no live failure was retried.

The archived candidate includes `691cd5a` chat repair / `d1f60e4` helper ancestry,
but excludes later `771` / `724` endpoint repairs. None of those repairs, ChatView,
or the full hardened application is qualified by this attempt.

## Exact launch and first harness failure

Executed once as owned background shell `sh_0f42529dd001mvvnJaY3gxDkhj`:

```sh
SK_OPENCODE_AUTHORIZE_HOST=yes bun \
  /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf/source/examples/todo-app/tests/sk-opencode-live-host-owner.ts \
  /Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-fe10b82e-932f-40ff-b249-171bc7c8cdbf
```

First and only browser execute:

```sh
bun /Users/kkrausse/.nvm/versions/node/v24.7.0/bin/browser-control execute \
  --session sk-root-repair-qa-20260930 --json \
  'return {url:page.url(),title:await page.title()}'
```

Actual result: `ok:false`, `isError:true`, `value:null`,
`valueUnavailable:true`, `_tag:"RelayClient.RelayRejected"`,
`message:"Session not found: sk-root-repair-qa-20260930"`, empty logs/warnings,
exit **1**. Explicit continuation requires an already-created session; the agent
incorrectly used it as session creation. No browser page or guest was created.
No fresh-origin storage inspection or initial rendered snapshot occurred.

### Browser Control project TODO

- [ ] Before a **new authorized cohort**, create the new named session with
  `session new`, or use the documented bare `execute` creation and retain its
  returned ID. Verify its owned `about:blank` page before host navigation.
  Browser Control 0.8.2 rejects execute with a nonexistent explicit session;
  expected continuation rejection matches actual behavior, so this is a QA setup
  correction, not a claimed Browser Control product defect. Deterministic repro
  is the exact execute above. Recovery was **not attempted** under the stop rule.

No MCP, shared relay restart, user-tab/origin adoption, browser profile switch,
storage clearing, credential read, reset, DELETE, source replacement, A→B,
prompt/tool/provider/model inference or paid operation occurred.

## Evidence and cleanup

Before escalation, saved independent `qa-failed-before-cleanup.json` with original
failure, preflight error, origin/session identities, zero counts and failed scope;
saved own-session/origin-target absence. This is **external QA evidence**, not an
invented native client's `failed-before-cleanup.json` or `live-evidence.json`.
Neither client terminal file exists because the client never ran.

Known returned guest service/workspace did not exist. Therefore guarded guest
cleanup, `failureCleanup.completed:true`, `/failure-host-join`, and `/host-join`
were unavailable and **not requested**. After preserving failure, independently
read exact PID/PPID/archived-command identity via `ps`. Saved
`qa-failure-escalation.json`, then sent **SIGTERM only to owned host PID 31839**.
No relay, browser, user session, other origin or other agent resource was stopped.

Archived initiator joined its child stdout/stderr/exit: host **exit 143**, both
readers joined, startup-origin stdout retained, empty host stderr. Initiator then
reported `Owned host failed` and completed with **exit 1**; its actual background
completion notification was observed and complete output copied to
`qa-initiator-completion.txt`.

Important: the immutable initiator's `host-process-join.json` labels its default
branch `mounted-foundation-host-cleanup` even on SIGTERM. **That label is not a
pass:** actual exit 143 and explicit QA escalation receipt establish forced
host-only failure cleanup. No `host-listener-absence.json` was produced by its
normal-success branch.

Independent `qa-failure-absence.json` / `qa-result.json` positively verify:
initiator PID 31836 and child PID 31839 absent (`ESRCH`), listener 51662 absent
(`ECONNREFUSED`), attempted session absent and owned-origin target absent.
Readonly CLI status was filtered to these ownership facts; no existing state was
adopted or modified. Postflight reverified every frozen hash. **Exclusive slot is
released; no further live action is pending from this QA agent.**

## Counts and unrun qualification

| Evidence / operation | Count |
| --- | ---: |
| Archived host launches | 1 |
| Browser executes attempted / successful | 1 / 0 |
| Created sessions / owned tabs / Start clicks / guest launches | 0 / 0 / 0 / 0 |
| Actual guest request attempts / finite responses / codecs | 0 / 0 / 0 |
| Actual request-schema executions / independent codec re-executions | 0 / 0 |
| Rendered screenshots / manual admission / passing qualifications | 0 / 0 / 0 |

No raw request-attempt, finite-response or codec files exist; independently counted
the directory. No empty offline loop is described as parity success. No native ID,
project/location payload, empty native inventory/hydration, idle execution,
default model, source/plugin census, guest PID/listener identity, SSE join,
nonforced guest EOF/output drain, zero-work census or workspace close was
observed. **All those checks remain unrun.** No catalog/network events were
captured; no complete-egress or `backgroundWork:false` claim is made. Actual
648's ModelsDev global fetch/background callback owner remains a known exclusion,
not executed proof here. Current SDK upload ownership gap is unqualified by this
earlier finite-body-source stage. Retention/remote-zero-ref, headless and stable-root
toy remain outside scope.

Only this new report and QA-only script are committed using explicit owned paths;
no stage/client/production/runtime/cache/model/parent-document edits, no generic
unit-test scaffolding, and no push.
