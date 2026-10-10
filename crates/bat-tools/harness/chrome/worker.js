// Worker: load one esbuild implementation the way a guest process would and time it.
onmessage = async ({ data: kind }) => {
  const records = await (await fetch('/trace.json')).json();
  const big = records.reduce((a, b) => (b.options.loader === 'tsx' && b.input.length > a.input.length ? b : a), records[0]);
  const out = { kind };
  let transform;
  if (kind === 'shim') {
    const [bytes, mainSource, oxcSource] = await Promise.all([fetch('/bat_esbuild.wasm').then(r => r.arrayBuffer()), fetch('/bat-main.js').then(r => r.text()), fetch('/bat-oxc.js').then(r => r.text())]);
    let t = performance.now();
    const module = new WebAssembly.Module(bytes); // synchronous, as the shim does it
    out.compileMs = performance.now() - t;
    globalThis.__bat_wasm = () => module;          // the runtime's hook
    globalThis.process = { env: {}, cwd: () => '/' };
    const load = (source, require) => { const m = { exports: {} }; new Function('module', 'exports', 'require', '__dirname', source)(m, m.exports, require, '/'); return m.exports; };
    t = performance.now();
    const oxc = load(oxcSource, () => ({}));
    const esbuild = load(mainSource, name => name === './bat-oxc.js' ? oxc : {});
    out.requireMs = performance.now() - t;
    transform = esbuild.transform;
  } else {
    importScripts('/esbuild-browser.js');
    let t = performance.now();
    await esbuild.initialize({ wasmURL: '/esbuild.wasm', worker: false });
    out.initializeMs = performance.now() - t;
    transform = esbuild.transform;
  }
  let t = performance.now();
  await transform(records[0].input, records[0].options);
  out.firstMs = performance.now() - t;
  t = performance.now();
  for (const record of records.slice(1)) await transform(record.input, record.options);
  out.restMs = performance.now() - t;
  const times = [];
  for (let i = 0; i < 100; i++) { t = performance.now(); await transform(big.input, big.options); times.push(performance.now() - t); }
  out.warmMs = times.sort((a, b) => a - b)[50];
  postMessage(out);
};
