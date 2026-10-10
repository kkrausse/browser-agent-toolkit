'use strict';
// @tailwindcss/oxide 4.3.3's `Scanner`, backed by one plain single-threaded
// WebAssembly module (crates/bat-tools/oxide, wasm32-wasip1) instead of the
// N-API binding. Needs only `WebAssembly` and synchronous `fs`.
//
// The module comes from `globalThis.__bat_wasm('tailwindcss-oxide')` when a host
// provides that hook and it returns a precompiled `WebAssembly.Module`;
// otherwise `tailwindcss-oxide.wasm` next to this file is read and compiled
// synchronously. Instantiation is lazy: on the first `new Scanner`.

const fs = require('fs');
const path = require('path');
const { createWasi } = require('./wasi.js');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @returns {WebAssembly.Module} */
function loadModule() {
  const hook = globalThis.__bat_wasm;
  if (typeof hook === 'function') {
    const provided = hook('tailwindcss-oxide');
    if (provided instanceof WebAssembly.Module) return provided;
  }
  return new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'tailwindcss-oxide.wasm')));
}

/** @type {WebAssembly.Module | undefined} */
let compiled;
/** @type {ReturnType<typeof instantiate> | undefined} */
let current;

function instantiate() {
  compiled ??= loadModule();
  const state = { stderr: '', cwd: /** @type {string | undefined} */ (undefined), poisoned: false };
  const wasi = createWasi({ stderr: (text) => { state.stderr = (state.stderr + text).slice(-8192); } });
  const instance = new WebAssembly.Instance(compiled, { wasi_snapshot_preview1: wasi.imports });
  const x = /** @type {any} */ (instance.exports);
  wasi.bind(x.memory);
  if (typeof x._initialize === 'function') x._initialize();

  const bytes = () => new Uint8Array(x.memory.buffer);
  /** Length-prefixed UTF-8 strings into the module's input scratch; returns the byte length. */
  const input = (strings) => {
    const parts = strings.map((s) => encoder.encode(s));
    let length = 0;
    for (const part of parts) length += 4 + part.length;
    const ptr = x.ox_input(length);
    const memory = bytes();
    const view = new DataView(memory.buffer);
    let at = ptr;
    for (const part of parts) {
      view.setUint32(at, part.length, true);
      memory.set(part, at + 4);
      at += 4 + part.length;
    }
    return length;
  };
  const resultText = () => {
    const ptr = x.ox_result_ptr();
    return decoder.decode(bytes().subarray(ptr, ptr + x.ox_result_len()));
  };
  /** NUL-terminated strings produced by the last call. */
  const strings = () => {
    const text = resultText();
    return text === '' ? [] : text.slice(0, -1).split('\0');
  };
  /** Runs an export; a trap (Rust panic, which aborts) becomes an Error carrying its message. */
  const call = (fn) => {
    try {
      // The scanner resolves relative paths and bounds its .gitignore search by the working directory.
      const cwd = process.cwd();
      if (cwd !== state.cwd) {
        const raw = encoder.encode(cwd);
        bytes().set(raw, x.ox_input(raw.length));
        if (x.ox_chdir(raw.length) === 0) state.cwd = cwd;
      }
      const status = fn();
      if (status === 1) throw new Error(resultText());
      return status;
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        // The instance may hold broken state now: new scanners get a fresh one.
        state.poisoned = true;
        if (current === api) current = undefined;
        const detail = state.stderr.trim();
        state.stderr = '';
        throw new Error(`@tailwindcss/oxide (wasm): ${detail || error.message}`, { cause: error });
      }
      throw error;
    }
  };
  const api = { x, input, strings, call };
  return api;
}

const dropper = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(({ api, handle }) => { try { api.x.ox_drop(handle); } catch {} })
  : undefined;

/** @param {{ file?: string, content?: string, extension: string }} entry */
function changedContent(entry) {
  if (entry.file != null) return ['f', String(entry.file), String(entry.extension)];
  if (entry.content != null) return ['c', String(entry.content), String(entry.extension)];
  throw new TypeError('ChangedContent needs `file` or `content`');
}

function globEntries(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ base: flat[i], pattern: flat[i + 1] });
  return out;
}

class Scanner {
  #api;
  #handle;

  /** @param {{ sources?: Array<{ base: string, pattern: string, negated: boolean }> }} opts */
  constructor(opts) {
    const api = (current ??= instantiate());
    const sources = (opts && opts.sources) || [];
    const flat = [];
    for (const source of sources) flat.push(String(source.base), String(source.pattern), source.negated ? '1' : '0');
    this.#api = api;
    this.#handle = api.call(() => api.x.ox_new(api.input(flat)));
    if (dropper) dropper.register(this, { api, handle: this.#handle });
  }

  /** @returns {string[]} */
  scan() {
    const api = this.#api;
    api.call(() => api.x.ox_scan(this.#handle));
    return api.strings();
  }

  /** @param {Array<{ file?: string, content?: string, extension: string }>} input */
  scanFiles(input) {
    const api = this.#api;
    const flat = [];
    for (const entry of input) flat.push(...changedContent(entry));
    api.call(() => api.x.ox_scan_files(this.#handle, api.input(flat)));
    return api.strings();
  }

  /** @param {{ file?: string, content?: string, extension: string }} input */
  getCandidatesWithPositions(input) {
    const api = this.#api;
    // Like the N-API binding, `content` wins over `file` here.
    const entry = input.content != null
      ? ['c', String(input.content), String(input.extension)]
      : changedContent(input);
    api.call(() => api.x.ox_positions(this.#handle, api.input(entry)));
    const flat = api.strings();
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ candidate: flat[i + 1], position: Number(flat[i]) });
    return out;
  }

  /** @returns {string[]} */
  get files() {
    const api = this.#api;
    api.call(() => api.x.ox_files(this.#handle));
    return api.strings();
  }

  /** @returns {string[]} */
  get scannedFiles() {
    const api = this.#api;
    api.call(() => api.x.ox_scanned_files(this.#handle));
    return api.strings();
  }

  /** @returns {Array<{ base: string, pattern: string }>} */
  get globs() {
    const api = this.#api;
    api.call(() => api.x.ox_globs(this.#handle));
    return globEntries(api.strings());
  }

  /** @returns {Array<{ base: string, pattern: string }>} */
  get normalizedSources() {
    const api = this.#api;
    api.call(() => api.x.ox_normalized_sources(this.#handle));
    return globEntries(api.strings());
  }
}

exports.Scanner = Scanner;
