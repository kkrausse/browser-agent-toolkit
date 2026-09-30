import { $ } from "bun";
import { buildUIStyles } from "./scripts/build-ui-styles";
import { uiLicenses } from "./scripts/ui-licenses";
import { readQualifiedOpenCodeApplication } from './src/opencode-application';
import { fileURLToPath } from 'node:url';
// Verify first; distribute only the receipted payload, never retained browser state.
const application = await readQualifiedOpenCodeApplication(process.env.OPENCODE_PACKAGE_DIR
  ?? fileURLToPath(new URL('../vivari/.runtime/opencode-release-2.0.3/', import.meta.url)));
await $`rm -rf dist`;
await $`bunx tsc --emitDeclarationOnly`;
// Build the runtime implementation directly: Bun 1.4's sideEffects optimization
// incorrectly drops a re-export-only root entry. Declarations use src/index.ts.
for (const [entry, name] of [
  ["src/controller.ts", "index.js"],
  ["src/react.tsx", "react.js"],
    ["src/editor.tsx", "editor.js"],
    ["src/browser.ts", "browser.js"],
  ["src/diagnostics.ts", "diagnostics.js"],
]) {
  const result = await Bun.build({
    entrypoints: [entry!],
    outdir: "dist",
    naming: name!,
    target: "browser",
    jsx: { runtime: "automatic", development: false },
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/*", "@kev-browser-agent-kit/workspace", "@kev-browser-agent-kit/workspace/react", "@kev-browser-agent-kit/workspace/diagnostics"],
  });
  if (!result.success) throw new AggregateError(result.logs);
}
for (const entry of ['prepare', 'server', 'diagnostics-server']) {
  const result = await Bun.build({ entrypoints: [`src/${entry}.ts`], outdir: 'dist', naming: `${entry}.js`, target: 'bun', packages: 'external' });
  if (!result.success) throw new AggregateError(result.logs);
}
await Bun.write('dist/application/build-receipt.json', application.receiptBytes);
for (const asset of application.assets) await Bun.write('dist/application/.runtime/opencode-bun-server/' + asset.file, asset.bytes);
await buildUIStyles();
await Bun.write("dist/THIRD-PARTY-LICENSES.txt", await uiLicenses());
// A compiled local package has the same public exports without bringing build/test dependencies.
const metadata = await Bun.file('package.json').json();
const relocate = (value: unknown): unknown => typeof value === 'string' ? value.replace('./dist/', './')
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
await Bun.write('dist/package.json', JSON.stringify({ name: metadata.name, version: metadata.version, type: metadata.type,
  license: metadata.license, exports: relocate(metadata.exports), sideEffects: metadata.sideEffects,
  peerDependencies: metadata.peerDependencies, peerDependenciesMeta: metadata.peerDependenciesMeta }, null, 2));
for (const file of ['README.md', 'PROVENANCE.md', 'LICENSE', 'LICENSE.marked', 'LICENSE.shadcn', 'LICENSE.upstream']) await Bun.write('dist/' + file, Bun.file(file));
