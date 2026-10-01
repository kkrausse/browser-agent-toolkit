# Historical experiment drivers

These files are one-shot experiment drivers (prepare / serve / client / runner /
fixture scripts and Browser Control execute bodies). They were moved here from
`examples/todo-app/tests/` on 2026-09-30 so that `tests/` holds only the
`*.test.ts` files `bun test` runs and the modules those tests import or read.

- They are **not** part of `bun test` (no file here matches a test pattern) and
  **not** run by CI. Nothing in `package.json` invokes them.
- Documents written before the move — notably everything under
  `docs/experiments/` — cite these files by their old
  `examples/todo-app/tests/<name>` paths. Read such a path as
  `examples/todo-app/experiments/<name>` unless the file still exists in `tests/`.
- Relative `import`s of modules that stayed in `tests/` were rewritten to
  `../tests/<name>`. String paths were deliberately left as written: several
  scripts build or hash `examples/todo-app/tests/<name>` (some against a
  `git archive` of a pinned historical revision, where that path is correct, and
  some as evidence-receipt keys). A script that resolves a moved sibling through
  such a string needs its path adjusted before it can be rerun from this tree.
- Many scripts hard-code machine-local temp directories or sibling checkouts from
  the session that produced them. They record how evidence was produced; they are
  not expected to run on another machine unchanged.

`editor-performance-and-acceptance.md` (formerly `tests/README.md`) documents the
isolated performance harness and the Browser Control editor acceptance phases.

## Near-duplicates that are deliberately kept

A hygiene review on 2026-09-30 proposed deleting three files as copies of a
sibling. Each was checked and none is a strict duplicate, so all remain:

- `effect-process-fixture.ts` — differs from `effect-process-fixture-v2.ts` in the
  stale-loader-rejection scenario (v2's header says v1 is retained on purpose).
  `effect-process-runner.ts` launches it, and
  `effect-process-qualified-runner.ts` asserts its SHA-256.
- `effect-process-runner.ts` — the baseline-only admission against a different
  pinned runtime revision and receipts than `effect-process-qualified-runner.ts`,
  which also asserts this file's SHA-256 and would fail without it.
- `reset-evidence.js` — the phase-1 Browser Control body (fixed ports, no switch
  token). `../tests/reset-evidence-v2.js` is a rewrite with a different caller
  protocol, not a superset: 20 of its 35 lines have no counterpart there.
