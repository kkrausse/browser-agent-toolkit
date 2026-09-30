# Runtime architecture

[Editable Excalidraw scene](runtime-architecture.excalidraw).
PNG/SVG viewing exports are generated locally and untracked; the scene is the
source of truth, and its `.excs` sibling is an untracked editing projection.

- **Application policy:** choose jobs, commands, source/dependency delivery, launch order,
  readiness, and restart/reuse behavior. Vite and OpenCode are guest programs, not
  dedicated runtime infrastructure workers.
- **Toolkit lifecycle:** workspace and execution APIs coordinate the requested work.
  `Runtime.start()` attaches to an existing workspace host, not a second kernel.
- **Runtime mechanism:** the JS kernel supervises PIDs, the FS worker owns the live
  Rust/Wasm filesystem, and the fetcher handles delegated egress. Process FS calls
  go directly to the FS worker; not every syscall passes through the kernel.

Solid kernel/FS/fetcher boxes are baseline boot workers. Process workers are
created on demand; dashed helpers are lazy or UI-specific. The preview service
worker belongs to the host browser origin. Guest global `fetch()` can use browser
networking directly; not all egress goes through the fetcher. OPFS is persistent
backing storage, not the live guest filesystem.

## Source grounding

Checked against isolated Vivari candidate `446df00` (based on pinned `e998de62`),
plus toolkit sources. This is an architecture diagram, not a production-pin update.

- Vivari: `packages/core/src/host-sdk/host.ts`,
  `packages/core/src/workers/{kernel,fs,fetcher,process}-worker.ts`.
- Vivari: `packages/kernel-host/{kernel,kernel-fs,fs-server,opfs-persistence,sqlite-server}.js`.
- Vivari: `packages/core/src/host-sdk/browser/{endpoint,preview}.ts`,
  `packages/runtime/fs-client.js`, `packages/runtime/builtins/bun-worker.js`.
- Toolkit: `workspace-api/src/{workspace,runtime}.ts`,
  `opencode-chat/src/browser.ts`, `examples/todo-app/src/start-editor.ts`.

The diagram intentionally omits minor messages and asset-loader details. It does
not depict shipped Wasm artifacts as independent workers.
