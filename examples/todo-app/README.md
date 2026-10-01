# TODO example

A local proof of concept for Browser Agent Toolkit: an ordinary React Router 7
TODO app served by Bun/tRPC, with optional browser-hosted OpenCode editing.
This example is not a static hosted demo. TODO data is held in server memory.

## Ordinary application

From the repository root, after supplying the prepared OpenCode prerequisite in
the [root setup guide](../../README.md):

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

## Optional browser editor

1. Build and package the runtime following
   [`vivari/DEVELOPMENT.md`](../../vivari/DEVELOPMENT.md).
2. Prepare the editor from this directory:

   ```sh
   bun run prepare:editor
   bun run build
   LOCAL_EDITOR_ADMIN=1 PORT=4390 bun start
   ```

3. Open `http://127.0.0.1:4390` and choose **Open editor**.

`LOCAL_EDITOR_ADMIN=1` is a loopback-only local fixture, not production
authentication. The app owns editing authorization in `src/server/editing.ts`;
model forwarding is wired through `server.ts` and the toolkit server adapter.
Inspect that configuration before model use;
no credentials are included. The current example's readiness check selects Muse
Spark unless a model catalog is supplied; this is not a generic provider/key selector.

### Model catalog

By default the editor uses the built-in free default model and lists whatever
free models the provider publishes. To choose the models yourself, give the
server a public catalog file:

```sh
MODEL_CATALOG=/absolute/path/model-config.json \
LOCAL_EDITOR_ADMIN=1 PORT=4390 bun start
```

`bun run dev` and `bun run preview` read the same variable. The provider key is
separate and stays in the environment as `VIVARI_MODEL_API_KEY` (for example
`bun --env-file=/absolute/path/.env.local server.ts`); never put it in the
catalog, which is delivered to the browser.

The file is `{"defaultModel": "<id>", "models": {"<id>": {...}}}`. Each model has
`name`, `package` (`@opencode/ai/providers/openai`, `.../anthropic` or
`.../openai-compatible`), `capabilities: {tools, input, output}`,
`limit: {context, input?, output}`, `websocket: false` and optionally
`disabled`. Other fields are rejected. The default must be an enabled,
tool-capable model in the catalog.

```json
{
  "defaultModel": "muse-spark-1.3",
  "models": {
    "muse-spark-1.3": {
      "name": "Muse Spark 1.3",
      "package": "@opencode/ai/providers/openai",
      "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
      "limit": { "context": 1048576, "output": 131072 },
      "websocket": false
    }
  }
}
```

The server validates the file at startup and refuses to start if it is missing
or invalid. It adds the catalog to the manifest it serves, so `.editor/` output
is not modified and changing the catalog needs a server restart, not a new
`prepare:editor`. The Model picker then offers exactly the enabled catalog
models. Models the catalog does not name are removed, including the provider's
own free-tier list, which is rejected (HTTP 403) through this proxy. Reopen the editor to apply a
changed catalog; saved chats keep the model they already selected. Listing a
model does not prove the key has access to it.

`RUNTIME_DIR` overrides the default `../../workspace-api/dist/runtime`.
The toolkit package supplies the verified OpenCode application; optionally use
`OPENCODE_PACKAGE_DIR` to select an equivalent qualified artifact root.

The browser Tailwind backend has a source-pinned repair. Build it with:

```sh
bun ../../vivari/scripts/build-tailwind-wasm-candidate.ts --node /absolute/path/to/node
```

Use the resulting receipt path and SHA-256 as `TAILWIND_CANDIDATE_RECEIPT` and
`TAILWIND_CANDIDATE_SHA256` when running `prepare:editor`. Both must be supplied
together. This is needed for the previously qualified browser CSS/HMR path; see
the source pin in `../../opencode-chat/src/tailwind-wasm-candidate.json`.

Preparation writes ignored `.editor/` output. The guest uses the same application
source as the host, and guest API requests are bridged back to this Bun server.
The browser workspace retains source/chat state independently of the server's
in-memory TODO list. A local workspace flush is not a server save or Git commit.

## Checks

```sh
bun test
bun run typecheck
bun run build
```

Browser acceptance scripts are in `experiments/`; consult their
[instructions](experiments/editor-performance-and-acceptance.md). Historical receipts remain in `random` and do not
claim that this relocated example has received a fresh browser acceptance run.
