// node:zlib on the native Wasm helper (crates/bat-node-native): deflate, zlib
// and gzip through flate2/miniz_oxide, brotli through the brotli crate.
//
// One engine (a Rust stream handle plus an output buffer in linear memory)
// backs all three forms: the *Sync functions, the callback functions (the same
// work, delivered from a later loop turn) and the Transform stream classes.
// Compression is synchronous inside a write, so a stream's output for a chunk
// is pushed before that chunk's callback runs.
//
// Not implemented: zstd (the exports are absent), preset dictionaries,
// `windowBits`/`memLevel`/`strategy` (accepted and ignored: miniz_oxide always
// uses a 32 KiB window, which also reads every smaller one), and `params()`
// changing the level mid-stream.
import type { Runtime } from '../process/runtime'
import { nativeOf, type Native } from './crypto'
import { registerBuiltin } from './registry'

// Engine modes, as bat_z_new takes them.
const DEFLATE = 0
const INFLATE = 1
const GZIP = 2
const GUNZIP = 3
const DEFLATE_RAW = 4
const INFLATE_RAW = 5
const UNZIP = 6
const BROTLI_ENCODE = 7
const BROTLI_DECODE = 8

const isBrotli = (mode: number): boolean => mode >= BROTLI_ENCODE
const isEncoder = (mode: number): boolean => mode === DEFLATE || mode === GZIP || mode === DEFLATE_RAW || mode === BROTLI_ENCODE

/** Output buffer for the one-shot functions, where the stream's chunk size is not observable. */
const ONE_SHOT_CHUNK = 128 * 1024

const constants: Record<string, number> = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, ZLIB_VERNUM: 4880,
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
  BROTLI_DECODE: 8, BROTLI_ENCODE: 9,
  Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0,
  BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1, BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5, BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7, BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11, BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13, BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15, BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19, BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21, BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27, BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,
}

const CODE_NAMES = ['Z_OK', 'Z_STREAM_END', 'Z_NEED_DICT', 'Z_ERRNO', 'Z_STREAM_ERROR', 'Z_DATA_ERROR', 'Z_MEM_ERROR', 'Z_BUF_ERROR', 'Z_VERSION_ERROR']

interface Config {
  /** Deflate level 0-9; unused by decoders and brotli. */
  level: number
  chunkSize: number
  /** Flush mode of an ordinary write. */
  flush: number
  /** Flush mode at end of input. */
  finishFlush: number
  /** What a bare `stream.flush()` uses. */
  fullFlush: number
  /** The value of `finishFlush` that means "the input is complete". */
  finish: number
  maxOutputLength: number
  /** Brotli encoder: quality, lgwin, mode, size hint. */
  brotli: [number, number, number, number]
}

interface Engine {
  mode: number
  handle: number
  out: number
  outCap: number
  /** The flush value that means "the input is complete" (Z_FINISH or BROTLI_OPERATION_FINISH). */
  finish: number
  /** Input bytes consumed so far. */
  bytesWritten: number
  /** The last write left the stream complete. */
  ended: boolean
}

function coded<E extends Error>(error: E, code: string, errno?: number): E {
  ;(error as any).code = code
  if (errno !== undefined) (error as any).errno = errno
  return error
}

function outOfRange(name: string, range: string, value: unknown): RangeError {
  return coded(new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${value}`), 'ERR_OUT_OF_RANGE')
}

function createZlib(rt: Runtime): any {
  const { Buffer, kMaxLength } = rt.require('buffer')
  const stream = rt.require('stream')
  const { Transform } = stream
  const C = constants

  let cached: Native | undefined
  const native = (): Native => cached ?? (cached = nativeOf(rt))

  const toBytes = (value: any): Uint8Array => {
    if (typeof value === 'string') return Buffer.from(value)
    if (value instanceof Uint8Array) return value
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    const got = value === null ? 'null' : typeof value === 'object' ? `an instance of ${value.constructor?.name ?? 'Object'}` : `type ${typeof value} (${String(value)})`
    throw coded(new TypeError(`The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer. Received ${got}`), 'ERR_INVALID_ARG_TYPE')
  }

  const integer = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw coded(new TypeError(`The "${name}" property must be of type number. Received ${typeof value}`), 'ERR_INVALID_ARG_TYPE')
    }
    if (value < min || value > max) throw outOfRange(name, `>= ${min} and <= ${max}`, value)
    return Math.floor(value)
  }

  const configure = (mode: number, options: any): Config => {
    const o = options ?? {}
    const chunkSize = integer(o.chunkSize, 'options.chunkSize', C.Z_MIN_CHUNK, Infinity, C.Z_DEFAULT_CHUNK)
    const maxOutputLength = integer(o.maxOutputLength, 'options.maxOutputLength', 1, kMaxLength ?? 2 ** 32, kMaxLength ?? 2 ** 32)
    if (isBrotli(mode)) {
      const params = o.params ?? {}
      return {
        level: 0,
        chunkSize,
        flush: integer(o.flush, 'options.flush', 0, 3, C.BROTLI_OPERATION_PROCESS),
        finishFlush: integer(o.finishFlush, 'options.finishFlush', 0, 3, C.BROTLI_OPERATION_FINISH),
        fullFlush: C.BROTLI_OPERATION_FLUSH,
        finish: C.BROTLI_OPERATION_FINISH,
        maxOutputLength,
        brotli: [
          integer(params[C.BROTLI_PARAM_QUALITY], 'options.params[BROTLI_PARAM_QUALITY]', 0, 11, C.BROTLI_DEFAULT_QUALITY),
          integer(params[C.BROTLI_PARAM_LGWIN], 'options.params[BROTLI_PARAM_LGWIN]', 10, 24, C.BROTLI_DEFAULT_WINDOW),
          integer(params[C.BROTLI_PARAM_MODE], 'options.params[BROTLI_PARAM_MODE]', 0, 2, C.BROTLI_DEFAULT_MODE),
          integer(params[C.BROTLI_PARAM_SIZE_HINT], 'options.params[BROTLI_PARAM_SIZE_HINT]', 0, 2 ** 32 - 1, 0),
        ],
      }
    }
    const level = integer(o.level, 'options.level', C.Z_MIN_LEVEL, C.Z_MAX_LEVEL, C.Z_DEFAULT_LEVEL)
    return {
      level: level === C.Z_DEFAULT_COMPRESSION ? 6 : level,
      chunkSize,
      flush: integer(o.flush, 'options.flush', C.Z_NO_FLUSH, C.Z_BLOCK, C.Z_NO_FLUSH),
      finishFlush: integer(o.finishFlush, 'options.finishFlush', C.Z_NO_FLUSH, C.Z_BLOCK, C.Z_FINISH),
      fullFlush: C.Z_FULL_FLUSH,
      finish: C.Z_FINISH,
      maxOutputLength,
      brotli: [0, 0, 0, 0],
    }
  }

  // ------------------------------------------------------------------- engine

  const open = (mode: number, config: Config, outCap: number): Engine => {
    const { x } = native()
    const [a, b, c, d] = isBrotli(mode) ? config.brotli : [config.level, 0, 0, 0]
    return { mode, handle: x.bat_z_new(mode, a, b, c, d), out: x.bat_alloc(outCap), outCap, finish: config.finish, bytesWritten: 0, ended: false }
  }

  const close = (engine: Engine): void => {
    if (!engine.handle) return
    const { x } = native()
    x.bat_z_free(engine.handle)
    x.bat_free(engine.out, engine.outCap)
    engine.handle = 0
  }

  const failure = (engine: Engine, detail: number, brotliCode: number): Error => {
    if (engine.mode === BROTLI_ENCODE) return coded(new Error('Compression failed'), 'ERR_BROTLI_COMPRESS_FAILED', -1)
    if (engine.mode === BROTLI_DECODE) {
      // Node's code is the decoder's error name: BROTLI_DECODER_ERROR_FORMAT_PADDING_1 -> ERR__ERROR_FORMAT_PADDING_1.
      const name = Object.keys(C).find((key) => key.startsWith('BROTLI_DECODER_ERROR_') && C[key] === brotliCode)
      return coded(new Error('Decompression failed'), name ? `ERR_${name.slice('BROTLI_DECODER'.length)}` : 'ERR_BROTLI_DECOMPRESSION_FAILED', brotliCode)
    }
    // 1 header, 2 deflate data, 3 gzip CRC, 4 gzip length (z.rs E_*).
    const message = ['', 'incorrect header check', 'invalid compressed data', 'incorrect data check', 'incorrect length check'][detail] ?? 'invalid compressed data'
    return coded(new Error(message), 'Z_DATA_ERROR', C.Z_DATA_ERROR)
  }

  const truncated = (): Error => coded(new Error('unexpected end of file'), 'Z_BUF_ERROR', C.Z_BUF_ERROR)

  /** Feed all of `input` with `flush`, handing each piece of output (a fresh Buffer) to `sink`. */
  const pump = (engine: Engine, input: Uint8Array, flush: number, sink: (chunk: any) => void): void => {
    const n = native()
    const { x } = n
    const length = input.length
    const base = length ? x.bat_alloc(length) : 0
    try {
      if (length) n.mem().set(input, base)
      const finishing = isEncoder(engine.mode) && flush === engine.finish
      let at = 0
      let stalled = 0
      for (;;) {
        const status = x.bat_z_write(engine.handle, base + at, length - at, engine.out, engine.outCap, flush)
        const view = n.mem()
        const result = new Int32Array(view.buffer, x.bat_z_result(), 4)
        const consumed = result[0]
        const produced = result[1]
        if (status < 0) throw failure(engine, result[2], result[3])
        at += consumed
        engine.bytesWritten += consumed
        engine.ended = status === 1
        if (produced) sink(Buffer.from(view.subarray(engine.out, engine.out + produced)))
        if (at < length) {
          // No progress with input left cannot happen; stop rather than spin.
          if (!consumed && !produced) break
          continue
        }
        // Input is used up. A full output buffer may be hiding more; a finishing encoder runs until it reports the end.
        if (produced === engine.outCap) continue
        if (finishing && status !== 1 && (produced || ++stalled < 3)) continue
        break
      }
    } finally {
      if (length) x.bat_free(base, length)
    }
  }

  const runSync = (mode: number, data: unknown, options: any): any => {
    const input = toBytes(data)
    const config = configure(mode, options)
    const engine = open(mode, config, Math.max(config.chunkSize, ONE_SHOT_CHUNK))
    const chunks: any[] = []
    let total = 0
    try {
      pump(engine, input, config.finishFlush, (chunk) => {
        total += chunk.length
        if (total > config.maxOutputLength) {
          throw coded(new RangeError(`Cannot create a Buffer larger than ${config.maxOutputLength} bytes`), 'ERR_BUFFER_TOO_LARGE')
        }
        chunks.push(chunk)
      })
      if (!isEncoder(mode) && config.finishFlush === config.finish && !engine.ended) throw truncated()
    } finally {
      close(engine)
    }
    const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
    return options?.info ? { buffer, engine: undefined } : buffer
  }

  const runAsync = (mode: number, data: unknown, options: any, cb: any): void => {
    if (typeof options === 'function') [options, cb] = [undefined, options]
    if (typeof cb !== 'function') throw coded(new TypeError('The "callback" argument must be of type function'), 'ERR_INVALID_ARG_TYPE')
    const input = toBytes(data)
    rt.loop.defer(() => {
      let result: unknown
      try {
        result = runSync(mode, input, options)
      } catch (error) {
        return cb(error)
      }
      cb(null, result)
    })
  }

  // ------------------------------------------------------------------ streams

  const kConfig = Symbol('kConfig')
  const kEngine = Symbol('kEngine')
  /** Empty chunks that carry a flush request through the writable queue, so it stays ordered with writes. */
  const flushMarks = new WeakMap<object, number>()
  const flushChunks = new Map<number, any>()
  const flushChunk = (kind: number): any => {
    let chunk = flushChunks.get(kind)
    if (!chunk) {
      chunk = Buffer.alloc(0)
      flushMarks.set(chunk, kind)
      flushChunks.set(kind, chunk)
    }
    return chunk
  }

  function ZlibBase(this: any, mode: number, options: any) {
    const config = configure(mode, options)
    Transform.call(this, { autoDestroy: true, ...options })
    this[kConfig] = config
    this[kEngine] = { mode, handle: 0, out: 0, outCap: config.chunkSize, finish: config.finish, bytesWritten: 0, ended: false } as Engine
    this.bytesWritten = 0
    this._closed = false
  }
  Object.setPrototypeOf(ZlibBase.prototype, Transform.prototype)
  Object.setPrototypeOf(ZlibBase, Transform)

  /** The stream's engine, created on the first write. */
  const engineOf = (self: any): Engine => {
    const engine: Engine = self[kEngine]
    if (!engine.handle) {
      Object.assign(engine, open(engine.mode, self[kConfig], engine.outCap), { bytesWritten: engine.bytesWritten })
      const n = native()
      const { handle, out, outCap } = engine
      n.track(self, () => (n.x.bat_z_free(handle), n.x.bat_free(out, outCap)))
    }
    return engine
  }

  const release = (self: any): void => {
    self._closed = true
    const engine: Engine = self[kEngine]
    if (!engine.handle) return
    native().untrack(self)
    close(engine)
  }

  /** `last` is the write made when the writable side ends. */
  const streamWrite = (self: any, chunk: Uint8Array, flush: number, last: boolean): void => {
    const engine = engineOf(self)
    try {
      pump(engine, chunk, flush, (piece) => self.push(piece))
    } finally {
      self.bytesWritten = engine.bytesWritten
    }
    if (last && !isEncoder(engine.mode) && flush === engine.finish && !engine.ended) throw truncated()
  }

  Object.defineProperty(ZlibBase.prototype, 'bytesRead', {
    configurable: true,
    enumerable: true,
    get(this: any) {
      return this.bytesWritten
    },
    set(this: any, value: number) {
      this.bytesWritten = value
    },
  })
  ZlibBase.prototype._transform = function (chunk: any, _encoding: string, done: (error?: unknown) => void) {
    if (this._closed) return done()
    const mark = flushMarks.get(chunk)
    try {
      streamWrite(this, toBytes(chunk), mark ?? this[kConfig].flush, false)
    } catch (error) {
      return done(error)
    }
    done()
  }
  ZlibBase.prototype._flush = function (done: (error?: unknown) => void) {
    if (this._closed) return done()
    try {
      streamWrite(this, new Uint8Array(0), this[kConfig].finishFlush, true)
    } catch (error) {
      return done(error)
    }
    done()
  }
  ZlibBase.prototype.flush = function (kind?: any, cb?: any) {
    if (typeof kind === 'function' || (kind === undefined && !cb)) [kind, cb] = [this[kConfig].fullFlush, kind]
    if (this.writableFinished) {
      if (cb) rt.loop.nextTick(cb)
    } else if (this.writableEnded) {
      if (cb) this.once('end', cb)
    } else {
      this.write(flushChunk(kind), '', cb)
    }
  }
  ZlibBase.prototype.close = function (cb?: any) {
    if (cb) stream.finished(this, cb)
    this.destroy()
  }
  ZlibBase.prototype._destroy = function (error: unknown, done: (error?: unknown) => void) {
    release(this)
    done(error)
  }
  ZlibBase.prototype.reset = function () {
    const engine: Engine = this[kEngine]
    if (engine.handle) native().x.bat_z_reset(engine.handle)
    engine.ended = false
  }
  // The level cannot change mid-stream here; the call is accepted and the data stays valid.
  ZlibBase.prototype.params = function (_level: number, _strategy: number, cb?: any) {
    if (cb) rt.loop.nextTick(cb)
  }

  const streamClass = (name: string, mode: number): any => {
    const ctor = function (this: any, options?: any): any {
      if (!(this instanceof ctor)) return new (ctor as any)(options)
      ZlibBase.call(this, mode, options)
    }
    Object.defineProperty(ctor, 'name', { value: name })
    Object.setPrototypeOf(ctor.prototype, ZlibBase.prototype)
    Object.setPrototypeOf(ctor, ZlibBase)
    return ctor
  }

  // ------------------------------------------------------------------ exports

  const crc32 = (data: unknown, value: number = 0): number => {
    const input = toBytes(data)
    const n = native()
    let crc = 0
    n.call([input], 0, ([pointer]) => (crc = n.x.bat_crc32(pointer, input.length, value >>> 0)))
    return crc >>> 0
  }

  const codes: Record<string, number | string> = {}
  for (const name of CODE_NAMES) {
    codes[name] = constants[name]
    codes[constants[name]] = name
  }

  const exports: any = { crc32, constants: Object.freeze({ ...constants }), codes: Object.freeze(codes) }
  const kinds: [string, number][] = [
    ['Deflate', DEFLATE], ['Inflate', INFLATE], ['Gzip', GZIP], ['Gunzip', GUNZIP], ['DeflateRaw', DEFLATE_RAW],
    ['InflateRaw', INFLATE_RAW], ['Unzip', UNZIP], ['BrotliCompress', BROTLI_ENCODE], ['BrotliDecompress', BROTLI_DECODE],
  ]
  for (const [name, mode] of kinds) {
    const ctor = streamClass(name, mode)
    // `gzip`, `gzipSync`, `createGzip`, `Gzip`; `brotliCompress`, ...
    const lower = name[0].toLowerCase() + name.slice(1)
    exports[name] = ctor
    exports[`create${name}`] = (options?: any) => new ctor(options)
    exports[lower] = (data: unknown, options: any, cb: any) => runAsync(mode, data, options, cb)
    exports[`${lower}Sync`] = (data: unknown, options?: any) => runSync(mode, data, options)
  }
  // The deprecated top-level copies of the non-brotli constants.
  for (const [name, value] of Object.entries(constants)) {
    if (!name.startsWith('BROTLI')) Object.defineProperty(exports, name, { value, enumerable: false, writable: false, configurable: false })
  }
  return exports
}

registerBuiltin('zlib', createZlib)
