// node:crypto on the native Wasm helper (crates/bat-node-native).
//
// Digests, HMAC, PBKDF2/HKDF/scrypt and AES (CBC, CTR, GCM) run in Rust behind
// integer handles. Randomness, `webcrypto` and `subtle` are the worker's own
// WebCrypto. Everything asymmetric is a function that throws
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM when called, so importing it is harmless.
//
// The hot path is `createHash(a).update(x).digest('hex')` (bundlers hash every
// module). Updates are not sent to Wasm one by one: bytes are copied straight
// into one scratch region of linear memory that the most recently updated
// digest owns, and `digest()` is then a single call over that region. Only
// when a second digest needs the scratch, or more than SCRATCH_LIMIT is
// pending, does the owner get a Rust-side state (a handle) to absorb them.
//
// This file also owns the shared Wasm instance (`nativeOf`), which zlib.ts
// imports.
import type { Runtime } from '../process/runtime'
import { registerBuiltin, unsupported } from './registry'

export interface NativeExports {
  memory: WebAssembly.Memory
  bat_alloc(length: number): number
  bat_free(pointer: number, length: number): void
  bat_hash_oneshot(alg: number, data: number, length: number, out: number): number
  bat_hmac_oneshot(alg: number, key: number, keyLength: number, data: number, length: number, out: number): number
  bat_hash_new(alg: number): number
  bat_hmac_new(alg: number, key: number, keyLength: number): number
  bat_hash_update(handle: number, data: number, length: number): void
  bat_hash_final(handle: number, out: number): number
  bat_hash_copy(handle: number): number
  bat_hash_free(handle: number): void
  bat_crc32(data: number, length: number, init: number): number
  bat_pbkdf2(alg: number, pw: number, pwLen: number, salt: number, saltLen: number, iterations: number, out: number, outLen: number): number
  bat_hkdf(alg: number, ikm: number, ikmLen: number, salt: number, saltLen: number, info: number, infoLen: number, out: number, outLen: number): number
  bat_scrypt(pw: number, pwLen: number, salt: number, saltLen: number, logN: number, r: number, p: number, out: number, outLen: number): number
  bat_cipher_new(mode: number, encrypt: number, key: number, keyLength: number, iv: number, ivLength: number): number
  bat_cipher_aad(handle: number, data: number, length: number): void
  bat_cipher_padding(handle: number, on: number): void
  bat_cipher_update(handle: number, data: number, length: number, out: number): number
  bat_cipher_final(handle: number, out: number, tag: number, tagLength: number): number
  bat_cipher_free(handle: number): void
  bat_z_new(mode: number, a: number, b: number, c: number, d: number): number
  bat_z_write(handle: number, input: number, inLength: number, out: number, outCap: number, flush: number): number
  bat_z_result(): number
  bat_z_reset(handle: number): void
  bat_z_free(handle: number): void
}

export interface Native {
  x: NativeExports
  /** Linear memory as bytes. Growing memory detaches it: take it again after every call into Wasm. */
  mem(): Uint8Array
  /** Run `fn` with each input copied into linear memory (pointers in order) plus `outLength` writable bytes; returns a copy of those. */
  call(inputs: Uint8Array[], outLength: number, fn: (pointers: number[], out: number) => void): Uint8Array
  /** Call `free` when `owner` is garbage collected (a stream or cipher dropped without being finished). */
  track(owner: object, free: () => void): void
  untrack(owner: object): void
}

const natives = new WeakMap<object, Native>()

/** The process's instance of the native helper, created on first use. */
export function nativeOf(rt: Runtime): Native {
  let native = natives.get(rt)
  if (native) return native
  const x = new WebAssembly.Instance(rt.wasmModule('native'), {}).exports as unknown as NativeExports
  let bytes = new Uint8Array(x.memory.buffer)
  const mem = () => (bytes.byteLength === 0 ? (bytes = new Uint8Array(x.memory.buffer)) : bytes)
  const registry = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<() => void>((free) => free()) : undefined
  native = {
    x,
    mem,
    call(inputs, outLength, fn) {
      let total = outLength
      for (const input of inputs) total += input.length
      const base = x.bat_alloc(total)
      try {
        const pointers: number[] = []
        let at = base
        const view = mem()
        for (const input of inputs) {
          view.set(input, at)
          pointers.push(at)
          at += input.length
        }
        fn(pointers, at)
        return mem().slice(at, at + outLength)
      } finally {
        x.bat_free(base, total)
      }
    },
    track: (owner, free) => registry?.register(owner, free, owner),
    untrack: (owner) => void registry?.unregister(owner),
  }
  natives.set(rt, native)
  return native
}

const HASHES = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-256']
const DIGEST_SIZE = [16, 20, 28, 32, 48, 64, 32]
/** Pending bytes a digest may keep in the scratch before they go to a Rust-side state. */
const SCRATCH_LIMIT = 1 << 20

const CBC = 0
const CTR = 1
const GCM = 2
const CIPHERS: Record<string, { mode: number; key: number; iv: number }> = {}
for (const bits of [128, 192, 256]) {
  CIPHERS[`aes-${bits}-cbc`] = { mode: CBC, key: bits / 8, iv: 16 }
  CIPHERS[`aes-${bits}-ctr`] = { mode: CTR, key: bits / 8, iv: 16 }
  CIPHERS[`aes-${bits}-gcm`] = { mode: GCM, key: bits / 8, iv: 12 }
}

const UNAVAILABLE = [
  'createSign', 'createVerify', 'sign', 'verify', 'Sign', 'Verify',
  'generateKeyPair', 'generateKeyPairSync', 'generateKey', 'generateKeySync',
  'publicEncrypt', 'publicDecrypt', 'privateEncrypt', 'privateDecrypt',
  'createPublicKey', 'createPrivateKey',
  'createECDH', 'ECDH', 'createDiffieHellman', 'createDiffieHellmanGroup', 'getDiffieHellman',
  'DiffieHellman', 'DiffieHellmanGroup', 'diffieHellman',
  'X509Certificate', 'Certificate',
  'generatePrime', 'generatePrimeSync', 'checkPrime', 'checkPrimeSync',
  'argon2', 'argon2Sync', 'encapsulate', 'decapsulate',
  'setEngine', 'setFips', 'secureHeapUsed',
]

const HEX: string[] = []
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16))

interface DigestState {
  alg: number
  /** HMAC key, until a Rust-side state exists. */
  key: Uint8Array | null
  /** Rust-side state, 0 while everything pending is still in the scratch. */
  handle: number
  /** Bytes of this digest in the scratch; non-zero only for the scratch owner. */
  used: number
  done: boolean
}

function coded<E extends Error>(error: E, code: string): E {
  ;(error as E & { code: string }).code = code
  return error
}

function argType(name: string, expected: string, value: unknown): TypeError {
  const got = value === null ? 'null' : typeof value === 'object' ? `an instance of ${(value as object).constructor?.name ?? 'Object'}` : `type ${typeof value} (${String(value)})`
  return coded(new TypeError(`The "${name}" argument must be ${expected}. Received ${got}`), 'ERR_INVALID_ARG_TYPE')
}

function createCrypto(rt: Runtime): any {
  const { Buffer } = rt.require('buffer')
  const stream = rt.require('stream')
  const webcrypto: Crypto = rt.host?.global?.crypto ?? (globalThis as any).crypto
  const encoder = new TextEncoder()

  let cached: Native | undefined
  const native = (): Native => cached ?? (cached = nativeOf(rt))

  const kState = Symbol('kState')

  // ---------------------------------------------------------------- arguments

  const asBytes = (value: any, name: string, encoding?: string): Uint8Array => {
    if (typeof value === 'string') return Buffer.from(value, encoding === 'buffer' ? 'utf8' : encoding)
    if (value instanceof Uint8Array) return value
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) return new Uint8Array(value)
    throw argType(name, 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView', value)
  }

  const keyBytes = (key: any, name = 'key', encoding?: string): Uint8Array => (key instanceof KeyObject ? (key as any)[kState] : asBytes(key, name, encoding))

  const algIds = new Map<string, number>()
  const lookupAlg = (name: unknown): number => {
    let id = algIds.get(name as string)
    if (id !== undefined) return id
    if (typeof name !== 'string') throw argType('algorithm', 'of type string', name)
    const plain = name.toLowerCase().replace(/^rsa-/, '').replace(/^sha-/, 'sha').replace('sha512/256', 'sha512-256')
    id = HASHES.indexOf(plain)
    if (id >= 0) algIds.set(name, id)
    return id
  }
  const algId = (name: unknown): number => {
    const id = lookupAlg(name)
    if (id < 0) throw coded(new Error('Digest method not supported'), 'ERR_OSSL_EVP_UNSUPPORTED')
    return id
  }
  const digestId = (name: unknown): number => {
    const id = lookupAlg(name)
    if (id < 0) throw coded(new TypeError(`Invalid digest: ${name}`), 'ERR_CRYPTO_INVALID_DIGEST')
    return id
  }

  const uint = (value: unknown, name: string, min: number, max: number): number => {
    if (typeof value !== 'number') throw argType(name, 'of type number', value)
    if (!Number.isInteger(value) || value < min || value > max) {
      throw coded(new RangeError(`The value of "${name}" is out of range. It must be >= ${min} && <= ${max}. Received ${value}`), 'ERR_OUT_OF_RANGE')
    }
    return value
  }

  const callback = (cb: unknown, name = 'callback'): ((...a: any[]) => void) => {
    if (typeof cb !== 'function') throw argType(name, 'of type function', cb)
    return cb as (...a: any[]) => void
  }

  /** Run `work` in a later turn and hand its result or its throw to `cb`. */
  const later = (cb: (...a: any[]) => void, work: () => unknown): void => {
    rt.loop.defer(() => {
      let value: unknown
      try {
        value = work()
      } catch (error) {
        return cb(error)
      }
      cb(null, value)
    })
  }

  const encoded = (bytes: any, encoding?: string): any => (encoding && encoding !== 'buffer' ? bytes.toString(encoding) : bytes)

  // ------------------------------------------------------------------ digests

  let scratchPointer = 0
  let scratchCapacity = 0
  let scratchOwner: DigestState | null = null
  let outPointer = 0

  /** Make the scratch at least `need` bytes, keeping the owner's pending bytes. */
  const reserve = (need: number): void => {
    if (need <= scratchCapacity) return
    const { x, mem } = native()
    const capacity = Math.max(need, scratchCapacity * 2, 1 << 16)
    const pointer = x.bat_alloc(capacity)
    if (scratchCapacity) {
      if (scratchOwner?.used) mem().copyWithin(pointer, scratchPointer, scratchPointer + scratchOwner.used)
      x.bat_free(scratchPointer, scratchCapacity)
    }
    scratchPointer = pointer
    scratchCapacity = capacity
  }

  /** Give `state` a Rust-side state and move its pending scratch bytes into it. */
  const spill = (state: DigestState): void => {
    const n = native()
    if (!state.handle) {
      if (state.key) {
        const key = state.key
        n.call([key], 0, ([pointer]) => (state.handle = n.x.bat_hmac_new(state.alg, pointer, key.length)))
        state.key = null
      } else {
        state.handle = n.x.bat_hash_new(state.alg)
      }
      const handle = state.handle
      n.track(state, () => n.x.bat_hash_free(handle))
    }
    if (state.used) {
      n.x.bat_hash_update(state.handle, scratchPointer, state.used)
      state.used = 0
    }
  }

  const own = (state: DigestState): void => {
    if (scratchOwner === state) return
    if (scratchOwner?.used) spill(scratchOwner)
    scratchOwner = state
  }

  const feed = (state: DigestState, data: Uint8Array): void => {
    const length = data.length
    if (length === 0) return
    own(state)
    if (state.used + length > SCRATCH_LIMIT) {
      spill(state)
      if (length > SCRATCH_LIMIT) {
        const { x, mem } = native()
        reserve(SCRATCH_LIMIT)
        for (let at = 0; at < length; at += SCRATCH_LIMIT) {
          const part = data.subarray(at, Math.min(at + SCRATCH_LIMIT, length))
          mem().set(part, scratchPointer)
          x.bat_hash_update(state.handle, scratchPointer, part.length)
        }
        return
      }
    }
    reserve(state.used + length)
    native().mem().set(data, scratchPointer + state.used)
    state.used += length
  }

  const feedText = (state: DigestState, text: string): void => {
    // Worst case three bytes per UTF-16 unit; encodeInto writes into the scratch without an intermediate buffer.
    const room = text.length * 3
    const used = scratchOwner === state ? state.used : 0
    if (used + room > SCRATCH_LIMIT) return feed(state, Buffer.from(text, 'utf8'))
    if (room === 0) return
    own(state)
    reserve(used + room)
    const at = scratchPointer + used
    state.used = used + encoder.encodeInto(text, native().mem().subarray(at, at + room)).written
  }

  const update = (state: DigestState, data: unknown, encoding?: string): void => {
    if (state.done) throw coded(new Error('Digest already called'), 'ERR_CRYPTO_HASH_FINALIZED')
    if (typeof data === 'string') {
      if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8' || encoding === 'buffer') feedText(state, data)
      else feed(state, Buffer.from(data, encoding))
    } else if (data instanceof Uint8Array) {
      feed(state, data)
    } else if (ArrayBuffer.isView(data)) {
      feed(state, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    } else {
      throw argType('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data)
    }
  }

  /** Finish `state`; the digest is then at `outPointer`. Returns its length. */
  const finish = (state: DigestState): number => {
    const { x, mem, untrack } = native()
    if (!outPointer) outPointer = x.bat_alloc(64)
    let length: number
    if (state.handle) {
      spill(state)
      length = x.bat_hash_final(state.handle, outPointer)
      untrack(state)
      state.handle = 0
    } else if (state.key) {
      // One call: the key goes behind the pending data in the scratch.
      const key = state.key
      own(state)
      reserve(state.used + key.length)
      mem().set(key, scratchPointer + state.used)
      length = x.bat_hmac_oneshot(state.alg, scratchPointer + state.used, key.length, scratchPointer, state.used, outPointer)
    } else {
      length = x.bat_hash_oneshot(state.alg, scratchPointer, scratchOwner === state ? state.used : 0, outPointer)
    }
    if (scratchOwner === state) scratchOwner = null
    state.used = 0
    state.done = true
    return length
  }

  const output = (length: number, encoding?: string): any => {
    const view = native().mem()
    if (encoding === 'hex') {
      let text = ''
      for (let i = outPointer, end = outPointer + length; i < end; i++) text += HEX[view[i]]
      return text
    }
    return encoded(Buffer.from(view.subarray(outPointer, outPointer + length)), encoding)
  }

  const newState = (alg: number, key: Uint8Array | null): DigestState => ({ alg, key, handle: 0, used: 0, done: false })

  // `Hash`, `Hmac` and the ciphers are Transform streams in Node, but nearly
  // every caller only uses update/digest. As in Node, the stream state is set
  // up on first access to it, so a plain `createHash()` does not pay for it.
  function LazyTransform(this: any, options?: unknown) {
    this._options = options
  }
  Object.setPrototypeOf(LazyTransform.prototype, stream.Transform.prototype)
  Object.setPrototypeOf(LazyTransform, stream.Transform)
  for (const name of ['_readableState', '_writableState']) {
    Object.defineProperty(LazyTransform.prototype, name, {
      configurable: true,
      enumerable: true,
      get(this: any) {
        stream.Transform.call(this, this._options)
        // Strings reach _transform as strings with their encoding, as update() expects.
        this._writableState.decodeStrings = false
        return this[name]
      },
      set(this: any, value: unknown) {
        Object.defineProperty(this, name, { value, enumerable: true, configurable: true, writable: true })
      },
    })
  }

  function Hash(this: any, algorithm: unknown, options?: unknown): any {
    if (!(this instanceof Hash)) return new (Hash as any)(algorithm, options)
    ;(this as any)[kState] = newState(algId(algorithm), null)
    LazyTransform.call(this, options)
  }
  Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype)
  Object.setPrototypeOf(Hash, LazyTransform)
  Hash.prototype.update = function (data: unknown, encoding?: string) {
    update(this[kState], data, encoding)
    return this
  }
  Hash.prototype.digest = function (encoding?: string) {
    const state: DigestState = this[kState]
    if (state.done) throw coded(new Error('Digest already called'), 'ERR_CRYPTO_HASH_FINALIZED')
    return output(finish(state), encoding)
  }
  Hash.prototype.copy = function (options?: unknown) {
    const state: DigestState = this[kState]
    if (state.done) throw coded(new Error('Digest already called'), 'ERR_CRYPTO_HASH_FINALIZED')
    const copy = Object.create(Hash.prototype)
    const next = newState(state.alg, null)
    if (state.handle || state.used) {
      spill(state)
      const n = native()
      const handle = (next.handle = n.x.bat_hash_copy(state.handle))
      n.track(next, () => n.x.bat_hash_free(handle))
    }
    copy[kState] = next
    LazyTransform.call(copy, options)
    return copy
  }
  Hash.prototype._transform = function (chunk: unknown, encoding: string, done: (error?: unknown) => void) {
    update(this[kState], chunk, encoding)
    done()
  }
  Hash.prototype._flush = function (done: (error?: unknown) => void) {
    this.push(this.digest())
    done()
  }

  function Hmac(this: any, algorithm: unknown, key: unknown, options?: any): any {
    if (!(this instanceof Hmac)) return new (Hmac as any)(algorithm, key, options)
    const id = algId(algorithm)
    // The key is copied: the caller may reuse its buffer before digest().
    ;(this as any)[kState] = newState(id, Uint8Array.from(keyBytes(key, 'key', options?.encoding)))
    LazyTransform.call(this, options)
  }
  Object.setPrototypeOf(Hmac.prototype, LazyTransform.prototype)
  Object.setPrototypeOf(Hmac, LazyTransform)
  Hmac.prototype.update = Hash.prototype.update
  Hmac.prototype.digest = function (encoding?: string) {
    const state: DigestState = this[kState]
    // Node returns an empty result for a second digest() on an Hmac.
    if (state.done) return encoded(Buffer.alloc(0), encoding)
    return output(finish(state), encoding)
  }
  Hmac.prototype._transform = Hash.prototype._transform
  Hmac.prototype._flush = Hash.prototype._flush

  const hash = (algorithm: unknown, data: unknown, outputEncoding: string = 'hex'): any => {
    const state = newState(algId(algorithm), null)
    update(state, data)
    return output(finish(state), outputEncoding)
  }

  // --------------------------------------------------------------- randomness

  const fillRandom = (bytes: Uint8Array): void => {
    for (let at = 0; at < bytes.length; at += 65536) webcrypto.getRandomValues(bytes.subarray(at, at + 65536))
  }

  const randomBytes = (size: unknown, cb?: unknown): any => {
    const bytes = Buffer.alloc(uint(size, 'size', 0, 2 ** 31 - 1))
    if (cb === undefined) {
      fillRandom(bytes)
      return bytes
    }
    later(callback(cb), () => (fillRandom(bytes), bytes))
  }

  const randomRange = (buffer: any, offset: unknown = 0, size?: unknown): Uint8Array => {
    if (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) throw argType('buf', 'an instance of ArrayBuffer, Buffer, TypedArray, or DataView', buffer)
    const all = asBytes(buffer, 'buf')
    const start = uint(offset, 'offset', 0, all.length)
    return all.subarray(start, start + (size === undefined ? all.length - start : uint(size, 'size', 0, all.length - start)))
  }

  const randomFillSync = (buffer: any, offset?: unknown, size?: unknown): any => {
    fillRandom(randomRange(buffer, offset, size))
    return buffer
  }

  const randomFill = (buffer: any, ...rest: unknown[]): void => {
    const cb = callback(rest.pop())
    const range = randomRange(buffer, rest[0] as any, rest[1] as any)
    later(cb, () => (fillRandom(range), buffer))
  }

  const randomInt = (...args: unknown[]): any => {
    const cb = typeof args[args.length - 1] === 'function' ? callback(args.pop()) : undefined
    const max = args.pop() as number
    const min = args.length ? (args[0] as number) : 0
    if (!Number.isSafeInteger(min)) throw argType('min', 'a safe integer', min)
    if (!Number.isSafeInteger(max)) throw argType('max', 'a safe integer', max)
    const range = max - min
    if (!(range > 0)) {
      throw coded(new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`), 'ERR_OUT_OF_RANGE')
    }
    if (range > 2 ** 48 - 1) {
      throw coded(new RangeError(`The value of "max - min" is out of range. It must be <= ${2 ** 48 - 1}. Received ${range}`), 'ERR_OUT_OF_RANGE')
    }
    // Rejection sampling over 48 random bits, so every value is equally likely.
    const limit = 2 ** 48 - (2 ** 48 % range)
    const draw = (): number => {
      const bytes = new Uint8Array(6)
      for (;;) {
        webcrypto.getRandomValues(bytes)
        const value = ((bytes[0] << 8) | bytes[1]) * 2 ** 32 + (((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0)
        if (value < limit) return (value % range) + min
      }
    }
    if (!cb) return draw()
    later(cb, draw)
  }

  const randomUUID = (): string => {
    if (typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID()
    const b = webcrypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    let s = ''
    for (let i = 0; i < 16; i++) s += (i === 4 || i === 6 || i === 8 || i === 10 ? '-' : '') + HEX[b[i]]
    return s
  }

  const timingSafeEqual = (a: unknown, b: unknown): boolean => {
    const x = asBytes(typeof a === 'string' ? undefined : a, 'buf1')
    const y = asBytes(typeof b === 'string' ? undefined : b, 'buf2')
    if (x.length !== y.length) throw coded(new RangeError('Input buffers must have the same byte length'), 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH')
    let diff = 0
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
    return diff === 0
  }

  // ----------------------------------------------------------- key derivation

  const derive = (inputs: Uint8Array[], length: number, fn: (x: NativeExports, pointers: number[], out: number) => number): any => {
    const n = native()
    let status = 0
    const bytes = n.call(inputs, length, (pointers, out) => (status = fn(n.x, pointers, out)))
    if (status !== 0) throw coded(new Error('Key derivation failed'), 'ERR_CRYPTO_OPERATION_FAILED')
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  const pbkdf2Job = (password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown): (() => any) => {
    if (typeof digest !== 'string') throw argType('digest', 'of type string', digest)
    const alg = digestId(digest)
    const pw = Uint8Array.from(keyBytes(password, 'password'))
    const s = Uint8Array.from(asBytes(salt, 'salt'))
    const rounds = uint(iterations, 'iterations', 1, 2 ** 31 - 1)
    const length = uint(keylen, 'keylen', 0, 2 ** 31 - 1)
    return () => derive([pw, s], length, (x, [p, q], out) => x.bat_pbkdf2(alg, p, pw.length, q, s.length, rounds, out, length))
  }
  const pbkdf2Sync = (password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown): any =>
    pbkdf2Job(password, salt, iterations, keylen, digest)()
  const pbkdf2 = (password: unknown, salt: unknown, iterations: unknown, keylen: unknown, digest: unknown, cb: unknown): void => {
    if (typeof digest === 'function') throw argType('digest', 'of type string', digest)
    later(callback(cb), pbkdf2Job(password, salt, iterations, keylen, digest))
  }

  const scryptJob = (password: unknown, salt: unknown, keylen: unknown, options: any = {}): (() => any) => {
    const pw = Uint8Array.from(keyBytes(password, 'password'))
    const s = Uint8Array.from(asBytes(salt, 'salt'))
    const length = uint(keylen, 'keylen', 0, 2 ** 31 - 1)
    const N = options.N ?? options.cost ?? 16384
    const r = options.r ?? options.blockSize ?? 8
    const p = options.p ?? options.parallelization ?? 1
    const maxmem = options.maxmem ?? 32 * 1024 * 1024
    const logN = Math.log2(N)
    const bad = (why: string) => coded(new RangeError(`Invalid scrypt params: ${why}`), 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS')
    if (!Number.isInteger(logN) || logN < 1 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw bad('N must be a power of two above 1, r and p positive integers')
    if (128 * N * r > maxmem) throw bad('memory limit exceeded')
    return () => (length === 0 ? Buffer.alloc(0) : derive([pw, s], length, (x, [a, b], out) => x.bat_scrypt(a, pw.length, b, s.length, logN, r, p, out, length)))
  }
  const scryptSync = (password: unknown, salt: unknown, keylen: unknown, options?: unknown): any => scryptJob(password, salt, keylen, options)()
  const scrypt = (password: unknown, salt: unknown, keylen: unknown, options: unknown, cb?: unknown): void => {
    if (typeof options === 'function') [options, cb] = [undefined, options]
    later(callback(cb), scryptJob(password, salt, keylen, options))
  }

  const hkdfJob = (digest: unknown, ikm: unknown, salt: unknown, info: unknown, keylen: unknown): (() => ArrayBuffer) => {
    if (typeof digest !== 'string') throw argType('digest', 'of type string', digest)
    const alg = digestId(digest)
    const key = Uint8Array.from(keyBytes(ikm, 'ikm'))
    const s = Uint8Array.from(asBytes(salt, 'salt'))
    const i = Uint8Array.from(asBytes(info, 'info'))
    const length = uint(keylen, 'length', 0, 2 ** 31 - 1)
    if (length > 255 * DIGEST_SIZE[alg]) throw coded(new RangeError('Invalid key length'), 'ERR_CRYPTO_INVALID_KEYLEN')
    return () => {
      const out = derive([key, s, i], length, (x, [a, b, c], o) => x.bat_hkdf(alg, a, key.length, b, s.length, c, i.length, o, length))
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
    }
  }
  const hkdfSync = (digest: unknown, ikm: unknown, salt: unknown, info: unknown, keylen: unknown): ArrayBuffer => hkdfJob(digest, ikm, salt, info, keylen)()
  const hkdf = (digest: unknown, ikm: unknown, salt: unknown, info: unknown, keylen: unknown, cb: unknown): void => {
    later(callback(cb), hkdfJob(digest, ikm, salt, info, keylen))
  }

  // ------------------------------------------------------------- secret keys

  function KeyObject(this: any, type: unknown, bytes: Uint8Array): any {
    if (type !== 'secret') throw coded(new Error('crypto.KeyObject: only secret keys are available in this runtime'), 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')
    this[kState] = bytes
  }
  Object.defineProperties(KeyObject.prototype, {
    type: { get: () => 'secret', enumerable: true, configurable: true },
    symmetricKeySize: {
      get(this: any) {
        return this[kState].length
      },
      enumerable: true,
      configurable: true,
    },
  })
  KeyObject.prototype.export = function (options?: { format?: string }) {
    const bytes = Buffer.from(this[kState])
    return options?.format === 'jwk' ? { kty: 'oct', k: bytes.toString('base64url') } : bytes
  }
  KeyObject.prototype.equals = function (other: any) {
    if (!(other instanceof KeyObject)) throw argType('otherKeyObject', 'an instance of KeyObject', other)
    const a: Uint8Array = this[kState]
    const b: Uint8Array = (other as any)[kState]
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const createSecretKey = (key: unknown, encoding?: string): any => new (KeyObject as any)('secret', Uint8Array.from(asBytes(key, 'key', encoding)))

  // ------------------------------------------------------------------ ciphers

  interface CipherState {
    handle: number
    mode: number
    encrypt: boolean
    tag: Uint8Array | null
    tagLength: number
    decoder: any
  }

  const cipherInfo = (name: unknown) => {
    const info = typeof name === 'string' ? CIPHERS[name.toLowerCase()] : undefined
    if (!info) throw coded(new TypeError(typeof name === 'string' ? 'Unknown cipher' : 'The "cipher" argument must be of type string'), typeof name === 'string' ? 'ERR_CRYPTO_UNKNOWN_CIPHER' : 'ERR_INVALID_ARG_TYPE')
    return info
  }

  const openCipher = (self: any, encrypt: boolean, name: unknown, key: unknown, iv: unknown, options?: any): void => {
    const info = cipherInfo(name)
    const k = keyBytes(key)
    if (k.length !== info.key) throw coded(new RangeError('Invalid key length'), 'ERR_CRYPTO_INVALID_KEYLEN')
    const v = iv === null ? new Uint8Array(0) : asBytes(iv, 'iv')
    if (info.mode === GCM ? v.length === 0 : v.length !== info.iv) throw coded(new TypeError('Invalid initialization vector'), 'ERR_CRYPTO_INVALID_IV')
    const tagLength = options?.authTagLength ?? 16
    if (info.mode === GCM && !(Number.isInteger(tagLength) && tagLength >= 4 && tagLength <= 16)) {
      throw coded(new TypeError(`Invalid authentication tag length: ${tagLength}`), 'ERR_CRYPTO_INVALID_AUTH_TAG')
    }
    const n = native()
    let handle = 0
    n.call([k, v], 0, ([kp, vp]) => (handle = n.x.bat_cipher_new(info.mode, encrypt ? 1 : 0, kp, k.length, vp, v.length)))
    const state: CipherState = { handle, mode: info.mode, encrypt, tag: null, tagLength, decoder: null }
    n.track(state, () => n.x.bat_cipher_free(handle))
    self[kState] = state
    LazyTransform.call(self, options)
  }

  const live = (self: any, what: string): CipherState => {
    const state: CipherState = self[kState]
    if (!state.handle) throw coded(new Error(`Invalid state for operation ${what}`), 'ERR_CRYPTO_INVALID_STATE')
    return state
  }

  /** Bytes as the caller asked for them; a text encoding goes through a StringDecoder so characters may span calls. */
  const cipherOutput = (state: CipherState, bytes: Uint8Array, encoding: string | undefined, last: boolean): any => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (!encoding || encoding === 'buffer') return buffer
    state.decoder ??= new (rt.require('string_decoder').StringDecoder)(encoding)
    return last ? state.decoder.end(buffer) : state.decoder.write(buffer)
  }

  const cipherMethods = {
    update(this: any, data: unknown, inputEncoding?: string, outputEncoding?: string) {
      const state = live(this, 'update')
      const input = asBytes(data, 'data', inputEncoding)
      const n = native()
      let written = 0
      const out = n.call([input], input.length + 16, ([pointer], o) => (written = n.x.bat_cipher_update(state.handle, pointer, input.length, o)))
      return cipherOutput(state, out.subarray(0, written), outputEncoding, false)
    },
    final(this: any, outputEncoding?: string) {
      const state = live(this, 'final')
      const n = native()
      const gcm = state.mode === GCM
      if (gcm && !state.encrypt && !state.tag) throw coded(new Error('Unsupported state or unable to authenticate data'), 'ERR_CRYPTO_INVALID_STATE')
      const tag = gcm && !state.encrypt ? state.tag! : new Uint8Array(16)
      let status = 0
      // Layout of the call's memory: tag, then 16 bytes for the last block.
      const out = n.call([tag], 16, ([tagPointer], o) => {
        status = n.x.bat_cipher_final(state.handle, o, tagPointer, tag.length)
        if (gcm && state.encrypt) state.tag = n.mem().slice(tagPointer, tagPointer + state.tagLength)
      })
      n.x.bat_cipher_free(state.handle)
      n.untrack(state)
      state.handle = 0
      if (status === -2) throw coded(new Error('error:1C80006B:Provider routines::wrong final block length'), 'ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH')
      if (status < 0) {
        throw gcm
          ? new Error('Unsupported state or unable to authenticate data')
          : coded(new Error('error:1C800064:Provider routines::bad decrypt'), 'ERR_OSSL_BAD_DECRYPT')
      }
      return cipherOutput(state, out.subarray(0, status), outputEncoding, true)
    },
    setAAD(this: any, data: unknown, _options?: unknown) {
      const state = live(this, 'setAAD')
      const aad = asBytes(data, 'buffer')
      const n = native()
      n.call([aad], 0, ([pointer]) => n.x.bat_cipher_aad(state.handle, pointer, aad.length))
      return this
    },
    getAuthTag(this: any) {
      const state: CipherState = this[kState]
      if (!state.encrypt || state.handle || !state.tag) throw coded(new Error('Invalid state for operation getAuthTag'), 'ERR_CRYPTO_INVALID_STATE')
      return Buffer.from(state.tag)
    },
    setAuthTag(this: any, tag: unknown, encoding?: string) {
      const state = live(this, 'setAuthTag')
      const bytes = Uint8Array.from(asBytes(tag, 'buffer', encoding))
      if (state.encrypt || state.mode !== GCM) throw coded(new Error('Invalid state for operation setAuthTag'), 'ERR_CRYPTO_INVALID_STATE')
      if (bytes.length < 4 || bytes.length > 16) throw coded(new TypeError(`Invalid authentication tag length: ${bytes.length}`), 'ERR_CRYPTO_INVALID_AUTH_TAG')
      state.tag = bytes
      return this
    },
    setAutoPadding(this: any, on: unknown = true) {
      const state = live(this, 'setAutoPadding')
      native().x.bat_cipher_padding(state.handle, on ? 1 : 0)
      return this
    },
    _transform(this: any, chunk: unknown, encoding: string, done: (error?: unknown) => void) {
      this.push(this.update(chunk, encoding))
      done()
    },
    _flush(this: any, done: (error?: unknown) => void) {
      try {
        this.push(this.final())
      } catch (error) {
        return done(error)
      }
      done()
    },
  }

  function Cipheriv(this: any, cipher: unknown, key: unknown, iv: unknown, options?: unknown): any {
    if (!(this instanceof Cipheriv)) return new (Cipheriv as any)(cipher, key, iv, options)
    openCipher(this, true, cipher, key, iv, options)
  }
  function Decipheriv(this: any, cipher: unknown, key: unknown, iv: unknown, options?: unknown): any {
    if (!(this instanceof Decipheriv)) return new (Decipheriv as any)(cipher, key, iv, options)
    openCipher(this, false, cipher, key, iv, options)
  }
  for (const ctor of [Cipheriv, Decipheriv]) {
    Object.setPrototypeOf(ctor.prototype, LazyTransform.prototype)
    Object.setPrototypeOf(ctor, LazyTransform)
    for (const [name, value] of Object.entries(cipherMethods)) {
      Object.defineProperty(ctor.prototype, name, { value, writable: true, configurable: true })
    }
  }

  const getCipherInfo = (name: unknown): any => {
    const info = typeof name === 'string' ? CIPHERS[name.toLowerCase()] : undefined
    if (!info) return undefined
    const mode = ['cbc', 'ctr', 'gcm'][info.mode]
    return { name: (name as string).toLowerCase(), mode, keyLength: info.key, ivLength: info.iv, ...(info.mode === CBC ? { blockSize: 16 } : {}) }
  }

  // ------------------------------------------------------------------ exports

  const exports: any = {
    createHash: (algorithm: unknown, options?: unknown) => new (Hash as any)(algorithm, options),
    createHmac: (algorithm: unknown, key: unknown, options?: unknown) => new (Hmac as any)(algorithm, key, options),
    hash,
    getHashes: () => [...HASHES.map((name) => `RSA-${name.toUpperCase().replace('SHA512-256', 'SHA512/256')}`), ...HASHES],
    Hash,
    Hmac,
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync,
    randomFill,
    randomInt,
    randomUUID,
    getRandomValues: (array: any) => webcrypto.getRandomValues(array),
    timingSafeEqual,
    pbkdf2,
    pbkdf2Sync,
    scrypt,
    scryptSync,
    hkdf,
    hkdfSync,
    createCipheriv: (cipher: unknown, key: unknown, iv: unknown, options?: unknown) => new (Cipheriv as any)(cipher, key, iv, options),
    createDecipheriv: (cipher: unknown, key: unknown, iv: unknown, options?: unknown) => new (Decipheriv as any)(cipher, key, iv, options),
    Cipheriv,
    Decipheriv,
    getCiphers: () => Object.keys(CIPHERS),
    getCipherInfo,
    KeyObject,
    createSecretKey,
    getCurves: () => [],
    getFips: () => 0,
    constants: {},
  }
  Object.defineProperties(exports, {
    webcrypto: { get: () => webcrypto, enumerable: true, configurable: true },
    subtle: { get: () => webcrypto.subtle, enumerable: true, configurable: true },
  })
  for (const name of UNAVAILABLE) {
    const stub = function () {
      unsupported('crypto', name)
    }
    Object.defineProperty(stub, 'name', { value: name })
    exports[name] = stub
  }
  return exports
}

registerBuiltin('crypto', createCrypto)
