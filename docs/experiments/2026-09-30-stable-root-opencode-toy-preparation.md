# Two fixed source roots — preparation blocked

Absolute report path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-stable-root-opencode-toy-preparation.md`

## Outcome

**Not runnable-prepared, not executed, `retentionAccepted:false`.** A concrete
actual-648 source preflight found a blocker to the requested **root-varying config
response bytes under explicit location routing**. No placeholder UI or mock
candidate was created. No browser, host, guest, OpenCode process, API call, session,
SSE, inference, tool or PTY was started. No existing stage/runtime/app was changed.

The blocker is not two-directory creation or retaining one process. Those remain
source-expressible, as documented in the source-feasibility report. It is the
stronger config-routing acceptance criterion imposed on the exact frozen server.

## Actual artifact boundary

Read in full before this preparation:

- `docs/experiments/2026-09-30-stable-opencode-workspace-source-feasibility.md`
  (source-feasibility delivery `7aa5cf2`).
- `docs/experiments/2026-09-30-delivered-opencode-retention-lifetime-audit.md`
  (delivery `4b3738d`).

Fresh preflight verified the read-only prepared manifest hash
`57a149355cbfa1974da6637bbe6e437b23d7455d13f0b11d088c1146f3497c7f`, its unique
`/app/server.js` asset, and the complete 27,721,680-byte actual server SHA-256
`648140f53c48820106d4727fd29f1914f8f86a4e2c3f3430551eb9dd41a806b5`.
This is not the baseline `1df` server or a version-label equivalence claim.

1-based LF source boundaries in those exact bytes:

| Boundary | Lines | Consequence |
| --- | --- | --- |
| Entrypoint | 558823–558849 | `config: { project: false, content: '{"snapshot":false}' }` is fixed; `models.fetch:true` is also fixed. |
| Server options forwarding | 558660–558677 | Config node receives `project`, `file`, `content` from those startup options. No per-request config selection is introduced. |
| Discovery | 449437–449471 | `project === false` produces no project directories; root-local `opencode.json`, `.opencode`, `.agents`, `.claude` discovery does not supply A/B markers. |
| File substitution | 447052–447097; 451074–451090 | Loaded path configs resolve relative file tokens against the config file's own directory, not the selected root. Frozen shared global files cannot substitute A/B-relative markers this way. |
| Virtual config | 451110–451137 | Virtual content substitution does use location.directory, but the fixed `{"snapshot":false}` contains no env/file token or root marker. |
| Config response | 558571 | `GET /api/config` returns config entries, not an arbitrary selected-root file read. |

Thus distinct immutable A/B config files can exist on disk, but this server does
not discover them through the admitted config route. Supplying location query
parameters, a UI label, or a fabricated codec response does not fix that. Global
config changes, plugin-injected location-dependent documents, credential/wellknown
mutations, config reloads, or modified server content would require a different
reviewed contract and violate this preparation's frozen-input limits. Setting an
environment variable does not change the literal startup options shown above.

This does **not** assert all possible config responses are permanently identical:
global background/config activity remains unqualified. It establishes that the
requested intentional root-local config-marker proof has no reviewed source path
under the permitted fixed inputs and finite routes.

## Reproducible source-only preflight

New owned helper:
`examples/todo-app/tests/sk-stable-opencode-preflight.ts`.

Run from the repository with Bun:

```sh
bun examples/todo-app/tests/sk-stable-opencode-preflight.ts
```

It only reads the pinned prepared artifacts, checks hashes and exact source
anchors, and writes an exclusive new ignored evidence directory. It fails if
artifact identity or an audited source anchor changes. It does not run the bundle
or its handlers, test a cache lifetime, or claim live byte parity.

Executed once locally, producing:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/sk-stable-opencode-blocker-21f1e5ff-68a8-4122-8ab6-b4ab7c0b8494/preflight.json`.
That receipt preserves extracted source text, LF ranges and excerpt SHA-256s.
No generic unit tests were added. No source archive, new built runtime/client,
origin, host-owner receipt, response-codec parity receipt or A→B→A continuity
receipt is falsely reported as prepared: the semantic admission gate failed before
those steps. Existing actual-codec executor and stages were inspected read-only.

## Narrow handoff to parent

One explicit scope decision is needed before implementing a real runnable toy:

- Keep actual 648 immutable and **expect shared config response bytes**, proving
  routing through actual project directory/canonical fields plus separately
  verified immutable A/B filesystem marker/config bytes. This is weaker than the
  requested root-varying config API proof and needs parent approval, not a silent
  substitution. Project ID/labels alone remain insufficient isolation evidence.
- Alternatively authorize a separately reviewed server/config identity with
  root-sensitive config discovery/content. That is not this exact pinned-648
  experiment and is outside this task's allowed mutations.

After that decision, ordinary trusted-button A0→B→A activation can be prepared
against a fresh committed source archive and frozen actual runtime/host pairing.
It must still serialize admission and finite completion before client publication,
reject stale epochs/closures, omit native session routes entirely, retain both
physical roots without eviction/removal, and preserve exact execution object,
health PID, listener generation/endpoint and exclusive host-owner receipts with
one start/one delivery. Streaming inputs must be excluded by the actual transport
shape rather than source attestation. No optional Vite restart is needed to settle
this blocker, and no SDK repair was bypassed.

Actual ModelsDev refresh remains owned by the still-running server; A/B location
subscribers can remain active. Neither `backgroundWork:false` nor remote drain is
established. Background callbacks, eventual deletion, resource bounds and large
cohorts remain production blockers. Even a later bounded passing toy would not
qualify native chat, full workspace/tool execution, background drain or long-term
production retention. Parent owns high-level design and final refactor decision;
sole browser QA owner remains `ses_f0c19439effe3pvL2PjB06ciX0`.
