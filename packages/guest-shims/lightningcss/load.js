// Instantiates lightningcss-wasm's module the way its Node entry (wasm-node.mjs) does, but
// on demand and with fewer needs: WebAssembly (synchronous compile, so a worker when in a
// browser), fs.readFileSync, and getRandomValues. lightningcss-wasm's own entry points are
// not used: both instantiate at load, the ES ones locate the .wasm through import.meta.url,
// the CommonJS one through require('url') and takes webcrypto from node:crypto.
//
// From the lightningcss-wasm package this reads two files and no JavaScript of its own:
//   lightningcss_node.wasm            (exported by the package as a subpath)
//   node_modules/napi-wasm/index.js   (its bundled dependency: N-API for Wasm, CommonJS)
//
// The bundleAsync part is lightningcss-wasm's async.mjs (MPL-2.0, see vendor/LICENSE)
// rewritten as CommonJS: Binaryen Asyncify unwinds the Rust stack when the bundler awaits a
// JavaScript promise (a custom resolver), and bundle() is called again to rewind into it.
'use strict';
const fs = require('fs');
const path = require('path');

const State = { None: 0, Unwinding: 1, Rewinding: 2 };

function createBundleAsync(env, hooks) {
  const { instance, exports } = env;
  const { asyncify_get_state, asyncify_start_unwind, asyncify_stop_unwind, asyncify_start_rewind, asyncify_stop_rewind } = instance.exports;
  // __asyncify_data: [stack start, stack end], then 4096 bytes of saved stack.
  const DATA_ADDR = instance.exports.napi_wasm_malloc(8 + 4096);
  new Int32Array(env.memory.buffer, DATA_ADDR).set([DATA_ADDR + 8, DATA_ADDR + 8 + 4096]);
  const assertNoneState = () => {
    if (asyncify_get_state() !== State.None) throw new Error(`Invalid async state ${asyncify_get_state()}, expected 0.`);
  };
  let promise, result, error;
  hooks.awaitPromiseSync = (promiseAddr, resultAddr, errorAddr) => {
    if (asyncify_get_state() === State.Rewinding) {
      asyncify_stop_rewind();
      if (result != null) env.createValue(result, resultAddr);
      if (error != null) env.createValue(error, errorAddr);
      promise = result = error = null;
      return;
    }
    assertNoneState();
    promise = env.get(promiseAddr);
    asyncify_start_unwind(DATA_ADDR);
  };
  return async function bundleAsync(options) {
    assertNoneState();
    let res = exports.bundle(options);
    while (asyncify_get_state() === State.Unwinding) {
      asyncify_stop_unwind();
      try { result = await promise; } catch (err) { error = err; }
      assertNoneState();
      asyncify_start_rewind(DATA_ADDR);
      res = exports.bundle(options);
    }
    assertNoneState();
    return res;
  };
}

function load() {
  const wasmPath = require.resolve('lightningcss-wasm/lightningcss_node.wasm');
  const packageDir = path.dirname(wasmPath);
  const bundledNapi = path.join(packageDir, 'node_modules/napi-wasm/index.js');
  const { Environment, napi } = require(fs.existsSync(bundledNapi) ? bundledNapi : 'napi-wasm');
  const random = globalThis.crypto ?? require('crypto').webcrypto;

  const hooks = { awaitPromiseSync: undefined };
  let env;
  const module = new WebAssembly.Module(fs.readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(module, {
    env: {
      ...napi,
      await_promise_sync: (promiseAddr, resultAddr, errorAddr) => hooks.awaitPromiseSync(promiseAddr, resultAddr, errorAddr),
      __getrandom_v03_custom: (ptr, len) => { random.getRandomValues(env.memory.subarray(ptr, ptr + len)); },
    },
  });
  instance.exports.register_module();
  env = new Environment(instance);
  const { transform, transformStyleAttribute, bundle } = env.exports;
  return { transform, transformStyleAttribute, bundle, bundleAsync: createBundleAsync(env, hooks) };
}

exports.load = load;
