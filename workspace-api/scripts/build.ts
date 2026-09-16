import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
await rm(resolve(root, "dist/lib"), { recursive: true, force: true });
for (const [entry, target] of [["index.ts", "browser"], ["react.tsx", "browser"], ["assets.ts", "node"], ["server.ts", "node"]] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, "src", entry)], outdir: resolve(root, "dist/lib"),
    target, format: "esm", jsx: { runtime: "automatic", development: false }, external: ["react", "react/jsx-runtime", "@kev-browser-agent-kit/workspace"], sourcemap: "external" });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entry}`);
}
const types = Bun.spawn(["bun", "x", "--no-install", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await types.exited) throw Error("Declaration build failed");
const metadata = await Bun.file(resolve(root, 'package.json')).json();
const relocate = (value: unknown): unknown => typeof value === 'string' ? value.replace('./dist/lib/', './')
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
await Bun.write(resolve(root, 'dist/lib/package.json'), JSON.stringify({ name: metadata.name, version: metadata.version,
  type: metadata.type, types: relocate(metadata.types), exports: relocate(metadata.exports),
  peerDependencies: metadata.peerDependencies, peerDependenciesMeta: metadata.peerDependenciesMeta }, null, 2));
for (const file of ['README.md', 'LOCAL-PACKAGES.md']) await Bun.write(resolve(root, 'dist/lib', file), Bun.file(resolve(root, file)));
