# Four startup fixes for the editor, not yet run in a browser (2026-10-03)

Follows `2026-10-03-startup-breakdown-diesel2.md` (cold open 17.2 s fresh, 14.5 s
reopen on diesel2). Code and offline checks only: the browser was in use for live
measurement, so **nothing here has been opened in Chrome**. Every saving below is
the measurement's estimate, not a result. Module resolution in the runtime is another
agent's work and is not touched.

Worktree `/home/kkrausse/devfs/repos/kkrausse/bat-startup-fixes`, branch
`perf/startup-fixes` (from `perf/startup-breakdown` at `8057968`), not pushed.
Runtime fork branch `perf/startup-fixes` on `kkrausse/vivari`, pushed, pinned in
`vivari/runtime-source.json` at `484b770` (from `main` at `f9893bd`; `main` not moved).

| # | fix | toolkit commit | fork commit | default | switch back |
|---|---|---|---|---|---|
| 1 | no per-file hashing after the image digest passed | `a06d39b` | `ed609fb` | on | `?deliveryVerify=files` |
| 2 | OpenCode starts when the preview listens | `e15545a` | — | on | `?startup=serial` |
| 3 | delivered trees leave the OPFS mirror | `bda0898` | `484b770` | on | `?managedPersist=1` |
| 4 | guest optimizer includes the client's dependencies | `d0d4c91` | — | on (new workspaces) | source change only |

The flags are read from the page URL by `examples/todo-app/src/start-editor.ts` and
combine freely with `?opencodeTrace=1&viteTrace=1`.

## 1. Delivery no longer hashes 10,534 files after hashing the image

**Found.** The open question was whether the image digest is checked at acquire. It
is, in `workspace-api/src/delivery.ts`: the complete compressed image is hashed and
compared (length and SHA-256) with `delivery.image` from the manifest, both for a
Cache Storage hit (a mismatch deletes the entry and downloads) and for a download (a
mismatch throws). Nothing reaches decode otherwise. The per-file pass in the
runtime's `install-tree.js` then inflated and hashed each body again (1.6 s).

**Changed.** The image path sends `bodiesVerified: true`; the fork's
`installTreeImage` skips the per-body inflate + SHA-256 for that literal flag only.

**Why it is safe.**
- The manifest is the one source of the image digest and of the per-file digests, so
  the per-file pass never protected against a wrong manifest.
- The preparer builds the image from the same `assets` list it writes into the
  manifest and refuses a file that differs from its entry (`bundleVfsImage`).
- gunzip of checked bytes is deterministic; body boundaries come from the image's own
  header, inside the checked bytes.
- Still enforced: path, root, mode and symlink validation before any root is removed;
  the VFS's own zlib well-formedness and length check per compressed body
  (`write_file_body`).
- Unchanged paths: the bundle path (`installTree`, used when the runtime has no image
  support) has no flag and hashes every file; a runtime without the flag ignores it.

**What does change.** A body the VFS rejects is now found while writing, after the
managed roots were removed, not before. Delivery fails as before; the next open
installs again. Managed roots hold nothing else.

**Offline evidence.** The real prepared image (10,534 files) through the real delivery
code, the fork's installer and the Rust VFS under Bun: verify 26 ms with the skip,
488 ms without, and in both modes every installed file read back equal to its
manifest digest (0 mismatches). Chrome's 1.6 s was not re-measured.

**Live pass must check.** `delivery.install.ready` shows `perFileVerify: false` and
`verifyMs` near zero (was about 1600); `installMs` is not worse; with
`?deliveryVerify=files` both return to the old values; a fresh and a reopen both
start the preview and OpenCode normally.

## 2. OpenCode starts when the preview's server is listening

**Found.** The order was not serial by original design. Until `98c91a6` (2026-09-30)
both were started together. A workspace switch then twice left cold Vite silent for
its whole 30 s listen budget while chat finished starting
(`2026-09-30-interactive-workspace-preview-startup.md`). The cause was never
established; serial was "a bounded ordering repair". What that repair protects:
nothing competes with cold Vite before it listens.

**Changed.** Default order `overlap`: OpenCode is started from the preview launch's
connect callback, which the controller calls once the guest's listener exists (about
3.5 s in). The preview's remaining 5.3 s fresh / 3.0 s reopen (optimizer, first
render, frame load) then overlaps OpenCode's 4.5 / 3.1 s. That is about what a fully
parallel start could gain, without re-entering the order that failed.

This is deliberately not "parallel by default" as asked: the full-parallel order is
the one that failed on 2026-09-30 and cannot be requalified without a browser. It is
available as `?startup=parallel` for the A/B.

**Preserved.**
- Chat order: start, `beforeChatConnect` (session restore), `chatConnectReady`, chat
  client. These only need the chat service.
- Readiness budgets and deadlines: untouched, one set per launch (30 s listen, 60 s
  connect, 120 s overall, 45 s client wait).
- A preview that never listens does not start OpenCode.
- The step never ends with a start in flight: a preview failure after listening is
  thrown only when the overlapping chat start has settled, and wins if both fail.
- Each failed launch cleans up in the controller as before. A service that did come
  up stays published, as the preview already did when OpenCode failed; a retry
  reuses it, a switch's recovery stops the runtime.
- Ready only when both are ready. The retained switch (`resume`) is unchanged.

**Differences to expect.** The chat panel can attach before the preview frame shows
the application. After a preview failure that happened after listening, OpenCode may
be running (before: never started).

**Offline evidence.** `examples/todo-app/tests/start-editor.test.ts` runs the real
recipe with stubbed boundaries for the three orders and the failure joins. It could
not load on `perf/startup-breakdown` (its stub lacked the Vite tracing exports added
in `da9c2ab`); that is fixed here.

**Live pass must check.**
- `editor.startup-order` is `overlap`; `service.launch` for `chat` comes right after
  `service.listen.ready` for `vite`.
- **Vite's `GET /` and frame load do not get slower by more than OpenCode gets
  earlier** (shared kernel thread for filesystem and SQLite). Compare whole-operation
  time against `?startup=serial`, fresh and reopen.
- OpenCode's spawn → attached under overlap against its serial 3.1 / 4.5 s.
- A workspace switch on the full path (`?workspaceSwitch=full`), which is where the
  2026-09-30 failure appeared: several in a row, Vite must listen every time.
- `?startup=parallel` only as a data point; if Vite fails to listen there, that
  confirms the old finding and is not a regression of the default.

## 3. Delivered trees are no longer mirrored to OPFS

**Found.** The mirror set is decided in the runtime
(`packages/core/src/workers/kernel-filesystem.ts`, `shouldPersist`): a fixed list, with
no way for a host to say that it reinstalls a tree. `/app` (31.0 MB) and
`/workspace/.browser-editor-backends` (6.7 MB) were therefore written to OPFS after
each delivery, restored at the next boot, then removed and rewritten by delivery.

**Changed.** The fork adds `persist: false` to both install-tree messages. The
installer calls `persistence.exclude(root)` per root before removing it: the root's
subtree delete is queued first (so existing OPFS copies and manifest entries go),
then nothing under the root is mirrored for that kernel's lifetime. Managed delivery
sends it for its roots (`/workspace/node_modules`, never mirrored anyway;
`.browser-editor-backends`; `/opencode-v2`; `/app`).

**Why nothing is lost.** The installer removes each managed root completely before
writing it, and delivery runs on every new kernel before the services start (a new
kernel has no `node_modules`; the step is skipped only while the same kernel's runtime
is up). So nothing restored under a managed root has ever survived an open. The
exclusion matches only `root` and `root/...`; everything that lives only in OPFS is
outside: workspace source, `/workspace/.server`, `/workspace/.browser-editor-cache`
(Vite's optimizer cache), `/var/lib/vivari/module-plans`, `/runtime-probe`.

**Existing origins.** The first open after the change still restores the old 38 MB
(1.56 s as before). That open's delivery deletes it from OPFS and from the manifest.
From the second reopen the restore is about 12 MB. No migration; switching back with
`?managedPersist=1` mirrors again.

**Known, not changed.** `restore()` fails the boot if the manifest lists a file whose
bytes are gone. A tab killed between a root's delete and the manifest rewrite leaves
that state. The window existed on every delivery of a mirrored root (delete, then
38 MB of rewrites); now it exists once, for the delete alone.

**Offline evidence.** Fork `scripts/test-opfs-exclude.mjs`: three boots over an
in-memory OPFS twin with the real VFS, installer and mirror. Legacy mirrored roots are
dropped; source, server state, the plan cache and Vite's cache survive and are
restored; later writes under a root are not mirrored; `persist: true` mirrors again.
Real OPFS was not exercised.

**Live pass must check.**
- On an origin with existing state: first reopen unchanged; **second** reopen's
  restore is smaller (count and time in the open diagnostics; about 12 MB instead of
  50) and the editor comes up with its source, chat sessions and Vite cache
  (`Hash is consistent. Skipping.`), and OpenCode's plan `hit`.
- OPFS census (`40-opfs.js` of the measurement): no `/vv-vfs/files/app`, no
  `.browser-editor-backends`; `manifest.json` lists neither.
- Exit and reopen, and a full workspace switch, still work; `workspace.flush` does
  not report an error.
- The saving (about 1 s) assumed restore time follows bytes. Measure it.

## 4. The guest's first optimizer run includes the client's dependencies

**Found.** React Router's Vite plugin gives the dependency scanner entries only with
`future.unstable_optimizeDeps`. Without it `optimizeDeps.entries` is empty, there is
no `index.html`, and the first run bundles only the plugin's own include list. The
application's client dependencies turn up at the first page load: second run, frame
reload. Reproduced outside the browser with the guest configuration:
`BROWSER_AGENT_GUEST=1 bun --bun node_modules/vite/bin/vite.js optimize --force` in
`examples/todo-app` gives 7 optimized entries before, the same 7 plus
`@tanstack/react-query`, `@trpc/react-query`, `@trpc/tanstack-react-query`,
`@trpc/client` after.

**Changed.** `examples/todo-app/vite.config.ts` sets `optimizeDeps.include` to those
four when `BROWSER_AGENT_GUEST === '1'`. The guest's configuration is that file as it
is: the preparer copies it verbatim into the manifest's project source, and the
preview launch sets the variable. On the host the option is undefined, so
`react-router dev` and `build` are unchanged.

**Reach.** Workspaces created from prepared source after the change (a fresh origin,
"New workspace"). A workspace already stored in the browser keeps its own
`vite.config.ts` (browser edits win); it also already has its optimizer cache.

**Live pass must check.** On a fresh origin with `?viteTrace=1`: one "Dependencies
bundled" line, no "new dependencies found", no frame reload; the first run will be
longer than 0.9 s (it now bundles 11 entries), so compare listening → application
ready as a whole (was 3.0 + 2.2 s). A reopen still logs `Hash is consistent`.

## Offline results

| | before (this worktree, `8057968`) | after |
|---|---|---|
| workspace-api | 101 pass | 102 pass |
| opencode-chat | 154 pass, 2 skip, 3 fail, 1 error | the same, identical failures |
| examples/todo-app | 182 pass, 17 skip, 2 fail, 1 error | 191 pass, 17 skip, 1 fail |
| vivari (toolkit) | 4 pass | 4 pass |
| typecheck | 23 errors | the same 23 |
| `bun run build:example`, `prepare:editor` | pass | pass |

- opencode-chat's failures are the two in the migration handoff
  (`readiness-lab-bundle`, `opencode-launch`'s unresolved `@opencode/schema`) plus
  `test/javascript.test.ts` "fresh modules support relative imports…", which fails the
  same way before and after and is not in the handoff's list. Not investigated.
- todo-app: the remaining failure is the XFS `readdirSync` order one from the handoff;
  the one that went away is `start-editor.test.ts` failing to load.
- Fork: `node --test scripts/install-tree.test.mjs` (3 pass),
  `test-opfs-exclude.mjs`, `test-sqlite-persist.mjs`, `test-single-kernel.mjs`,
  `test-single-kernel-lifecycle.mjs` pass. `bun run verify` and the full runtime
  contracts were not run.

## Not done

- No browser run, no timing. No measurement of contention on the kernel thread.
- The model list in OpenCode's database (out of scope).
- A prepared optimizer cache (would remove the remaining first run).
