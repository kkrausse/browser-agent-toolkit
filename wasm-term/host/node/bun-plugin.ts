// Bun bundler plugin for a JavaScript program that runs on the machine
// (js-worker.ts): maps the Node built-ins Bun's browser target does not
// polyfill, or polyfills badly, onto modules/*.ts. Bun's own polyfills cover
// events, buffer, stream, util, assert, string_decoder; `path` is wrapped to
// add the `posix`/`win32` namespaces; `crypto` is replaced (see modules/crypto.ts).
//
//   await Bun.build({ target: "browser", plugins: [nodeShimsPlugin()], ... })
import type { BunPlugin } from "bun";
import path from "node:path";

const modules = path.join(import.meta.dir, "modules");
const shim = (name: string) => path.join(modules, `${name}.ts`);

/** Built-in name → the module that stands in for it. */
export const NODE_SHIMS: Record<string, string> = {
  fs: shim("fs"),
  "fs/promises": shim("fs-promises"),
  url: shim("url"),
  os: shim("os"),
  console: shim("console"),
  process: shim("process"),
  path: shim("path"),
  crypto: shim("crypto"),
  // No meaning in a browser Worker: importing works, calling throws by name.
  child_process: shim("unavailable"),
  module: shim("unavailable"),
  vm: shim("unavailable"),
  sqlite: shim("unavailable"),
  worker_threads: shim("unavailable"),
  perf_hooks: shim("unavailable"),
  tty: shim("unavailable"),
  net: shim("unavailable"),
};

export function nodeShimsPlugin(): BunPlugin {
  const names = Object.keys(NODE_SHIMS).map(name => name.replace("/", "\\/")).join("|");
  return {
    name: "wasm-term-node-shims",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^(node:)?(${names})$`) }, args => {
        // A shim may wrap the bundler's own polyfill of the module it replaces.
        if (args.importer.startsWith(modules + path.sep)) return undefined;
        return { path: NODE_SHIMS[args.path.replace(/^node:/, "")]! };
      });
    },
  };
}
