
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
  restricts `os`/`cpu` (and `cpu` lacks `wasm32`). That removed all 9 native packages in
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
