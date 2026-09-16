# Source provenance

Compatibility target: published OpenCode **2.0.3**, upstream tag revision
**d44b52ca66b6bf69626c0384626d1a9cd9555977**. This is an explicit release
protocol pin, not a claim of compatibility with arbitrary V2 releases.

Vendored from https://github.com/anomalyco/opencode:

| Local file | Upstream path | Modifications |
| --- | --- | --- |
| `src/vendor/reducer.ts` | [`packages/app/src/context/server-session-v2-reducer.ts`](https://github.com/anomalyco/opencode/blob/d7a7256bb6b0952f486c95718cfbf460b1570a56/packages/app/src/context/server-session-v2-reducer.ts) | Original derivation at d7a7256; local type imports. Adapted against candidate `packages/core/src/session/message-updater.ts`: inbox delivery triggers authoritative history recovery instead of inventing messages, streamed timestamps and terminal provider state are retained, failed-tool metadata is self-contained, compaction metadata is retained. |
| `src/vendor/types.ts` | [`packages/client/src/promise/generated/types.ts`](https://github.com/anomalyco/opencode/blob/d44b52ca66b6bf69626c0384626d1a9cd9555977/packages/client/src/promise/generated/types.ts) | Exact 2.0.3 generated source; imported only as types, with no runtime SDK dependency. Reproduce with `bun scripts/sync-vendor-types.ts`, which verifies its SHA-256. |
| `LICENSE.upstream` | [`LICENSE`](https://github.com/anomalyco/opencode/blob/d7a7256bb6b0952f486c95718cfbf460b1570a56/LICENSE) | Exact complete MIT notice, Copyright (c) 2025 opencode. Distributed in tarballs. |

`src/api.ts` now uses the published **`@opencode/client/effect@2.0.3`** and
**`effect@4.0.0-rc.112`**, pinned in `package.json` and `bun.lock`. The original
handwritten HTTP wrapper and SSE parser have been replaced by official resource
methods and the shared native event Stream. The local layer retains caller-owned
string/init fetch routing, session pagination and the model activation barrier.
`src/controller.ts` uses Effect programs, scopes, fibers and a ManagedRuntime.
Vendored wire types remain the public React snapshot/reducer representation;
official schemas perform HTTP decoding and schema-to-wire encoding.

These runtime dependencies are bundled, with their notices collected in
`THIRD-PARTY-LICENSES.txt`. Published 2.0.3 client/protocol/schema packages omit
their license file; the release tag's root LICENSE was checked against the
existing `LICENSE.upstream` and is used for those three packages.

No code from the Solid UI,
private packages, fonts or media is included. Markdown rendering is locally
authored with Marked 17.0.4 tokenization and React escaping; upstream Markdown
helpers were reviewed but not copied.

The React bundle includes the Marked tokenizer. Its complete Marked/Markdown
notices from `marked@17.0.4/LICENSE.md` are distributed as `LICENSE.marked`.

## 2.0.3 release audit (September 15)

Compared the complete generated contract against beta-19425. Changes add idle
history records, session permission rules/events, session diffs, file-not-found
errors and preferences APIs. Existing session, prompt, message, model, form,
permission-reply and event payloads used by this client remain compatible.
Authoritative history recovery retains the new idle records; the generic transcript
renderer displays them. New preferences/session-rule editing APIs are not exposed
as UI controls. The generated contract SHA-256 is
`9238842bf9d4dbef486f4c20fb4051a5ccb051a30a9d84a9d4267c089ef37fed`.

The server now builds from frozen published packages, with explicit archive
integrity instead of a claimed clean source checkout. The existing jsonc-parser
ESM selection remains; application/dependency source and emitted bytes are not
rewritten. See [the historical release acceptance](https://github.com/kkrausse/random/blob/0bcad3e36753b51bdcad3234d75ac9fc30907966/browser-container-poc/doc/opencode-2.0.3-upgrade.md) for real
model/tool/browser retention checks and the beta-to-release database migration.

## Historical beta-19425 protocol audit

The retained source is authoritative for wire shapes. Public V2 client and API
guides were consulted on 2026-09-11:
<https://opencode.ai/v2/docs/build/client> and <https://opencode.ai/v2/docs/api>.
The previous generated `src/vendor/types.ts` SHA-256 was
`c3542397d6c1e208e6decbc9105a63499bfa5969c02ce28d204308151c16c7c0`.

Verified candidate `packages/protocol/src/groups/{session,model,plugin,form,permission,event}.ts`,
generated client types, server model/plugin handlers, core catalog, and core
session message updater. Session list/create, message cursor pages, active-session
maps, `{model:{providerID,id}}`, text prompts, permission replies and SSE envelopes
retain the shapes used here. Prompt responses now describe inbox items and are
not interpreted as messages. Interrupt returns `{interrupted}`; execution state
still comes from events plus authoritative active-session hydration.

Catalog reads no longer await activation: the client now explicitly posts to
`plugin/await-activation?location[directory]=...` before listing models. This waits
for settlement, not a guarantee that every configured plugin succeeded.

Legacy question HTTP routes/events are removed. Hydration uses `session/{id}/form`;
events use nested `form.created.data.form` and `form.replied` / `form.cancelled`.
`src/forms.ts` explicitly adapts the question tool's `metadata.kind = "question"`
projection from candidate `packages/core/src/tool/plugin/question.ts`: sequential
`q0...` string/multiselect fields with label-valued options. The public
`questions`, `replyQuestion(id, string[][])`, and `rejectQuestion(id)` API is kept:
replies post `{answer:{q0:string|string[],...}}` to `/form/{id}/reply`, and rejection
posts without a body to `/form/{id}/cancel`. The old public `QuestionRequest` view
is now package-owned rather than misrepresented as a candidate native type.

Arbitrary forms (including numeric, boolean, external, conditional, constrained,
or differently keyed/value-mapped forms) are exposed in `unsupportedForms` and
visibly explain that another compatible client is needed. They are never silently
dropped or submitted through the question adapter. HTTP failures, including 404,
remain failures. No legacy endpoint probing/fallback is performed.

The generated contract changed beyond forms (inbox, streamed/provider metadata,
optional terminal tool metadata, compaction provider context). It was replaced
only after reviewing these differences. Durable `session.message.content.updated`
is not in the candidate live `V2Event` union, so no unsupported SSE handler is
invented. History hydration remains authoritative for persisted messages.

The source audit and acceptance rationale are in the owning repository's
`browser-container-poc/doc/opencode-chat-ui-audit/`. This package does not depend
on those files at runtime or during its build.
# Package-owned UI primitives

`src/components/ui` adapts shadcn/ui's MIT-licensed **Base UI** registry
(`base-nova/button`, `select`, `input`, and `textarea`) into compact local
components. Registry source: <https://ui.shadcn.com/r/styles/base-nova/button.json>
and its sibling component URLs. See `LICENSE.shadcn`.

Buttons, selects, text inputs, radio groups, and checkboxes use `@base-ui/react`;
the textarea follows shadcn's native-element implementation. Lucide supplies
select/checkbox indicators. CVA, clsx, and tailwind-merge compose variants.
These implementation dependencies are bundled into the UI subpaths, with
their dependency licenses shipped in `dist/THIRD-PARTY-LICENSES.txt`.
React and React DOM stay external optional peers. Tailwind 4 is build-time only;
the distributed stylesheets contain compiled, namespaced component utilities.
