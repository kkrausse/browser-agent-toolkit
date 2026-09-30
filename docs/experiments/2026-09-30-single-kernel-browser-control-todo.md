# Browser Control diagnostic scope todo

Browser Control 0.8.2, relay build `2026-09-20T05:32:28.650Z`, extension 0.0.25.
Owned session: `single-kernel-app-3abef79d`, fresh test page
`http://127.0.0.1:62428/`. No old origins were targeted.

The first optional blocked-worker stack diagnostic used a raw WebSocket inside
the Bun Browser Control CLI without binding its session scope. `Target.getTargetInfo`
returned `Target not found: 4E5F03019AEA084B110F06CB01741A3A` even though the
session's normal CDP/Playwright inventories exposed that owned worker. Expected:
read the exact retained worker stack. Actual: raw client could not see the worker.
It closed its socket; no debugger pause or navigation occurred.

Correction: bind the documented relay query `browserControlSessionId`, attach
only the exact owned root, and replay its nested targets before resolving the
owned worker. This is session scoping, not a relay restart or security workaround.
The runtime's child-sync hang is separate from this diagnostic setup issue.

The corrected session-bound diagnostic succeeded. It captured `execSync →
spawnSync → spawn → call`, parked in `Atomics.wait` for opcode 20. The debugger
was resumed and the diagnostic socket closed. No workload was restarted and
no browser relay restart/session replacement was necessary. Todo resolved as
diagnostic setup, not a Browser Control runtime defect.

## e35eab4 post-close target propagation observation

Same installed Browser Control version/interface, owned session
`single-kernel-app-32c23419`, new origin `http://127.0.0.1:54123/`.
After the joined workspace close, the immediate `Target.getTargets` still returned
the terminated kernel and PID 14; the harness's strict zero census failed. A single
later read-only census returned only the owned page. No stop/close replay, reload,
reset, relay restart or session replacement was attempted. Expected: bounded
observation of target removal after close; actual: immediate assertion raced target
propagation. Offline harness repair uses at most 15 seconds of read-only census
polling and still rejects auxiliary workers immediately. The failed attempt is
retained, not retroactively marked passed.

## Interactive consumer iframe reattachment loop

Browser Control CLI 0.8.2 (confirmed with `--version`); previously recorded relay
build `2026-09-20T05:32:28.650Z` and extension 0.0.25 were not re-queried here.
Parent-owned session `quiet-panda-336`, isolated loopback page
`http://127.0.0.1:53971/`, live host PID 82790, initial consumer commit `7a131b7`.
No browser automation, relay restart, runtime rebuild, or server restart was
performed by the diagnosing agent.

Observed errors, from the session journal:

- `locator.waitFor: Timeout 120000ms exceeded.` waiting for the hidden
  `Load file` button. The source disclosure was collapsed: locator misuse,
  not evidence of a Browser Control failure. 3,067 console/page events were
  captured (3,065 repeated entries folded).
- `locator.click: Timeout 30000ms exceeded.` for the preview's `Add` button
  after filling `New todo`; 848 console/page events, 846 folded.
- `locator.evaluateAll: Execution context was destroyed, most likely because
  of a navigation`, diagnostic `execution-context/context-destroyed;
  pageClosed=false; urlChanged=false; mainFrameNavigations=0`.

Reproduction: open the live editor; let startup finish; expand the source
disclosure and load `/src/home.tsx`; fill the TODO input and click Add. Expected:
one stable preview attachment, enabled Add for nonempty text, successful mutation,
and readable preview DOM. Actual: repeated Vite connecting/connected messages,
lost preview state, intermittently blank preview, disabled Add after a separately
successful fill, and destroyed iframe execution contexts. Main page/chat remain
healthy; a follow-up preview read showed the initial empty list. A parent-observed
chat disclosure click also failed to remain expanded; causality for that symptom
is not independently established.

Diagnosis: the live consumer subscribes to every controller snapshot but supplies
new inline `hostPaths` and readiness callback identities on each render.
`EditorPreview` includes both in its attachment effect dependencies. Its readiness
check calls `clientReady`, which publishes another controller snapshot; cleanup
disposes the attachment and navigates the iframe to `about:blank`, then reattaches.
Process-output publications can trigger the same cycle. This explains iframe-only
navigation without main-frame navigation, rather than a Browser Control defect.
The host log contains only its startup ownership receipt; the Bun host builds its
bundle once, has no hot/watch mode, serves static assets with `no-store`, and has
no automatic reload or heartbeat navigation. Runtime/provider proxy behavior was
not changed.

Recovery attempted by parent: short follow-up reads retained the healthy main
page; no session replacement. Consumer repair hoists attachment props to stable
module constants. The running host has already-built bytes: coordinate a host
restart/new origin and explicit browser transition with the parent to activate
the fix. Do not reload away unflushed source edits. Live verification remains
pending; retain this todo until the parent confirms stable attachment and TODO
interaction. No private form values or credentials are recorded here.

Offline validation: the corrected live consumer bundles successfully in memory
against the same frozen qualification libraries (two outputs; nothing written or
served). TODO consumer tests: 99 passed, one failed because
`reuse-pilot-fence.test.ts` imports an absent historical `.diagnostics` runtime
source endpoint; the failure is unrelated to this prop-identity repair.
