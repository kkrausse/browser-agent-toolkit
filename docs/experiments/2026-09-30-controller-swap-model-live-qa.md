# Controller swap / model live QA — stopped on QA assertion defect

## Outcome

**Not accepted.** Visible cohort completed readiness and A→B→A checkpoints
(10 individual guards passed), then stopped at its first failed assertion.
The failure is an agent-authored JSON property-order comparison, not evidence of
a production model-switch defect. No retry, release, rejection, Enter, explicit
Send, or headless cohort followed. Headless: **0 run**, no engine acceptance.
This failed run is preserved rather than repaired into green.

Read the full repaired-harness handoff (`e1048ed`), previous failed optional
wrapper report (`6aa7fd8`), frozen wrapper/adapter/server, and candidate
`691cd5aa0880349968773047402adec0bfeb16df` provenance before testing.
No production source, fixture, existing runner, or parent status report changed.

## Frozen identity / ownership

Ran the handoff's exact serve-only command with `QA_SERVE_ONLY=1`, candidate root
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat`
and output
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final`.
The frozen server validates candidate manifest, every transitive source hash,
all frozen harness files, and its own source before listening; it did not rebuild.

Fresh random origin `http://127.0.0.1:63768/`, owned PID **96295**, shell
`sh_0f3e76db5001WciAaankHvvgF2`. Serving receipt:
`frozen-final/serve-receipt-96295-1790798425575.json`.
Actual fetched HTML and JS were hashed and retained **before browser actions**.

| Artifact | SHA-256 |
| --- | --- |
| Served JS | `6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47` |
| Served HTML | `95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a` |
| Freeze receipt | `6ae1e31df41a28c441b30d53a6ad5d63941c2ef2752d199bf20617092c8fa0b9` |
| Wrapper | `5e1458bdf8ee8f55e6aa2d77ad2b6dc5872137664787b2d1768e7f95e7b639f7` |
| Adapter | `71b0876fcbe42f992e3c748f14382befa2ef160bc3427cf578d9f8ed4fbe90b5` |
| Frozen server | `1d788bcf049e13001d737f9d320edb839988689929d5aad3e7b0d067fd042a7f` |

Visible: Bun **1.4.0**, Bun-backed Browser Control CLI **0.8.2**, new owned
session **rapid-raven-880**. No MCP, relay restart, existing user tab/origin,
storage clearing, forced click, dispatched click, or input mutation bypass.
Actions used ordinary locator clicks, `pressSequentially`, and real model options.
DOM evaluation only read outer-root identity and storage key sets.

Evidence directory (absolute):
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-model-live-qa`.
It contains served bytes, serving receipt, six PNGs, `visible-gates.json`,
`visible-failure.json`, full `visible-journal.jsonl`, `cleanup.json`, and
`evidence-sha256.json`. The journal preserves the exact erroneous assertion.

## Observed gates / first failure

1. Both actual controllers ready, no ready errors; selected A connected/idle,
   selected `ses1`, loading/pending false. Both activation POSTs completed;
   all holds/releases/rejects/prompts zero.
2. Trusted type `qa-A-private`, switch to B: B empty. Independently retained
   actual `section.oc-chat` ElementHandle is strictly equal to current DOM root;
   rootSame=true, rootChanges=0, profilerMounts=1; zero prompts/unexpected writes.
3. Trusted type `qa-B-private`, switch back to A: A empty, not restored A text
   and not B text. Same identity/counter guards pass. Child textarea identity
   was deliberately not asserted. **Composer-local draft lifetime ends on each
   controller prop switch.**
4. Trusted type `qa-A-current-session`, expand Session & model, inspect Model
   combobox/listbox, select real `QA Model Two · p` option. Assertion
   `first exact model hold` fails because it requires this serialization:
   `{"model":{"providerID":"p","id":"m2"}}`.

The preserved actual body is `{"model":{"id":"m2","providerID":"p"}}`:
semantically the same exact two-field model object, but different key order.
The QA incorrectly compared `JSON.stringify(heldBody)` with a literal string.
**Do not claim this as a candidate defect or a passed model checkpoint.**
No action followed the failure. Read-only preservation observes A pending=true,
ses1, one held POST `/proxy/api/session/ses1/model`; releases=rejects=unexpected
writes=prompts=0. B remains ready with zero holds/prompts and only its activation
write. Outer DOM reference still equal; profilerMounts=1/rootChanges=0.
Draft remains exactly `qa-A-current-session`; Send, Model, New chat disabled;
textarea editable. These are post-failure diagnostic observations, not continuation
of an accepted checkpoint. Append/Enter, release, no-auto-send intervals, rejection,
recovery and explicit one-prompt behavior remain **untested here**.

Opened and actually inspected `visible-B-empty.png` and
`visible-first-failure.png`: B shows empty composer/Ready; failure image shows
A text retained, Preparing chat, disabled Model/New chat/Send, held receipt and
no prompt writes. Screenshots are full-page and include tall fixture receipts;
reads and screenshots are sequential rather than atomic.

## Network / console / limits

Observed requests: two app loopback GETs (`/`, `/lab.js`) and two extension-local
scripts (`aeblfdkhhhdcdjpifhhbdiojplfjncoa` inline injection and
`liecbddmkiiihnedobmlmillhodjkdmb` console recording). Console contains React
DevTools info and one favicon 404; zero page errors. No remote provider requests
observed. LocalStorage keys empty; SessionStorage keys are the classified
extension/tool markers `__darkreader__wasEnabledForHost` and
`__browser_control_ghost_cursor_position__`. No storage changes/clearing requested.

All model responses are deterministic injected fixture gates. No paid inference,
actual provider validation, backend durability, packaged workspace acceptance,
or inherited disposal/handshake-flake qualification. No dedicated headless
runner was created or launched because visible acceptance was a prerequisite.

### QA / Browser Control project todo

- [ ] A separately authorized new cohort must compare the model object semantically
  (exact keys and values), never JSON property order. CLI 0.8.2, owned session and
  origin above; deterministic reproduction and exact error in preserved journal.
  Expected: explicit p/m2 model object, one A hold, B untouched. Actual: correct
  object serialized id-first, mistaken assertion fails. Recovery: evidence capture
  and owned cleanup only. No Browser Control transport failure or repair occurred.

## Cleanup / slot release

After evidence preservation, deleted only owned session `rapid-raven-880` and
SIGTERM'd only PID 96295. Background shell joined with SIGTERM completion.
Independent `ps` and listener `lsof` checks both exit 1 with empty output;
owned session absent from inventory. No headless context/process existed.
Other sessions/tabs untouched. **Exclusive visible Browser Control ownership
released.**
