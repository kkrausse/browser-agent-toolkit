# Controller/model complete live QA — visible pass, headless not accepted

## Outcome

**Visible local-fixture acceptance PASS: 9 checkpoints / 91 guards, 13 captures.**
**Complete visible+headless acceptance NOT achieved.** The serial headless cohort
stopped on its first model-hold assertion after 3 checkpoints / 21 guards. It also
used installed Playwright Core **1.63.0**, not the requested **1.62.1**. The engine
prerequisite was read concurrently with launch instead of checked beforehand: an
agent-authored QA qualification mistake. No retry, continued action, production
patch, forced action, or wait-to-green followed the failed assertion.

New runner: `opencode-chat/scripts/controller-model-complete-qa.ts`. Old runner
`controller-swap-model-browser-qa-followup.ts` remains unchanged (SHA-256
`12793b69420486059abd1996179b9b37da37f37df8954b59b48e23e4ba1ceb2e`). Previous
`63dc19a` and `8cb984b` reports/evidence remain failed historical cohorts, not
relabeled. The former JSON-order oracle and latter hidden-role capture timeout
were read before this new run. No frozen/production/parent-status file changed.

## Frozen provenance / isolation

Candidate **691cd5aa0880349968773047402adec0bfeb16df**, handoff **e1048ed**.
Ran the exact handoff serve-only command (`QA_SERVE_ONLY=1`), candidate source:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat`

Frozen output:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final`

The server verified frozen source/manifest/transitive harness identities before
listening, without rebuild. Fresh random owned origin **http://127.0.0.1:49272/**,
PID **9732**, shell **sh_0f40331b20014XN8D9IVHK0ob2**. Unique serving receipt
`frozen-final/serve-receipt-9732-1790800245210.json` retained in evidence.

Both cohorts fetched, retained and verified actual served bytes before UI actions:

| Artifact | SHA-256 |
| --- | --- |
| JS | `6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47` |
| HTML | `95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a` |
| Freeze receipt | `6ae1e31df41a28c441b30d53a6ad5d63941c2ef2752d199bf20617092c8fa0b9` |
| New runner at execution | `bbc9b10e43a3dac11bd53014661532470b642f36c1954f5287c269a6082fddfa` |
| Emitted visible code | `44cd4d778109d8900e65318bd526dbf08afed7ef83c47337d43bac1764e538a7` |

New previously nonexistent evidence root (mktemp; per-cohort mkdir refuses existing
output):

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-model-complete-fOXtnm`

Contains executed runner/code, served bytes, hashes, oracle preflight, all gates
and raw fixture write bodies, results, viewport PNGs, full visible journal,
headless first-failure receipt/PNG, engine closure, exact cleanup, summary and
recursive `evidence-sha256.json`.

## Corrected observer / exact oracle

Capture reads native `details.oc-settings.open`. In all five pre-model captures
it records **settingsExpanded=false / controlsNotQueried=true**; it never queries
Model or New chat by accessible role when collapsed. Public receipt `pending`
is the fixture wrapper's `sessionOperationPending`, not inferred accessibility.
Only the actual model step clicks the ordinary summary, then inspects the actual
settings roles/options and performs ordinary option clicks. The first-failure
collector uses receipt/text-content reads and a viewport screenshot, without any
control-role calls. Thus the prior hidden-role observer timeout is not repeated.

Exact semantic oracle sorts keys, demands only outer `model`, only nested
`id,providerID`, exact string types and intended `p/m2` or `p/m` values. Concrete
preflight **6/6**: both key orders accepted, extra outer/nested keys and wrong
type/value rejected. Actual raw bodies retained, not normalized away. No actual
pinned-codec byte-parity rule outside this injected fixture was relaxed.

## Visible — completed trusted UI acceptance

Bun **1.4.0**, Bun-backed Browser Control CLI **0.8.2**, new owned session
**gentle-sparrow-704**. Used `bun /Users/kkrausse/.nvm/versions/node/v24.7.0/bin/browser-control`
throughout; no MCP, relay restart, adopted user tab, user origin, storage
clearing/repair, dispatched/forced click, controller-call substitute, or scripted
input mutation. Ordinary `pressSequentially`, Enter and locator clicks only.

1. Both controllers ready, no ready errors, zero holds/releases/rejects/prompts/
   unexpected writes. Each activation POST completed without a model hold.
   A connected/idle ses1, loading=false, pending=false.
2. Typed `qa-A-private`; Controller B click produced empty B composer, no A leak.
3. Typed `qa-B-private`; Controller A click produced empty A composer, neither
   private draft restored/leaked. No prompts. Child textarea remount permitted.
4. Typed `qa-A-current-session`, expanded summary, inspected real settings and
   both options; selected `QA Model Two · p`. Exactly one held A/ses1 POST with
   exact semantic p/m2 body, B unchanged, pending=true, text preserved.
   Send/Model/New chat disabled; textarea editable.
5. Appended `-pending`, pressed Enter. Exact draft
   `qa-A-current-session-pending`, zero prompts, still exactly one hold and all
   three controls disabled (no second admission).
6. Clicked Release model mutation: holds=1/releases=1/rejects=0, held=false,
   pending=false, chosen p/m2, text intact, controls reenabled. Zero prompts both
   immediately and after the explicit 300 ms observation interval.
7. Selected real `Model · p`: second A hold, exact p/m body, text unchanged,
   pending controls disabled. Enter again produced zero prompts.
8. Clicked Reject model mutation: holds=2/releases=1/rejects=1, held=false,
   pending=false, last successful model p/m2. Recoverable visible injected
   transport error, text intact, zero prompts immediately/after 300 ms. Send and
   Model reenabled. Explicit Dismiss UI click cleared error; B unchanged.
9. Only then clicked Send: exactly one A POST `/proxy/api/session/ses1/prompt`
   with current exact draft; composer empty after success; B promptCount=0.
   No invented history echo (fixture does not stream accepted text).

Independent saved **actual `section.oc-chat` ElementHandle equality** passed,
alongside rootSame=true/rootChanges=0/profilerMounts=1, across controller switches,
hold/release and final send. Final receipt: profilerUpdates=146, commits=30,
switches A→B→A; no child textarea identity assertion.

Retained model raw bodies:

```json
{"model":{"id":"m2","providerID":"p"}}
{"model":{"id":"m","providerID":"p"}}
```

Final A writes: activation, those two model POSTs, then prompt body
`{"id":null,"text":"qa-A-current-session-pending","delivery":null,"resume":null}`.
B's entire fixture receipt remained byte-identical to its initial receipt:
ready=true, only activation write, all counters zero.

Actually opened and inspected `3-B-empty.png`, `7-pending-Enter.png`,
`11-rejected-immediate.png`, `13-explicit-Send.png` and the supplemental
`final-manual-viewport.png`. B visibly empty/Ready; pending draft retained with
disabled controls/Preparing chat; rejection visibly reports injected transport
error with p/m2 retained, draft intact and enabled Send. The first final screenshot
partially clipped bottom controls; the read-only supplemental root-scroll capture
shows empty composer, selected QA Model Two, enabled Model/New chat, disabled Send
for empty text, Ready, no alert. Images were opened, not merely saved.

## Headless — first failure preserved, NOT qualified

Serial after visible pass and image inspection; fresh ephemeral context, no
profile/storage reuse. Brave **154.0.8037.58**, Playwright Core **1.63.0** (wrong
required version), viewport 1280×1100, service workers blocked. Context routing
denied every non-owned-origin request; **denied=[]**, observed only `/` and
`/lab.js`. No actual provider request.

Initial readiness, A→B empty and B→A empty checkpoints completed; actual outer
DOM equality/rootChanges=0/profilerMounts=1 passed. At model step, expanded roles
were inspected; the immediate option inventory was **[]**, unlike visible's two
options. Ordinary option click returned, but the next receipt had pending=false
and **zero model holds/writes**. First assertion:

```text
Error: m2-held: pending exact hold count
```

First-failure collector succeeded without hidden-role lookup. Opened the actual
PNG: summary expanded, server-default model still shown, A current draft intact,
Ready, enabled Send, no error. Full counters: both ready, activation only,
holds/releases/rejects/unexpected writes/prompts all zero. No raw live headless
model body exists. Receipt identity rootSame=true/rootChanges=0/profilerMounts=1,
profilerUpdates=57/commits=17. No append/Enter/release/reject/Send checkpoint ran.

The version mismatch is a definite QA observer/engine qualification gap. The
model-click/receipt timing or selection cause is **not established** by this
stopped run; it must not be promoted to a production regression or accepted
headless model coverage. No diagnostic action retried the failed cohort.

### QA / Browser Control project todo

- [ ] Before a separately authorized new headless cohort, resolve and assert
  Playwright Core 1.62.1 **before launch**, then inspect/wait for the actual open
  menu before choosing an option and define the legitimate model-admission
  completion boundary before checking counters. Preserve this failed source and
  evidence. Expected one admitted A p/m2 hold; actual zero holds and model unchanged.
  Exact engine/source/error above. Recovery attempted: evidence and owned cleanup
  only. No Browser Control transport failure, native-global repair or relay change.

## Errors / limits / cleanup / release

Visible console: React DevTools informational message, favicon 404 only; zero
page errors and zero Browser Control warnings. Observed app requests restricted
to loopback plus two extension-local injection/console scripts. Headless console
DevTools info only, zero page errors. The intentionally injected rejection is
expected fixture error, explicitly dismissed through UI.

Local stub only: **no real inference/provider validation, backend model durability,
full workspace/packaged app qualification, pinned-codec parity qualification,
disposal/handshake-flake acceptance**, or acceptance of later production owner/SDK
changes. This lab remains the frozen 691 candidate, not 724909b/7713686.

Headless `finally` closed owned context/browser and saved its receipt. Deleted
only `gentle-sparrow-704`; first delete command's unsupported `--json` was rejected
without deleting anything, then supported deletion succeeded. SIGTERM only PID
9732; exact server shell joined with SIGTERM completion. Independent `ps` and
port-49272 `lsof` both exit 1/empty; owned session absent from inventory. Other
sessions/tabs untouched. **Exclusive visible Browser Control slot RELEASED.**

## Commit provenance

Only these two QA paths were staged by this agent. Concurrent commit **fa5bbaf**
briefly captured them with another agent's preparation report before this agent's
`git commit --only` ran (it reported nothing to commit). The other agent then
replaced its commit with **3fbe8b7**, excluding the QA paths. This agent did not
rewrite either commit. Report is now independently committed as **eae659c**;
the runner and this corrected provenance use a subsequent own-path-only commit.
No push.
