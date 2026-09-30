# Delivered OpenCode retention lifetime audit — source only

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-delivered-opencode-retention-lifetime-audit.md`

## Decision

**Do not admit retention or the restricted A→B pilot yet.** The actual delivered
648 bundle preserves the baseline RcMap/location lifetime mechanism, including its
positive-reference eviction hazard. Its conditional **zero refs → invalidate →
joined location close → acquire** argument still holds at source level. However,
the delivered entrypoint enables a repeating **global ModelsDev background
refresh** that the baseline disabled. Thus the old blanket “no background work”
premise does **not** transfer to this artifact, even with only finite routes.
No stronger remote-drain contract was found.

This is a static source/byte review, not core execution or live qualification.
Zero server/core/browser/profile/origin/API/model/tool/shell calls, evictions,
source replacements or retention transitions were performed. No tests, production
patches or scaffolding were added. Frozen assets, receipts, source pins, active
libraries/helpers, staging harness and parent status report were not changed.

## Reverified identity and provenance

The final stage is
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-opencode-live-f50f5e6f-037b-48ac-9a14-5542b35c9e9a`.
Its source snapshot is `874e759ae83b26224ae165c14c2e8c2a193d1aed`, runtime revision
`e35eab4af7a53ff08eb70c09df59c40b78bfdd67`, runtime/payload version
`bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.

Freshly read and SHA-256 hashed both complete artifacts:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Actual frozen `/app/server.js` asset | 27,721,680 | `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5` |
| Read-only baseline `server.js` | 27,721,709 | `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929` |

Actual asset absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3/prepared/648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5.bin`.
Baseline absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/vivari/.runtime/opencode-release-2.0.3/.runtime/opencode-bun-server/server.js`.

The frozen manifest has exactly one file asset targeting `/app/server.js`; its
hash/length match actual bytes. Parsed `manifest.opencode.receipt` equals the
stage's server receipt: `BUILD_PASS`, exit 0, registry `@opencode/server` 2.0.3,
upstream tag `d44b52ca66b6bf69626c0384626d1a9cd9555977`, integrity
`sha512-XlUL8p9fpW9FEssTY5aWS0qpcrDb1pV3dEbu6lU8KOgCIt6/gHwAKibEz4XPYf978vSRrvYGjreHIv0loA7fTg==`.
The tag denotes upstream release provenance, not a claim that a source checkout
was rebuilt here. Receipt builder: Bun 1.4.0, revision
`34cbb9a40b4bd1bd767d134a7065e66c2432a676`.

The four existing recipe files under
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-upstream/vivari/experiments/opencode-release-server`
were independently hashed and match the recorded receipt:

| Input | SHA-256 |
| --- | --- |
| `package.json` | `c2f0a456a44f099442b7854d70e0b5a543672fe91a3427c621233d02d9723707` |
| `bun.lock` | `d50fd8123bd950a286a70a1ae890d5ee5cd6203d0aaa83b63552a36bc78020de` |
| `server.ts` | `eb2d8c4ad892e4d69e45be6697c6369714c9910666a3f2df38da00dbdbdd4e7e` |
| `build.ts` | `ae0e980ba11dd15d4ecb6c1d501b1da4e1ef34c82ed0d78767928d977361f2b3` |

No rebuild, registry download or new whole-dependency-tree attestation occurred.
The frozen asset—not a current checkout or matching version label—is the reviewed
source. Baseline report/excerpts were read-only comparison inputs.

## Exact shipped boundaries versus baseline

Positions below are **1-based LF lines**, not Unicode `splitlines()` positions.
Every range in this table was extracted afresh from 648 and located as an
**identical text snippet** in 1df; baseline positions were not assumed.
Symbol names are bundled names, not editable source APIs.

| Boundary / shipped symbol | Actual 648 lines | Baseline 1df lines |
| --- | --- | --- |
| `scopedWith`; `provideLayer` | 5959–5970; 10257–10266 | same |
| RcMap `get5`, `release3`, `invalidate` | 15473–15627 | same |
| HttpEffect `toHandled`, `scoped5` | 37643–37719 | same |
| LayerMap `make72`, `get`, `contextEffect` | 42203–42223 | same |
| Coordinator interruption / `awaitIdle` | 81953–81982 | same |
| `importModule`, main-context default loader | 83806–83823 | same |
| Global `SessionExecution`, `instances.provide` | 228495–228562 | same |
| Location `canonical22` | 442619–442660 | same |
| `Session.wait`, `Session.interrupt` | 451912–451941 | same |
| `Session.create`, parent/location/settings | 452206–452244 | same |
| HttpApi response codec / `makeSuccessSchema` | 454414–454620 | same |
| Persistent PTY remove/shutdown/global node | 458604–458675 | same |
| RPC call race / `Service15.close` | 458878–458915 | same |
| Plugin activation scopes / close / barrier | 460740–460889 | same |
| Root-create protocol payload | 517546–517561 | same |
| Permission/form list protocol | 518045–518053; 518154–518162 | same |
| Debug list/eviction contract | 518459–518472 | same |
| API group middleware ownership | 519075–519079 | same |
| Node request fiber / response handling | 532856–532870; 532984–533095 | same |
| Global ModelsDev refresh service | 538209–538300 | 538208–538299 |
| ModelsDev plugin refresh callback | 543901–543942 | 543900–543941 |
| Ordinary PTY teardown finalizer | 551333–551349 | 551332–551348 |
| `buildLocationServiceMap2` | 552775–552816 | 552774–552815 |
| `requestRef`, location/session middleware | 555263–555329 | 555262–555328 |
| Model catalog read handlers | 555563–555571 | 555562–555570 |
| Session list/create/active/get handlers | 556175–556255 | 556174–556254 |
| Session permission/form list handlers | 556540–556559; 556772–556778 | 556539–556558; 556771–556777 |
| Global event feed / subscribe handler | 557124–557182 | 557123–557181 |
| Activation handler | 557277–557279 | 557276–557278 |
| Debug key list / invalidate handler | 557374–557379 | 557373–557378 |

### Acquisition, zero refs and finalizer lifetime

- Location key is directory plus optional workspace ID, not source generation or
  session ID. On this non-Windows target `canonical22` preserves directory spelling.
  Query/header routing defaults to process cwd when absent; explicitly route
  `/workspace`, no workspace ID. Persisted project/session identity is not erased
  by eviction. Global supplementary config remains reread by location boot
  (`Config.load`, 451110–451138, identical in both bundles).
- LayerMap `get` wraps `RcMap.get` in an Effect-context layer. `get5` increments
  references and registers `release3` on its acquiring scope. Location middleware
  and `instances.provide(session)` use `Effect.provide(layer)`, whose own scoped
  layer acquisition closes before that effect returns. The lookup/build scope is
  a **different, cached entry scope**, with infinite idle TTL; it owns plugin and
  location services beyond any one finite request.
- RcMap's actual branch is unchanged:

  ```js
  remove4(self2.state.map, key);
  if (entry.refCount > 0) return;
  if (entry.fiber) yield* interrupt6(entry.fiber);
  yield* close(entry.scope, void_4);
  ```

  At zero refs it awaits entry-scope close. At positive refs it only removes the
  key. `release3` checks **key presence, not old-entry identity** (15524–15530);
  infinite TTL plus same-key reacquisition retains the baseline overlap/finalizer
  hazard. The previous offline failure is not new execution proof for 648.
- Location invalidate awaits inner invalidate, then `build4.close` (552804–552805),
  which is RPC's deferred close signal (458913), not an all-reader finalizer join.
  The debug handler is not location-middleware scoped and does not deliberately
  acquire a ref itself. Its NoContent success and `RcMap.keys` list absence do not
  expose counts, generations, detached entries or joined remote finalizers.
- HttpEffect gives requests a closing scope; Node owns request fibers in its serve
  scope and interrupts prematurely closed responses. Buffered small byte bodies
  call `nodeResponse.end` and return; stream bodies run until stream completion.
  **Client EOF/abort is not a server-owned ref/finalizer acknowledgment.** These
  source paths support restricted normal-completion reasoning, not live proof.

### Mounted candidate finite routes and global SSE

The frozen mounted fence (`sk-opencode-live-client.ts:55–62`) allows concurrent
bootstrap and the following wider surface. Ownership is not uniform:

| Route class | Shipped ownership / inference limit |
| --- | --- |
| `GET /api/health` | Global handler, no location acquisition; PID is not a drain receipt |
| `GET /api/config`, `/api/project/current`, `/api/plugin`, `/api/model`, `/api/model/default`; `POST /api/plugin/await-activation` | Location middleware + scoped acquisition; finite value/barrier, not background-work completion |
| `GET /api/session`, `/api/session/active`, `/api/session/:id`, `/api/session/:id/message` | Global persisted session/read/execution surface, no group location middleware; routing query alone does not constrain inventory or prove ownership |
| `POST /api/session` | Global create uses **payload.location**, otherwise cwd; query `/workspace` is insufficient |
| `GET /api/session/:id/permission`, `/api/session/:id/form` | Handlers acquire stored session's location through `instances.provide`; global form sentinel uses `requestRef` |
| `GET /api/event` | Global bus-backed SSE, no location middleware/ref; subscriber queue is acquire/release scoped; cancellation needs its own join, not debug eviction |

Create contract has no parent field. Core create still supports parent location,
metadata and permissions inheritance; caller-supplied existing ID returns an
existing record. A fresh root therefore requires explicit payload `/workspace`,
no workspace/ID/parent/fork/model/metadata/permissions, unique native ID and empty
hydration checks. Session-ID routes must be pinned to the **owned selected root**,
not admitted for arbitrary IDs by the mounted fence's broad regex. Root creation
publishes an event: finite create completion does not drain plugin subscribers.

Global SSE remains independently owned even though it does not keep a location
RcMap ref. It can carry events from all locations, including plugin RPC events.
Local controller/SSE disposal is necessary but cannot certify global execution,
plugin callbacks or remote subscriber finalization.

### Relevant differences and surviving exclusions

648's entrypoint at **558831** sets `models:{fetch:true}`; 1df at **558830** sets
`fetch:false`. In the identical ModelsDev service, 538288–538289 conditionally
fork a repeating refresh (five-minute spacing, HTTP fetch/cache write and possible
`Refreshed` event). This is a **global** node (538293–538298), surviving location
eviction. The built-in location plugin subscribes to that event and reloads
integration/catalog state (543941); its subscriber belongs to plugin scope.
Activation waits a latch, not the global refresh fiber or all plugin work.
Thus even the original five-route gate can boot services in a process with this
background owner. A source-only ref argument is not a literal “no background work”
argument. Unknown: actual refresh timing, guest transport behavior and whether all
outgoing refresh callbacks/finalizers settle at the intended boundary.

Other full-bundle differences include earlier HttpRouter/FindMyWay placement and
generated local identifier renaming, embedded build-machine paths, an added
`init_http()` at 533115, and entrypoint
`provideService(HttpClient.TracerPropagationEnabled,false)` at 558848. These do
not establish a new drain protocol. Critical response codecs/protocol snippets
above are identical; exact 648 codec extraction was independently reconstructed
as bytes and matches the staged codec SHA-256
`8ae896cd21951fd8370239d0de61b0e61ea470cc9196f32c40df7c72000fca61`.
Use this actual codec, not version-based equivalence. Codec parity proves only
status/serializer headers/body contract; domain decode (including undefined/null
cursors and property ordering) cannot replace full observed-byte checks.

Cancellation/background execution exclusions are **not relaxed**: global
SessionExecution can acquire a session location after HTTP admission; interrupt
requests cancellation and wait joins only that coordinator. Children, jobs,
independent clients and plugin work require separate accounting. Plugin effects
run in activation scopes and cleanup closes those scopes, but escaped JS work or
unmanaged processes are not certified. Ordinary PTY finalizer disposes listeners
and calls `process.kill()` without an exit join; persistent PTY is global and
daemon-owned, with separate terminate/shutdown/handoff APIs. All stay excluded.
Main-context default dynamic import has no proven module-cache invalidation:
changed plugin/module/dependency/config/environment identity still requires the
existing restart fallback, not same-process reuse.

## Exact admission prerequisite and remaining blocks

1. Complete separately authorized **actual-648 mounted live qualification** and
   joined guest/host cleanup first. This source audit does not authorize a slot,
   launch, reset, DELETE or A→B transition.
2. Keep the existing restricted gate's exact finite allowlist: serial, normally
   consumed `GET /api/health`, `/api/config`, `/api/project/current`,
   `/api/session/active`; `POST /api/plugin/await-activation`. Freeze admission,
   join finite/local disposal, poison on concurrency/abort/error/timeout and
   reject any unreviewed route. Mounted success **does not satisfy** this gate:
   it permits concurrency, session creation/hydration and SSE. Any wider gate
   requires separate approval, exact owned-root routing and lifetime qualification.
3. Do not set `backgroundWork:false` merely because no prompt/tool was sent.
   Resolve the actual global ModelsDev refresh owner and location subscriber
   boundary explicitly before relying on restricted zero-ref inference. Under
   the **current literal no-background-work admission contract**, 648 is not
   admitted. No speculative server patch or policy waiver is proposed here.
4. A bounded dynamic **exact-delivered core/service finalizer fixture** remains
   required: observe scoped acquisition/release, zero-ref invalidate joining old
   location/plugin finalizers **before same-key reacquisition**, and controlled
   reader/cancellation settlement. Characterize the known positive-ref/same-key
   hazard as a forbidden negative, not a permissible eviction path. Include the
   shipped global refresh/subscriber interaction if it is to be admitted. An
   installed-Effect-only characterization or codec executor cannot stand in for
   delivered core behavior. This concrete lifetime failure warrants a targeted
   fixture later; none was executed or implemented by this source-review task.
5. Require exclusive owner/PID/execution/endpoint identities, unchanged non-source
   inputs, no execution ever admitted, no independent readers/PTY/jobs/children,
   and freshly verified root/source identities. Only after parent review of these
   gates may a separately bounded, no-inference A→B proposal be considered.

**Full remote ref/finalizer receipt remains absent.** At local evidence inspection,
the stage still reported `remoteZeroRef:false`, `retentionAccepted:false`,
`liveRuns:0`; no `live-evidence.json`, `host-process-join.json` or
`host-listener-absence.json` was present. An `owned-origin.json` appeared during
this review, so parent QA may be ongoing: this is not a claim that no later live
run exists. No origin was accessed. Local completion, byte codecs, empty active
inventory and debug key disappearance remain source inference, not remote proof.

## Retained static evidence

New unique ignored directory (no full bundle copied into Git):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/delivered-opencode-lifetime-audit-20260930-2aead6f6-5cba-4df4-8c8b-469653a76f6d`.

| File | SHA-256 |
| --- | --- |
| `identity.json` | `81c50796aed6d654b048ccf407ca833adb8a12bc6998de0ff7edcb36176e0c9e` |
| `provenance.json` | `255c7bdeae34da6976dca1560e42d9b24448bd691d36ce15b65db09743395900` |
| `source-boundaries.json` | `42f6064b5292a51f099a831cd93c63aafb760cfed216a33709244dcf76dbaa29` |
| `source-excerpts.txt` | `a5c20bea6eabd48d0933af0915cfd3732684f666908ab5b009db22007ad0a126` |
| `bundle-diff.txt` | `61ab9440891e31000a372822cec62edab50f0131f678e3ff73145ef69cafaaf3` |

Only this new report is committed. No push. Nothing in this report upgrades the
staging or baseline evidence to accepted retention.
