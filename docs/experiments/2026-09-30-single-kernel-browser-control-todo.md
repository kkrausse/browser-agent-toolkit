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
