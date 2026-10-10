// The module transform (crates/bat-modules, Wasm) for files that were not
// compiled at prepare time: workspace sources in the overlay, `-e` scripts,
// `module._compile`, `vm`. Instantiated synchronously on first use. Results
// are cached by content hash in a non-persistent overlay directory, so a
// second process (or a restart of the dev server) reads the function body
// instead of parsing the source again.
import { decodeFacts, type Facts } from '../../../crates/bat-modules/js/facts'
import type { Runtime } from '../process/runtime'

export interface Compiled {
  code: string
  facts: Facts
}

export interface TransformOptions {
  packageType?: 'module' | 'commonjs'
  forceKind?: 'cjs' | 'esm'
  /** Replacement for `import(` in code that has no `__bat` in scope. */
  dynamicImport?: string
}

interface Exports {
  memory: WebAssembly.Memory
  bat_alloc(length: number): number
  bat_free(pointer: number, length: number): void
  bat_transform(src: number, srcLen: number, name: number, nameLen: number, opts: number, optsLen: number): number
  bat_result_free(result: number): void
}

export interface Transformer {
  /** Transform source text. Throws SyntaxError with the first diagnostic. */
  transform(source: Uint8Array | string, filename: string, options?: TransformOptions): Compiled
  stats: { transforms: number; cacheHits: number; ms: number; bytes: number; instantiateMs: number }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 53-bit string hash of bytes (cyrb53): cache file names. */
function hash(bytes: Uint8Array, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

export function createTransformer(rt: Runtime): Transformer {
  const kernel = rt.kernel
  const stats = { transforms: 0, cacheHits: 0, ms: 0, bytes: 0, instantiateMs: 0 }
  let wasm: Exports | undefined
  let cacheReady = false
  const cacheDir = `${rt.config.cacheDir}/modules`

  function instance(): Exports {
    if (!wasm) {
      const t0 = performance.now()
      wasm = new WebAssembly.Instance(rt.wasmModule('modules'), {}).exports as unknown as Exports
      stats.instantiateMs = performance.now() - t0
    }
    return wasm
  }

  function encodeOptions(o: TransformOptions): Uint8Array {
    let flags = 0
    if (o.packageType === 'commonjs') flags |= 1
    if (o.packageType === 'module') flags |= 2
    if (o.forceKind) flags |= (o.forceKind === 'cjs' ? 1 : 2) << 2
    const dyn = encoder.encode(o.dynamicImport ?? '')
    const bytes = new Uint8Array(4 + 4 * 4 + dyn.length)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, flags, true)
    // jsxImportSource, jsxFactory, jsxFragmentFactory: defaults (empty strings)
    view.setUint32(16, dyn.length, true)
    bytes.set(dyn, 20)
    return bytes
  }

  function run(src: Uint8Array, filename: string, options: TransformOptions): { word: number; blob: Uint8Array; code: Uint8Array } {
    const w = instance()
    const put = (bytes: Uint8Array): number => {
      const p = w.bat_alloc(bytes.length || 1)
      new Uint8Array(w.memory.buffer, p, bytes.length).set(bytes)
      return p
    }
    const name = encoder.encode(filename)
    const opts = encodeOptions(options)
    const srcP = put(src)
    const nameP = put(name)
    const optsP = put(opts)
    let result = 0
    try {
      result = w.bat_transform(srcP, src.length, nameP, name.length, optsP, opts.length)
      const buffer = w.memory.buffer
      const h = new Uint32Array(buffer, result, 10)
      if (h[0] !== 1) {
        const lines = decoder.decode(new Uint8Array(buffer, h[8], h[9])).split('\n')
        const first = lines.find((l) => l.startsWith('E')) ?? lines[0] ?? 'E\t0\t0\ttransform failed'
        const [, line, column, ...message] = first.split('\t')
        const e = new SyntaxError(`${message.join('\t')}\n    at ${filename}:${line}:${column}`)
        throw e
      }
      return {
        word: h[1],
        code: new Uint8Array(buffer, h[2], h[3]).slice(),
        blob: new Uint8Array(buffer, h[4], h[5]).slice(),
      }
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) wasm = undefined // the Rust side aborted: start over next time
      throw e
    } finally {
      if (wasm === w) {
        if (result) w.bat_result_free(result)
        w.bat_free(srcP, src.length || 1)
        w.bat_free(nameP, name.length || 1)
        w.bat_free(optsP, opts.length || 1)
      }
    }
  }

  function transform(source: Uint8Array | string, filename: string, options: TransformOptions = {}): Compiled {
    const src = typeof source === 'string' ? encoder.encode(source) : source
    // The extension decides how the file is parsed, so it is part of the key.
    const dot = filename.lastIndexOf('.')
    const ext = dot > filename.lastIndexOf('/') ? filename.slice(dot + 1) : ''
    const seed = (options.packageType === 'module' ? 1 : options.packageType === 'commonjs' ? 2 : 0) | (options.forceKind === 'cjs' ? 4 : options.forceKind === 'esm' ? 8 : 0)
    const key = `${cacheDir}/${hash(src, seed)}-${src.length.toString(36)}${options.dynamicImport ? 'd' : ''}.${ext || 'js'}`
    const cached = src.length >= 256 ? kernel.tryReadFile(key) : undefined
    if (cached && cached.length >= 8) {
      const dv = new DataView(cached.buffer, cached.byteOffset, cached.byteLength)
      const word = dv.getUint32(0, true)
      const blobLen = dv.getUint32(4, true)
      stats.cacheHits++
      return { facts: decodeFacts(word, cached.subarray(8, 8 + blobLen)), code: decoder.decode(cached.subarray(8 + blobLen)) }
    }
    const t0 = performance.now()
    const out = run(src, filename, options)
    stats.ms += performance.now() - t0
    stats.transforms++
    stats.bytes += src.length
    if (src.length >= 256) {
      try {
        if (!cacheReady) {
          kernel.mkdir(cacheDir, { recursive: true })
          cacheReady = true
        }
        const file = new Uint8Array(8 + out.blob.length + out.code.length)
        const dv = new DataView(file.buffer)
        dv.setUint32(0, out.word, true)
        dv.setUint32(4, out.blob.length, true)
        file.set(out.blob, 8)
        file.set(out.code, 8 + out.blob.length)
        kernel.writeFile(key, file)
      } catch {
        // A cache that cannot be written is only slower.
      }
    }
    return { facts: decodeFacts(out.word, out.blob), code: decoder.decode(out.code) }
  }

  return { transform, stats }
}
