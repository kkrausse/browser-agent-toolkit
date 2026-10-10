// Host-side artefacts of the runtime, added to runtime/dist/ (run by
// runtime/build.ts, or alone: `bun runtime/src/host/build.ts`):
//
//   host.js       the module the toolkit imports (`bootRuntime`)
//   bat-netd.js   the bridge worker (preview requests, frame WebSockets, image download)
//   sw.js         the preview service worker (classic script)
//   kernel.wasm   the kernel build (newest of target-net, target-runtime, target-kernel)
//   sqlite3.wasm  node:sqlite's engine
//
// With the process runtime's files this makes runtime/dist/ the complete,
// self-contained asset directory: serve it as `<base>runtime/` beside the
// manifest (the toolkit's prepare step copies it there).
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dir
const root = join(here, '../../..')
const dist = join(here, '../../dist')
const minify = process.argv.includes('--minify')
mkdirSync(dist, { recursive: true })

async function bundle(entry: string, out: string, format: 'iife' | 'esm') {
  const t0 = performance.now()
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format, minify, sourcemap: 'none' })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    throw new Error(`build failed: ${out}`)
  }
  const text = await result.outputs[0].text()
  writeFileSync(join(dist, out), text)
  console.log(`${out.padEnd(22)} ${(text.length / 1024).toFixed(0).padStart(6)} KiB  ${(performance.now() - t0).toFixed(0)} ms`)
}

await bundle(join(here, 'host.ts'), 'host.js', 'esm')
await bundle(join(here, 'netd.ts'), 'bat-netd.js', 'esm')
await bundle(join(here, '../sw/sw.ts'), 'sw.js', 'iife')

const kernels = (process.env.BAT_KERNEL_WASM ? [process.env.BAT_KERNEL_WASM] : ['target-net', 'target-runtime', 'target-kernel'].map((t) => join(root, t, 'wasm32-wasip1-threads/release/bat_kernel.wasm')))
  .filter(existsSync)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
if (kernels[0]) {
  copyFileSync(kernels[0], join(dist, 'kernel.wasm'))
  console.log(`kernel.wasm            ${(statSync(kernels[0]).size / 1024).toFixed(0).padStart(6)} KiB  from ${kernels[0].slice(root.length + 1)}`)
} else console.warn('no kernel build found (crates/bat-kernel/build.sh); kernel.wasm not copied')
const sqlite = join(here, '../sqlite/sqlite3.wasm')
if (existsSync(sqlite)) copyFileSync(sqlite, join(dist, 'sqlite3.wasm'))
