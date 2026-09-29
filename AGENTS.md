# Browser Agent Toolkit

- Commit only your own changes. Do not push unless explicitly requested.
- Use Bun and TypeScript. Keep library builds and example consumers separate.
- The editable Vivari runtime is the pinned `vendor/vivari` checkout (or `VIVARI_SOURCE`), not generated
  `.runtime` output. Read `vivari/DEVELOPMENT.md` before runtime work.
- Preserve upstream licenses, provenance, source pins, and artifact verification.
- Browser automation uses the Bun-backed `browser-control` CLI.
- Keep toolkit experiment results and chronological status reports in `docs/experiments/`
  in this repository. Keep setup and architecture documentation concise.
- The original `random` repository is historical reference only; do not write or commit
  new toolkit reports there.
