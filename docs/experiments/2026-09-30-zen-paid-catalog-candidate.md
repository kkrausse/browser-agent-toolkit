# Paid Console catalog candidate (not live qualification)

The live TODO host at `http://127.0.0.1:54770/` has **not** been restarted or activated.
The user chose a **separate** Console pay-as-you-go key through the existing
`VIVARI_MODEL_API_KEY` environment mechanism. No IRS secret, SOPS configuration,
or personal OpenCode authentication was read. No inference or browser interaction occurred.

## Public catalog and isolated build

The existing IRS Tools `src/server/editorModelCatalog.ts` loader was invoked against
`https://models.dev/api.json`, using its supported-endpoint/privacy snapshot at IRS
revision `dda2e4a8ee8f0280a7390f3d50ef27d426c545d6`. It produced 28 approved models:
26 paid and the eligible `space-bunny-free` and `longcat-2.5-preview-free` entries.
Default: `muse-spark-1.3` (paid Muse Spark 1.3). GPT, Claude, contributor Muse,
unsupported protocols, and other privacy-excluded trial models are not supplied.
This is catalog eligibility, not proof that an account has funds or access.

Public generated config (no credential):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/zen-paid-catalog-candidate/model-config.json`

Isolated library candidate (not qualified):
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/zen-paid-catalog-candidate/chat/browser.js`

The candidate adds `defaultModel` to the existing configuration installer and permits
the native Anthropic/openai-compatible adapter types already used by IRS. Explicit
defaults must exist in the supplied catalog; they omit the implicit contributor-free
fallback. Omitted defaults retain the original qualified configuration.

The live launcher accepts that public config through `VIVARI_MODEL_CATALOG`, adds
catalog metadata to the delivered manifest without changing receipted source/runtime
files, and builds a separate browser-library candidate in its new output directory.
`live-origin.json` records the consumed library path/hash and `qualified: false`.
All qualified input assets are still verified; runtime and OpenCode executable
artifacts are unchanged. No full library/runtime rebuild was performed.

Combined consumer staging, including the committed workspace-warning fix `9431953`
and these paid-catalog edits:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-zen-paid-combined-20260930-isolated`
Its `candidate-provenance.json` records source/library hashes. Do not use the earlier
warning-only isolated consumer: it excludes these startup edits. All 9,587 frozen
input hashes were reverified for the combined build. No server was started.

## Pending controlled same-port handoff

1. User provisioned the separate key in the repository-root ignored `.env.local`;
   Bun's environment-only presence check returned `true`, and Git confirms it is ignored.
   Load it with Bun's explicit `--env-file` argument; never print it or place it in
   public model config, guest files, UI, or ownership logs. Check only presence.
2. Orderly exit the browser editor, retaining browser source and native chat storage.
   Immediately before stopping the host, snapshot `/api/getTodos`'s
   `result.data` array to a local file. Preserve IDs, titles, and completed flags.
3. After explicit restart approval, stop only the recorded host process, then run
   the existing live launcher with `PORT=54770`,
   `VIVARI_MODEL_CATALOG=<public config above>`, and
   `VIVARI_TODO_SNAPSHOT=<saved array file>`. The snapshot is validated with the
   existing TODO schema before populating the same host map shape. Use the original
   input `/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/.diagnostics/single-kernel-e35eab4-full-attempt1`
   and a **new** exclusive output directory. Do not reuse the old output or receipts.
4. Verify exact host TODO contents before reopening the editor. Reopen on the same
   origin, confirm source/native chat preservation, check paid model list and
   initial Muse Spark 1.3 selection, and select another approved paid model without
   submitting inference. Existing chats may retain their previous model selection;
   do not rewrite saved conversations. Do not claim activation/qualification before
   these browser checks.

The existing handler captures provider headers when constructed; environment changes
alone cannot alter the current host. No hot-reload credential callback or replacement
auth framework was added.

After the parent confirms closure, writes the TODO array snapshot, and safely stops
**only current host PID 88406**, the exact replacement launch from repository root is:

```sh
PORT=54770 \
VIVARI_MODEL_CATALOG="$PWD/.diagnostics/zen-paid-catalog-candidate/model-config.json" \
VIVARI_TODO_SNAPSHOT="<absolute path to saved TODO array>" \
bun --env-file="$PWD/.env.local" examples/todo-app/tests/serve-single-kernel-live.ts \
  "$PWD/.diagnostics/single-kernel-e35eab4-full-attempt1" \
  "$PWD/.diagnostics/single-kernel-zen-paid-live-$(date +%s)"
```

This launch builds the current combined consumer into a new output directory and
reports only a credential-presence boolean. The staging folder itself must not be
reused as the launch output because exclusive output creation prevents overwrites.

## Validation

- Configuration/startup plus workspace-switch regression tests: 23 passed, 105 assertions.
- Isolated browser candidate build: succeeded, zero runtime builds.
- Package-wide `tsc --noEmit`: blocked by absent installed
  `@kev-browser-agent-kit/workspace` declarations and consequent existing implicit
  types. No generated installation or frozen qualification bytes were replaced to
  work around this.
