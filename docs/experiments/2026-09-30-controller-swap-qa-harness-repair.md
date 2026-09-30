# Controller-swap QA harness repair — offline frozen, live acceptance pending

## Scope and outcome

Added separately named QA wrapper, fixture adapter, freeze/serve script, and one
narrow regression for the observed fixture gate swallowing plugin activation.
No production source, original failed wrapper/server, original browser QA script,
parent status report, or frozen candidate bytes were edited. No browser or server
was started. **This is not same-view/model live acceptance.** The immediate
New-chat criterion remains unchanged; this optional cohort does not replace it.

Candidate remains `691cd5aa0880349968773047402adec0bfeb16df`, rooted at:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat`

Owned new files under repository
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/`:

- `opencode-chat/test-ui/readiness-controller-swap-repaired-qa.tsx`
- `opencode-chat/test-ui/controller-swap-repaired-fixture.ts`
- `opencode-chat/test-ui/controller-swap-repaired-fixture.test.ts`
- `opencode-chat/scripts/serve-controller-swap-repaired-qa.ts`
- this report.

## Corrected semantics / fixture inputs

One unconditional, unkeyed `ChatView` stays at the same React tree position inside
an unkeyed Profiler. The wrapper observes the **actual `section.oc-chat` root**
identity across commits and records Profiler mounts/updates; it does not require
the child textarea to persist. The candidate intentionally keys `SessionComposer`
by controller identity. Composer drafts are component-local: switching A→B→A
remounts the composer each time. Expected A on return is **empty**, not restored
`qa-A-private`, and not B's text. Within one mounted controller/composer, a pending
model operation must preserve the current session's typed text.

Two independent frozen `fixture()` instances share `/hidden` and session IDs
`ses1`/`ses2`. A thin adapter overrides only GET `/proxy/api/model` to add a second
fully shaped fixture model (`p/m2`, label `QA Model Two · p`) alongside existing
`p/m` (`Model · p`). Server default remains the frozen `p/m`.

The only held write is **POST `/proxy/api/session/ses1/model`**, with exactly
`{"model":{"providerID":"p","id":"m2"}}` or the corresponding `"m"` body.
Malformed/concurrent requests to that exact route reject and increment
`unexpectedModelWrites`. Other routes remain frozen fixture behavior, including
POST `/proxy/api/plugin/await-activation` (HTTP 204), creation and prompt. Release
returns HTTP 204 (the pinned switch-model wire contract); reject injects a
transport Error. Holds/releases/rejects, held body, prompts and all writes are
visible in `output[aria-label="QA receipts"]` for each controller.

These are legitimate **injected fixture responses**, not actual model API or
provider validation. No artificial prompt/history echo was added.

## Offline validation and preserved failure

Bun 1.4.0. Isolated validation staging `check/` links `src`, `test`, and
`node_modules` to the frozen candidate rather than shared editable production.

- Browser bundle build-only: exit 0; no listener created.
- Strict TypeScript no-emit check of all four new code/test files with ES2023,
  Bundler resolution, react-jsx, DOM libs and bun/react/react-dom types: exit 0.
- Narrow fixture regression: **1 pass, 0 fail, 21 assertions**, 149 ms. It proves
  activation reaches ready without holds, two model options, exact held body,
  pending controller send/model rejection, release/reject counters, pending flag
  recovery and zero auto/queued prompt writes. It does not prove browser controls.

First validation test timed out: Bun's `expect(second).rejects.toThrow()` matcher
blocked before the deferred fixture could be rejected. A standalone diagnostic
confirmed the fixture/controller release and rejection paths completed normally.
The repaired test attaches a normal Promise rejection handler before rejecting
the gate. Original timeout log remains `offline-regression.log`; final pass is
`offline-regression-repaired.log`. Initial offline freeze remains `frozen/`;
the handoff is the separately created **`frozen-final/`**, never a rewrite.

Evidence root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb`

Final receipts:

- `frozen-final/freeze-receipt.json`: validates the original candidate manifest,
  hashes all transitive candidate source files, and records wrapper/adapter/server,
  bundle, HTML and exact fixture inputs.
- `offline-handoff-receipt.json`: records validation log/test hashes, final freeze
  receipt hash, preserved failed-source hashes and original artifact hashes.
- `offline-typecheck-final.log`: empty successful output.
- `offline-build-final.json`: build-only receipt output.

| Final artifact | SHA-256 |
| --- | --- |
| Wrapper | `5e1458bdf8ee8f55e6aa2d77ad2b6dc5872137664787b2d1768e7f95e7b639f7` |
| Adapter | `71b0876fcbe42f992e3c748f14382befa2ef160bc3427cf578d9f8ed4fbe90b5` |
| Server | `1d788bcf049e13001d737f9d320edb839988689929d5aad3e7b0d067fd042a7f` |
| Bundle | `6d0d5dca77986145d93d0f19642fddaf13dba5a460f284459ca123f215f0ec47` |
| HTML | `95c7bf92d4c6eea13e4dbc3b93e17ab87102103b087896d40c85821a2b5e7a2a` |
| Freeze receipt | `6ae1e31df41a28c441b30d53a6ad5d63941c2ef2752d199bf20617092c8fa0b9` |

Original failed wrapper/server still hash respectively
`c99e84eb139d29707e41969eb1ea8bccac672181b3fceb55c4daffeb1a81020d` /
`007e3721623b8f22bf327672247c30c6f9f772ee477c988f465172a98f9fb000`.
Original candidate bundle/HTML still match manifest:
`16ae8532768e09441c458b07d255b9b88cabfd3af0a22a1b2ca3c134e9d83bb4` /
`a866f88b894f599a1c92b0239eb906f9d5498ef65b3b60276e654259760109bb`.
Failed browser screenshots/journal/result and the original failure report were
not touched.

## Runnable frozen handoff — parent exclusively owns live slot

After the parent releases the browser slot, start this command in a separately
owned terminal. It serves **existing frozen bytes only**, checks hashes before
opening a listener, chooses a fresh loopback port, and prints origin/PID and a
new unique serving receipt. No origin has yet been allocated for this handoff.

```sh
QA_FROZEN_SOURCE='/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat' \
QA_OUTPUT='/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final' \
QA_SERVE_ONLY=1 bun '/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/controller-swap-repaired-46MQpb/frozen-final/qa-source/scripts/serve-controller-swap-repaired-qa.ts'
```

Use a fresh owned browser session/context, sequential visible and headless
cohorts, Bun-backed Browser Control CLI for visible work. Verify actual served
HTML/bundle hashes before actions. Capture each guard, writes, errors, screenshots,
and journal; stop at first failure and preserve evidence. Clean up only owned
PID/session. Do not repair or rerun a failed cohort into acceptance.

### Exact live assertions (still pending)

1. Wait for **both** receipt cases `ready:true`, no ready errors, connected/idle,
   selected `ses1`, not loading/pending; holds/releases/rejects/prompts all zero.
   Observe activation writes completed without becoming model holds.
2. Save the actual `section.oc-chat` DOM reference for independent identity checks.
   Trusted type `qa-A-private`; switch A→B. B textarea is empty and never displays
   A text. Root remains strictly equal to saved node; rootChanges=0, rootSame=true,
   profilerMounts=1. Textarea identity is **not an assertion**.
3. Trusted type `qa-B-private`; switch B→A. A textarea is empty, contains neither
   A's previous draft nor B's draft. Same outer-root assertions, no prompt writes.
4. Trusted type `qa-A-current-session`. Open Session & model and choose
   `QA Model Two · p` using real controls. Confirm exactly one A hold with `ses1`
   and the explicit `p/m2` body; B remains untouched. A pending=true, selected ses1,
   same textarea text; Send, Model and New chat disabled; textarea remains editable.
5. While held, trusted append `-pending` and press Enter. Text stays exactly
   `qa-A-current-session-pending`; prompts remain zero. Check model disabled means
   no second admission, holds still 1. No scripted controller sends substitute for
   the actual UI checks. Capture a held screenshot with the text/disabled controls.
6. Trusted click Release model mutation. A holds=1/releases=1/rejects=0, held=false,
   pending=false, model=p/m2. Same text; Send/Model enabled after idle recovery;
   **zero prompts**, immediately and after an observation interval. No automatic
   or queued send on release.
7. Select `Model · p` to hold a second operation, verify explicit p/m body and
   unchanged current text. Trusted Enter while held again produces zero prompts.
   Trusted Reject model mutation: holds=2/releases=1/rejects=1, unexpected writes=0,
   pending=false, last successful model remains p/m2, recoverable visible error,
   same text and zero prompts immediately/after interval. Dismiss error if needed.
8. Only now explicitly click Send. Exactly one A prompt to ses1, body text exactly
   `qa-A-current-session-pending`; B prompts zero; composer clears on success.
   Fixture does not stream accepted text into history, so transcript echo is not
   required or fabricated. Capture receipt and final controls.

Identity evidence is the actual outer DOM reference plus stable unkeyed source
position and Profiler boundary, not a private React fiber introspection hook.
Offline gate/controller assertions do not replace these trusted UI actions.
Actual provider switching, backend durability and model execution remain outside
this injected-fixture cohort. Independent visible/headless QA is **pending**.
