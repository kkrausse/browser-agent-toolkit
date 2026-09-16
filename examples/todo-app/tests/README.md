# Combined editor browser acceptance

This harness was carried over from the original POC. Historical browser receipts
remain in `random`; this document gives run instructions, not fresh qualification
of the extracted repository. Inspect current UI before using a phase: source-editor
phases can be unavailable in newer panel versions.

`editor-acceptance.js` is a Browser Control execute body, prepared against the
current `examples/todo-app/src/{home,editing,editor-panel}.tsx` and
`opencode-chat/src/{editor,react,types}.tsx` / vendor types. Preparation/runtime/OpenCode migration is coordinated by the parent;
this file does not launch, rebuild, navigate, reset storage, or select its session.
Historical context remains in the original repository's acceptance documents.
Candidate protocol was also checked against the refreshed generated vendor types,
`vendor/reducer.ts` (`session.tool.called/success` → native tool objects), and the
retained beta-19425 source at `server-process-candidate.0co24kti/.runtime/opencode-v2-source`:
`packages/core/src/tool/plugin/shell.ts`, plus `shell/result.ts` and the native edit
input schema. The candidate uses **shell**, not the older **bash** tool name.

## Launch through the Bun-backed CLI only

Use the Bun-backed `browser-control` CLI. No MCP, direct Playwright connection,
or alternative browser driver. Select an explicit session; commands below use
`SESSION` as a placeholder.

After the parent prepares/builds/launches the app and deliberately navigates its
chosen page to the exact URL, configure once (absolute evidence directory outside
tracked sources; receipts can contain demo source, todo titles, tool inputs/output):

```sh
bunx --bun browser-control execute --session SESSION 'state.editorAcceptanceConfig = { url: "http://127.0.0.1:4390/", evidenceDir: "/absolute/private/editor-acceptance", phase: "startup" }; return await snapshot()'
bunx --bun browser-control execute --session SESSION --file examples/todo-app/tests/editor-acceptance.js

# Select each subsequent phase, then execute the same file:
bunx --bun browser-control execute --session SESSION 'state.editorAcceptanceConfig.phase = "open"; return {phase: state.editorAcceptanceConfig.phase}'
bunx --bun browser-control execute --session SESSION --file examples/todo-app/tests/editor-acceptance.js
```

Run from the repository root or use an absolute script path. Do not run the file
as `bun tests/editor-acceptance.js`: `page`, `state`, `snapshot`, `fs`, and `path`
are injected by Browser Control. `sourcePath` defaults to `/src/home.tsx` and
`headingFrom` to `Todos`. Change them only after inspecting the actual source.

Each invocation inspects DOM first, performs one phase, inspects again, and writes
a uniquely named JSON receipt. State and JSHandles preserve exact document and
controller identity across phases without installing production hooks or globals.
Filesystem reads call the real `workspace.fs.readFile` via a read-only controller
handle obtained from the controlled React DOM ancestry. Missing/minified/changed
React shapes block rather than selecting a guessed API. No callbacks or hook state
are modified. Expanding a tool `<details>` is the only DOM-only UI action.

Receipts have `PASS`, `SUBMITTED`, `PENDING`, `BLOCKED`, or `OBSERVED` status.
**CLI success is not phase success**: assertion failures are captured as `BLOCKED`
so diagnostics survive. Consumers must check `value.status` (CLI `--json`) or the
artifact's `status`. There is no aggregate PASS. A `PASS` applies only to the named
phase. Source flush means local workspace persistence, not remote publication.

## Phase order and evidence

| Phase | Action / required proof |
| --- | --- |
| `startup` | Admin launcher enabled, normal todo UI ready, editor/preview absent; retain normal document/main identity and independently query host todos. Run before opening. |
| `open` | Click launcher once; returns SUBMITTED. |
| `ready` | Observe actual workspace lifecycle, both Vite/chat clients ready, real chat connected, enabled iframe todo form; normal app stays mounted in same host document. Repeat while PENDING. |
| `crud-add` | Add uniquely named owned todo inside iframe; independently GET host `/api/getTodos` and retain its ID. |
| `crud-toggle` | Submit one completion click for the owned todo; independently prove host `completed:true` and checked DOM state. Repeats observe without toggling again. |
| `crud-delete` | Delete only that exact owned title/ID and prove absence from host API. No broad cleanup. |
| `source-open` | Open Source; current textarea must equal independent `/src/home.tsx` bytes. |
| `hmr-edit` | Capture original bytes and preview document; fill textarea with one h1 edit, no explicit save/flush. SUBMITTED. |
| `hmr-verify` | Exact independently read bytes + explicit local flush UI status + changed heading + same preview Document. Repeat while PENDING. |
| parent coordination | Inspect chat and choose **New chat** if no selected session. Select a real tool-capable model if required. Harness does not silently create extra sessions or select a guessed model. |
| `model-send` | Submit genuine read + minimal edit prompt once, storing prior session/message/tool IDs first. |
| `model-verify` | New user message in same session, idle execution, completed assistant, new native read/edit tools targeting exact file, `executed:false` (local), ran/completed timestamps, correlated edit old/new strings, exact independent source bytes, changed heading, same preview Document. No model prose is used as evidence. |
| `file-link` | Open actual tool file button and compare textarea with independently read edited file. |
| `shell-send` | Independently reread the model-verified source, require unchanged bytes, compute its SHA-256, then ask native built-in `shell` to execute the exact ordinary `node -e` source-check command once, foreground with timeout 8000ms. Node reads `/workspace/src/home.tsx` with `node:fs`, checks the complete byte hash with `node:crypto` and the expected h1, then emits a unique marker. |
| `shell-verify` | Correlate sole new native local tool to same session and exact Node command; require completed status/timestamps, numeric `metadata.exit === 0`, non-truncated completed metadata, first text content equal to exact success marker including newline, second text content equal to the candidate's exit notice. Independently reread unchanged workspace source afterward. Unknown contracts BLOCK. |
| `close` | Capture session/message IDs, exact source, and live lifecycle handle; click Exit only when chat idle. |
| `closed` | Retained controller reports no workspace/runtime/services, persistence closed; iframe detached, normal main retained, launcher enabled; captured pre-close service executions have exited and output drains joined (record exitCode/signal/forced). Repeat while PENDING. |
| `reopen` | Click launcher once; then run `ready` and `source-open` again. |
| `retention` | Compare independent full source bytes and original session/message IDs plus stable conversation content/native tool records after reopen. If prior chat isn't auto-selected, parent must select it via inspected UI; load earlier messages if paginated, then retry. |
| `inspect` | Observation-only snapshot/status/activity receipt at any point. |

Actions/waits are limited to 8 seconds; `ready` and turn verification take short
observations rather than monopolizing a long execute. Workspace reads and host API
requests also have 8-second bounds. A PENDING result is **not** a pass. Parent should
set an overall deadline (suggestion: 180s startup, 30s autosave/HMR, 180s model/shell,
60s cleanup) and stop with the latest diagnostic receipt when exceeded. Browser
context evaluation itself remains subject to the CLI's transport timeout.

Do not automatically rerun action phases after a timeout: inspect the existing
todo/source/turn first. Send intents are stored before clicking to prevent duplicate
model submissions. Preserve the Browser Control journal and all JSON receipts.
On a relay restart, `state`/handles are lost: old disk receipts remain evidence,
but cross-phase document identity can no longer be established. Start a new
explicit baseline rather than manufacturing identity from old timestamps. A reload
also invalidates same-document evidence; there is intentionally no automatic reload.

## Additional coordinated cases / limitations

- **Startup cancellation:** use a separate run/baseline; `startup`, `open`, then
  `cancel-startup` while actual controller `busy` is true, followed by `closed`.
  If startup already settled, cancellation is BLOCKED, not a pass. Parent coordinates
  reopening and readiness afterward. Closed lifecycle evidence proves controller
  cleanup and joins captured service exit/drain promises; it is not independent
  OS/worker leak instrumentation or a claim that shutdown was natural exit 0.
  Startup cancellation may occur before services exist; its captured list can be
  empty and does not establish cleanup of a fully running editor.
- **Strict new Tailwind utility:** after `source-open`, run `tailwind-baseline`.
  Parent first verifies the utility is absent from the entire prepared source/CSS
  graph (the script checks only target source and initial computed value). Through
  the inspected source textarea add `className="tracking-[7px]"` to the h1, preserving
  its text and other code; wait for local autosave. Run `tailwind-verify`: independent
  source inclusion, same Document, rendered class, and computed `letter-spacing:7px`
  must all hold. Config override: `tailwind: {utility, property, value}`. A class in
  source/DOM alone never passes. Run this after retention or preserve the amended
   retention baseline deliberately; do not perturb model's exact-one-edit comparison.
   The completed PR run used `{selector: '.row', utility: 'text-[37px]',
   property: 'font-size', value: '37px'}` and the exact `className="row"` →
   `className="row text-[37px]"` edit. The gate also requires a matching declaration
   in the installed CSSOM. The unlayered h1 font-size rule makes `.row` the correct
   target for this font-size test. Actual HMR CSS responses are captured separately.
- **Shell migration blocker:** extraction follows beta-19425's real `toolResult`
  and `ShellResult.metadata/notice`: first content item is combined process capture,
  second is the tool-generated notice. Ordinary guest Node must read
  the exact target source through `node:fs` and verify its SHA-256 through standard
  `node:crypto` before printing anything. The expected hash comes from independently
  read workspace source, not from the model. Source-check path/hash/heading/marker
  are saved with both shell receipts; exact command is in the turn/native tool
  record. Missing Node, fs/crypto support, or mismatched source must block this gate;
  there is no host-runtime substitute or injected tool fallback. Capture must equal
  the exact success marker. This does not independently qualify stderr separation.
  Do not accept a model-authored “exit 0,” a custom JS stand-in, shell-looking prose,
  or normalize away banners/truncation. Missing metadata, failure to launch the
  platform shell, or different native payloads retain BLOCKED for parent diagnosis.
  Phase names/order are unchanged. An existing old printf-only shell intent cannot
  qualify the strengthened gate; preserve its receipts and coordinate a new run
  rather than resubmitting or rewriting its baseline silently.
- **Forms migration:** no `/question` endpoint is called. Permissions, the current
  question UI's form projection, unsupported forms, or a future native `forms` array
  stop verification for parent coordination. Unsupported forms must never be ignored
  to manufacture an idle/pass result.
- **Tool migration:** current ToolCard only exposes file links for `input.path` or
  `input.filePath`. Patch formats that embed paths solely inside a patch string are
  deliberately not inferred. Inspect migrated tool schema before extending target
  correlation; a completed unrelated tool must never satisfy model-edit acceptance.
- **Backend reload persistence:** CRUD already cross-checks real host state from
  outside the iframe, but does not reload the host. Parent can run a separate normal
  app create/toggle/reload flow; do not interleave reload with HMR document handles.
- **Authorization and lazy graph:** startup DOM checks do not establish absence of
  eager runtime downloads, nor unauthorized asset/model denial. Parent must collect
  pre-navigation network evidence on a separate non-admin fixture and inspect the
  prepared bundle graph. Record exact preparation/runtime/OpenCode hashes alongside
  receipts; this harness cannot infer which build the launcher serves.
- **Restoration:** original source is in `state.editorAcceptance.hmr.original` and
  the HMR/source receipts. After collecting retention evidence, parent may restore
  it through inspected **File contents**, wait for autosave, and use **Reload file**
  plus independent read to verify. Preserve any later user edits; no automatic full
  source reset, conversation deletion, storage clearing, or server restart occurs.

The execute body can be syntax-checked with Bun's `AsyncFunction` parser.
Distinguish initial guarded/failed observations from verified phase results.
The Node command builder additionally receives host-only sanity checks using a
temporary source fixture: exact output/exit 0 for matching bytes/heading, nonzero
exit with no marker for changed bytes, wrong heading, or missing source. This
validates command construction and quoting only, never guest Node or browser shell
acceptance.
