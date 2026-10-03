# TODO example

A local proof of concept for Browser Agent Toolkit: an ordinary React Router 7
TODO app served by Bun/tRPC, with optional browser-hosted OpenCode editing.
This example is not a static hosted demo. TODO data is held in server memory.

## Ordinary application

From the repository root, with the prerequisites in the
[root setup guide](../../README.md):

```sh
bun run setup
bun run dev
```

Development serves the frontend at `http://localhost:5173`, proxying `/api` to
Bun on port 3001. App source changes use Vite HMR. To pick up toolkit source
changes, stop and rerun the root dev command, which rebuilds and refreshes packages.

For a production build, run `bun run build:example` at the root, then:

```sh
cd examples/todo-app
bun start
```

Production serves on port 3000 by default (`PORT` overrides it).

## Browser editor

After `bun run setup` at the repository root, from this directory:

```sh
bun run editor
```

This prepares the editor (`.editor/`), builds the app and serves it on loopback
port 3000 (`PORT` overrides it). Open `http://127.0.0.1:3000` and choose
**Open editor**. The separate steps are `bun run prepare:editor`, `bun run build`
and `bun start`. To reach it from another device, put it behind an HTTPS proxy
such as `tailscale serve --bg --https=10000 http://127.0.0.1:3000`.

Editing is always on in this demo; `src/server/editing.ts` only refuses
cross-site requests. A real app (IRS tools) decides who may edit there, from its
own sign-in. Model forwarding is wired through `server.ts` and the toolkit server
adapter.

### Model key and catalog

Chat needs a provider key. Put it in a gitignored `.env.local` in this directory,
which Bun loads on start:

```sh
VIVARI_MODEL_API_KEY=<key>
```

Without a key the editor, files and preview still work. The server says so at
start and answers inference requests with a 401 that names the variable instead
of forwarding them.

With a key, the Model picker offers the enabled models of the checked-in public
catalog [`model-catalog.json`](model-catalog.json). `MODEL_CATALOG=/absolute/path.json`
selects another catalog, with or without a key. The key is never put in a
catalog, which is delivered to the browser. Listing a model does not prove the
key has access to it.

The file is `{"defaultModel": "<id>", "models": {"<id>": {...}}}`. Each model has
`name`, `package` (`@opencode/ai/providers/openai`, `.../anthropic` or
`.../openai-compatible`), `capabilities: {tools, input, output}`,
`limit: {context, input?, output}`, `websocket: false` and optionally
`disabled`. Other fields are rejected. The default must be an enabled,
tool-capable model in the catalog.

The server validates the catalog at startup and refuses to start if it is
invalid. It adds the catalog to the manifest it serves, so `.editor/` output is
not modified and changing the catalog needs a server restart, not a new
`prepare:editor`. Models the catalog does not name are removed, including the
provider's own free-tier list, which is rejected (HTTP 403) through this proxy.
Reopen the editor to apply a changed catalog; saved chats keep the model they
already selected.

### Preparation

`prepare:editor` installs the guest's dependencies and writes ignored `.editor/`
output. It regenerates that (about 15 s) when `package.json`, `bun.lock`, the
runtime distribution, the OpenCode application, the Tailwind backend or the
installed toolkit packages changed, and otherwise only refreshes the application
source (under a second). The served manifest is rebuilt from the generated one
on every run, so edits made to it do not survive. Delete `.editor/` to force a
full regeneration.

`RUNTIME_DIR` overrides the default `../../workspace-api/dist/runtime`, and
`OPENCODE_PACKAGE_DIR` selects an equivalent qualified OpenCode artifact root.
The browser Tailwind backend is the source-pinned repair built by the root setup
(`vivari/.runtime/tailwind-wasm-candidate/current.json`; pin in
`../../opencode-chat/src/tailwind-wasm-candidate.json`). To use another receipt,
set both `TAILWIND_CANDIDATE_RECEIPT` and `TAILWIND_CANDIDATE_SHA256`.

The guest uses the same application source as the host, and guest API requests
are bridged back to this Bun server. The browser workspace retains source/chat
state independently of the server's in-memory TODO list. A local workspace flush
is not a server save or Git commit.

### Switching workspaces

A switch between saved workspaces keeps the runtime, the installed dependencies
and the OpenCode server running when it can: only the preview is restarted and
only source files are replaced, then sessions are re-imported and chat reconnects.
It does so when both workspaces have the same `package.json` dependency sections
and lockfiles, OpenCode is healthy and no session is running. Otherwise, and
whenever that path fails part way, it stops everything, clears the workspace and
starts again as before. `?workspaceSwitch=full` on the page URL always takes the
full path, for comparing the two; the `switch.path` diagnostic event records which
one ran and why.

### Stage timings

The editor records where each open, reopen, switch, save and exit spends its
time. Expand **Debug · Timings** under the workspace panel for the recent
operations and their stages; **Copy JSON** and **Download JSON** export the lot.
Automation reads the same records from `window.__editorTimings` (`operations`,
`unattached`, `summary()`, `json()`, `clear()`), available once the editor has
been opened and kept across Exit and reopen until the page reloads.
`summary().variance` compares the fastest and slowest run of each kind by stage
and by context (service-worker control, kernel cold or warm, chat sessions, guest
process and VFS counts, tab visibility). Records hold durations, counts and sizes
only, in memory, and are never sent anywhere.

## Checks

```sh
bun test
bun run typecheck
bun run build
```

Browser acceptance scripts are in `experiments/`; consult their
[instructions](experiments/editor-performance-and-acceptance.md). Historical receipts remain in `random` and do not
claim that this relocated example has received a fresh browser acceptance run.
