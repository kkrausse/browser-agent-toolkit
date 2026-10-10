// Bundles the real opencode TUI (vendor/opencode, packages/tui, unmodified
// source) with OpenTUI wired to the wasm core.
//
//   bun build/build-site.ts --target=bun       -> dist/opencode-tui.bun.js (Bun host, real Node APIs)
//   bun build/build-site.ts --target=browser   -> dist/site/: everything the browser guest loads
//       guest.js            host/guest.ts, the JS-guest entry the machine imports
//       tui.js (+ .map)     the TUI itself (host/worker-app.ts)
//       opentui.wasm        the Zig core (copied from dist/opentui.wasm; `bun run build:native`)
//       parser.worker.js    OpenTUI's tree-sitter worker
//       tree-sitter.wasm    web-tree-sitter's runtime
//       assets/<lang>/...   the grammars and queries OpenTUI ships (markdown, js, ts, zig)
//   --minify (what `bun run build:tui` passes) halves tui.js; the linked source map still
//   resolves stack traces. `bun run build:tui:debug` leaves it readable.
import path from "node:path"
import { cpSync, mkdirSync } from "node:fs"
import type { BunPlugin } from "bun"
import { nodeShimsPlugin } from "../../../host/node/bun-plugin"
import { opentuiWasmPlugin, OPENTUI_ROOT } from "./opentui-wasm-plugin"

const HERE = path.resolve(import.meta.dir, "..")
const OPENCODE_ROOT = path.resolve(HERE, "../../vendor/opencode")
const TUI = path.join(OPENCODE_ROOT, "packages/tui")
const args = process.argv.slice(2)
const target = (args.find((arg) => arg.startsWith("--target="))?.slice(9) ?? "bun") as "bun" | "browser"

const { createSolidTransformPlugin } = (await import(
  path.join(OPENTUI_ROOT, "packages/solid/scripts/solid-plugin.ts")
)) as { createSolidTransformPlugin: () => BunPlugin }

const version = (await Bun.file(path.join(OPENCODE_ROOT, "package.json")).json()).version as string

// One copy of everything stateful: OpenTUI comes from the vendored source tag
// (so the wasm plugin's anchors are source lines), Solid from opencode's tree
// (it carries opencode's solid-js patch).
function singleInstances(): BunPlugin {
  const opentuiFrom = [
    path.join(OPENTUI_ROOT, "packages/solid/index.ts"),
    path.join(OPENTUI_ROOT, "packages/keymap/package.json"),
    path.join(OPENTUI_ROOT, "packages/examples/package.json"),
  ]
  return {
    name: "single-instances",
    setup(build) {
      build.onResolve({ filter: /^@opentui\/(core|solid|keymap)(\/.*)?$/ }, (args) => {
        const self = args.path.match(/^@opentui\/(core|solid|keymap)(\/.*)?$/)!
        // A package resolves its own name through its own exports map.
        const candidates = [path.join(OPENTUI_ROOT, "packages", self[1]!, "package.json"), ...opentuiFrom]
        for (const from of candidates) {
          try {
            return { path: Bun.resolveSync(args.path, path.dirname(from)) }
          } catch {}
        }
        throw new Error(`cannot resolve ${args.path} inside vendor/opentui`)
      })
      // The host files live outside the opencode workspace; resolve their
      // opencode-side imports as if they were written in packages/tui.
      build.onResolve({ filter: /^(@opencode\/|effect($|\/))/ }, (args) => {
        if (!args.importer.startsWith(HERE + path.sep)) return undefined
        return { path: Bun.resolveSync(args.path, TUI) }
      })
      build.onResolve({ filter: /^solid-js(\/.*)?$/ }, (args) => {
        const sub = args.path.slice("solid-js".length)
        const root = path.join(TUI, "node_modules/solid-js")
        // Always the client build; the "node"/"bun" conditions pick the SSR one.
        if (sub === "") return { path: path.join(root, "dist/solid.js") }
        if (sub === "/store") return { path: path.join(root, "store/dist/store.js") }
        if (sub === "/web") return { path: path.join(root, "web/dist/web.js") }
        return { path: Bun.resolveSync(args.path, TUI) }
      })
    },
  }
}

// opencode's package "imports" maps select per-runtime variants. Three need a
// variant of our own; the rest are pinned to the one that needs no host.
function conditionalStubs(): BunPlugin {
  return {
    name: "conditional-stubs",
    setup(build) {
      build.onResolve({ filter: /^#attention-sounds$/ }, () => ({
        path: path.join(HERE, "src/shims/attention-sounds.ts"),
      }))
      build.onResolve({ filter: /^#plugin-source$/ }, () => ({ path: path.join(HERE, "src/shims/plugin-source.ts") }))
      build.onResolve({ filter: /^#zed-sqlite$/ }, () => ({ path: path.join(HERE, "src/shims/zed-sqlite.ts") }))
      // Pinned explicitly so the choice does not depend on which conditions
      // the bundler adds for its target ("bun" for --target=bun).
      const pinned: Record<string, string> = {
        // XDG layout (the workerd variant puts everything under os.tmpdir()).
        "#global-roots": "packages/util/src/global-roots.ts",
        // Rejects with "unavailable": no dynamic import of plugin files.
        "#runtime-import": "packages/util/src/runtime/import.workerd.ts",
        // Pure JS (string-width + Intl.Segmenter) instead of Bun.stringWidth.
        "#string-width": "packages/tui/src/util/string-width.node.ts",
        // Empty module instead of Bun.plugin + a transpiler for external plugins.
        "#runtime-plugin-support": "packages/tui/src/plugin/runtime-plugin-support.node.ts",
      }
      build.onResolve({ filter: /^#(global-roots|runtime-import|string-width|runtime-plugin-support)$/ }, (args) => ({
        path: path.join(OPENCODE_ROOT, pinned[args.path]!),
      }))
    },
  }
}

const minify = args.includes("--minify")
const define = {
  ...(target === "browser" ? { global: "globalThis" } : {}),
  OPENCODE_VERSION: JSON.stringify(version),
  OPENCODE_CHANNEL: JSON.stringify("wasm-term"),
}

async function bundle(entry: string, outdir: string, name: string, plugins: BunPlugin[], options: { minify?: boolean; sourcemap?: "linked" | "none" } = {}) {
  const result = await Bun.build({
    entrypoints: [path.join(HERE, entry)],
    outdir,
    naming: name,
    target,
    format: "esm",
    sourcemap: options.sourcemap ?? "linked",
    minify: options.minify ?? false,
    conditions: ["node"],
    define,
    plugins,
  })
  for (const log of result.logs) console.error(String(log))
  if (!result.success) process.exit(1)
  for (const output of result.outputs) console.log(path.relative(HERE, output.path), output.size)
}

if (target === "bun") {
  await bundle("host/bun-main.ts", path.join(HERE, "dist"), "opencode-tui.bun.js", [conditionalStubs(), singleInstances(), opentuiWasmPlugin(), createSolidTransformPlugin()])
} else {
  const site = path.join(HERE, "dist/site")
  mkdirSync(site, { recursive: true })
  await bundle("host/worker-app.ts", site, "tui.js", [nodeShimsPlugin(), conditionalStubs(), singleInstances(), opentuiWasmPlugin(), createSolidTransformPlugin()], { minify })
  await bundle("host/guest.ts", site, "guest.js", [nodeShimsPlugin()], { sourcemap: "none" })
  await bundle("src/tree-sitter-worker.ts", site, "parser.worker.js", [nodeShimsPlugin(), opentuiWasmPlugin()], { sourcemap: "none", minify })
  const core = path.join(OPENTUI_ROOT, "packages/core")
  cpSync(path.join(HERE, "dist/opentui.wasm"), path.join(site, "opentui.wasm"))
  cpSync(Bun.resolveSync("web-tree-sitter/tree-sitter.wasm", core), path.join(site, "tree-sitter.wasm"))
  cpSync(path.join(core, "src/lib/tree-sitter/assets"), path.join(site, "assets"), {
    recursive: true,
    filter: (source) => !/\.(ts|md)$/.test(source),
  })
}
