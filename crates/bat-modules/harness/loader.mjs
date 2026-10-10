// Reference loader for the module format in docs/design/module-format.md.
//
// This file is the executable half of that document: a synchronous loader,
// small enough to read in one sitting, that the runtime's loader is ported
// from. Everything here is normative unless a comment says "host" or
// "reference only". It knows nothing about Node or the browser; the host
// object supplies resolution, file contents, compilation and builtins:
//
//   host.resolve(specifier, parentId, mode)  -> id      mode: "import" | "require"
//   host.source(id)   -> { code, facts }     transformed function body + facts
//   host.read(id)     -> string              original text (JSON only)
//   host.compile(text, id) -> function       evaluate a function expression
//   host.builtin(id, loader) -> exports | undefined    node:fs, native addons
//   host.url(id)      -> string              import.meta.url
//   host.dirname(id)  -> string

const NEW = 0; // record exists, nothing has run
const LINKING = 1; // ESM: prelude is running / dependencies are being linked
const LINKED = 2; // ESM: export getters and dependency namespaces are in place
const EVALUATING = 3; // body is running (or waiting on async dependencies)
const EVALUATED = 4;
const FAILED = 5; // ESM only: `error` is rethrown to every later importer

// The function wrappers. The body starts on the wrapper's line, so line
// numbers in stack traces are the source's own. The newline before the
// closing brace matters: a body may end in a `//` comment.
const WRAP = {
  cjs: ["(function (exports, require, module, __filename, __dirname, __bat) {", "\n})"],
  esm: ["(function* (__bat) {", "\n})"],
  esmAsync: ["(async function* (__bat) {", "\n})"],
};

export function createLoader(host) {
  const records = new Map(); // id -> record
  let main; // the record import.meta.main / require.main refer to

  function newNamespace() {
    const namespace = Object.create(null);
    Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
    return namespace;
  }

  // ---- records -----------------------------------------------------------

  function load(id) {
    let record = records.get(id);
    if (record) return record;
    record = { id, kind: "", state: NEW, facts: undefined, fn: undefined, module: undefined, namespace: undefined,
      generator: undefined, deps: [], stars: [], pending: undefined, error: undefined, facade: undefined };
    records.set(id, record);
    try {
      const builtin = host.builtin(id, loader);
      if (builtin !== undefined) {
        record.kind = "builtin";
        record.module = { exports: builtin };
        record.state = EVALUATED;
        return record;
      }
      record.module = { id, filename: id, path: host.dirname(id), exports: {}, loaded: false, children: [], paths: [] };
      if (id.endsWith(".json")) {
        // JSON needs no transform: parse the original text when first required.
        record.kind = "json";
        return record;
      }
      const { code, facts } = host.source(id);
      record.facts = facts;
      record.kind = facts.kind === "esm" ? "esm" : "cjs";
      const wrap = record.kind === "cjs" ? WRAP.cjs : facts.async ? WRAP.esmAsync : WRAP.esm;
      record.fn = host.compile(wrap[0] + code + wrap[1], id);
      if (record.kind === "esm") record.namespace = newNamespace();
      return record;
    } catch (error) {
      records.delete(id);
      throw error;
    }
  }

  // ---- the `__bat` object passed to every module function ------------------

  function context(record) {
    let meta;
    return {
      // ESM prelude: live export bindings. Each value is a function returning
      // the current value of a local binding (which throws while that binding
      // is in its temporal dead zone, exactly like the real thing).
      exports(getters) {
        for (const name of Object.keys(getters)) {
          Object.defineProperty(record.namespace, name, { get: getters[name], enumerable: true });
        }
      },
      // ESM prelude: one call per static dependency, in source order. Returns
      // the dependency's namespace object WITHOUT evaluating it; the body
      // reads imported names through that object at each use.
      link(specifier) {
        try {
          const dep = load(host.resolve(specifier, record.id, "import"));
          record.deps.push(dep);
          return namespaceOf(dep);
        } catch (error) {
          // The prelude of an async generator cannot throw synchronously;
          // keep the first failure and report it from link().
          record.error ??= error;
          return newNamespace();
        }
      },
      // ESM prelude: `export * from` the dependency with this namespace.
      star(namespace) {
        record.stars.push(namespace);
      },
      // `import(specifier)` in both module kinds.
      import(specifier) {
        return importFrom(record.id, String(specifier));
      },
      // `import.meta`, created on first use.
      get meta() {
        return (meta ??= {
          url: host.url(record.id),
          filename: record.id,
          dirname: host.dirname(record.id),
          resolve: (specifier) => host.url(host.resolve(specifier, record.id, "import")),
          main: record === main,
        });
      },
    };
  }

  // ---- namespaces and interop --------------------------------------------

  // What `import` sees. ESM: the module's own namespace. Anything else gets a
  // namespace built Node's way: `default` is module.exports (always, whatever
  // `__esModule` says), plus the statically detected export names.
  function namespaceOf(record) {
    if (record.namespace) return record.namespace;
    const namespace = (record.namespace = newNamespace());
    const whole = { get: () => record.module.exports, enumerable: true };
    Object.defineProperty(namespace, "default", whole);
    Object.defineProperty(namespace, "module.exports", whole);
    for (const name of cjsExportNames(record, new Set())) {
      if (name in namespace) continue; // "default", "module.exports", or a name reached twice
      Object.defineProperty(namespace, name, { get: () => record.module.exports?.[name], enumerable: true });
    }
    return namespace;
  }

  // facts.exports plus, transitively, the names of every module in
  // facts.reexports (`module.exports = require("./x")`, `__exportStar(...)`).
  function cjsExportNames(record, seen) {
    if (seen.has(record)) return [];
    seen.add(record);
    if (record.kind === "builtin") return Object.keys(Object(record.module.exports));
    if (record.kind !== "cjs") return [];
    const names = [...record.facts.exports];
    for (const specifier of record.facts.reexports) {
      try {
        names.push(...cjsExportNames(load(host.resolve(specifier, record.id, "require")), seen));
      } catch {
        // An unresolvable re-export contributes no names; require() will report it.
      }
    }
    return names;
  }

  // What `require()` of an ES module returns (Node 22+ rules): the
  // "module.exports" export if there is one; otherwise the namespace, with
  // `__esModule: true` added when there is a default export, so that code
  // compiled from `import x from` keeps working.
  function requireView(record) {
    const namespace = record.namespace;
    if ("module.exports" in namespace) return namespace["module.exports"];
    if (!("default" in namespace) || "__esModule" in namespace) return namespace;
    if (!record.facade) {
      record.facade = newNamespace();
      for (const name of Object.keys(namespace)) {
        Object.defineProperty(record.facade, name, { get: () => namespace[name], enumerable: true });
      }
      Object.defineProperty(record.facade, "__esModule", { value: true });
    }
    return record.facade;
  }

  // ---- ESM: link, then evaluate ------------------------------------------

  // Run the prelude of `record` and of everything it statically imports.
  // After this every module in the graph has its export getters defined and
  // its function declarations hoisted, so cycles behave as in real ESM: an
  // importer can call a function declaration of a module that has not run.
  function link(record) {
    if (record.kind !== "esm" || record.state !== NEW) return;
    record.state = LINKING;
    record.generator = record.fn.call(undefined, context(record)); // module `this` is undefined
    const prelude = record.generator.next(); // runs to the single `yield`
    if (record.facts.async) prelude.catch(() => {});
    if (record.error) {
      record.state = FAILED;
      throw record.error;
    }
    for (const dep of record.deps) link(dep);
    // `export *`: every name of the dependency except `default`; the module's
    // own exports win. (Reference only: conflicting names from two `export *`
    // resolve to the first instead of being excluded as ambiguous.)
    for (const from of record.stars) {
      for (const name of Object.keys(from)) {
        if (name === "default" || name === "module.exports" || name in record.namespace) continue;
        Object.defineProperty(record.namespace, name, { get: () => from[name], enumerable: true });
      }
    }
    record.state = LINKED;
  }

  // Evaluate dependencies in order, then the body. Returns undefined when
  // everything finished synchronously, otherwise a promise. A module that is
  // already evaluating (a cycle) is not waited for.
  function evaluate(record) {
    if (record.kind !== "esm") return void runCjs(record);
    if (record.state === FAILED) throw record.error;
    if (record.state >= EVALUATING) return record.pending;
    record.state = EVALUATING;
    const fail = (error) => {
      record.state = FAILED;
      record.error = error;
      record.pending = undefined;
      throw error;
    };
    try {
      let waits;
      for (const dep of record.deps) {
        const wait = evaluate(dep);
        if (wait) (waits ??= []).push(wait);
      }
      // Resume the generator after its `yield`: this is the module body. An
      // async generator (top-level await) returns a promise for its end.
      const body = () => (record.facts.async ? record.generator.next() : void record.generator.next());
      const running = waits ? Promise.all(waits).then(body) : body();
      if (!running) {
        record.state = EVALUATED;
        return undefined;
      }
      record.pending = running.then(() => {
        record.state = EVALUATED;
        record.pending = undefined;
      }, fail);
      record.pending.catch(() => {});
      return record.pending;
    } catch (error) {
      fail(error);
    }
  }

  // True if evaluating `record` could not finish synchronously.
  function hasAsync(record, seen = new Set()) {
    if (record.kind !== "esm" || seen.has(record)) return false;
    seen.add(record);
    if (record.state === EVALUATED) return false;
    return record.facts.async || record.pending !== undefined || record.deps.some((dep) => hasAsync(dep, seen));
  }

  // ---- CommonJS ------------------------------------------------------------

  function runCjs(record) {
    if (record.state !== NEW) return; // done, or running: a cycle sees the exports so far
    record.state = EVALUATING;
    const module = record.module;
    try {
      if (record.kind === "json") {
        module.exports = JSON.parse(host.read(record.id).replace(/^﻿/, ""));
      } else {
        const require = makeRequire(record);
        module.require = require;
        record.fn.call(module.exports, module.exports, require, module, record.id, module.path, context(record));
      }
      module.loaded = true;
      record.state = EVALUATED;
    } catch (error) {
      records.delete(record.id); // like Node: a CommonJS module that threw is forgotten
      throw error;
    }
  }

  function makeRequire(record) {
    const require = (specifier) => requireFrom(record.id, specifier);
    require.resolve = (specifier, options) => host.resolve(specifier, record.id, "require", options);
    require.cache = cache;
    require.extensions = { ".js": true, ".json": true, ".node": true };
    Object.defineProperty(require, "main", { get: () => main?.module, enumerable: true });
    return require;
  }

  // Reference only: enough of `require.cache` for code that looks itself up.
  const cache = new Proxy({}, {
    get: (_, id) => records.get(id)?.module,
    has: (_, id) => records.has(id),
    deleteProperty: (_, id) => records.delete(id) || true,
    ownKeys: () => [...records.keys()],
    getOwnPropertyDescriptor: (_, id) =>
      records.has(id) ? { value: records.get(id).module, enumerable: true, configurable: true } : undefined,
  });

  function requireFrom(parentId, specifier) {
    const record = load(host.resolve(String(specifier), parentId, "require"));
    if (record.kind !== "esm") {
      runCjs(record);
      return record.module.exports;
    }
    // require(esm): link, refuse graphs with top-level await, evaluate now.
    link(record);
    if (hasAsync(record)) {
      const error = new Error(`require() cannot be used on an ESM graph with top-level await. Use import() instead. (${record.id})`);
      error.code = "ERR_REQUIRE_ASYNC_MODULE";
      throw error;
    }
    evaluate(record);
    return requireView(record);
  }

  async function importFrom(parentId, specifier) {
    await null; // import() never evaluates anything synchronously
    const record = load(host.resolve(specifier, parentId, "import"));
    if (record.kind === "esm") {
      link(record);
      await evaluate(record);
    } else {
      runCjs(record);
    }
    return namespaceOf(record);
  }

  const loader = {
    records,
    /** Run `id` as the main module (it sees `import.meta.main` / `require.main === module`). */
    async runMain(id) {
      main = load(id);
      return importFrom(id, id);
    },
    /** `import(specifier)` as if written in the module `parentId`. */
    import: (specifier, parentId) => importFrom(parentId, specifier),
    /** `require(specifier)` as if written in the module `parentId`. */
    require: (specifier, parentId) => requireFrom(parentId, specifier),
    /** A `require` function bound to `parentId` (what `createRequire` returns). */
    createRequire(parentId) {
      return makeRequire({ id: parentId });
    },
  };
  return loader;
}
