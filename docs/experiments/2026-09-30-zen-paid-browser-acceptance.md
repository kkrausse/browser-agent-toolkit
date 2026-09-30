# Paid Zen browser acceptance — September 30, 2026

## Outcome and evidence ownership

**Bounded live paid acceptance passed with corrected candidate `f56cbbd`:** Ready,
ordinary paid-model selection, one real paid Muse Spark 1.3 inference, and paid
selection/transcript retention across reload and workspace switching. Healthy switch
progress was observed without an Interrupted alert. A rapid New chat/send readiness
race remains a known bounded UI issue; not all flows are stable or qualified.

The parent performed and supplied these browser/host observations. This worker only
records them and reads public provenance; it performed no browser, code, runtime,
host-process or credential operations. No push was requested or performed.

## Chronological activation and observations

1. The user provisioned a separate `VIVARI_MODEL_API_KEY` in the ignored environment
   file. Presence was `true`; the actual key was never printed or copied into the
   guest. No IRS secret or personal OpenCode authentication was used.
2. Original host PID **88406** was orderly closed, then stopped after saving the exact
   `/api/getTodos` `result.data` array to
   `.diagnostics/zen-activation-todos-final.json`. Replacement host PID **72288**
   retained **http://127.0.0.1:54770/** and browser/native storage. Exact TODO
   restoration was verified: zero items. Source and native-origin state were retained.
3. Authenticated Zen `GET models` returned **HTTP 200 with 70 models**; the paid
   default existed. Catalog discovery alone is not proof of credential validity or
   successful inference. Initial paid boot nevertheless failed disabled-model gating.
4. The launch's initial catalog/default candidate was hot-swapped to `d208bea`, with
   the previous UI backed up in `.diagnostics/zen-proxy-startup-backup-1790787163822`.
   This candidate still failed: the public proxy marker alone did not undo the Zen
   pre-plugin's disabled state. The post configuration now explicitly emits
   `disabled: false` for supplied proxy models, preserving explicit caller disables;
   it restores availability after the pre-plugin gating. The host strips guest
   authorization and replaces it with host provider authorization. The public
   `editor-host-proxy` apiKey marker is not the private credential.
5. Corrected `f56cbbd` was staged in
   `.diagnostics/single-kernel-zen-paid-availability-staged-20260930`. Only compiled
   JS/CSS were copied into the live output; replaced UI was backed up in
   `.diagnostics/zen-paid-availability-backup-1790787903208`. Runtime bytes remained
   unchanged. Paid boot reached **Ready**. Ordinary pointer selection of paid
   **Muse Spark 1.3** succeeded without alerts. New chat resolved this paid default;
   existing saved conversations retained their prior explicit model choices.
6. First send immediately after New chat returned **ChatError: Chat is not ready**,
   with **no model call**. Its initial prompt was lost during hydration. The parent
   waited for the chat heading and refilled the prompt. This failed UI attempt is
   not counted as inference and is not relabeled successful.
7. One actual tiny paid Muse Spark 1.3 prompt was submitted:
   **Reply exactly OK. Do not use tools or change any files.** The assistant returned
   **OK**, followed by **Run completed**, without alerts or tool execution. This
   actual inference, not the model-list response, proves this bounded paid path worked.
8. Ordinary pointer selection changed the active test chat to paid **Qwen 3.8 Max**.
   **Exit/save → reload → Open editor → Ready** restored Qwen and the `OK` transcript
   without alerts. No Qwen inference was attempted or claimed.
9. During **SmokeB → SmokeA**, the parent observed the exact normal status
   **Switching to Smoke A… Restoring source, preview and chat.**, with no Interrupted
   alert. A completed; returning to B restored Qwen and the `OK` transcript without
   alerts. This verifies the healthy presentation fix in `9431953` on the combined UI.

Final active workspace is **SmokeB**, with the test conversation selecting paid Qwen
3.8 Max and retaining the Muse-produced `OK` transcript. All three existing
workspaces and the six original native chats were preserved; no storage wipe was used.

## Catalog counting and policy boundary

The supplied IRS loader snapshot contributes **28 entries: 26 paid and two free**.
The live picker also includes **six legacy free entries**, making **34 options**.
This is not an exact 28-option approved-only picker and does not establish enforcement
of the full IRS security/privacy policy. New chats use the supplied paid Muse default;
saved chats may retain previous explicit models. Paid Qwen selection/retention does
not prove Qwen inference or that every paid model is accessible.

## Provenance and retained artifacts

All relative diagnostics paths in this report are under
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/`.

- Live output: `.diagnostics/single-kernel-zen-paid-live-20260930-activation`.
- Original frozen input: `.diagnostics/single-kernel-e35eab4-full-attempt1`.
- Runtime revision: `e35eab4af7a53ff08eb70c09df59c40b78bfdd67`.
- Runtime version: `bfad1c4df939a808e476ee2803dddb9c7833a84c969edd8f106b3d5b440a426e`.
- **9,587** frozen input hashes verified; **zero runtime rebuilds**.
- Launch `live-origin.json` records the **initial**, unqualified browser candidate:
  `fd905d6e1f83498f110e3ce39d14af06f66a43536d1a67bbe9021824c610f198`.
  That startup record is not the final hot-swapped served UI identity.
- Final actual served JS SHA-256:
  `cc41088228f0f5363d5bd857bb34132caa2cb656ad6287156847db7fd7ef14ec`.
- Final embedded candidate browser library SHA-256, from the availability staging
  receipt: `b2fc801d557e59c93aee6e8e2f60094d04a077075406e20868660770a91c9149`.
- Staged CSS SHA-256:
  `e189d3bb577191a29718476ba1b3f17a4a9721e41f6eeb80b095fe51ff3b9e49`.

The staging receipt describes its own staging operation (`hostRestarted: false`),
not the earlier same-port host handoff. Candidate libraries remain **unqualified**;
no frozen qualification receipt was mutated or retroactively promoted by this pass.

## Scope and remaining caveats

This is one bounded real paid inference and observed UI persistence/presentation,
not agent-edit/tool/dependency-mutation acceptance, a full E2E suite, all-model paid
qualification, an account/funds/access guarantee, or a startup SLA. The disabled
startup failures and rapid New chat/send race remain part of the record. Healthy
switch observation does not newly qualify every interrupted-journal recovery path.
Previously recorded runtime/full-suite failures are not erased by this UI pass.

Preparation and causal records:
[catalog candidate](2026-09-30-zen-paid-catalog-candidate.md),
[proxy startup](2026-09-30-paid-proxy-startup.md), and
[switch presentation](2026-09-30-workspace-switch-presentation.md).
