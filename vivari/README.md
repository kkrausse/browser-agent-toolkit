# Vivari integration tooling

The runtime source is the separate
[`kkrausse/vivari` fork](https://github.com/kkrausse/vivari/tree/browser-runtime).
This directory contains source pins, build/preparation tools, upstream notices,
and qualification helpers. It is not a second copy of the runtime source.

Start with [development setup](DEVELOPMENT.md). The primary runtime commands are:

```sh
bun scripts/setup-runtime.ts
bun scripts/build-runtime.ts
bun ../workspace-api/scripts/distribution.ts
```

Setup creates a missing checkout at the recorded revision; it does not reset an
existing checkout. `VIVARI_SOURCE` selects another runtime source directory.

The current OpenCode build recipe is
[`experiments/opencode-release-server/`](experiments/opencode-release-server/README.md).
Its receipted outputs are generated under `.runtime/`, not committed source.
The chat package checks exact artifact identities; see the
[root setup guide](../README.md) before rebuilding that prerequisite.

The standalone ripgrep packager and source-pinned Tailwind backend build require
additional generated inputs. They are not part of the default package build.
Old experiments, results, and chronological documentation remain in the original
`random/browser-container-poc` history.
