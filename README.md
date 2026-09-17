# Browser Agent Toolkit

**Run agent harnesses in the browser.**

Experimental workspace and OpenCode integration built on
[Vivari](https://github.com/kkrausse/vivari/tree/integration/upstream-runtime). A browser-hosted
workspace supplies files, execution, service endpoints, and a live preview.
OpenCode runs its server and agent loop inside that workspace; model inference
still happens at a configured provider.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `workspace-api/` | `@kev-browser-agent-kit/workspace`: filesystem/persistence, execution, endpoints, previews, optional React lifecycle helpers |
| `opencode-chat/` | `@kev-browser-agent-kit/opencode-chat`: server preparation/launch, headless client, optional chat/editor UI |
| `examples/todo-app/` | Local React Router + Bun/tRPC TODO application with an optional browser editor |
| `vivari/` | Runtime source pins, build/packaging tools, and runtime qualification support |

Development package names are retained. Source lives at
[`kkrausse/browser-agent-toolkit`](https://github.com/kkrausse/browser-agent-toolkit).
GitHub Packages release tooling is being added for versioned external consumers;
local builds remain supported.

## Local setup

Use Bun 1.4.0 (the extraction's package workflow was developed against this
version). Runtime builds additionally require the toolchain documented in
[`vivari/DEVELOPMENT.md`](vivari/DEVELOPMENT.md).

```text
kkrausse/
  browser-agent-toolkit/
    vendor/vivari/         # gitignored checkout of the pinned runtime fork
  irs-tools/               # future consumer; integration not implemented here
```

### Prepared OpenCode prerequisite

The chat build verifies an exact OpenCode 2.0.3 artifact and receipt before copying
them into the package. This artifact is generated, ignored, and not included in a
source checkout. Fetch the previously qualified artifact from its checksummed
GitHub Release asset:

```sh
bun scripts/setup-opencode.ts
```

To seed another checkout from an existing qualified integration directory:

```sh
bun scripts/import-opencode.ts /path/to/integration/vivari
```

This copies only the verified receipt and declared application outputs, not
credentials, caches, or workspace state. Alternatively set `OPENCODE_PACKAGE_DIR`
to the directory containing the qualified `build-receipt.json` and
`.runtime/opencode-bun-server/` payload.

The rebuild recipe is in `vivari/experiments/opencode-release-server/`. Rebuilding
on another host may change artifact identities; a new build is not automatically
qualified and must not silently replace the pinned contract. The download command
checks both the archive hash and the existing application receipt/output contract.

### Build and run

First create and build the pinned runtime (requires the native toolchain below):

```sh
bun vivari/scripts/setup-runtime.ts
bun vivari/scripts/build-runtime.ts --release
bun workspace-api/scripts/distribution.ts
```

Once the runtime and prepared OpenCode prerequisite are available, from this repository root:

```sh
bun run setup           # install, build both packages, install/build the example
bun run dev             # rebuild/refresh local packages, then start the example
bun run build:example   # rebuild/refresh and produce the example production build
bun run test
bun run typecheck
```

Open `http://localhost:5173` for development. The ordinary TODO application does
not require a model key. See [`examples/todo-app/README.md`](examples/todo-app/README.md)
for browser-editor preparation and local model configuration.

`bun run build` builds the library packages in dependency order. Root commands
refresh Bun's installed local package copies, so changes are included on the next
build without version bumps or a manual dependency update. Local consumers use
`workspace-api/dist/lib` and `opencode-chat/dist`.

**Live cross-package watching is not wired yet.** During a running example dev
session, toolkit source changes need a restart via `bun run dev` to rebuild and
refresh dependencies. Ordinary example source edits use the app's existing HMR.
The automatic toolkit watcher and `irs-tools` build/deploy integration are later
work, not guarantees of this extraction.

## Runtime and application delivery

The JS library packages, Vivari workers/WASM distribution, and prepared application
dependencies are separate build inputs. Build the runtime fork, package its
distribution, and prepare the example as described in the linked setup guides.
Runtime changes generally require restarting the browser workspace.

This is a compatibility POC, not arbitrary native Linux or stock Node/Bun execution.
OpenCode and tool delivery retain explicit compatibility packaging. The TODO
example uses a host Bun API and model proxy; it is not a static-only website.
There is no hosted demo or BYOK/login implementation in this extraction.

## History and licensing

This repository starts with a clean source snapshot from
`kkrausse/random` commit `0bcad3e36753b51bdcad3234d75ac9fc30907966`, under
`browser-container-poc/`. Original history and chronological status/acceptance
documents remain there. They describe the original environment, not fresh
qualification of this checkout.

Package licenses, upstream notices, and provenance are retained in their source
directories. See `opencode-chat/PROVENANCE.md`, its `LICENSE*` files, and
`vivari/LICENSE*`. No new umbrella licensing decision is made by this extraction.
