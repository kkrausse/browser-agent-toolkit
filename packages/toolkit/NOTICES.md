# Third-party notices

- Parts of `src/chat/` are ported from OpenCode 2.0.26
  (https://github.com/anomalyco/opencode, MIT, see `LICENSE.upstream`):
  - `src/chat/connection.ts` from `packages/client/src/solid/connection.ts` (the event
    connection loop: connect timeout, back-off, idle watchdog, foreground and online
    resync, batched flush);
  - `src/chat/reduce.ts` from the event handler of `packages/client/src/solid/data.ts`
    (events folded into messages, parts, inbox, permissions and forms);
  - `createKeys` in `src/chat/sync.ts` from `createSync` in the same file (the
    invalidate-and-rerun rule for reads);
  - `pendingStatus` in `src/chat/selectors.ts` from `pending.status` in the same file;
  - `validateAnswer` and `isFieldActive` in `src/chat/forms.ts` from
    `packages/core/src/form.ts`;
  - `ascending` in `src/chat/id.ts` from `packages/schema/src/identifier.ts`.
- The built `browser.js` bundles `@opencode/client@2.0.26` (the promise entry; MIT, same
  upstream), which the chat makes every request through.
- The built `browser.js` embeds the guest `runJavascript` plugin, which bundles Effect
  (https://github.com/Effect-TS/effect, MIT).
- Controller and model proxy are carried over from the previous toolkit in this
  repository (`opencode-chat`, MIT).
- The chat view, its UI primitives and Markdown rendering are in
  `@kkrausse/browser-agent-toolkit-react` (`packages/react`), with their notices.
