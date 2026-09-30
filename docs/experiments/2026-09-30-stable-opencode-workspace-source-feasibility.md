# Stable OpenCode + stable workspace roots — source feasibility

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-stable-opencode-workspace-source-feasibility.md`

## Result and limits

**Technically expressible, not qualified or a refactor decision.** One existing
Workspace/Runtime can retain an OpenCode execution while independently stopping
and restarting Vite. Its filesystem can contain distinct stable project
directories, and the actual delivered OpenCode service caches locations by
directory plus optional native workspace ID. Switching the *client's owned
location* need not evict either location or replace either source directory.

This avoids exercising the known same-key eviction/reacquisition failure during
that switch; it does **not** establish isolation, inactivity, bounded long-term
resource use, or background-drain safety. A stable server directory alone does
not change the source location key. Adding IDs to the same physical directory
does not stop old readers/writers seeing replacement source.

Existing selective lifecycle APIs suffice for an initial finite toy. Existing
editor integration does not implement that toy contract: root-specific client
reattachment, enforced session ownership, preview/client joins, and background
qualification remain gaps. No new SDK is necessarily required to launch two
roots; a full remotely acknowledged location/ref/finalizer drain API remains
absent, especially for eventual eviction/deletion.

Scope: source and local artifact bytes only. No browser, guest/core/server,
benchmark, model/inference/secret request, reset, installation, test, fixture,
production/layout rewrite, or prepared-asset modification. Only this report is
changed. Parent owns hardening admission, architecture/status and final decision.

## Identity and source conventions

Toolkit source was read at HEAD
`93b8a6b758d2f1d99e304151be641ca540cfbf26`; unrelated parent edits were left alone.
Toolkit paths below are relative to
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.
Runtime paths are relative to
`/Users/kkrausse/Documents/repos/kkrausse/vivari-single-kernel`.
Runtime e35 source is
`e35eab4af7a53ff08eb70c09df59c40b78bfdd67`, **not** the newer runtime working HEAD
`516ef37e21182796b6ea4665df8667ffde5b6837`. Execution, kernel-worker and
kernel-filesystem bytes match e35; endpoint was separately read with `git show`
at e35 rather than inferring parity from the current file.

Delivered artifact directory, read-only:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-fresh-2026-09-30-independent-17ef8e3/prepared`.
`648:<line>` below means 1-based **LF** lines of its complete
`648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5.bin`,
delivered at `/app/server.js`. Relevant excerpts were reread from those bytes.

Fresh byte verification:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| server | 27,721,680 | `648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5` |
| manifest.json | 3,831,207 | `57a149355cbfa1974da6637bbe6e437b23d7455d13f0b11d088c1146f3497c7f` |
| managed image | 43,248,169 | `9d51ecdb367408aba9616b32fe6fab1691d5b280b2700ed96f6e22675ec69cb9` |
| managed bundle | 41,790,638 | `268a79b5833375ceb8b8ea23e9ae1fdb115cea8aba636691d3e543e5481f925a` |

Relevant source-byte anchors (SHA-256):

| Source | Hash |
| --- | --- |
| `workspace-api/src/react.tsx` | `f54ff33489af03449aa9ef74d901252cb95c50ca9cdddf2340390747daa9db3c` |
| `workspace-api/src/runtime.ts` | `c4c7e1ff8aca5400ebe07cfabf63a98e333a219d0c1e238eaa9eb41c69ee2723` |
| `workspace-api/src/workspace.ts` | `ef9b89b720aaf18b1912fa5784f7f9b88ea1ddc70a70edba3b316c335f72c22b` |
| `opencode-chat/src/opencode-launch.ts` | `0a7ea93e5620b4f4711ac6fdf307857fb3ebc0c6bd18465ade324bd6be61fe6e` |
| `opencode-chat/src/prepared.ts` | `600193f04e45fca06d3e4b96aa3aeefb2f9927c01684540817efe0ec24b2f49f` |
| `opencode-chat/src/api.ts` | `ab2ec1c2f79a7015c8f33c36ba5bcfb4c331105518452eb24d175f878bd10270` |
| `opencode-chat/src/editor-adapter.ts` | `b507b246a832175c5f219f54bbb7e074cce087db24f22448c752f02997bbd532` |
| e35 `packages/core/src/host-sdk/execution.ts` | `6eb78f0e2d27390688e2a1894f1165f9cd9a41375cc4664da6a75b045888e9d2` |
| e35 `packages/core/src/host-sdk/browser/endpoint.ts` | `00688dc09c742bc31f298cd8e3c773c05f179e53c993d8a09eeecd2b0554bffc` |
| e35 `packages/core/src/workers/kernel-filesystem.ts` | `df050ed4c76a90f15a0c64480c987f850d633047396b999621757f955e3b6ce0` |
| e35 `packages/core/src/workers/kernel-worker.ts` | `01f7d1ccc48e7ea147a17dec9b37d879d643b76be3cca72993e2cd270c4166b0` |

The earlier delivered lifetime audit remains applicable:
`docs/experiments/2026-09-30-delivered-opencode-retention-lifetime-audit.md`
(delivered in commit `4b3738d`). Current V2 API documentation was consulted, but
its newer route names are not substituted for the pinned 2.0.3 artifact contract.

## What is separated already, and what is entangled

### Public Workspace/Runtime lifecycle

- `Workspace.open` permits only ID `default`, one document owner and one origin
  store (`workspace-api/src/workspace.ts:104–126`). Logical roots would be
  directories **inside that one Workspace**, not additional `Workspace.open`s.
- `workspacePath` prepends `/workspace` (`:6–8`): `fs.mkdir('/projects/A')`
  addresses `/workspace/projects/A`. Public fs read/write/stat/readdir/rename/
  remove/watch supports these descendants (`:133–157`), but has no configurable
  mount root, raw-root access or symlink method. A bounded app-level root facade
  is expressible with prefixing; it is not provided by this API. Watches cover all
  `/workspace` mutations and require application root filtering.
- Runtime permits one attachment and owns a set of independent executions and
  endpoints (`workspace-api/src/runtime.ts:25–35,37–66`). `node` accepts explicit
  guest cwd; `expose` is per port/listener. Runtime stop aborts **all** endpoints
  and executions (`:68–75`); it does not destroy the Workspace's kernel.
- **Selective stop exists publicly:**
  `WorkspaceController.stopService(name)` detaches that service's attachment,
  disposes its endpoint and joins execution shutdown/output drain
  (`workspace-api/src/react.tsx:266–279`). `stopService('vite')` does not stop
  `chat`, Runtime or Workspace. Re-launching `vite` after the stop is expressible
  (`:137–148,213–228`). This is source feasibility, not a live survival result.
- `stopService` is not a global admission barrier: it does not join unpublished
  pending launches; `stopServices` joins those first (`:285–291`). A selective
  switch must serialize/freeze its own startup and forbid concurrent same-name
  launches. `detach` invokes attachment disposal synchronously, not by awaiting
  an arbitrary async client finalizer. Explicit client/preview joining is owed.
- `clearWorkspace` requires an unattached Runtime and erases descendants of both
  `/workspace` and `/.server` (`workspace.ts:45,80–101`). It cannot be used for a
  retained-server switch. Root-scoped `fs.remove` exists, but deleting an inactive
  root with retained location services is still a lifetime operation, not safe
  merely because the UI stopped selecting it.
- Current UI explicitly disposes chat, calls `stopRuntime`, clears the whole
  Workspace and restores source (`examples/todo-app/src/workspace-editor.tsx:
  141–152`); native transfer deletes/imports sessions because the kernel-owned
  SQLite mount can survive clear (`src/workspace-sessions.ts:59–82`). A stable-root
  switch would not run that destructive transfer as-is.

### Server/state/process and hardcoded path sites

| Site | Exact coupling / consequence |
| --- | --- |
| `opencode-chat/src/opencode-launch.ts:3,20–23` | Readiness location queries fixed to `/workspace`. Launching via the existing helper boots that location even if the intended first root is A. |
| `opencode-launch.ts:12,15–18,71–79` | Code/cwd `/app`, database `/runtime-probe/opencode.sqlite`, tree-sitter `/app/*.wasm`, support PATH `/app/node_modules/.bin` in prepared use; HOME/XDG/TMPDIR under **`/workspace/.server`**. These are not one directory. |
| `opencode-chat/src/browser.ts:100–107` | Config API fs paths `/.server/...` are workspace-relative, so they write **`/workspace/.server/...`**, not raw `/.server`. The raw clear root is a separate compatibility target. |
| `browser.ts:12–85,109–126` | Readiness expects fixed location/config path and built-in editor plugins. `startOpenCode` exposes serviceName/readiness, not cwd/state-root/location options. It generates a new password on each invocation; an already-present service is reused by controller name. Do not call it to “reconfigure” a retained execution. |
| `648:558823–558849` | `/app/server.js` itself fixes port 4096, accepts `OPENCODE_DATABASE_PATH`, defaults DB to `/runtime-probe`, sets `models.fetch:true`, `config.project:false`, disables filewatcher/fff, and joins service shutdown after stdin EOF. No server-source relocation is necessary just to retain it. |
| `opencode-chat/src/javascript-plugin.ts:24–35`; `javascript-runner.ts:23–27` | Custom execution defaults cwd `/workspace` and output logs `/workspace/.server/javascript`, not the selected native location. Plugin passes input without deriving cwd from ctx. This blocks assuming full tool correctness under nested roots; excluded from finite toy. |
| `workspace-api/src/environment-experiment.ts:5,22,28,383–399` | Experiment receipt/runner and replacement script target `/workspace`; replacement recursively cleans that root and raw `/.server`. Not usable unchanged for stable-root switching. |
| `examples/todo-app/src/workspace-sessions.ts:46,64,78` | Native catalog filter/import payload fixed to `/workspace`; current delete loop must not run on retained multi-root session state. |
| `opencode-chat/src/editor-adapter.ts:6–28` | Directory option exists, but chat is cached in a WeakMap **by Service**, once per service lifetime. Passing B with the same retained Service returns A's existing chat. Direct controller creation is available; retargeting/replacing this cache entry without stopping service is not a public adapter operation. |

Therefore the suggested stable service/state home is compatible with existing
process launch primitives, but the *pinned convenience recipe* is not root/state
parameterized. Also, `/app` and the DB are **already outside** `/workspace`:
moving those again is not the missing fix. Retaining code/state at existing paths
while leaving `/workspace/.server` untouched is enough for the finite hypothesis;
no layout is selected here.

Kernel source is not fixed to one project: e35
`packages/core/src/workers/kernel-filesystem.ts:182–192` persists ordinary paths
except node_modules and explicit ignored/volatile paths. Distinct source roots
can coexist durably, but node_modules is intentionally not mirrored per file.
Kernel/SQLite ownership survives Runtime stop; long-term durability and database
flush/reopen semantics are separate from “directory exists.”

### Managed dependencies, backends and Vite

- Actual code and support assets are separate under `/app`; project dependencies
  and backend archive inputs are `/workspace/node_modules` and
  `/workspace/.browser-editor-backends`. `package-tree.ts:7–26` fixes allowed
  roots to these plus legacy `/opencode-v2`; `prepared.ts:29–40` pins `/app`
  outputs/support and rejects legacy entries. `prepare.ts:91–126` captures at
  those destinations and emits preview cwd `/workspace`. A stock redelivery
  replaces managed roots, including `/app`; it is **not safe while the retained
  server or its children use those roots**.
- Generic `managedDeliveryTool` accepts explicit roots and validates same-root
  relative symlinks (`workspace-api/src/delivery.ts:7–52`), but the prepared app
  wrapper supplies fixed roots (`prepared.ts:90–105`). No install API promises
  an atomic relocation of existing pinned destinations or automatic dependency
  dedupe among logical workspaces. Do not rewrite the pinned image/manifest to
  claim it supports a new layout.
- Keeping unchanged dependencies at `/workspace/node_modules` is a plausible
  minimal **shared ancestor** for `/workspace/projects/A` and B; ordinary package
  lookup walks ancestors. This is dependency reuse, not root isolation. Packages
  may resolve via realpaths, inspect cwd/package files, or write caches. Different
  dependency sets require separately managed identities and memory accounting;
  no arbitrary-package portability claim is justified.
- Backend overrides are relative `file:.browser-editor-backends/<hash>.tgz`
  (`prepare-dependencies.ts:66,122,130–159,175–181`; `prepared.ts:57–63`). Installed
  backend bytes already exist in node_modules, but installing from a nested root's
  derived lock would expect the archive relative to that root. Ancestor reuse
  does not relocate those install inputs. Toy must not install/update packages.
- Guest boundary plugin returns **relative** cacheDir
  `.browser-editor-cache/vite` (`workspace-api/src/vite.ts:14–18`) and resolves
  its private module against config.root (`:35–36`). Base is port/preview routing,
  not physical directory. Starting Vite with explicit nested cwd/root is possible;
  the fixed manifest preview options do not do it automatically.
- Verified actual delivered Vite 7.3.6 config bytes at
  `/workspace/node_modules/.bun/vite@7.3.6+6bded8e7c34e0714/node_modules/vite/dist/node/chunks/config.js`,
  SHA-256 `c2fcfa51206dc1f8d22120ef4a82af8b9acdc02f4476520b6a0897d12a724ba3`:
  root is explicit config.root or process.cwd (`:35539`); envDir follows root
  (`:35609`); explicit cacheDir resolves against root, default uses nearest
  package's node_modules/.vite (`:35616–35617`); default publicDir follows root
  (`:35619–35620`). Thus per-root explicit cacheDir is expressible without moving
  dependency bytes. Native config loading, framework plugins and their additional
  caches/realpath resolution still require actual qualification. No performance
  or compatibility result follows from these lines.

## Native location/session routing is not a tenant fence

Actual `648:442621–442625,552775–552816` uses directory spelling plus workspaceID
and an **infinite idle TTL**. There is no source-generation key. On this target
canonicalization does not realpath/normalize directory spelling; use exactly one
validated absolute spelling, reject aliases/trailing-slash variants/symlink roots.
Native workspace IDs are optional core provisioning identities, not the browser
Workspace.id or the app catalog UUID; their environment path can invoke native
workspace connection/provisioning (`648:408816`). Do not invent native workspace
IDs merely to name app roots. Distinct local directory refs without workspace IDs
are enough for this hypothesis.

The routing boundaries were reread:

- Location middleware reads `location[directory]` / `location[workspace]`, then
  header fallbacks, finally **process cwd `/app`**, and acquires that location
  (`648:555263–555282`). Never rely on missing location or just base-URL query
  propagation. Query directory is not session ownership authorization.
- Global session-create uses **payload.location**, otherwise cwd
  (`648:517546–517561,556222–556243`). Core create can return an existing caller
  ID before considering the requested location (`648:452206–452224`). Use a fresh
  server-created ID, explicit directory, and verify returned stored location.
- Persisted session `location` is reconstructed from stored directory and
  workspace_id (`648:81754–81757`). Session-scoped middleware fetches session by
  ID and provides its **stored** location (`648:555316–555321`); location query
  does not override it. Export/get/message/execution surfaces are not generally
  constrained by location middleware (`648:556244–556255,452287–452318`).
- Native session catalog has an actual **separate** `directory` filter, not
  `location[directory]`: SQL compares equality when directory is present,
  workspaceID only when truthy, and optionally project/subpath/parent/search
  (`648:81838–81861`). Missing workspace filter does not mean “workspaceID IS NULL.”
  Cursor replaces the handler's query selection (`648:556180–556204`), so subsequent
  cursor scope must be validated, not allowed from another root. App API uses this
  directory filter (`opencode-chat/src/api.ts:55–65`); native transfer does too.
- Project resolution is independent: without VCS it hashes resolved directory;
  ancestor Git/Hg roots can group nested directories under one project
  (`648:523507–523537`). Use the directory filter and stored session location,
  not projectID alone, to fence nested logical workspaces.
- `session.active` is global (`648:556248–556252`), as is event SSE
  (`648:557124–557182`). One event subscriber receives the global feed; location
  queries do not filter it. SSE has a bounded dropping queue (capacity 4096),
  overflow failure and a 15-second heartbeat, not per-workspace isolation.
- `api.ts:72–110` accepts arbitrary session IDs for messages/mutations and exposes
  global active/events. Controller session-ID filtering is not a complete fence:
  title events update its catalog before selected-session filtering
  (`controller.ts:229–236`). Disposing a chat joins local reader/runtime work
  (`:640–658`), not all remote plugin/execution/background work.

Required application boundary: immutable active generation + directory + owned
native root IDs; check each ID against verified stored location before admitting
an ID route; reject stale generations **at dispatch**, including old closures,
queued hydration and retained selection. Allow only explicitly reviewed routes,
query/header keys and payload shapes. A location-only GET query, endpoint listener
token or UI disabled state is insufficient. Global event data must be filtered
before catalog/reducer mutation, with unowned/location-less events separately
classified; the smallest finite toy can omit SSE entirely.

## Multiple valid old locations and global background refresh

Distinct stable locations avoid invalidating A on A→B, so A's scoped plugins and
services intentionally remain valid. This removes the *particular* removed-key /
same-key reacquisition race from that transition. It also retains their listeners,
catalog/config/tool state and any legitimate owned background activity.

`648:558831` enables global ModelsDev fetch. `648:538209–538289` owns a global
KV-backed cache, a five-minute repeat, HTTP retry/timeout, catalog invalidation
and Refreshed publication (including an initial refresh attempt, not simply a
timer that waits five minutes first). This owner is shared; there is not a fresh
network refresh process per project. Every activated location's built-in
`opencode.models.dev` plugin subscribes and updates loaded snapshot state then
reloads **its own** integration and catalog (`648:543901–543942`). Those callbacks
remain active for A **and** B even when UI selects only B. Reload capabilities
are actual location service reloads (`648:461351–461360,461444`), not a UI refresh.

Proven direct consequences: global cache writes/possible network egress, per-live-
location callback/state work, retained subscriber/fiber ownership, and global
events potentially reaching any client. **Not proven:** that this callback alone
edits inactive project source, that all composed transforms are side-effect-free,
that its timing is harmless, or that plugin-launched/escaped JS/process work is
drained by activation completion. Source stability makes such writes land in the
old root rather than accidentally in replacement B, but does not forbid them.
Arbitrary plugins can use filesystem/process/global storage APIs; a directory is
not a kernel filesystem sandbox. Writes outside the root remain possible.

Global config loads at location boot and offers reload mechanics
(`648:449437–449470,451110–451150`); delivered `project:false` disables ordinary
project config discovery, not global supplementary plugins/config. Stable A/B can
still share global settings. Changing those bytes/env while retaining locations
can produce old/new state coexistence. Plugin activation tracks revisions/closes
changed activation scopes (`648:460740–460812`), but module imports use the main-
context default loader (`648:83812–83823,461665–461666`) with no reviewed cache
invalidation guarantee. Freeze plugin/config/dependency/environment identity for
the toy; changes still require existing conservative restart fallback.

Infinite location TTL supplies no LRU/count/memory cap. Bounded two-root ownership
caps the number of deliberately booted location entries for that experiment,
not bytes/listeners/fibers spawned inside them. Long-term growth includes native
sessions, global caches, plugin storage, process module cache, queues and children.
There is no resource-growth measurement here. Event queue bounds do not bound the
whole service. Any future root deletion/eviction needs admission freeze and
reader/execution/plugin drain again. Debug key absence is not that receipt;
positive-reference invalidate still removes the key without joining entry close,
and same-key reacquisition remains forbidden (earlier delivered audit).

## Comparison, restricted to source consequences

| Candidate | What source supports | What remains unresolved |
| --- | --- | --- |
| Same directory replaced + evicted | Existing replacement flow can restart services conservatively; restricted zero-ref eviction argument is conditional. | Old location sees replacement pathname; positive-ref/same-key hazard; background/finalizer drain and source-generation identity required. |
| Stable server/state directory only | Protect server files/state if excluded from cleanup. Code/DB already outside project source. | Source key remains `/workspace`; old source readers/writers/config caches still overlap replacement. Does not fix location lifetime. |
| Distinct stable source locations; no switch eviction | Cached A and B can coexist; stored native session locations and explicit directory catalog filters are available; selective Vite restart is available. | Root/session/client enforcement, shared global refresh/events/config/plugins, tool cwd defaults, resource caps and eventual drain/eviction. No speed or overall-safety superiority proven. |

## Smallest post-hardening exploratory contract (not implemented/authorized)

This is a bounded feasibility question, not a replacement architecture plan:
“Can one exact delivered OpenCode execution/listener remain unchanged while one
preview execution is restarted against two unchanged distinct local roots, with
finite requests restricted to each explicitly owned location/session?”

Preconditions and scope:

1. Finish existing parent-owned mounted hardening/cleanup qualification first.
   Fresh separately owned origin/artifact selection; no concurrent editors,
   independent clients, sessions already executing, PTY/jobs/child tool work.
   Freeze exact 648/image/runtime/config/plugin/env identities. No inference,
   shell/tool/permission/form/model mutation, package install, source replacement,
   session import/delete, location reload or eviction.
2. Exactly two validated non-symlink roots A/B, exact spellings, both retained
   unchanged. Illustrative `/workspace/projects/<id>` is **not** a selected layout.
   Use one Workspace/Runtime, one server start and one managed delivery before
   that start; never redeliver `/app` or dependencies while server lives. Root-
   scoped source operations/cacheDir/preview cwd must be explicit. No changes to
   frozen archive/image/source recipes are implied by this report.
3. Background must be **classified, not declared absent**. Actual 648 ModelsDev
   already violates the old literal `backgroundWork:false` premise even without
   inference. Before admission, parent must separately resolve global refresh /
   multi-location subscriber qualification and any egress restriction. A quick
   run shorter than five minutes or a no-prompt run does not satisfy that gate.
   Unchanged 648 cannot be claimed a no-network/no-background toy merely by
   excluding model routes. This report offers no waiver or server patch.
4. Finite owned requests only; direct root-specific controller/transport rather
   than cached `attachChat` retargeting. If native session create/read is admitted,
   one fresh root ID per directory with explicit payload.location and verified
   returned location/empty hydration; route fence pins only those IDs. No SSE is
   needed for the smallest toy. If later admitted, SSE has its own joined reader
   and pre-reducer filtering obligations. Stale A client dispatch rejected while
   B is active, even though A's server location remains valid.
5. Freeze/serialize launches and finite readers, explicitly join outgoing local
   client/preview ownership; call only `stopService('vite')`, then launch Vite with
   B cwd/root/cache. Do not call stopRuntime/stopServices/clearWorkspace or close
   chat stdin. Poison/fail closed on timeout/abort/concurrency/unexpected route,
   service exit/output failure or ownership mismatch; existing full teardown
   remains recovery, not silent continued retention.
6. **Exact process identity proof is feasible but composite:** retain the same
   Service.execution/endpoint objects; continuously observe that execution.exited
   never settles and healthy/drained output has no failure; compare finite health
   PID (`648:557355–557361`), listener token and kernel diagnostic process rows
   before/after each switch. e35 kernel sends `{execId,pid}` at proc-started
   (`kernel-worker.ts:1240–1267`) and `{port,pid,listenerId}` with per-kernel
   listener generations (`:1746–1748`); e35 endpoint embeds/pins listenerId
   (`host-sdk/browser/endpoint.ts:6–34,55`). Public Execution drops PID/execId
   (`host-sdk/execution.ts:54,82–104`), so health PID alone is not an exact receipt.
   A dedicated bounded host-observation mapping or already qualified owner probe
   must connect launch/execution to that PID/listener without exposing internals
   as a new production API. Diagnostics are independent samples, not atomic proof;
   retained object + uninterrupted execution + same listener/PID evidence plus
   exclusive ownership is the required conjunction.
7. Toy success would establish only no-inference switch expressibility and observed
   identity/routing/source preservation for that bounded run. It would not admit
   arbitrary execution, background inactivity, deletion/eviction, changed config/
   plugins/dependencies, memory/performance wins, or long-term retention safety.

The next decision stays with parent/user after hardening. No source finding here
upgrades the current retained-process candidate to accepted retention.
