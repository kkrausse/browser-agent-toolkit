// Builds the runtime's browser artefacts into runtime/dist/:
//
//   bat-process.js      process worker (classic script): kernel binding, event
//                       loop, loader, builtins written in TypeScript
//   bat-nodelib.js      Node's own lib (third_party/node), one lazy factory per
//                       module, loaded with importScripts
//   bat-harness.js      the harness page's script
//   bat-kerneld.js      the supervisor worker (runtime/src/kernel/kerneld.ts)
//   bat_modules.wasm    module transform       (crates/bat-modules)
//   bat_node_native.wasm  zlib and digests     (crates/bat-node-native)
//   bat_sh.wasm         /bin/sh and coreutils  (crates/bat-sh)
//
//   bun runtime/build.ts [--watch-none] [--minify]
//
// Builtins from other parts of the tree are picked up automatically: every
// `runtime/src/<dir>/builtins.ts` is imported into the process bundle after
// runtime/src/node/index.ts, so its `registerBuiltin` calls replace the
// placeholders for `net`, `http`, `https` and `sqlite`.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const src = join(import.meta.dir, 'src')
const dist = join(import.meta.dir, 'dist')
const gen = join(dist, '.gen')
const minify = process.argv.includes('--minify')
mkdirSync(gen, { recursive: true })

// ---- process worker entry ----
const extras: string[] = []
for (const name of ['crypto', 'zlib']) if (existsSync(join(src, 'node', `${name}.ts`))) extras.push(join(src, 'node', `${name}.ts`))
for (const dir of readdirSync(src)) {
  const file = join(src, dir, 'builtins.ts')
  if (dir !== 'node' && existsSync(file)) extras.push(file)
}
const rel = (from: string, to: string) => {
  const r = relative(from, to).replace(/\.ts$/, '')
  return r.startsWith('.') ? r : `./${r}`
}
writeFileSync(
  join(gen, 'process-entry.ts'),
  [`import ${JSON.stringify(rel(gen, join(src, 'node/index.ts')))}`, ...extras.map((f) => `import ${JSON.stringify(rel(gen, f))}`), `import ${JSON.stringify(rel(gen, join(src, 'process/worker.ts')))}`, ''].join('\n'),
)

// ---- Node lib entry: one factory per vendored file ----
const lib = join(root, 'third_party/node')
const ids: [string, string][] = []
const walk = (dir: string) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) {
      const r = relative(lib, p).replace(/\.js$/, '')
      if (r.startsWith('lib/')) ids.push([r.slice(4), p])
      else if (r.startsWith('internal/')) ids.push([r, p])
    }
  }
}
walk(join(lib, 'lib'))
walk(join(lib, 'internal'))
const lines = [
  `import { primordials } from ${JSON.stringify(join(lib, 'primordials.js'))}`,
  `import { createBufferBinding } from ${JSON.stringify(join(lib, 'bindings/buffer.js'))}`,
  `import { UV_CODES, errname, getErrorMap } from ${JSON.stringify(join(lib, 'bindings/uv-errors.js'))}`,
  `import { OS_SIGNALS, OS_ERRNO, OS_PRIORITY, OS_DLOPEN, UV_UDP_REUSEADDR, FS_CONSTANTS, CRYPTO_CONSTANTS } from ${JSON.stringify(join(lib, 'bindings/constants.js'))}`,
  ...ids.map(([, p], i) => `import f${i} from ${JSON.stringify(p)}`),
  `globalThis.__bat_nodelib({`,
  `  primordials, createBufferBinding,`,
  `  uv: { ...UV_CODES, errname, getErrorMap },`,
  `  constants: { os: { signals: OS_SIGNALS, errno: OS_ERRNO, priority: OS_PRIORITY, dlopen: OS_DLOPEN, UV_UDP_REUSEADDR }, fs: FS_CONSTANTS, crypto: CRYPTO_CONSTANTS },`,
  `  factories: { __proto__: null, ${ids.map(([id], i) => `${JSON.stringify(id)}: f${i}`).join(', ')} },`,
  `})`,
  '',
]
writeFileSync(join(gen, 'nodelib-entry.js'), lines.join('\n'))

async function bundle(entry: string, out: string, format: 'iife' | 'esm') {
  const t0 = performance.now()
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format, minify, sourcemap: 'none' })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    throw new Error(`build failed: ${out}`)
  }
  const text = `${await result.outputs[0].text()}\n//# sourceURL=bat:///${out}\n`
  writeFileSync(join(dist, out), text)
  console.log(`${out.padEnd(22)} ${(text.length / 1024).toFixed(0).padStart(6)} KiB  ${(performance.now() - t0).toFixed(0)} ms`)
}

await bundle(join(gen, 'process-entry.ts'), 'bat-process.js', 'iife')
await bundle(join(gen, 'nodelib-entry.js'), 'bat-nodelib.js', 'iife')
await bundle(join(src, 'kernel/kerneld.ts'), 'bat-kerneld.js', 'esm')
if (existsSync(join(import.meta.dir, 'harness/page.ts'))) await bundle(join(import.meta.dir, 'harness/page.ts'), 'bat-harness.js', 'esm')

for (const [from, to] of [
  ['crates/bat-modules/js/bat_modules.wasm', 'bat_modules.wasm'],
  ['crates/bat-node-native/js/bat_node_native.wasm', 'bat_node_native.wasm'],
  ['crates/bat-sh/js/bat_sh.wasm', 'bat_sh.wasm'],
]) {
  if (existsSync(join(root, from))) copyFileSync(join(root, from), join(dist, to))
  else console.warn(`missing ${from} (build it first); ${to} not copied`)
}
