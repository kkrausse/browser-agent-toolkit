# Single-kernel live wrapper follow-up — 24c9042

September 30, 2026. Parent-observed evidence from the Bun-backed Browser Control
CLI session `quiet-panda-336`; this documentation-only follow-up performed no
browser/process operations, rebuild, or push.

## Current ownership and unchanged inputs

- Working URL: **http://127.0.0.1:54770/**; server PID **88406**.
- Output/receipt: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-interactive-1790778679425/live-origin.json`.
- Wrapper repair: `24c9042`, stable module-level `hostPaths` and readiness callbacks.
- Frozen input: `.diagnostics/single-kernel-e35eab4-full-attempt1`.
- Runtime: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Distribution: `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
- Receipt verifies **9,587 artifacts**, **zero runtime builds**, `e2e: false`,
  and no private credential configured. Runtime/distribution remained unchanged.
- Browser journal: `/Users/kkrausse/.browser-control/sessions/quiet-panda-336/journal.jsonl`.

## Chronological observations

1. The original wrapper at `http://127.0.0.1:53971/` / PID **82790** exhibited an
   iframe reattachment loop; its observer recorded **2,828 iframe navigations**.
   Inline attachment-prop identities were replaced by stable module constants
   in `24c9042`. The old browser workspace exited orderly before transition to
   the fresh wrapper origin. That old server was left serving, but is **not the
   recommended exploration origin**.
2. At the new origin, chat reached **Ready** and the TODO preview hydrated.
   The parent created **Single-kernel live smoke test** and completed it. The
   immediate Playwright `check` reported a controlled asynchronous state
   mismatch; a subsequent independent wait verified the checkbox was **checked**.
3. The parent loaded `/src/home.tsx` and used the explicit UI save to change the
   heading to **Todos · live editing verified**. Vite HMR was logged. Following
   observer reset, CRUD/HMR caused **zero preview navigations**.
4. **Session & model** disclosure remained stable. **New chat** created
   `ses_f0d43c5f2ffeoENBgXI9XWrE0E` and hydration ended. No model was called.
5. **Exit** returned the **Open editor** button. A full `page.reload`, then
   **Open editor**, reached **Ready**. The heading edit and completed TODO
   persisted across the full reload.
6. The parent restored the source heading to **Todos**, used **Save and flush**,
   and verified HMR. Only the owned smoke-test TODO was deleted, yielding
   **No todos yet**. The live browser/editor and current server were left active.

## Outcome and limits

**Fresh wrapper boot + manual CRUD/HMR/persistence bounded pass.** The
interactive attachment-loop diagnostic is resolved for this follow-up; it was
an application-wrapper identity loop, not evidence of a Browser Control defect.

This is **not** a full E2E pass, model-inference test, post-close worker census,
or performance qualification. Standard model-proxy public routing remains
untested, and no private credential was used. New-chat hydration is not model
inference evidence. The existing fresh full E2E `17ef8e3` worker-cleanup failure
remains separate and unresolved: case 1 retained a kernel target beyond the
15-second census bound, and cases 2–9 were not reached. The old workspace's
orderly Exit and the interactive reopen observation do not supersede that
cleanup failure.
