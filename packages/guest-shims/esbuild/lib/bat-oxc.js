'use strict';
// Binding for bat_esbuild.wasm (crates/bat-tools/wasm): one synchronous call per transform.
// Needs only WebAssembly and fs. A runtime that already holds the compiled module hands it
// over through globalThis.__bat_wasm('esbuild') (a WebAssembly.Module, or undefined).
const fs = require('fs');
const path = require('path');

let instance;
let loadMs = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function load() {
  if (instance) return instance;
  const start = performance.now();
  const given = typeof globalThis.__bat_wasm === 'function' ? globalThis.__bat_wasm('esbuild') : undefined;
  const module = given instanceof WebAssembly.Module ? given : new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'bat_esbuild.wasm')));
  instance = new WebAssembly.Instance(module, {}).exports;
  loadMs = performance.now() - start;
  return instance;
}

const LOADERS = { js: 0, jsx: 1, ts: 2, tsx: 3 };
const JSX = { transform: 0, automatic: 1, preserve: 2 };

/** Options as crates/bat-tools/wasm/src/lib.rs documents them. */
function encodeOptions(o) {
  let flags = LOADERS[o.loader] | (JSX[o.jsx] << 4);
  if (o.sourceMap) flags |= 1 << 2;
  if (o.sourcesContent) flags |= 1 << 3;
  if (o.jsxDev) flags |= 1 << 6;
  if (o.keepUnusedImports) flags |= 1 << 7;
  if (o.experimentalDecorators) flags |= 1 << 8;
  if (o.assignClassFields) flags |= 1 << 9;
  if (o.minifyWhitespace) flags |= 1 << 10;
  if (o.asciiOnly) flags |= 1 << 11;
  if (o.legalComments) flags |= 1 << 12;
  if (o.collectImports) flags |= 1 << 13;
  const strings = [o.sourcefile ?? '', o.jsxFactory ?? '', o.jsxFragment ?? '', o.jsxImportSource ?? ''];
  const parts = [flags, ...strings.map(s => encoder.encode(s))];
  for (const pairs of [o.define ?? [], o.rewriteImports ?? []]) {
    parts.push(pairs.length);
    for (const [a, b] of pairs) parts.push(encoder.encode(a), encoder.encode(b));
  }
  let size = 0;
  for (const part of parts) size += typeof part === 'number' ? 4 : 4 + part.length;
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  let at = 0;
  for (const part of parts) {
    if (typeof part === 'number') { view.setUint32(at, part, true); at += 4; continue; }
    view.setUint32(at, part.length, true); bytes.set(part, at + 4); at += 4 + part.length;
  }
  return bytes;
}

/**
 * @returns {{ status: 0|1|2, code: string, map: string, messages: {error:boolean,line:number,column:number,length:number,text:string}[],
 *   imports: {kind:'import-statement'|'dynamic-import'|'require-call', path:string}[], reason: string }}
 */
function transform(source, options) {
  const wasm = load();
  const input = typeof source === 'string' ? encoder.encode(source) : source;
  const opts = encodeOptions(options);
  const src = wasm.bat_alloc(input.length), opt = wasm.bat_alloc(opts.length);
  new Uint8Array(wasm.memory.buffer, src, input.length).set(input);
  new Uint8Array(wasm.memory.buffer, opt, opts.length).set(opts);
  const result = wasm.bat_esbuild_transform(src, input.length, opt, opts.length);
  // Views are taken after the call: the memory may have grown.
  const header = new Uint32Array(wasm.memory.buffer, result, 11);
  const text = index => header[index + 1] === 0 ? '' : decoder.decode(new Uint8Array(wasm.memory.buffer, header[index], header[index + 1]));
  const out = { status: header[0], code: text(1), map: text(3), messages: [], imports: [], reason: text(9) };
  for (const line of text(5).split('\n')) {
    if (!line) continue;
    const [severity, lineNumber, column, length, ...rest] = line.split('\t');
    out.messages.push({ error: severity === 'E', line: +lineNumber, column: +column, length: +length, text: rest.join('\t') });
  }
  for (const line of text(7).split('\n')) {
    if (!line) continue;
    out.imports.push({ kind: line[0] === 'i' ? 'import-statement' : line[0] === 'd' ? 'dynamic-import' : 'require-call', path: line.slice(2) });
  }
  wasm.bat_result_free(result);
  wasm.bat_free(src, input.length);
  wasm.bat_free(opt, opts.length);
  return out;
}

module.exports = { transform, load, stats: () => ({ loaded: !!instance, loadMs }) };
