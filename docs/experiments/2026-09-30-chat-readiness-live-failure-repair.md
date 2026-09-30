# Chat readiness live-failure repair — frozen candidate, live acceptance pending

Candidate code commit: `691cd5aa0880349968773047402adec0bfeb16df`.
This followup does **not** replace or relabel the failed independent QA report
(`d8f2a49`) or candidate `55ae98c`. No browser was operated, no server was started,
and no user profile, origin, storage, runtime, or inference was used in this repair.
The original evidence directory was read only:
`/Users/kkrausse/Documents/opencode/chat-readiness-qa-20260930/`.

## Causal evidence, not a wait-to-green adjustment

1. Evaluated the exact retained failed `lab.js` in a new offline Happy DOM window.
   Its SHA-256 remained
   `332455a344edaa030ea72757de4dd2495a7c823b504f75ae70e472e82f5345ec`.
   `window.addEventListener === originalNativeFunction` was **false**. Ordinary
   event registration threw `TypeError: target.addEventListener is not a function`.
   The classic script's top-level Base UI function declaration replaces the native
   global before ordinary Browser Control injected listeners can use it.
2. Archived original candidate `55ae98c72437d27ff683c65dbb79f3b3f9e31572`
   into a new staging directory, linked only installed test dependencies, and ran
   the new click/input regression against its unchanged controller/React sources.
   Result: **0 pass, 1 fail**, at the semantic assertion, not a fixture/setup error.
   After synchronous New chat click and immediate input, actual state was `ses1`,
   pending false, before-input text `old draft`, and resulting text
   `old draftimmediate new draft`. This matches the independent recorded
   `qa-old-firstqa-new-intended` failure.
3. The previous public `createSession` merely constructed an Effect and scheduled
   it via `runPromise`/`forkIn`. Mutation admission and logical selection occurred
   only when that generator executed. Synchronous DOM click/input reproduces this
   without Playwright, a pending-state wait, or browser event synchronization.
   Thus the admission defect is real; changing independent QA to wait for pending
   before typing would conceal it. The regression uses synchronous React `act`
   for DOM flushes, not an asynchronous request/pending wait.

Reproduction log:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/prior-regression.log`.

## Repairs and deterministic coverage

- `src/controller.ts`: mutation admission, logical draft allocation/retry reuse,
  and selection publish synchronously before public creation/selection returns.
  Closing old scopes, HTTP creation, and hydration remain asynchronous Effect work.
  Ownership is captured at admission; stale transitions cannot hydrate a later
  selection. Abandonment before scheduling prevents the creation request entirely;
  already-started late results still cannot hijack selection/drafts.
- Public send rejects a pending intent immediately, never queues it for later
  readiness, and fences the selected conversation before its request fiber starts.
  Error publication uses the original admitted generation/selection, so an old
  rejection cannot contaminate a later selection. Existing token-owned cleanup,
  stable draft through server-ID assignment/hydration, retry, and accepted-clear
  semantics are retained. React production source did not need another change.
- `scripts/serve-chat-readiness-lab.ts`: explicit `format: "iife"` gives all bundle
  declarations lexical isolation. No native globals are repaired or patched.
  `--freeze=<directory>` writes exactly the HTML/JS that the once-built server
  would serve and prints their hashes, without starting a server.
- Actual-output regression executes that emitted classic-script bundle in a fresh
  offline DOM, checks both native add/remove event globals by identity, and checks
  successful ordinary registration/dispatch. This is an offline bundle check,
  **not** a substitute for Browser Control's actual locator inspection.
- No-await click/input regression checks immediate logical admission and text,
  disabled Send/Enter suppression, stable ID/draft assignment, and old-draft revisit.
  Same-turn controller tests cover duplicate admission, cancellation before request,
  pending-send rejection, send/selection isolation, and zero prompt counts.
  Existing tests cover held hydration, failure/retry, late creation, accepted-send
  count **exactly one** with the intended session/text, and no implicit prompts.
  Controller isolation now changes the controller prop on the same mounted
  `ChatView`, rather than replacing it with a standalone Composer.

## Checks and build/peer limitations

From `opencode-chat/`:

```sh
bun test test-ui/chat-readiness.test.tsx test-ui/readiness-lab-bundle.test.ts test/controller.test.ts test/markup.test.tsx test/reducer.test.ts test/reader-fence.test.ts test/location-fence.test.ts test/transport.test.ts
bun x --no-install tsc --noEmit --target ESNext --module Preserve --moduleResolution Bundler --jsx react-jsx --skipLibCheck --strict src/controller.ts src/react.tsx test-ui/chat-readiness.test.tsx test-ui/readiness-lab-bundle.test.ts test-ui/readiness-lab.tsx scripts/serve-chat-readiness-lab.ts
bun scripts/serve-chat-readiness-lab.ts --check
```

**66 pass, 0 fail** in both final working-checkout and frozen-source runs;
325 assertions. Targeted strict typecheck passes, including frozen source.
Lab build passes (3,216,728 bytes); separate browser-target controller and React
library builds also pass. `git diff --check` passes.

Full-package `bun run typecheck` was actually attempted and **fails** with missing
`@kev-browser-agent-kit/workspace` peer exports and consequent type errors in
browser/editor/prepare/diagnostics integration. The full destructive `build.ts`
pipeline was not run: declaration emission needs those peers and its script first
removes shared `dist`. Targeted builds are not packaged application acceptance.
The inherited tick-based handshake-disposal flake was unchanged; these passing
runs do not establish its timing stability. No sibling workspace/prepared helpers,
runtime, application switching/startup, independent QA script, retention files,
or parent status document were edited or staged.

## Frozen handoff for NEW independent live QA

Staging root:
`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/`.
It contains `candidate-source/` (committed source archive, with installed
node_modules symlink), `candidate-artifacts/` (frozen HTML/JS),
`candidate-manifest.json` (source/build hashes), and `candidate-tests.log`.

| Artifact | SHA-256 |
| --- | --- |
| Frozen `lab.js` | `16ae8532768e09441c458b07d255b9b88cabfd3af0a22a1b2ca3c134e9d83bb4` |
| Frozen HTML | `a866f88b894f599a1c92b0239eb906f9d5498ef65b3b60276e654259760109bb` |
| `src/controller.ts` | `a918a42da0e525b1c84f5a18e834fc7cc130fb6ac0331b770e3aa46259cfe7d3` |
| `src/react.tsx` (unchanged) | `cb54f8459f5ba6a12441830fa94c8e88289d53a6e661f5519bf8308af529662f` |

Parent assigns one visible owner after diagnostic cleanup. Start the once-built
stub lab from the frozen source, not the concurrently edited shared checkout:

```sh
cd /private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/chat-readiness-repair-0nXBtN/candidate-source/opencode-chat
bun scripts/serve-chat-readiness-lab.ts
```

Before browser actions, compare the actual served bundle/HTML hashes to the table.
Use a new fresh loopback origin and new owned Browser Control **Bun CLI** session;
ordinary locator inspection must succeed without patched globals. Immediate trusted
New chat click + typing is still mandatory; do not insert a pending wait first.
Preserve fresh failure/checkpoint screenshots and counter observations separately
from the failed original evidence. Then run the isolated headless real-browser
cohort against the same verified bytes, never concurrently with visible ownership.

No change to `scripts/chat-readiness-browser-qa.ts` was made or proposed to weaken
the first assertion. Its final separate-page baseline does **not** prove a
same-view controller prop switch; independent live QA still needs a genuine
same-view controller-switch surface/cohort before claiming that acceptance.
The current lab exposes one controller only. This is an explicit remaining
coverage/capability gap, not a green controller-isolation browser result.

**Remaining actual acceptance:** visible native locator inspection, immediate
click/type admission, both pending gates/Enter blocking, ID/hydration draft
preservation, Ready without queued send, one explicit accepted-send counter and
clear, rejection/retry, late-result abandonment/session revisit, same-view
controller isolation, console/network/owned cleanup evidence, and headless real
Chromium. Whole packaged application integration and inherited disposal-flake
stability also remain pending. Nothing here claims live/browser acceptance.
