# Releasing to GitHub Packages

The public source is `kkrausse/browser-agent-toolkit`. Releases are manually
dispatched from a selected committed Git ref using **Publish packages**. Supply
an explicit, unused version. Pushes do not publish. Nothing publishes to npmjs.
GitHub's npm registry requires authentication even when downloading public packages.

The first release is **`0.1.0-alpha.1`**, an experimental prerelease. Packaging
checks do not establish full runtime qualification: the retained runtime contract
suite currently has a known `markAsUncloneable` failure. Keep browser acceptance
results and their exact runtime distribution identity separate from packaging
results. Prereleases publish under the `next` dist-tag, stable versions under
`latest`; consumers should still pin exact versions.

## Packages and development names

| Published package | Contents |
| --- | --- |
| `@kkrausse/browser-agent-runtime` | Validated runtime distribution, workers, WASM, backend policy and build receipt |
| `@kkrausse/browser-agent-workspace` | Bundled workspace API, declarations and asset/server helpers |
| `@kkrausse/browser-agent-opencode-chat` | UI/tooling plus the pinned, independently verified prepared OpenCode application |

All packages in a run receive the supplied version. Development package names and
imports stay intact. The staged chat package declares
`@kev-browser-agent-kit/workspace: npm:@kkrausse/browser-agent-workspace@<version>`
as an exact dependency, replacing its development peer. No local `@vivari/core`
dependency is allowed in published manifests or emitted imports: the workspace
build must bundle it. The staged workspace includes the runtime receipt's
`host-sdk` declarations under `vivari-host/`, rewrites its declaration re-exports
to local paths, and makes its React entry's workspace self-import relative.
This supports both public names and consumer aliases without a fourth package.
Release staging never edits source manifests or shared build output.

### Licensing

This extraction makes **no new umbrella licensing grant**. There is intentionally
no required root `LICENSE`. Workspace metadata is `UNLICENSED` when its built
metadata provides no license grant. Bundled Vivari code and vendored host
declarations retain `LICENSE.vivari`; SQLite-WASM retains
`LICENSE.sqlite-wasm`. Runtime metadata points to `LICENSES.md` explaining these
inherited terms, rather than labeling the combined distribution MIT. Chat keeps
its existing package license, upstream/UI notices and generated third-party
license inventory. Public source/package visibility does not create a license.

## Prerequisites and build

Use Node **24.18.0**, Bun **1.4.0**, Rust **1.93.0** (targets
`wasm32-unknown-unknown`, `wasm32-wasip1`) and wasm-pack **0.13.1**.
The workflow obtains runtime source using `vivari/runtime-source.json`; update
and commit that configuration with the qualification evidence for a new source
revision. Its default checkout is `vendor/vivari` inside the toolkit. Do not pin a second revision
in this workflow. Local `VIVARI_SOURCE` overrides still require the exact configured
clean runtime commit for a release.

Workspace's frozen dependency/lockfile must resolve `@vivari/core` from the
default runtime checkout.
From clean committed toolkit source:

```sh
bun vivari/scripts/setup-runtime.ts  # only if the configured checkout is absent
bun scripts/setup-opencode.ts
bun scripts/release.ts 0.1.0-alpha.1
```

Output is `.release/0.1.0-alpha.1/`: staging directories, tested `.tgz` files, unpacked
smoke inputs and `release.json` with hashes, npm integrity, source pins and sizes.
The script builds the pinned runtime in `--release` mode, validates the
distribution, checks licenses, rejects local runtime dependencies, verifies the
actual packed files/exports, imports packed asset helpers, browser-bundles the
packed workspace/chat and enforces **both packed and unpacked sizes below 256 MiB**.
An isolated temporary consumer installs pinned React/TypeScript test dependencies,
extracts the actual tarballs under consumer alias paths, typechecks workspace
declarations in NodeNext mode and chat declarations in bundler mode with
`skipLibCheck: false`, resolves the runtime export, imports the packaged application
helper and renders workspace SSR. Test dependencies download from npmjs; no
toolkit package is published there. The exact GitHub alias versions do not exist
before first publishing, so this prepublish smoke extracts their archives locally
rather than claiming to test a registry install. Verify the real pinned registry
install in the consumer after publishing.
These are packaging checks, not a replacement for runtime/browser qualification.
Keep `.release/`, build output and `vendor/` ignored.

To check existing output without rebuilding any shared artifacts:

```sh
bun scripts/release.ts 0.1.0-alpha.1 --check-pack
```

This accepts an in-progress toolkit working tree, still requires a clean pinned
runtime release receipt, and writes to `.release/0.1.0-alpha.1-check/` with
`publishable: false`. It cannot establish that existing workspace/chat builds
match the current source commit. The workflow rejects check-only receipts.
Set `RELEASE_SMOKE_TMP` to an existing scratch directory if desired.

### Prepared OpenCode delivery

The workflow publishes **all three packages** by default. Before building it runs
`bun scripts/setup-opencode.ts`, which fetches the public GitHub Release payload
pinned in `vivari/opencode-input.json` (`opencode-input-2.0.3`), verifies its archive
SHA-256 and validates the existing independent application contract in
`opencode-chat/src/opencode-application.ts`. The verified directory contains:

```text
build-receipt.json
.runtime/opencode-bun-server/<all contract output files>
```

The script installs it under `vivari/.runtime/opencode-release-2.0.3`, or verifies
an already present copy. Chat build and packed smoke revalidate the receipt and
every contract output, including files inside the hidden `.runtime` directory.
No same-repository Actions artifact prerequisite is needed. A normal Linux runtime
build does not regenerate this prepared OpenCode payload: preparation remains a
separate process. Merely publishing a newer archive does not qualify it or establish
full runtime acceptance. The release provenance includes the committed download pin.

## Publishing and consuming

Dispatch the workflow only after committing and pushing all source pins and
inherited notices. It publishes the tested archives using `GITHUB_TOKEN` with
`packages: write`, sets `publishConfig.registry` to GitHub Packages and associates
packages with this repository. Verify/set each package's **public visibility**
in GitHub package settings after first creation; `--access=public` does not replace
GitHub's package visibility controls. npm provenance attestations are not requested
(GitHub Packages does not support npmjs's provenance flow); embedded provenance,
receipts, hashes and retained Actions artifacts provide build traceability.

Publishing several packages is not atomic. A failed run may have published an
earlier package. Inspect the registry before retrying; versions are immutable.

The separate `verify` job installs the exact versions from the registry into an
empty consumer with a fresh Bun cache, then checks public imports, SSR, runtime
assets and the prepared application. It uses only `packages: read`. To verify an
existing version without publishing, dispatch with `verify_only: true`. Locally:

```sh
# NODE_AUTH_TOKEN is supplied by your environment, with read:packages permission.
bun scripts/verify-registry.ts 0.1.0-alpha.1
```

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
    "@kev-browser-agent-kit/workspace": "npm:@kkrausse/browser-agent-workspace@0.1.0-alpha.1",
    "@kev-browser-agent-kit/opencode-chat": "npm:@kkrausse/browser-agent-opencode-chat@0.1.0-alpha.1",
    "@kkrausse/browser-agent-runtime": "0.1.0-alpha.1"
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
