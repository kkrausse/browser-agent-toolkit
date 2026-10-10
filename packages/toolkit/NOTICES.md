# Third-party notices

- `src/chat/vendor/reducer.ts`, `src/chat/vendor/types.ts`: from OpenCode
  (https://github.com/anomalyco/opencode, MIT, see `LICENSE.upstream`). The reducer derives
  from `packages/app/src/context/server-session-v2-reducer.ts`; the types are the generated
  client types of release 2.0.3 (`packages/client/src/promise/generated/types.ts`).
  `src/chat/api.ts` follows the request shapes of `@opencode/client@2.0.3`.
- `src/chat/ui/*`: adapted from shadcn/ui's Base UI registry (MIT, see `LICENSE.shadcn`).
- `src/chat/markdown.tsx` uses Marked (MIT, see `LICENSE.marked`).
- The built `browser.js` embeds the guest `runJavascript` plugin, which bundles Effect
  (https://github.com/Effect-TS/effect, MIT).
- Controller, chat view and model proxy are carried over from the previous toolkit in this
  repository (`opencode-chat`, MIT).
