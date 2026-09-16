# Vivari integration workflow

The editable runtime is the standalone `kkrausse/vivari` fork on `browser-runtime`.
Default local source: a sibling `vivari` checkout next to `browser-agent-toolkit`.
`VIVARI_SOURCE` overrides this. Read `DEVELOPMENT.md` before runtime work.

- Do not edit `.runtime/patched` or regenerate `patches/0001-sqlite.patch`.
  Older handoffs describe the retired workflow; use this file and DEVELOPMENT.md.
- Edit normal files in the fork and follow its AGENTS.md and ARCHITECTURE.md.
- Resolve host build/test paths through `scripts/runtime-source.mjs`. Browser
  imports use the Vite source alias, not this Node filesystem helper.
- Generated WASM, bundles, receipts, and caches are not editable source.
- Keep generic contracts with the fork; keep application packaging and browser
  qualification here. Retain explicit completion checkpoints, not just exit zero.
- Runtime tools should use supported files/execution/package APIs. Add a kernel
  operation only when a reusable missing capability actually requires it.
- Target upstream install/mount-and-run without prerequisite package-hacking
  scripts. Runtime shims/loaders and reusable JS/WASM backends own compatibility;
  normal upstream builds and generic dependency/asset delivery remain valid.
  Investigate direct execution before adding consumer transforms. Record existing
  transforms as temporary exceptions with removal gates; preserve lazy imports.
  Historical case studies and cleanup plans remain in the original `random` repo.
- Commit only your own files in each repository. Preserve concurrent work and
  existing runtime checkouts. Browser automation uses the browser-control CLI.
