# Third-party notices

- `src/chat/vendor/reducer.ts`, `src/chat/vendor/types.ts`: from OpenCode
  (https://github.com/anomalyco/opencode, MIT, see `LICENSE.upstream`). The reducer derives
  from `packages/app/src/context/server-session-v2-reducer.ts`; the types are the generated
  client types of release 2.0.3 (`packages/client/src/promise/generated/types.ts`).
  `src/chat/api.ts` follows the request shapes of `@opencode/client@2.0.3`.
- The built `browser.js` embeds the guest `runJavascript` plugin, which bundles Effect
  (https://github.com/Effect-TS/effect, MIT).
- Controller and model proxy are carried over from the previous toolkit in this
  repository (`opencode-chat`, MIT).
- The chat view, its UI primitives and Markdown rendering are in
  `@kkrausse/browser-agent-toolkit-react` (`packages/react`), with their notices.
