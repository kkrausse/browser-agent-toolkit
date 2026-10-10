// Host for the reference loader on native Node (>= 24): real files, Node's
// own resolver, the Wasm build of the transform, and Node's builtins. Nothing
// here is part of the format; the browser runtime supplies its own host over
// the kernel.
//
// Run with `node --experimental-import-meta-resolve` (resolution of `import`
// specifiers relative to an arbitrary parent uses import.meta.resolve).

import { readFileSync, existsSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createTransform } from "../js/transform.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

/**
 * `fallbackParent`: a file whose node_modules is searched when a bare
 * specifier cannot be resolved from the importing file (lets fixtures that
 * live outside an app import the app's packages).
 */
export async function createNodeHost({ wasmPath = join(here, "../js/bat_modules.wasm"), fallbackParent, onTransform } = {}) {
  const transform = await createTransform(readFileSync(wasmPath));
  const packageTypes = new Map(); // directory -> "module" | "commonjs" | undefined
  const resolved = new Map();
  const stats = { files: 0, bytes: 0, ms: 0, esm: 0, cjs: 0 };

  // `type` of the nearest package.json; the search stops at node_modules.
  function packageType(dir) {
    if (packageTypes.has(dir)) return packageTypes.get(dir);
    let type;
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        type = JSON.parse(readFileSync(file, "utf8")).type;
      } catch {}
    } else {
      const parent = dirname(dir);
      if (parent !== dir && !dir.endsWith("/node_modules")) type = packageType(parent);
    }
    packageTypes.set(dir, type);
    return type;
  }

  return {
    stats,
    resolve(specifier, parentId, mode, options) {
      if (isBuiltin(specifier)) return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
      const key = `${mode}\0${dirname(parentId)}\0${specifier}`;
      let id = options ? undefined : resolved.get(key);
      if (id === undefined) {
        const from = (parent) => {
          if (mode === "require") return createRequire(parent).resolve(specifier, options);
          const url = import.meta.resolve(specifier, pathToFileURL(parent));
          return url.startsWith("file:") ? fileURLToPath(url) : url;
        };
        try {
          id = from(parentId);
        } catch (error) {
          if (!fallbackParent || /^[./]/.test(specifier)) throw error;
          id = from(fallbackParent);
        }
        if (!options) resolved.set(key, id);
      }
      return id;
    },
    read: (id) => readFileSync(id, "utf8"),
    source(id) {
      const text = readFileSync(id, "utf8");
      const start = performance.now();
      const type = packageType(dirname(id));
      const out = transform(text, id, { packageType: type === "module" || type === "commonjs" ? type : undefined });
      stats.ms += performance.now() - start;
      stats.files++;
      stats.bytes += text.length;
      stats[out.facts.kind === "esm" ? "esm" : "cjs"]++;
      if (!out.ok) {
        const first = out.diagnostics.find((d) => d.severity === "error");
        throw new SyntaxError(`${id}:${first.line}:${first.column}: ${first.message}`);
      }
      onTransform?.(id, out);
      return out;
    },
    // No importModuleDynamically: a native `import()` that escaped the
    // transform fails loudly instead of quietly using Node's loader.
    compile: (text, id) => vm.runInThisContext(text, { filename: id }),
    builtin(id, loader) {
      if (id === "node:module") {
        // `createRequire` must hand out the loader's require, not Node's.
        const createLoaderRequire = (from) =>
          loader.createRequire(String(from).startsWith("file:") ? fileURLToPath(from) : String(from));
        const patched = new Proxy(nodeModule, {
          get: (target, key) => (key === "createRequire" ? createLoaderRequire : key === "default" ? patched : target[key]),
        });
        return patched;
      }
      if (id.startsWith("node:")) return nodeRequire(id);
      if (id.endsWith(".node")) return nodeRequire(id); // native addons run natively
      return undefined;
    },
    url: (id) => (id.startsWith("/") ? pathToFileURL(id).href : id),
    dirname,
  };
}
