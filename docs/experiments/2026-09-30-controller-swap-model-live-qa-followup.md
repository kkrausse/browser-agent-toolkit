# Controller-swap model QA follow-up — capture-helper failure, not accepted

## Outcome and historical separation

**NOT ACCEPTED.** This newly authorized cohort passed **6 initial guards**, then
stopped on a capture-helper timeout: **0 completed checkpoints, 1 failure**.
No typing, controller switch, model selection, release/reject, Enter or Send took
place. Headless **0 run**: visible acceptance was its prerequisite.

Previous `63dc19a` remains unchanged: **3 checkpoints / 10 guards passed, 1
JSON-order oracle failure**. Its A→B→A composer-local draft observations are
historical partial evidence, not rerun or relabelled by this follow-up.

This follow-up fixes only the request-body QA oracle and adds a separately named
dedicated wrapper QA runner. No production, frozen wrapper, adapter, fixture,
server, original QA script, previous report/evidence or parent status file changed.

## Exact semantic oracle / new runner

New file: `opencode-chat/scripts/controller-swap-model-browser-qa-followup.ts`.
It parses the retained raw body and requires exact sorted outer keys `model`,
exact sorted model keys `id,providerID`, string types, provider `p`, and intended
model `m2` (or reverse `m`). Its browser guards require POST, exact A/ses1 model
route, exact hold/write count and unchanged B receipts. Member ordering is not
a protocol requirement here; no production pinned-codec byte-parity rule changed.

Concrete oracle preflight: **6/6 pass**. Both key orders accepted; extra outer
field, extra model field, wrong type and wrong value rejected. This is a narrow
counterexample check for the observed failure, not a generic unit-test scaffold.

The runner emits its self-contained function through Bun for visible CLI use and
contains a separate ephemeral headless Brave/Playwright Core launch path. That
headless path was **not executed or qualified**. Full pending/release/reject/send
checks exist in the new runner but remain unexecuted, not acceptance evidence.
The runner is committed verbatim with its diagnosed capture defect, not repaired
after a failed run.

| QA source executed | SHA-256 |
| --- | --- |
| Runner | `12793b69420486059abd1996179b9b37da37f37df8954b59b48e23e4ba1ceb2e` |
| Emitted visible code | `13773986e5d288b3283fb35bf43d42d4c161df3ae6fc7ef17bffe9d9bab540aa` |

## Frozen identity / fresh isolation

Read the full handoff previously and reread all runnable/live assertions for
this follow-up. Same candidate `691cd5aa0880349968773047402adec0bfeb16df`, repaired
offline handoff `e1048ed`, exact frozen wrapper/adapter/server bytes.

Executed the handoff's serve-only command with `QA_SERVE_ONLY=1`, candidate root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat`
and frozen output:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final`.
Server verified candidate manifest/all transitive source hashes/all harness hashes
and its own frozen source before listening; no rebuild occurred.

New origin **http://127.0.0.1:64402/**, owned PID **99844**, shell
`sh_0f3f0155f001Px3Y2OfjGARrrQ`. New serving receipt:
`frozen-final/serve-receipt-99844-1790798992776.json`.
Actual fetched JS/HTML matched before browser actions and are retained:

| Frozen artifact | SHA-256 |
| --- | --- |
| JS | `6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47` |
| HTML | `95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a` |
| Freeze receipt | `6ae1e31df41a28c441b30d53a6ad5d63941c2ef2752d199bf20617092c8fa0b9` |

Bun **1.4.0**, Bun-backed Browser Control CLI **0.8.2**, fresh owned session
**tidy-otter-893**. No MCP, relay restart, existing user profile/tab/origin/storage,
native-global repair, forced click or input-mutation bypass. The only browser
navigation was to the new owned origin; no app controls were acted on.

Fresh evidence root (created by `mktemp`, previously nonexistent):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-model-followup-LC2QC1`.
It retains serving receipt, runner-at-execution, actual served bytes/hashes,
oracle preflight, result, emitted code, full journal, separate read-only failure
receipt/PNG, cleanup and recursive `evidence-sha256.json`.

## First failure / precise contract

Initial six guards passed: both ready with zero counters/errors; each fixture's
only write was completed activation POST; selected A connected/idle ses1,
not loading/pending; actual retained `section.oc-chat` DOM reference equal to
current node; rootSame=true/rootChanges=0/profilerMounts=1.

Then the capture helper tried `getByRole('combobox', {name:'Model', exact:true})`
and `isDisabled()` before expanding **Session & model**. The collapsed details
exclude its controls from the normal accessible-role query. Exact failure:

```text
TimeoutError: locator.isDisabled: Timeout 5000ms exceeded.
  - waiting for getByRole('combobox', { name: 'Model', exact: true })
```

The automatic first-failure capture hit the same locator timeout; its error is
retained in `result.json`. No assertion was retried or candidate action continued.
A separate read-only preservation command avoided that role query, recorded DOM
control attributes and saved `preserved-first-failure.png`. Presence/rectangle
metrics for DOM descendants are **not** proof of role accessibility within closed
details. The failure is an agent-authored **QA capture-helper defect**, not an
app model defect or Browser Control transport failure.

Actually opened and inspected the PNG: Session & model collapsed, empty composer,
Ready, disabled Send (empty draft), both fixture cases ready, zero holds/prompts
and no switches. No A/B draft lifetime experiment occurred in this new cohort.
No model raw request exists here: the preflight examples and prior cohort's raw
body must not be passed off as a new live model request.

### Browser Control / QA project todo

- [ ] Separately authorized new cohort must make evidence collection safe for
  collapsed details without bypassing trusted action controls. Expected: capture
  initial receipt and state without requiring hidden accessible controls. Actual:
  capture timed out before checkpoint completion. Version/session/origin/error
  and deterministic emitted-code reproduction retained above. Recovery attempted:
  read-only evidence preservation and exact owned cleanup only. No relay/global
  repair, forced click, control expansion, retry or wait-to-green.

## Network, console and limits

Two observed app loopback GETs (`/`, `/lab.js`) and two extension-local scripts:
`aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js` and
`liecbddmkiiihnedobmlmillhodjkdmb/js/recordConsoleEvents.js`.
Console: React DevTools info plus favicon 404; **zero page errors**.
LocalStorage keys empty; SessionStorage contains classified extension marker
`__darkreader__wasEnabledForHost`. No storage clearing or app persistence.

No real inference, paid/provider requests, actual provider switching, backend
durability, pinned-codec parity qualification, full packaged workspace acceptance,
or disposal/handshake-flake qualification. Model lifecycle browser acceptance and
independent headless engine/request-denial evidence remain pending.

## Cleanup / exclusive slot released

Preserved evidence before deleting only session `tidy-otter-893` and SIGTERM'ing
only PID 99844. Exact server shell joined with SIGTERM completion. Independent
`ps` and port-64402 listener `lsof` checks both exit 1 with empty output; owned
session absent from inventory. No headless browser/context existed. Other tabs,
sessions and hosts untouched. **Exclusive visible Browser Control ownership
released.**
