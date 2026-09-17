# Releasing to GitHub Packages

The public source is `kkrausse/browser-agent-toolkit`. Releases are manually
dispatched from a selected committed Git ref using **Publish packages**. Supply
an explicit, unused version. Pushes do not publish. Nothing publishes to npmjs.
GitHub Packages may require authentication even when downloading public packages.

## Packages and development names

| Published package | Contents |
| --- | --- |
| `@kkrausse/browser-agent-runtime` | Validated runtime distribution, workers, WASM, backend policy and build receipt |
| `@kkrausse/browser-agent-workspace` | Bundled workspace API, declarations and asset/server helpers |
| `@kkrausse/browser-agent-opencode-chat` | Optional UI/tooling plus independently qualified prepared OpenCode application |

All packages in a run receive the supplied version. Development package names and
imports stay intact. The staged chat package declares
`@kev-browser-agent-kit/workspace: npm:@kkrausse/browser-agent-workspace@<version>`
as an exact dependency, replacing its development peer. No local `@vivari/core`
dependency is allowed in published manifests or emitted imports: the workspace
build must bundle it. Release staging never edits source manifests.

## Prerequisites and build

Use Node **24.18.0**, Bun **1.4.0**, Rust **1.93.0** (targets
`wasm32-unknown-unknown`, `wasm32-wasip1`) and wasm-pack **0.13.1**.
The workflow obtains runtime source using `vivari/runtime-source.json`; update
and commit that configuration after qualifying a new source revision. Its default
checkout should be `vendor/vivari` inside the toolkit. Do not pin a second revision
in this workflow. Local `VIVARI_SOURCE` overrides still require the exact configured
clean runtime commit for a release.

The toolkit must have a committed root `LICENSE`, and workspace's frozen
dependency/lockfile must resolve `@vivari/core` from the default runtime checkout.
From clean committed toolkit source:

```sh
bun vivari/scripts/setup-runtime.ts  # only if the configured checkout is absent
bun scripts/release.ts 0.1.0
```

Output is `.release/0.1.0/`: staging directories, tested `.tgz` files, unpacked
smoke inputs and `release.json` with hashes, npm integrity, source pins and sizes.
The script builds the pinned runtime in `--release` mode, validates the
distribution, checks licenses, rejects local runtime dependencies, verifies the
actual packed files/exports, imports packed asset helpers, browser-bundles the
packed workspace and enforces **both packed and unpacked sizes below 256 MiB**.
These are packaging checks, not a replacement for runtime/browser qualification.
Keep `.release/`, `.prepared-opencode/`, build output and `vendor/` ignored.

### Prepared OpenCode delivery

The current chat build verifies a fixed independent application contract in
`opencode-chat/src/opencode-application.ts`. A normal Linux runtime build does
not produce that prepared payload. The default workflow therefore publishes
runtime and workspace only. To include chat, provide a same-repository Actions
run ID containing an artifact named **prepared-opencode**, whose root contains:

```text
build-receipt.json
.runtime/opencode-bun-server/<all contract output files>
```

The delivering job must upload hidden files (`include-hidden-files: true`) and
only the receipt and approved output files. The chat build authenticates every
byte against its committed qualification contract. Merely uploading a newer
OpenCode build does not qualify it. Application preparation/delivery is a separate
pipeline; this release workflow does not overhaul it. Locally:

```sh
OPENCODE_PACKAGE_DIR=/absolute/path/to/qualified-delivery bun scripts/release.ts 0.1.0 --chat
```

## Publishing and consuming

Dispatch the workflow only after committing and pushing all source pins and
licenses. It publishes the tested archives using `GITHUB_TOKEN` with
`packages: write`, sets `publishConfig.registry` to GitHub Packages and associates
packages with this repository. Verify/set each package's **public visibility**
in GitHub package settings after first creation; `--access=public` does not replace
GitHub's package visibility controls. npm provenance attestations are not requested
(GitHub Packages does not support npmjs's provenance flow); embedded provenance,
receipts, hashes and retained Actions artifacts provide build traceability.

Publishing several packages is not atomic. A failed run may have published an
earlier package. Inspect the registry before retrying; versions are immutable.

Private consumers such as irs-tools configure a scoped registry using an
environment-provided token, never a committed credential:

```ini
@kkrausse:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Pin exact versions in the consumer and commit its lockfile. Existing imports can
use aliases:

```json
{
  "dependencies": {
    "@kev-browser-agent-kit/workspace": "npm:@kkrausse/browser-agent-workspace@0.1.0",
    "@kev-browser-agent-kit/opencode-chat": "npm:@kkrausse/browser-agent-opencode-chat@0.1.0",
    "@kkrausse/browser-agent-runtime": "0.1.0"
  }
}
```

Resolve the runtime directory on the build/server side, then use the workspace
asset helpers to validate and copy it into the consumer's served assets:

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRuntimeAssets } from '@kev-browser-agent-kit/workspace/assets';

const source = dirname(fileURLToPath(import.meta.resolve('@kkrausse/browser-agent-runtime/distribution.json')));
await copyRuntimeAssets({ source, destination: '/absolute/path/to/new/public/runtime' });
```

The runtime's content-derived distribution version is distinct from the package
semver. Browser workers must be served from this directory with the application's
existing isolation/service-worker configuration. For later local overrides,
replace aliases with paths to locally built package directories and select an
explicit locally validated runtime directory; do not publish development paths.
