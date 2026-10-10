// Loads real programs through the reference loader and the Wasm transform.
//
//   node --experimental-import-meta-resolve run.mjs [--app DIR] [--only NAME] [--verbose]
//
// `--app` is a project whose node_modules holds vite, @react-router/dev,
// @tailwindcss/vite, @babel/core and react-dom (default: the TODO example of
// the main checkout). Every module file is transformed by the Wasm build and
// evaluated by loader.mjs; only Node builtins and native `.node` addons come
// from Node itself.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./loader.mjs";
import { createNodeHost } from "./node-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const app = option("--app") ?? "/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/examples/todo-app";
const only = option("--only");
const verbose = args.includes("--verbose");
const appEntry = join(app, "__harness__.mjs"); // a parent id inside the app, for resolution
const fixture = (name) => join(here, "fixtures", name);

const host = await createNodeHost({ fallbackParent: appEntry });
const loader = createLoader(host);
const load = (specifier, parent = appEntry) => loader.import(specifier, parent);

const scenarios = {
  async "circular ESM pair with live bindings"() {
    const a = await load(fixture("cycle-a.mjs"));
    const b = await load(fixture("cycle-b.mjs"));
    // b ran first and called function declarations of a before a's body ran.
    assert.deepEqual(b.callIntoA, { readB: 1, defaultName: "default", defaultResult: "default-fn" });
    assert.equal(b.tdz, "ReferenceError"); // `counter` was still in its dead zone
    assert.equal(a.seenB, 2); // a saw b after bumpB()
    assert.deepEqual(b.liveCounter(), [1, 1]); // both read a's `counter` live
    a.bump();
    assert.equal(a.counter, 2);
    assert.throws(() => { a.counter = 5; }, TypeError);
    assert.equal(Object.prototype.toString.call(a), "[object Module]");
    assert.deepEqual(Object.keys(a), ["bump", "counter", "default", "early", "readB", "seenB"]);
  },

  async "top-level await, and a sync module that imports it"() {
    const tla = await load(fixture("imports-tla.mjs"));
    const direct = await load(fixture("tla.mjs"));
    assert.ok(direct.length > 100);
    assert.equal(tla.doubled, direct.length * 2);
    assert.equal(direct.meta.filename, fixture("tla.mjs"));
    assert.equal(direct.meta.dirname, join(here, "fixtures"));
    assert.equal(direct.meta.resolved, new URL(`file://${fixture("cjs-lib.cjs")}`).href);
    assert.equal(globalThis.__tlaSaw, 1);
  },

  async "ESM importing named exports from CJS, CJS requiring JSON"() {
    const { result, whole } = await load(fixture("esm-imports-cjs.mjs"));
    assert.deepEqual(result, {
      named: "named",
      defaultIsModuleExports: true,
      defaultProperty: "cjs-default-property",
      unboundThis: true,
      nsKeys: ["__esModule", "default", "fn", "late", "module.exports", "named", "pkg", "self"],
      pkgName: "fixture",
      dataList: [1, 2, 3],
      jsonProto: true,
      self: { thisIsExports: true, newTarget: true },
      dirnameOk: true,
      typeofModule: "undefined",
      typeofExports: "undefined",
    });
    assert.equal(await whole.late(), 2); // import() inside CommonJS reaches the loader
  },

  async "export * and require(esm)"() {
    const star = await load(fixture("star.mjs"));
    assert.equal(star.b, "own export wins");
    assert.equal(star.named, "named");
    assert.equal(typeof star.liveCounter, "function");
    assert.equal(star.lib.named, "named");
    assert.equal("default" in star, false);
    const cjs = loader.require(fixture("requires-esm.cjs"), appEntry);
    assert.deepEqual(cjs, {
      esModuleFlag: true,
      defaultResult: "default-fn",
      counter: 2,
      starIsNamespace: "Module",
      starB: "own export wins",
      starNamed: "named",
      starHasDefault: false,
      asyncError: "ERR_REQUIRE_ASYNC_MODULE",
    });
  },

  async "ambiguous .js detected as ESM"() {
    globalThis.__ambiguousThis = "unset";
    await load(fixture("ambiguous-esm.js"));
    assert.equal(globalThis.__ambiguousThis, undefined);
  },

  async "TSX component rendered with react-dom/server"() {
    const { html, Counter } = await load(fixture("component.tsx"));
    assert.equal(html, '<span class="loud">2<!-- --> todos</span>');
    assert.equal(new Counter().next(), 1);
  },

  async "react-dom/server renders an element"() {
    const React = loader.require("react", appEntry);
    const { renderToString } = await load("react-dom/server");
    assert.equal(renderToString(React.createElement("b", { id: "x" }, "hi")), '<b id="x">hi</b>');
  },

  async "@babel/core transforms"() {
    // Not a direct dependency of the app: resolve it from a package that has it.
    const babel = await load("@babel/core", host.resolve("@react-router/dev/vite", appEntry, "import"));
    const out = babel.transformSync("const f = (a) => a ?? 1;", { configFile: false, babelrc: false });
    assert.match(out.code, /a \?\? 1/);
    assert.equal(typeof babel.default.transformSync, "function");
  },

  async "vite: dist/node/index.js and its chunks, resolveConfig"() {
    const vite = await load("vite");
    assert.match(vite.version, /^7\./);
    const config = await vite.resolveConfig({ configFile: false, root: app, logLevel: "silent" }, "serve");
    assert.equal(config.root, app);
    assert.ok(config.plugins.length > 10);
  },

  async "@react-router/dev/vite"() {
    const { reactRouter } = await load("@react-router/dev/vite");
    const plugins = reactRouter();
    assert.ok(Array.isArray(plugins) && plugins.some((p) => p.name === "react-router"));
  },

  async "@tailwindcss/vite"() {
    const { default: tailwindcss } = await load("@tailwindcss/vite");
    const plugins = tailwindcss();
    assert.ok(plugins.some((p) => p.name.startsWith("@tailwindcss/vite")));
  },
};

let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  if (only && !name.includes(only)) continue;
  const before = { files: host.stats.files, ms: host.stats.ms };
  const start = performance.now();
  try {
    await run();
    console.log(
      `PASS ${name}  (${(performance.now() - start).toFixed(0)} ms, ${host.stats.files - before.files} files transformed in ${(host.stats.ms - before.ms).toFixed(0)} ms)`,
    );
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n${verbose ? error.stack : String(error.stack).split("\n").slice(0, 12).join("\n")}`);
  }
}
const s = host.stats;
console.log(
  `\n${s.files} modules transformed (${s.esm} ESM, ${s.cjs} CJS, ${(s.bytes / 1e6).toFixed(1)} MB) in ${s.ms.toFixed(0)} ms of Wasm transform time; ${loader.records.size} module records`,
);
process.exit(failed ? 1 : 0);
