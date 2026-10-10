'use strict';
// The `esbuild` package as the guest sees it.
//
//   transform / transformSync   js, jsx, ts, tsx: oxc compiled to Wasm, synchronous, in process
//                               (lib/bat-oxc.js). Anything it does not do (see `planTransform`)
//                               goes to the real esbuild.
//   build                       one entry whose imports all resolve to externals (how Vite
//                               bundles a config file): done here. Everything else: real esbuild.
//   context, analyzeMetafile    real esbuild.
//   formatMessages              here (plain JS).
//
// "Real esbuild" is the `esbuild-wasm` package this shim is laid over (or depends on),
// loaded on first use and never at require.
// BAT_ESBUILD_SHIM_LOG=<file> appends one JSON line per call saying which path served it.

const fs = require('fs');
const path = require('path');
const oxc = require('./bat-oxc.js');

const version = '0.28.2';

// ---------------------------------------------------------------- fallback

let real;
function fallback() {
  if (real) return real;
  // Laid over an installed esbuild-wasm (prepare's `overlay`), the real API is the
  // neighbouring main.js; as a package of its own, it is the esbuild-wasm dependency.
  try { real = require('./main.js'); } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    real = require('esbuild-wasm');
  }
  return real;
}

const logFile = process.env.BAT_ESBUILD_SHIM_LOG;
function log(api, served, start, detail) {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ api, served, ms: +(performance.now() - start).toFixed(2), ...detail }) + '\n');
}

// ---------------------------------------------------------------- messages

function toMessage(message, file, lines) {
  return {
    id: '', pluginName: '', text: message.text, notes: [], detail: undefined,
    location: message.line === 0 ? null : {
      file, namespace: '', line: message.line, column: message.column, length: message.length,
      lineText: lines()[message.line - 1] ?? '', suggestion: '',
    },
  };
}

function summarize(kind, errors) {
  const shown = errors.slice(0, 5).map(e => `\n${e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ` : ''}ERROR: ${e.text}`);
  const more = errors.length > 5 ? '\n...' : '';
  return `${kind} failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:${shown.join('')}${more}`;
}

function failure(kind, errors, warnings) {
  const error = new Error(summarize(kind, errors));
  error.errors = errors;
  error.warnings = warnings;
  return error;
}

function formatOne(message, kind, color, width) {
  const [red, yellow, bold, dim, green, reset] = color ? ['\x1b[31m', '\x1b[33m', '\x1b[1m', '\x1b[37m', '\x1b[32m', '\x1b[0m'] : ['', '', '', '', '', ''];
  const tint = kind === 'error' ? red : yellow;
  const label = kind === 'error' ? 'ERROR' : 'WARNING';
  const mark = kind === 'error' ? '✘' : '▲';
  const plugin = message.pluginName ? `[plugin ${message.pluginName}] ` : '';
  let out = `${tint}${mark} ${reset}${color ? `\x1b[4${kind === 'error' ? 1 : 3}m\x1b[30m` : ''}[${label}]${reset} ${bold}${plugin}${message.text}${reset}\n`;
  const frame = location => {
    if (!location) return '';
    const number = String(location.line);
    let text = location.lineText ?? '';
    const limit = width > 0 ? Math.max(20, width - number.length - 9) : Infinity;
    if (text.length > limit) text = text.slice(0, limit - 3) + '...';
    const start = Math.min(location.column, text.length), end = Math.min(start + (location.length ?? 0), text.length);
    const marker = end - start > 1 ? '~'.repeat(end - start) : '^';
    return `\n    ${location.file}:${location.line}:${location.column}:\n${dim}    ${number.padStart(3)} │ ${text.slice(0, start)}${reset}${green}${text.slice(start, end)}${reset}${dim}${text.slice(end)}${reset}\n`
      + `        ${' '.repeat(Math.max(0, number.length - 3))}╵ ${' '.repeat(start)}${green}${marker}${reset}\n`
      + (location.suggestion ? `        ${' '.repeat(Math.max(0, number.length - 3))}│ ${' '.repeat(start)}${green}${location.suggestion}${reset}\n` : '');
  };
  out += frame(message.location);
  for (const note of message.notes ?? []) out += `\n  ${note.text}\n` + frame(note.location);
  return out + '\n';
}

function formatMessagesSync(messages, options) {
  if (!options || (options.kind !== 'error' && options.kind !== 'warning')) throw new Error('Missing "kind" in options');
  return messages.map(message => formatOne(message, options.kind, !!options.color, options.terminalWidth ?? 0));
}

// ---------------------------------------------------------------- transform

/** JSON with comments and trailing commas, as tsconfig files are written. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2;
    } else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const NATIVE_LOADERS = new Set(['js', 'jsx', 'ts', 'tsx']);
// Options that change the output in ways this transform does not implement.
const UNSUPPORTED_WHEN_SET = ['minify', 'minifyIdentifiers', 'minifySyntax', 'mangleProps', 'reserveProps', 'mangleCache', 'dropLabels', 'drop', 'pure', 'banner', 'footer', 'globalName', 'lineLimit'];
// Options read here, and options that cannot change what this transform emits: no syntax is
// ever lowered (`target`, `supported`), nothing is renamed or removed (`keepNames`,
// `treeShaking`, `ignoreAnnotations`, `jsxSideEffects`, `mangleQuoted`), and the rest is logging.
const KNOWN = new Set(['loader', 'sourcemap', 'sourcefile', 'sourcesContent', 'sourceRoot', 'jsx', 'jsxDev', 'jsxFactory', 'jsxFragment', 'jsxImportSource',
  'tsconfigRaw', 'define', 'minifyWhitespace', 'charset', 'legalComments', 'format', 'target', 'supported', 'platform', 'keepNames', 'treeShaking',
  'ignoreAnnotations', 'jsxSideEffects', 'mangleQuoted', 'logLevel', 'logLimit', 'logOverride', 'color', 'absWorkingDir', ...UNSUPPORTED_WHEN_SET]);

function isSet(value) {
  return Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : !!value;
}

/** esbuild's rule for TypeScript's `useDefineForClassFields` when it is not given. */
function definesClassFields(compilerOptions) {
  if (typeof compilerOptions.useDefineForClassFields === 'boolean') return compilerOptions.useDefineForClassFields;
  const target = typeof compilerOptions.target === 'string' ? compilerOptions.target.toLowerCase() : undefined;
  if (target === undefined) return true;
  if (target === 'esnext') return true;
  const year = /^es(\d+)$/.exec(target);
  return !!year && +year[1] >= 2022;
}

/** Either `{ native }` (options for lib/bat-oxc.js) or `{ reason }` (use the real esbuild). */
function planTransform(options) {
  for (const key of Object.keys(options)) if (!KNOWN.has(key) && options[key] !== undefined) return { reason: `option ${key}` };
  for (const key of UNSUPPORTED_WHEN_SET) if (isSet(options[key])) return { reason: `option ${key}` };
  const loader = options.loader ?? 'js';
  if (!NATIVE_LOADERS.has(loader)) return { reason: `loader ${loader}` };
  if (options.format !== undefined && options.format !== 'esm') return { reason: `format ${options.format}` };
  const legal = options.legalComments ?? 'inline';
  if (legal !== 'inline' && legal !== 'none') return { reason: `legalComments ${legal}` };
  const sourcemap = options.sourcemap ?? false;
  if (sourcemap === 'linked') return { reason: 'sourcemap linked' };

  let compilerOptions = {};
  if (options.tsconfigRaw !== undefined) {
    const raw = typeof options.tsconfigRaw === 'string' ? parseJsonc(options.tsconfigRaw) : options.tsconfigRaw;
    compilerOptions = raw?.compilerOptions ?? {};
  }
  const typescript = loader === 'ts' || loader === 'tsx';
  // Kept as side-effect imports by esbuild; rare, removed from TypeScript 5.5.
  if (typescript && (compilerOptions.importsNotUsedAsValues === 'preserve' || compilerOptions.importsNotUsedAsValues === 'error')) return { reason: 'importsNotUsedAsValues' };

  const fromTsconfig = { react: 'transform', 'react-jsx': 'automatic', 'react-jsxdev': 'automatic', preserve: 'preserve', 'react-native': 'preserve' };
  const jsx = options.jsx ?? fromTsconfig[compilerOptions.jsx] ?? 'transform';
  const define = Object.entries(options.define ?? {});
  for (const [, value] of define) if (typeof value !== 'string') return { reason: 'define value is not a string' };
  return {
    native: {
      loader, jsx,
      sourcefile: options.sourcefile ?? '<stdin>',
      sourceMap: !!sourcemap,
      sourcesContent: options.sourcesContent ?? true,
      jsxDev: options.jsxDev ?? (options.jsx === undefined && compilerOptions.jsx === 'react-jsxdev'),
      jsxFactory: options.jsxFactory ?? compilerOptions.jsxFactory,
      jsxFragment: options.jsxFragment ?? compilerOptions.jsxFragmentFactory,
      jsxImportSource: options.jsxImportSource ?? compilerOptions.jsxImportSource,
      keepUnusedImports: !!(compilerOptions.verbatimModuleSyntax || compilerOptions.preserveValueImports),
      experimentalDecorators: !!compilerOptions.experimentalDecorators,
      assignClassFields: typescript && !definesClassFields(compilerOptions),
      minifyWhitespace: !!options.minifyWhitespace,
      asciiOnly: options.charset !== 'utf8',
      legalComments: legal === 'inline',
      define,
    },
  };
}

function finishMap(map, options) {
  if (!map) return '';
  if (options.sourceRoot === undefined) return map;
  const json = JSON.parse(map);
  json.sourceRoot = options.sourceRoot;
  return JSON.stringify(json);
}

/** The whole transform, synchronously. Returns `undefined` when the real esbuild has to do it. */
function transformHere(input, options) {
  const start = performance.now();
  const plan = planTransform(options);
  if (!plan.native) { log('transform', 'fallback', start, { reason: plan.reason, sourcefile: options.sourcefile }); return undefined; }
  const source = typeof input === 'string' ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
  const result = oxc.transform(source, plan.native);
  if (result.status === 2) { log('transform', 'fallback', start, { reason: result.reason, sourcefile: options.sourcefile }); return undefined; }
  let lines;
  const sourceLines = () => lines ??= source.split(/\r\n|\r|\n/);
  const messages = result.messages.map(m => ({ error: m.error, message: toMessage(m, plan.native.sourcefile, sourceLines) }));
  const warnings = messages.filter(m => !m.error).map(m => m.message);
  if (result.status === 1) {
    log('transform', 'oxc', start, { sourcefile: options.sourcefile, failed: true });
    throw failure('Transform', messages.filter(m => m.error).map(m => m.message), warnings);
  }
  let code = result.code, map = finishMap(result.map, options);
  if (options.sourcemap === 'inline' || options.sourcemap === 'both') {
    code += `//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`;
    if (options.sourcemap === 'inline') map = '';
  }
  log('transform', 'oxc', start, { sourcefile: options.sourcefile, bytes: source.length });
  return { warnings, code, map, mangleCache: undefined, legalComments: undefined };
}

function transformSync(input, options = {}) {
  return transformHere(input, options) ?? fallback().transformSync(input, options);
}

function transform(input, options = {}) {
  try {
    const result = transformHere(input, options);
    return result ? Promise.resolve(result) : fallback().transform(input, options);
  } catch (error) {
    return Promise.reject(error);
  }
}

// ---------------------------------------------------------------- build

const NotHere = Symbol('not handled by the single-file build');
const EXTENSION_LOADERS = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx' };
// Options the single-file build understands; any other set option means real esbuild.
const BUILD_KNOWN = new Set(['absWorkingDir', 'entryPoints', 'write', 'target', 'platform', 'bundle', 'format', 'mainFields', 'sourcemap', 'sourceRoot',
  'metafile', 'define', 'plugins', 'logLevel', 'logLimit', 'color', 'charset', 'legalComments', 'supported', 'treeShaking', 'keepNames', 'external', 'jsx',
  'jsxDev', 'jsxFactory', 'jsxFragment', 'jsxImportSource', 'tsconfigRaw', 'minifyWhitespace', 'sourcesContent', 'preserveSymlinks', 'conditions', 'resolveExtensions', 'packages']);

let builtins;
function isNodeBuiltin(id) {
  builtins ??= new Set(require('module').builtinModules);
  return id.startsWith('node:') || builtins.has(id);
}

/** Compiler options of the nearest tsconfig.json, following relative `extends`. */
function nearestTsconfig(file) {
  const read = (configPath, depth) => {
    let config;
    try { config = parseJsonc(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
    let base = {};
    const parents = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const parent of parents) {
      // A package-provided base would need Node resolution; the real esbuild does that.
      if (typeof parent !== 'string' || !parent.startsWith('.') || depth > 8) throw NotHere;
      const target = path.resolve(path.dirname(configPath), parent);
      base = { ...base, ...read(fs.existsSync(target) ? target : target + '.json', depth + 1) };
    }
    return { ...base, ...config.compilerOptions };
  };
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'tsconfig.json');
    if (fs.existsSync(candidate)) return read(candidate, 0);
    if (path.dirname(directory) === directory) return {};
  }
}

/**
 * `build()` for one entry point whose imports are all external after the plugins' `onResolve`
 * (or are Node builtins on `platform: "node"`). The result is then just that module,
 * transformed, with its specifiers replaced by what the plugins returned. Throws `NotHere`
 * for anything else, before or after running plugin callbacks; callbacks are side-effect
 * free reads in the callers this exists for (Vite's `bundleConfigFile`).
 */
async function buildSingleFile(options) {
  for (const key of Object.keys(options)) if (!BUILD_KNOWN.has(key) && options[key] !== undefined) throw NotHere;
  const entries = options.entryPoints;
  if (!options.bundle || options.write !== false || !Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== 'string') throw NotHere;
  if (options.format !== 'esm' || isSet(options.external) || options.packages !== undefined) throw NotHere;
  if (options.sourcemap === 'linked' || options.sourcemap === 'external' || options.sourcemap === 'both') throw NotHere;
  const cwd = options.absWorkingDir ?? process.cwd();

  const resolvers = [], loaders = [], starts = [], ends = [];
  for (const plugin of options.plugins ?? []) {
    const filtered = (list, name) => (filter, callback) => list.push({ name, filter: filter.filter, namespace: filter.namespace, callback });
    const api = {
      initialOptions: options, esbuild: module.exports,
      onStart: callback => starts.push(callback), onEnd: callback => ends.push(callback), onDispose() {},
      onResolve: filtered(resolvers, plugin.name), onLoad: filtered(loaders, plugin.name),
      resolve() { throw NotHere; },
    };
    await plugin.setup(api);
  }
  for (const callback of starts) await callback();
  const matching = (list, args) => list.filter(entry => (entry.namespace ?? 'file') === args.namespace && entry.filter.test(args.path));
  const resolve = async args => {
    for (const entry of matching(resolvers, args)) {
      // A throwing or erroring callback is a build error; the real esbuild words it.
      let result;
      try { result = await entry.callback(args); } catch { throw NotHere; }
      if (result == null) continue;
      if (isSet(result.errors) || isSet(result.warnings) || result.namespace !== undefined && result.namespace !== 'file') throw NotHere;
      if (result.path !== undefined || result.external) return result;
    }
    return undefined;
  };

  const entryResult = await resolve({ path: entries[0], importer: '', namespace: 'file', resolveDir: cwd, kind: 'entry-point', pluginData: undefined, with: {} });
  if (entryResult?.external) throw NotHere;
  const entry = entryResult?.path ?? path.resolve(cwd, entries[0]);
  let loaded;
  for (const item of matching(loaders, { path: entry, namespace: 'file' })) {
    try { loaded = await item.callback({ path: entry, namespace: 'file', suffix: '', pluginData: entryResult?.pluginData, with: {} }); } catch { throw NotHere; }
    if (loaded != null) break;
  }
  if (loaded && (isSet(loaded.errors) || isSet(loaded.warnings))) throw NotHere;
  let contents = loaded?.contents, loader = loaded?.loader ?? EXTENSION_LOADERS[path.extname(entry)];
  if (contents === undefined) contents = fs.readFileSync(entry, 'utf8');
  if (typeof contents !== 'string') contents = Buffer.from(contents).toString('utf8');
  if (!NATIVE_LOADERS.has(loader)) throw NotHere;

  // esbuild reads the tsconfig that governs the file; a tsconfigRaw option replaces it.
  const transformOptions = {
    loader, sourcefile: path.relative(cwd, entry), sourcemap: options.sourcemap ? true : false, sourcesContent: options.sourcesContent, sourceRoot: options.sourceRoot,
    define: options.define, charset: options.charset, legalComments: options.legalComments === 'none' ? 'none' : 'inline', minifyWhitespace: options.minifyWhitespace,
    jsx: options.jsx, jsxDev: options.jsxDev, jsxFactory: options.jsxFactory, jsxFragment: options.jsxFragment, jsxImportSource: options.jsxImportSource,
    tsconfigRaw: options.tsconfigRaw ?? { compilerOptions: nearestTsconfig(entry) },
  };
  const plan = planTransform(transformOptions);
  if (!plan.native) throw NotHere;
  let result = oxc.transform(contents, { ...plan.native, collectImports: true });
  if (result.status !== 0) throw NotHere; // syntax errors included: the real esbuild reports them

  const rewrites = new Map(), imports = [];
  for (const found of result.imports) {
    let resolved = await resolve({ path: found.path, importer: entry, namespace: 'file', resolveDir: path.dirname(entry), kind: found.kind, pluginData: undefined, with: {} });
    if (!resolved && options.platform === 'node' && isNodeBuiltin(found.path)) resolved = { external: true };
    if (!resolved?.external) throw NotHere; // a module to bundle
    const final = resolved.path ?? found.path;
    if (final !== found.path) rewrites.set(found.path, final);
    imports.push({ path: final, kind: found.kind, external: true });
  }
  if (rewrites.size) {
    result = oxc.transform(contents, { ...plan.native, rewriteImports: [...rewrites] });
    if (result.status !== 0) throw NotHere;
  }

  const name = path.relative(cwd, entry).split(path.sep).join('/');
  let code = `// ${name}\n${result.code}`;
  if (options.sourcemap) {
    const map = JSON.parse(result.map);
    map.mappings = ';' + map.mappings; // the comment line above
    if (options.sourceRoot !== undefined) map.sourceRoot = options.sourceRoot;
    code += `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
  }
  const bytes = Buffer.from(code);
  const outName = name.replace(/\.[^./]+$/, '') + '.js';
  const output = {
    errors: [], warnings: [],
    outputFiles: [{ path: '<stdout>', contents: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), hash: '', get text() { return code; } }],
    metafile: !options.metafile ? undefined : {
      inputs: { [name]: { bytes: Buffer.byteLength(contents), imports, format: 'esm' } },
      outputs: { [outName]: { imports, exports: [], entryPoint: name, inputs: { [name]: { bytesInOutput: bytes.length } }, bytes: bytes.length } },
    },
    mangleCache: undefined,
  };
  for (const callback of ends) await callback(output);
  return output;
}

async function build(options = {}) {
  const start = performance.now();
  let result;
  try {
    result = await buildSingleFile(options);
  } catch (error) {
    if (error !== NotHere) throw error;
    log('build', 'fallback', start, { entryPoints: options.entryPoints });
    return fallback().build(options);
  }
  log('build', 'oxc', start, { entryPoints: options.entryPoints });
  return result;
}

function context(options = {}) {
  log('context', 'fallback', performance.now(), { entryPoints: options.entryPoints });
  return fallback().context(options);
}

// ---------------------------------------------------------------- the rest

const buildSync = options => fallback().buildSync(options);
const formatMessages = (messages, options) => new Promise(done => done(formatMessagesSync(messages, options)));
const analyzeMetafile = (metafile, options) => fallback().analyzeMetafile(metafile, options);
const analyzeMetafileSync = (metafile, options) => fallback().analyzeMetafileSync(metafile, options);
// Nothing to start: the Wasm module is instantiated by the first transform, and the real
// esbuild starts itself when something needs it.
const initialize = () => Promise.resolve();
const stop = () => real ? real.stop() : Promise.resolve();

module.exports = { analyzeMetafile, analyzeMetafileSync, build, buildSync, context, formatMessages, formatMessagesSync, initialize, stop, transform, transformSync, version };
