// Bundles one entry with OpenTUI wired to the wasm core.
//   bun build/bundle.ts <entry> [--target=bun|browser] [--out=name]
import path from "node:path"
import { opentuiWasmPlugin, OPENTUI_ROOT } from "./opentui-wasm-plugin"

const HERE = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const entry = args.find((arg) => !arg.startsWith("--"))
if (!entry) throw new Error("usage: bun build/bundle.ts <entry> [--target=bun|browser]")
const target = (args.find((arg) => arg.startsWith("--target="))?.slice(9) ?? "bun") as "bun" | "browser"

const result = await Bun.build({
  entrypoints: [path.resolve(HERE, entry)],
  outdir: path.join(HERE, "dist"),
  target,
  format: "esm",
  sourcemap: "linked",
  plugins: [
    {
      name: "opentui-source",
      setup(build) {
        // Use OpenTUI's TypeScript source at the pinned tag, not the published
        // dist, so the plugin's anchors are stable, reviewable source lines.
        build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
          path: path.join(OPENTUI_ROOT, "packages/core/src/index.ts"),
        }))
      },
    },
    opentuiWasmPlugin(),
  ],
})
for (const log of result.logs) console.error(log)
if (!result.success) process.exit(1)
for (const output of result.outputs) console.log(path.relative(HERE, output.path), output.size)
