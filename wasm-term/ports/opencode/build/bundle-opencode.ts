// Bundles the real opencode TUI (vendor/opencode, packages/tui, unmodified
// source) with OpenTUI wired to the wasm core.
//   bun build/bundle-opencode.ts --target=bun       -> dist/opencode-tui.bun.js   (Bun host, real Node APIs)
//   bun build/bundle-opencode.ts --target=browser   -> dist/opencode-tui.browser.js (Worker host, shims)
import path from "node:path"
import type { BunPlugin } from "bun"
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

// Node built-ins for the browser target. Bun's own browser polyfills cover
// path, events, buffer, stream, util, crypto, assert, string_decoder; these are the rest.
function nodeShims(): BunPlugin {
  const shim = (name: string) => path.join(HERE, "src/node", name)
  const map: Record<string, string> = {
    fs: shim("fs.ts"),
    "fs/promises": shim("fs-promises.ts"),
    url: shim("url.ts"),
    os: shim("os.ts"),
    child_process: shim("unavailable.ts"),
    module: shim("unavailable.ts"),
    vm: shim("unavailable.ts"),
    sqlite: shim("unavailable.ts"),
    worker_threads: shim("unavailable.ts"),
    perf_hooks: shim("unavailable.ts"),
    tty: shim("unavailable.ts"),
    net: shim("unavailable.ts"),
    console: shim("console.ts"),
    process: shim("process-module.ts"),
    path: shim("path.ts"),
  }
  return {
    name: "node-shims",
    setup(build) {
      build.onResolve({ filter: /^(node:)?(fs|fs\/promises|url|os|child_process|module|vm|sqlite|worker_threads|perf_hooks|tty|net|console|process|path)$/ }, (args) => {
        // A shim may wrap the bundler's own polyfill of the module it replaces.
        if (args.importer.startsWith(path.join(HERE, "src/node") + path.sep)) return undefined
        return { path: map[args.path.replace(/^node:/, "")]! }
      })
    },
  }
}

const result = await Bun.build({
  entrypoints: [path.join(HERE, target === "bun" ? "host/bun-main.ts" : "host/worker-app.ts")],
  outdir: path.join(HERE, "dist"),
  naming: `opencode-tui.${target}.js`,
  target,
  format: "esm",
  sourcemap: "linked",
  conditions: ["node"],
  define: {
    ...(target === "browser" ? { global: "globalThis" } : {}),
    OPENCODE_VERSION: JSON.stringify(version),
    OPENCODE_CHANNEL: JSON.stringify("wasm-term"),
  },
  plugins: [...(target === "browser" ? [nodeShims()] : []), conditionalStubs(), singleInstances(), opentuiWasmPlugin(), createSolidTransformPlugin()],
})
for (const log of result.logs) console.error(String(log))
if (!result.success) process.exit(1)
for (const output of result.outputs) console.log(path.relative(HERE, output.path), output.size)
