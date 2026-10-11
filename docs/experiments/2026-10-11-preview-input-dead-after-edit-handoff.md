# The preview's input stops taking typing after an agent edit: handoff (2026-10-11)

Branch `fix/input-dead-after-root-edit`, cut from `main` at `0c7f843`. Worktree:
`/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit-public-demo`. Nothing is fixed
here; this is what was seen, what was ruled out and how to reproduce it without a model.

## What happened

One run of `examples/terminal-app/demo/run.ts` against the live public demo
(`https://kkrausse.github.io/browser-agent-toolkit/`, build of `0c7f843`, Chrome 154 on
diesel2, model "Ling 3.1 Flash Free" through the Deno relay):

- Steps 1 to 4 passed: fresh workspace, two todos added in the app, the prompt ("Give this app
  a dark theme with a violet accent, and show how many todos are left under the list."), the
  agent's edits, the app dark with "1 todo left", **same document** (the frame was not reloaded).
- Step 5 failed: the script typed "Ship it" into the "New todo" input, and the Add button stayed
  disabled. The run reported `pass: false`.

Afterwards, in the same tab, by `browser-control execute`:

| Probe | Result |
| --- | --- |
| Add button | `disabled: true`, before and after typing again with Playwright (`fill('')`, `type('Ship it')`), and Enter adds nothing |
| The input | DOM `value` is `"Ship it"`; its React props (`__reactProps…`) have `value: ""` and an `onChange` function |
| `src/home.tsx` as served (`?raw`) | `const [title, setTitle] = useState('')`, `<input … value={title} onChange={e => setTitle(e.target.value)} disabled={busy} />`, `<button disabled={busy \|\| !title.trim()}>Add</button>`: the app's logic is intact |
| The app's API | `getTodos`, `addTodo`, `setTodoCompleted` earlier in the run: 2–4 ms, 200. A fetch from the frame afterwards answered in 3 ms. No `addTodo` request after the edit |

So React owns the input and has a handler, the DOM receives the text, and React's state does
not change: input events are not reaching React's handlers after the hot update. The runtime,
the service worker and the app's API are not the problem.

## What differed from the runs that passed

The four real-model runs and the scripted runs made on 2026-10-10/11 (staging and local) all
passed step 5. In those the agent changed `src/style.css` and `src/home.tsx` only. In this run
the model's own summary lists two more files:

- `src/root.tsx`: it added `<meta name="theme-color" …>`. `root.tsx` is the React Router root
  route, the module that renders `<html>`.
- `src/editor-panel.css`.

The runner's `changed` list only names `style.css` and `home.tsx` because that is all it
watches for (`demo/run.ts`), not because the others were untouched.

**Hypothesis, not confirmed:** hot-updating the root route module re-renders or replaces what
React's event delegation hangs on (React listens at its root container; `root.tsx` renders the
document), leaving a tree whose DOM is live and whose events go nowhere. A `<meta>` added in
`<head>` by a hot update is also a candidate for a hydration-style mismatch.

Not checked:

- whether reloading the preview frame brings the input back (expected, untested);
- whether the same edit to `root.tsx` breaks inputs under a native `vite dev` of
  `examples/todo-app` (if it does, it is React Router / Vite behaviour and not the toolkit's);
- whether checkboxes and Delete (click handlers) are dead too, or only `onChange`;
- whether the order of the edits matters (`root.tsx` before or after `home.tsx`);
- the browser console of the preview frame at the time of the update.

## Reproducing it without a model

The development build's mock (`examples/terminal-app/mock-model.ts`) scripts turns by prompt
text; its "dark theme" script does two reads and three edits through the real tools. Add a
script (or a variant of that one) whose edits include the `root.tsx` change above, then run the
recorder's scenario against a development build:

```sh
R=/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit-public-demo
cd $R && bun install && bun scripts/setup.ts          # this worktree already has build outputs; rerun after source changes
cd $R/examples/terminal-app
PORT=4621 DIAG_FILE=/tmp/input-dead-diag.jsonl bun mock-model.ts      # own port; 4311 and 4411 are taken
MODEL_URL=http://127.0.0.1:4621/v1 OUT_DIR=dist-dev bun run build
PORT=4620 bun server.ts dist-dev                                       # a plain file server for that directory
browser-control session new input-dead
bun demo/run.ts --base http://127.0.0.1:4620/ --session input-dead
```

`ports/opencode/vendor` holds links to the client's source checkouts; the client itself does
not need rebuilding for this. `examples/terminal-app/README.md` ("The demo video", "The public
build") has the rest. To see the app's own behaviour outside the toolkit: `examples/todo-app`
under a plain `vite dev` (its README), make the same edit to `src/root.tsx` by hand and type
into the input.

## What a fix might be, by where the cause turns out to be

- **React Router / Vite behaviour on a root-route hot update, same natively:** nothing to fix
  in the runtime. Options are in the example: have the preview frame reload when `root.tsx`
  (or any file the framework cannot hot-update cleanly) changes, or accept it and say so. The
  demo's check would then need to allow a reloaded frame after such an edit.
- **Only in the tab:** then it is the toolkit's Vite/HMR path (the preview's service worker,
  the HMR WebSocket through the kernel, module URLs or timestamps), and the comparison with a
  native run is the way in. `runtime/harness/` has guest scripts for the runtime side.

## Related, seen the same day and not explained

Three reports of input lost in the first moment after something appears, which may or may not
be the same family:

- the OpenCode client dropped an early Enter (found: its own readiness gap; fixed with a
  bundle-time edit, `ports/opencode/build/opencode-edits-plugin.ts`);
- a prompt typed with no delay the instant the previous reply finished did not appear (seen
  once during the restructure, not investigated);
- in the todo example's React chat, a message sent the instant the text box appeared vanished
  (seen once during the React split, not compared with the build before it).

## Rules that apply

`AGENTS.md`. Do not stop or restart the tmux sessions `bat-pty`, `bat-pty-mock`,
`bat-terminal`, `bat-terminal-mock`, `tcp-relay`, `todo-editor`, `irs-dev`. Do not publish to
`gh-pages` or change the Deno relay without the user's word. The free model is rate-limited
(13 HTTP 429s and 3 min 14 s for this run): reproduce with the mock, and use the real model
only for a final check.
