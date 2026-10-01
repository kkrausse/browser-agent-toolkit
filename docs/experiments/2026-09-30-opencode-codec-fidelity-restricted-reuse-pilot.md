# Codec-fidelity restricted reuse pilot — passed

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-codec-fidelity-restricted-reuse-pilot.md`

## Outcome

**One newly authorized fresh origin completed cold startup and one A→B reset.**
Guest OpenCode PID remained **1**; config changed from `reuse-pilot-A` to
`reuse-pilot-B`; both pinned editor plugins were active after reacquisition.
Two distinct root sessions hydrated with empty message/permission/form history,
idle execution, explicit `/workspace` location and no inherited parent, fork,
model, permissions or metadata. Source marker B was verified after reset.

This is a new chronological attempt, not a correction of any prior failed run.
The previous report at `2026-09-30-opencode-contract-preflight-controlled-reuse-pilot.md`
and its retained 43226 origin remain unchanged. Requiring another live capture
before accepting source-proven nullable cursors was unnecessary: the pinned
HttpApi codec was executable offline and sufficient for this correction.

## Precise correction and actual codec proof

`examples/todo-app/tests/reuse-pilot-contract.ts` now accepts only string,
null or absent `previous`/`next` cursor entries, retaining the array data and
object cursor requirements. Numbers, booleans, arrays and objects remain rejected.
No generic JSON acceptance or API-shape guessing was introduced.

The codec-backed test verifies the complete packaged server SHA-256, extracts
the **unchanged dependency/protocol prefix** into private scratch space, initializes
its actual `ClientApi`, and uses each route's actual success schema plus
`makeSuccessSchema` → `Schema.encodeEffect` → `HttpServerResponse.toWeb`.
This executes the exact bundled Effect/HttpApi implementation, not a substitute
from the installed client dependency. `ClientApi` and the server's `Api` share
`makeDefaultApi`; inert client middleware identities do not change success codecs.
No server/service/model/tool operation starts in this test.

Source anchors in frozen `vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js`:

- 453078–453098: `transformResponse2` / JSON `toCodecJson`.
- 21892–21906: undefined JSON codec maps undefined to null.
- 454498–454535: real success schema and response transformation.
- 517518–517526: session list's `Schema.optional` body cursors.
- 519075–519139 and 555324–555328: shared API construction.
- 556179–556205 and 555456–555475: list/history handlers explicitly construct
  undefined empty-page cursor keys.

All 16 audited contracts pass actual schema decoding and response encoding:
health, config, current project, plugins, model catalog, activation 204,
session create/get/list/active, message history, permission/form lists,
debug-location refs and DELETE 204. Interrupt's bare boolean is offline-only;
it remains forbidden live. Tests check status, content type/length, empty 204
bodies, absence of Link-header pagination, and body cursor null encoding.
Fixture-only predicate tests are labeled accordingly rather than claimed as
packaged-wire proof. The offline controller/SDK test now uses nullable cursors too.

The test runs under Bun; its exact bundled dependency prefix executes with
Node 24.7.0 because Bun lacks the bundle's `node:sea` import. Preliminary
whole-bundle exploration additionally encountered unavailable tree-sitter WASM;
using the exact protocol prefix avoids unrelated server/plugin initialization.
There is no hand-fixture fallback or dependency/package/runtime modification.

Focused contract/fence/controller/reader/location tests: **74 passed, 0 failed,
410 assertions**. Preparation and final targeted TypeScript checks passed.

## Frozen identity and predeclared limits

Private evidence absolute directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-exclusive-reuse-2026-09-30T05-02-51-568Z/`

- Clean runtime source pin: `446df00f86d5d6d5d856a2e5deec0fac49f242fa`.
- Frozen distribution: `4ef513e7bb6233d356004b161132510293129cfa25bedb96d59b66e84ef42c6a`.
- Packaged server 2.0.3 SHA-256:
  `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`.
- **10,528** managed/payload file hashes verified.
- Frozen corrected client: **1,925,529 bytes**, SHA-256
  `148029a5d5b9d10d796743657f9f554ddd48a1a6aba399b618c82422af0d6564`.
  Receipt and host-served bytes match; no served-client edits after navigation.

Before navigation: one cold launch, at most one reset; cold **90 s**, reset
**60 s**, finite request/drain **20 s**, healthy cleanup **15 s**, observation
**180 s**. First failure stops; **zero** retries, replacement origins or budget
extensions. Codec-backed tests and targeted typecheck passed before admission.

## Actual reuse evidence

| Count / identity | Actual |
| --- | --- |
| Fresh origins / host servers / cold launches / resets | 1 / 1 / 1 / 1 |
| Accounted guest HTTP calls | 34: 32 normal finite, 2 global SSE HTTP 200 |
| Failed / cancelled finite / timed-out / unresolved finite | 0 / 0 / 0 / 0 |
| Session create / DELETE / B replacement / reacquire | 2 / 1 / 1 / 1 |
| Retries / replacements / extensions | 0 / 0 / 0 |
| Model inference / tools / shell / PTY / execution RPC | 0 each |
| Guest health PID A → B | 1 → 1 |
| A session | `ses_f0f4d280fffeczjuyWMZj47i06` |
| B session | `ses_f0f4cc964ffejwo3G487kW6DgA` |
| Project | `bf309ff466f7bcd6b1ca4751d16d42627dbac2ee`, unchanged `/workspace` |
| Final service exit | exitCode 0, signal null, forced false |
| Final guest processes / listeners / pending HTTP | 0 / 0 / 0 |

The native owned-service readiness probe (`GET /` HTTP 401) is outside the finite
caller fence. Model-catalog reads are not model inference. B's session list
correctly retains persisted A, follows its string body cursor to an empty page,
then creates B: the reset invalidates location/config state, not session storage.
B itself has empty history and distinct identity.

| Sample | ms |
| --- | ---: |
| Environment delivery | 1808.330 |
| Cold readiness qualification | 20104.685 |
| Cold client hydration | 8631.970 |
| Cold launch through hydration | 38385.525 |
| Reset dispose | 4.215 |
| Reset DELETE | 119.230 |
| Reset source/config write | 14.505 |
| Reset reinitialization + hydration | 24196.085 |
| **Reset total** | **24334.795** |
| Healthy cleanup | 56.930 |

This one restricted sample has reset/cold ratio approximately **0.634**.
Environment delivery is excluded from cold launch-through-hydration. This is
not a cohort, full-pipeline speed guarantee or production concurrency claim.

Reset ordering was freeze A admission → join all **15** normally consumed A
finite calls → await `ChatController.dispose` and global SSE cancellation →
await DELETE 204 → write B source/config → reacquire and qualify B.
Reset admission records `unresolved: 0`, `localDisposed: true`, and zero location
refs **inferred from the source-audited exclusive finite-handler completion**,
not a fabricated remote ref-count receipt. Guest output separately records
both global SSE interruptions and `OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE`.
Cleanup froze/drained B, joined its controller disposal, stopped/drained the
service, and verified final zero work before closing the workspace.

## Complete wire evidence retained before validation

All **32 finite responses**, totaling **47,270 body bytes**, retain complete
base64 bodies, headers, byte lengths and SHA-256 before parsing. Independent
offline verification recomputed every hash/length. Postflight decoded every
non-204 body using the exact pinned route schema and re-encoded it through the
actual HttpApi transport serializer: byte-for-byte parity, status and JSON
content type/length all match. The 204 responses are empty. Results are in
`live-codec-parity.json`; full private evidence is `live-evidence.json`.

Observed empty list and both empty message histories are exactly:

```json
{"data":[],"cursor":{"previous":null,"next":null}}
```

Those bodies are **50 bytes**, SHA-256
`aaeef26a2303e416441cfb66fe83fd09d61ca08216260b7fdadc9c249741b91f`.
Actual headers include `content-type: application/json`, `content-length: 50`,
`connection: close`, `vary: Origin, Accept-Encoding` and Date; no Link pagination
header. The populated B-bootstrap list is 672 bytes with string previous/next
body cursors; its subsequent empty page has the same 50-byte nullable shape.
Raw responses remain private, uncommitted evidence, not published credential fixtures.

The existing `a4069d1` fence still distinguishes normal transport consumption
from semantic rejection and joins reader cancellation. Any cancellation,
timeout, unresolved operation or rejected contract would have blocked reset;
none occurred in this run.

## Ownership and limits

Sole browser owner: **Bun-backed Browser Control CLI 0.8.2**, session
`rapid-walrus-546`, page `http://127.0.0.1:43227/`, host Bun PID **31956**.
Port was unoccupied before launch. Three successful executes: navigation,
bounded terminal-status read, evidence export (HTTP 200, **658,192 bytes**).
No MCP, raw CDP, reload, page replacement, second owner or browser failure.
Healthy guest resources were cleaned by the declared pilot; evidence page and
host remain available. No additional guest call was needed to diagnose shapes.

All previously failed origins/resources remain untouched, including
43226/PID 12962/`clever-comet-943`, 43225/PID 1493/`tidy-falcon-686`,
43224/PID 90779/`clever-tiger-361`, and older 43222/PID 6885 and 43223/PID 7042.
No runtime edits or pin changes, IRS/archive work, push, deployment or model
calls occurred.

**The production concurrent/cancelled-reader admission, drain and remote-release
fence remains a separate unresolved requirement.** This successful restricted
finite-owned pilot does not close that gap or authorize general reuse.
