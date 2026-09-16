# Published OpenCode 2.0.3 server

This release replaces the retained beta-19425 build in the TODO editor. It uses
the exported `@opencode/server/process` entrypoint, ordinary Effect scope ownership
and stdin EOF shutdown. All package versions/archive integrities are in `bun.lock`.

```sh
bun install --frozen-lockfile --linker isolated
bun run build
node probe.mjs
```

Use Node 24 for the real-worker probe. Output and immutable recipe copies go to
`../../.runtime/opencode-release-2.0.3/`; the probe uses isolated disk-backed SQLite
snapshots, not browser OPFS. It requires authenticated health reporting version
2.0.3, unauthenticated denial, EOF scope completion and natural exit 0.

Two remaining dependency selections are explicit:

- `@effect/platform-node-shared` is overridden to `4.0.0-rc.112`, matching this
  release's Effect family. Its transitive range otherwise selects rc.115, which
  imports `effect/ByteSize` unavailable in rc.112.
- The existing published `jsonc-parser` ESM entry selection avoids a guest failure
  resolving its UMD `./impl/format` require. No sources or emitted bytes are edited.

The three tree-sitter WASM files are copied unchanged from installed packages.
The bundler's emitted native FFI asset is retained, not asserted to execute in
Vivari. Build outputs/receipt are exact qualification identities: different host
paths, Bun versions or native platforms may produce different hashes and require
qualification before updating the toolkit's pins.

For beta database migration, set `OPENCODE_PROBE_BASELINE` to the retained beta
root and `OPENCODE_PROBE_STORAGE` to a new isolated directory, and run
`node probe.mjs --seed-migration`. Then unset `OPENCODE_PROBE_BASELINE` and run
`node probe.mjs --verify-migration` with the same storage. This checks an actual
upstream schema migration and the session's ID/title/project/location retention.
It does not run against the user's existing workspace database.

Historical September 15 browser receipts remain in the original `random` repo.
See the [toolkit setup guide](../../../README.md) for the exact-artifact prerequisite
and how to import a previously qualified payload without copying workspace state.
