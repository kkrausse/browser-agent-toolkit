# @kkrausse/browser-agent-toolkit-react

The React side of [`@kkrausse/browser-agent-toolkit`](../toolkit/README.md): the preview
frame, the chat view and a hook that opens the editor, with their stylesheet. Everything
that needs React or a UI library is here, so the toolkit package itself has neither.

```tsx
import { ChatView, EditorPreview, useEditor } from '@kkrausse/browser-agent-toolkit-react'
import '@kkrausse/browser-agent-toolkit-react/styles.css'

function Editor() {
  const { editor, snapshot, retry } = useEditor()
  if (!editor) return <p>{snapshot.error ?? snapshot.message}</p>
  return <>
    <EditorPreview editor={editor} hostPaths={['/api']} isReady={frame => !!frame.contentDocument?.querySelector('main')} />
    <ChatView controller={editor.chat} />
  </>
}
```

Install it beside the toolkit; `react` and `react-dom` (18 or later) are peers. (From
the release tarballs the toolkit is a peer too, satisfied by the app's `file:` install of
it; see "Releasing" in the toolkit's README.)

| Export | What |
| --- | --- |
| `useEditor(options?)` | `openEditor` as a hook: `{ editor, snapshot, retry, reopen }`; closes on unmount |
| `useEditorSnapshot(editor)` | the editor's live snapshot |
| `EditorPreview` | the preview frame of an open editor (`hostPaths`, `isReady`) |
| `ChatView` | the whole chat: session and model settings, transcript, requests, composer |
| `Transcript`, `Composer`, `useChatSnapshot` | its parts, for a layout of your own |
| `./styles.css` | precompiled and namespaced (`.oc-ui`, `ocui:` utilities): no Tailwind setup in the app, no preflight, nothing global |

What is not here: the chat's logic. The controller, its reducer, the session state and the
OpenCode API types are the toolkit's (`./browser`: `createChatController`, `canSend`,
`isPreparing`, the chat types), because `openEditor` creates the controller with or without
a view. This package imports the toolkit and never the other way round; its build keeps the
toolkit an import, so a page holds one copy of the chat code.

Build with `bun run build` after the toolkit's (the declarations come from its `dist/`).
Third-party notices: [NOTICES.md](NOTICES.md).
