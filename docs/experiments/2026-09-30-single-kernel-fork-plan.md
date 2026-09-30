# Single-kernel runtime fork

## Goal

Build a working isolated runtime fork before comparing performance with the existing
architecture. One kernel worker owns filesystem state, filesystem request servicing,
HTTP routing, persistence coordination, and process/workspace lifecycle. Guest code
continues running in separate process workers. Retain browser-required service-worker
plumbing; it must not become an independent runtime authority.

## Boundaries

- Toolkit worktree: `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel`.
- Toolkit branch: `experiment/single-kernel-runtime`.
- Runtime implementation lives in a separate editable Vivari worktree, selected
  explicitly through `VIVARI_SOURCE`; record its base and branch before edits.
- Preserve the canonical checkouts, prior runtime candidates, experimental evidence,
  provenance, licenses, and published archives. No push or deployment.
- Prefer a coherent experimental implementation over preserving the old internal
  worker topology. Preserve public behavior where practical and document changes.

## Implementation sequence

1. Map worker initialization, synchronous guest filesystem channels, HTTP delivery,
   native/WASM initialization, persistence, and shutdown. Choose and record the base.
2. Move filesystem ownership and request servicing into the kernel. Kernel-local
   operations must call the owned filesystem directly, never wait on themselves.
3. Consolidate runtime HTTP coordination and lifecycle ownership. Avoid synchronous
   waits in the kernel that prevent it from servicing guest requests or cancellation.
4. Build verified runtime/host artifacts and a separate example consumer.
5. Test real browser startup, filesystem operations, Vite preview, OpenCode health,
   streaming, stop/drain, source replacement, and persistence/reload. Assert the
   intended worker topology rather than merely asserting successful startup.
6. Repair concrete failures until the bounded acceptance suite works. Record known
   limitations. Performance comparisons follow working-version acceptance.

## Acceptance

One kernel worker plus guest process workers, with no dedicated filesystem or
optional HTTP coordinator worker. Filesystem correctness, guest synchronous I/O,
preview and server readiness, lifecycle cleanup, and persistence must have explicit
completion evidence. No model calls or claims of usable model chat without a test.
Existing retained investigation pages and servers are not test targets.

The parent session owns direction and integration decisions. Subagents own runtime
implementation and focused testing; browser ownership is exclusive. Keep progress
reports concise and commit only owned changes.
