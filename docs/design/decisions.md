
## 2026-10-09 — image format and prepare (bat-image / bat-prepare agent)

- **Index order is (parent path, name), not full path.** A plain full-path sort does not
  keep a directory's children together (`a/b` sorts before `a-x`, with `a/b/…` in
  between), so `readdir` would need a scan or a second table. Ordering by parent then
  name makes children one contiguous slice that a directory entry points at, while a
  literal full path is still one binary search. Measured on the TODO tree: 12,110
  entries, 1.73 MB head.
- **Body alignment is 16 bytes, not a page.** 4 KiB alignment would add about 2 KiB per
  body (~30 MB over 10k files plus 1.8k compiled bodies) for no benefit to a positioned
  read. It is a header field (`body_align_log2`), so a page-cache design that wants 4096
  is a writer flag, not a format change.
- **Facts word is `bat-modules`' word verbatim** (bits 0..23), plus two bits owned by
  prepare: bit 30 `FAILED`, bit 31 `IN_PROGRAM`. `bat-modules` must keep bits 24..31
  clear. The **facts blob** (import/export lists) is stored directly after the compiled
  body so one read returns both; its length is entry word 44.
- **`CODE_IS_SOURCE` modules store no second body.** 3,420 of 5,249 modules in the TODO
  tree compile to their own source; storing them twice would add ~50 MB.
- **Modules shipped in a program script keep no compiled body in the image** (only facts
  and blob, `IN_PROGRAM`). Otherwise the OpenCode bundle would be in the download three
  times (original 27.7 MB, compiled 27.7 MB, script 27.7 MB). Cost: without the script
  the loader must transform `/app/server.js` at run time.
- **Program registration is `__bat_define(path, fn)`** with the function header derived
  from the facts word; facts are not repeated in the script.
- **One image mounted at `/`** (`/workspace/node_modules`, `/app`, `/app/node_modules`)
  rather than one per root: one OPFS file, one handle per worker, one mount.
- **Editable source lives in `manifest.json`, not the image**, so a source-only change
  rewrites the manifest (3 ms) and never touches the dependency image.
- **Entry mtime is one fixed image-wide value** (2026-01-01T00:00:00Z), so equal inputs
  give byte-identical images (checked: same sha256 across four rebuilds).
- **Prune by rule, not by list:** a package is "platform native" when its package.json
  restricts `os`/`cpu` (and `cpu` lacks `wasm32`). That removed all 8 native packages in
  the TODO tree without naming them. `.map` (22 MB) and `.md`/`.mdx` (4.6 MB) are **kept**:
  whether the guest's Vite/esbuild read dependency source maps was not checked, and the
  brief was to be conservative. The policy's `prune.extensions` can drop them once a
  guest file-access trace shows they are never opened.
- **Two Bun installs, not three.** Frozen install of the project's own lock (proves lock
  and manifest agree), then install with overrides. The old third "delete and reinstall
  to verify" pass is dropped; both installs take ~0.3 s with a warm Bun cache.
- **`bun install --cpu/--os` cannot target the guest** (`wasm32` is rejected), so native
  optional packages are installed for the host and then pruned.
- **Need from `bat-modules`, not blocking:** `transform` takes the nearest package.json
  `type`; prepare computes it per package scope. Source maps for lowered TS/JSX are not
  stored in the image yet (no field asked for them).
- **Apps that are Bun workspace members are relocated, not re-resolved** (added when
  `examples/todo-app` became a member of this repo's workspace with
  `"@kkrausse/browser-agent-toolkit": "workspace:*"` and no lock of its own). Prepare
  stages the workspace root (root manifest + lock, every member's package.json, the
  `files` of linked members), installs there frozen, then builds a standalone
  `node_modules`: the store moves to `node_modules/.bun`, the member's links are
  re-pointed, each linked workspace package is copied to
  `.bun/<name>@workspace/node_modules/<name>` with links to its dependencies and peers
  (not devDependencies), and store packages nothing reaches are removed (288 of 417 in
  this repo: the toolkit's build-time dependencies). Rewriting the manifest to `file:`
  and letting Bun resolve again would have dropped the lock's pins.
- **The image's meta section carries nothing build-specific.** It briefly held the input
  fingerprint, which includes the tool binary's mtime, so every rebuild of `bat-prepare`
  changed the image hash and would have forced a 236 MB re-download for identical content.

## Toolkit package and TODO example (2026-10-09)

- **`RuntimeHost` is the only seam** between `packages/toolkit` and the runtime:
  `packages/toolkit/src/runtime-host.ts`. The runtime ships a module exporting
  `bootRuntime(options): Promise<RuntimeHost>`; `openEditor` imports it from
  `manifest.runtime.entry` (default `runtime/host.js` beside the manifest) unless the caller
  passes `boot`. Two members go beyond the list in the brief: `hostOrigin` (the runtime, not
  the toolkit, knows how a guest reaches the page's server, so "`host.internal` carries the
  page's scheme and port" is its fact) and `setHostPaths(port, prefixes)` (preview routing
  lives in the service worker).
- **`openEditor` returns `Promise<Editor>`**, resolved once the workspace is booted and both
  programs are starting; `editor.ready` is the rest. A synchronous return could not hand out
  `fs` or a preview URL, and waiting for the chat would hold the preview back. The chat
  controller exists from that moment: its requests wait behind the agent's verification.
- **The manifest is `bat-prepare`'s (`bat-prepared-v1`)**, not a second toolkit format.
  `prepare()` only maps options to `bat-prepare app` and reads the manifest back. The server
  handler adds `modelCatalog`/`defaultModel` when delivering it.
- **Chat client: Effect and `@opencode/client` dropped, reducer and generated types kept.**
  The published client's promise flavour is itself plain `fetch` plus a 40-line SSE reader,
  so `chat/api.ts` (about 120 lines, 15 calls) follows it call for call. The controller's
  scopes/fibers became three nested `AbortController`s plus the existing generation and
  selection counters. The vendored reducer (500 lines) is OpenCode's own event-to-message
  projection and was kept unchanged; the 6,500-line types file is type-only, exact generated
  2.0.3 output, and costs nothing at run time, so trimming it by hand would only lose the
  pin. Dropped with Effect: span diagnostics, the reader fence (dispose now aborts and joins
  its own requests), `exportChats` (superseded by native `editor.sessions.export`).
- **The `runJavascript` guest plugin still bundles Effect** (build-time, into one string).
  The promise plugin API shows no cancellation signal for a tool in its types (not tried at run time); the Effect one has it, and
  cancelling a runaway script matters. It now spawns `process.execPath` instead of
  `/bin/node.js`.
- **OpenCode is a Node program**: `node /app/server.js`, with `OPENCODE_DATABASE_PATH` inside
  `/workspace/.server/data`, so sessions persist with the workspace (the old runtime kept the
  database at `/runtime-probe`, outside it).
- **Startup order is one function** (`startupOrder` in `browser.ts`): the agent starts when
  the preview's server listens; both are joined; the preview's failure wins.
- **UI styling kept as it was.** The old chat UI already was shadcn-on-Base-UI with a
  prefixed, precompiled Tailwind sheet and Lucide icons; it is copied unchanged. Its
  dependencies are now ordinary `dependencies` of the package instead of being bundled.
- **A development fake host** (`./fake`, `./fake/server`) backs `RuntimeHost` with native
  processes so everything but the runtime is exercised for real. Measured there on diesel2
  (native Vite 7.3.6 and OpenCode 2.0.3, machine otherwise busy): preview listening 1.0 s
  after spawn, app visible 3.6 s after Open, agent verified 3.7 s after its spawn, chat
  attached 6.1 s after Open. These are native floors under load, not runtime numbers.
