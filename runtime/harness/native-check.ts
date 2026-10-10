// Checks runtime/src/node/{zlib,crypto}.ts against the host's node:zlib and
// node:crypto on the same inputs, with a mock Runtime, then measures a few
// throughputs. A script, not a test suite:
//
//   crates/bat-node-native/build-wasm.sh
//   bun runtime/harness/native-check.ts            # reference: Bun's node:* modules
//   bun build runtime/harness/native-check.ts --target node --outfile /tmp/native-check.mjs \
//     && BAT_NATIVE_WASM=$PWD/crates/bat-node-native/js/bat_node_native.wasm node /tmp/native-check.mjs
//
// Flags: --no-bench skips the measurements, --verbose lists every check.
// Exits 1 when any check fails.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../src/node/crypto'
import '../src/node/zlib'
import { factories } from '../src/node/registry'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const wasmPath = process.env.BAT_NATIVE_WASM ?? join(repo, 'crates/bat-node-native/js/bat_node_native.wasm')
const wasmBytes = readFileSync(wasmPath)

let compiled: WebAssembly.Module | undefined
const rt: any = {
  require: (id: string) => require('node:' + id.replace(/^node:/, '')),
  loop: { nextTick: process.nextTick, defer: (fn: () => void) => void setImmediate(fn) },
  wasmModule: () => (compiled ??= new WebAssembly.Module(wasmBytes)),
}

const zlib = factories.get('zlib')!.factory(rt)
const crypto = factories.get('crypto')!.factory(rt)
const refZlib = require('node:zlib')
const refCrypto = require('node:crypto')
const stream = require('node:stream')

// ---------------------------------------------------------------- bookkeeping

const verbose = process.argv.includes('--verbose')
const groups = new Map<string, { pass: number; fail: string[] }>()
const pending: Promise<void>[] = []

function record(group: string, name: string, error?: unknown): void {
  let g = groups.get(group)
  if (!g) groups.set(group, (g = { pass: 0, fail: [] }))
  if (error === undefined) g.pass++
  else g.fail.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  if (verbose) console.log(`${error === undefined ? 'ok  ' : 'FAIL'} ${group} / ${name}`)
}

function check(group: string, name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result instanceof Promise) {
      const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timed out')), 60000).unref())
      pending.push(Promise.race([result, timeout]).then(() => record(group, name), (error) => record(group, name, error)))
    } else {
      record(group, name)
    }
  } catch (error) {
    record(group, name, error)
  }
}

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `<${value.length} bytes ${Buffer.from(value.subarray(0, 12)).toString('hex')}${value.length > 12 ? '..' : ''}>`
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return text.length > 80 ? text.slice(0, 80) + '..' : text
}

function eq(actual: unknown, expected: unknown, what = 'value'): void {
  const same =
    actual instanceof Uint8Array && expected instanceof Uint8Array
      ? Buffer.compare(actual, expected) === 0
      : actual instanceof ArrayBuffer && expected instanceof ArrayBuffer
        ? Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0
        : actual === expected
  if (!same) throw new Error(`${what}: got ${show(actual)}, expected ${show(expected)}`)
}

function ok(condition: unknown, what: string): void {
  if (!condition) throw new Error(what)
}

/** The error a function throws, or undefined. */
function thrown(fn: () => unknown): any {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

/** Both implementations fail the same way (compared by `code`), or neither does. */
function sameFailure(mine: () => unknown, theirs: () => unknown, what: string): void {
  const [a, b] = [thrown(mine), thrown(theirs)]
  ok(!!a === !!b, `${what}: ${a ? 'mine threw ' + a.message : 'mine did not throw'}, reference ${b ? 'threw ' + b.message : 'did not throw'}`)
  if (a) eq(a.code, b.code, `${what} error code`)
}

const call = <T>(fn: (cb: (error: unknown, value: T) => void) => void): Promise<T> =>
  new Promise((done, fail) => fn((error, value) => (error ? fail(error) : done(value))))

/** Write `chunks` to a stream, end it, and collect what it emits. */
function through(s: any, chunks: Uint8Array[], between?: (s: any, index: number) => void): Promise<Buffer> {
  return new Promise((done, fail) => {
    const out: Buffer[] = []
    s.on('data', (chunk: Buffer) => out.push(chunk))
    s.on('error', fail)
    s.on('end', () => done(Buffer.concat(out)))
    chunks.forEach((chunk, index) => {
      s.write(chunk)
      between?.(s, index)
    })
    s.end()
  })
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (let at = 0; at < data.length; at += size) parts.push(data.subarray(at, at + size))
  return parts
}

// --------------------------------------------------------------------- inputs

/** A few MB of JavaScript source: TypeScript's compiler when installed, else this repo's sources repeated. */
function javascriptText(bytes: number): Buffer {
  const candidates: string[] = []
  const bunStore = join(repo, 'node_modules/.bun')
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) if (entry.startsWith('typescript@')) candidates.push(join(bunStore, entry, 'node_modules/typescript/lib/typescript.js'))
  }
  candidates.push(join(repo, 'node_modules/typescript/lib/typescript.js'))
  for (const path of candidates) if (existsSync(path) && statSync(path).size >= bytes) return readFileSync(path).subarray(0, bytes)
  const own = Buffer.concat(['crypto.ts', 'zlib.ts', 'registry.ts'].map((name) => readFileSync(join(repo, 'runtime/src/node', name))))
  const parts: Buffer[] = []
  for (let size = 0, i = 0; size < bytes; size += own.length, i++) parts.push(Buffer.from(own.toString().replaceAll('state', 'state' + i)))
  return Buffer.concat(parts).subarray(0, bytes)
}

function pseudoRandom(bytes: number, seed = 1): Buffer {
  const out = Buffer.alloc(bytes)
  let x = seed >>> 0 || 1
  for (let i = 0; i < bytes; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x
  }
  return out
}

const js = javascriptText(4 << 20)
const oneMB = js.subarray(0, 1 << 20)
const threeMB = js.subarray(0, 3 << 20)
const noise = pseudoRandom(100_000)
const short = Buffer.from('The quick brown fox jumps over the lazy dog — ünïcödé ✓')
const inputs: [string, Buffer][] = [
  ['empty', Buffer.alloc(0)],
  ['short', short],
  ['1 MB', oneMB],
  ['3 MB', threeMB],
]

// --------------------------------------------------------------------- crypto

const ALGS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-256']

for (const alg of ALGS) {
  for (const [label, data] of inputs) {
    check('digest', `${alg} ${label}`, () => {
      eq(crypto.createHash(alg).update(data).digest('hex'), refCrypto.createHash(alg).update(data).digest('hex'))
    })
  }
  check('digest', `${alg} encodings`, () => {
    for (const encoding of ['hex', 'base64', 'base64url', 'latin1', 'binary', undefined, 'buffer']) {
      const mine = crypto.createHash(alg).update(short).digest(encoding)
      const theirs = refCrypto.createHash(alg).update(short).digest(encoding === 'buffer' ? undefined : encoding)
      eq(mine, theirs, String(encoding))
      ok(encoding && encoding !== 'buffer' ? typeof mine === 'string' : Buffer.isBuffer(mine), `${encoding} result type`)
    }
  })
  check('digest', `${alg} incremental`, () => {
    // Odd-sized pieces, strings and buffers mixed, two digests interleaved so the scratch changes owner.
    const a = crypto.createHash(alg)
    const b = crypto.createHash(alg)
    const refA = refCrypto.createHash(alg)
    const refB = refCrypto.createHash(alg)
    let at = 0
    for (let i = 0; at < threeMB.length; i++) {
      const size = [1, 63, 64, 65, 1000, 70_000, 1_200_000][i % 7]
      const piece = threeMB.subarray(at, at + size)
      at += size
      a.update(piece)
      refA.update(piece)
      if (i % 3 === 0) {
        b.update(`text ${i} ✓`).update('6869', 'hex')
        refB.update(`text ${i} ✓`).update('6869', 'hex')
      }
    }
    eq(a.digest('hex'), refA.digest('hex'), 'a')
    eq(b.digest('base64'), refB.digest('base64'), 'b')
  })
  check('digest', `${alg} copy`, () => {
    const mine = crypto.createHash(alg).update('one')
    const theirs = refCrypto.createHash(alg).update('one')
    const [mineCopy, theirsCopy] = [mine.copy(), theirs.copy()]
    eq(mine.update('two').digest('hex'), theirs.update('two').digest('hex'), 'original')
    eq(mineCopy.update('three').digest('hex'), theirsCopy.update('three').digest('hex'), 'copy')
    eq(crypto.createHash(alg).copy().digest('hex'), refCrypto.createHash(alg).digest('hex'), 'copy of fresh')
  })
  for (const [label, key] of [['short key', Buffer.from('key')], ['200-byte key', pseudoRandom(200, 7)], ['empty key', Buffer.alloc(0)]] as [string, Buffer][]) {
    check('hmac', `${alg} ${label}`, () => {
      for (const [, data] of inputs.slice(0, 3)) {
        eq(crypto.createHmac(alg, key).update(data).digest('hex'), refCrypto.createHmac(alg, key).update(data).digest('hex'))
      }
      const mine = crypto.createHmac(alg, key)
      const theirs = refCrypto.createHmac(alg, key)
      for (const piece of split(threeMB, 700_001)) {
        mine.update(piece).update('x')
        theirs.update(piece).update('x')
        crypto.createHash('md5').update('steal the scratch').digest()
      }
      eq(mine.digest(), theirs.digest(), 'incremental')
    })
  }
}

check('digest', 'update copies its input', () => {
  const buffer = Buffer.from('first')
  const hash = crypto.createHash('sha256').update(buffer)
  buffer.write('XXXXX')
  eq(hash.digest('hex'), refCrypto.createHash('sha256').update('first').digest('hex'))
})
check('digest', 'aliases and typed arrays', () => {
  const expected = refCrypto.createHash('sha256').update(short).digest('hex')
  for (const name of ['SHA256', 'RSA-SHA256', 'Sha256']) eq(crypto.createHash(name).update(short).digest('hex'), expected, name)
  const words = new Uint16Array([1, 2, 3, 4])
  eq(crypto.createHash('sha1').update(words).digest('hex'), refCrypto.createHash('sha1').update(words).digest('hex'), 'Uint16Array')
  const view = new DataView(short.buffer, short.byteOffset + 3, 9)
  eq(crypto.createHash('sha1').update(view).digest('hex'), refCrypto.createHash('sha1').update(view).digest('hex'), 'DataView')
  eq(crypto.createHash('md5').update('aGk=', 'base64').digest('hex'), refCrypto.createHash('md5').update('aGk=', 'base64').digest('hex'), 'base64 input')
})
check('digest', 'errors', () => {
  const hash = crypto.createHash('sha1')
  hash.digest()
  eq(thrown(() => hash.digest())?.code, 'ERR_CRYPTO_HASH_FINALIZED', 'second digest')
  eq(thrown(() => hash.update('x'))?.code, 'ERR_CRYPTO_HASH_FINALIZED', 'update after digest')
  ok(thrown(() => crypto.createHash('nope')) instanceof Error, 'unknown algorithm throws')
  eq(thrown(() => crypto.createHash('sha1').update(5))?.code, 'ERR_INVALID_ARG_TYPE', 'bad update type')
  ok(crypto.getHashes().includes('sha256') && crypto.getHashes().includes('RSA-SHA256'), 'getHashes')
})
check('digest', 'hash() one-shot', () => {
  for (const alg of ALGS) {
    const expected = refCrypto.createHash(alg).update(short).digest()
    eq(crypto.hash(alg, short), expected.toString('hex'), alg)
    eq(crypto.hash(alg, short.toString(), 'base64'), expected.toString('base64'), `${alg} base64`)
    eq(crypto.hash(alg, short, 'buffer'), expected, `${alg} buffer`)
  }
})
check('digest', 'as a stream: write/end/read', async () => {
  const hash = crypto.createHash('sha256')
  ok(hash instanceof stream.Transform, 'Hash is a Transform')
  const read = new Promise<Buffer>((done) => hash.on('readable', () => { const data = hash.read(); if (data) done(data) }))
  hash.write('some data ')
  hash.write(Buffer.from('to hash'))
  hash.end()
  eq(await read, refCrypto.createHash('sha256').update('some data to hash').digest())
})
check('digest', 'as a stream: pipe', async () => {
  const source = stream.Readable.from(split(oneMB, 60_000))
  const hash = source.pipe(crypto.createHash('sha1')).setEncoding('hex')
  let out = ''
  hash.on('data', (text: string) => (out += text))
  await new Promise<void>((done, fail) => hash.on('end', done).on('error', fail))
  eq(out, refCrypto.createHash('sha1').update(oneMB).digest('hex'))
})
check('hmac', 'as a stream, string key, second digest', async () => {
  const hmac = crypto.createHmac('sha256', 'a secret')
  const read = new Promise<Buffer>((done) => hmac.on('data', done))
  hmac.end('payload')
  eq(await read, refCrypto.createHmac('sha256', 'a secret').update('payload').digest())
  const again = crypto.createHmac('sha256', 'k')
  again.update('x').digest()
  eq(again.digest('hex'), '', 'second digest is empty')
})
check('hmac', 'KeyObject key', () => {
  const key = crypto.createSecretKey(Buffer.from('0123456789abcdef'))
  eq(key.type, 'secret')
  eq(key.symmetricKeySize, 16)
  eq(key.export(), Buffer.from('0123456789abcdef'))
  eq(key.export({ format: 'jwk' }).k, refCrypto.createSecretKey(Buffer.from('0123456789abcdef')).export({ format: 'jwk' }).k, 'jwk')
  ok(key.equals(crypto.createSecretKey('0123456789abcdef', 'utf8')), 'equals')
  eq(crypto.createHmac('sha256', key).update('m').digest('hex'), refCrypto.createHmac('sha256', '0123456789abcdef').update('m').digest('hex'))
})

for (const digest of ['sha1', 'sha256', 'sha512', 'md5']) {
  check('kdf', `pbkdf2 ${digest}`, async () => {
    eq(crypto.pbkdf2Sync('password', 'salt', 1000, 50, digest), refCrypto.pbkdf2Sync('password', 'salt', 1000, 50, digest), 'sync')
    eq(crypto.pbkdf2Sync(Buffer.from('p'), pseudoRandom(16), 1, 20, digest), refCrypto.pbkdf2Sync(Buffer.from('p'), pseudoRandom(16), 1, 20, digest), '1 round')
    let returned = false
    const derived = call<Buffer>((cb) => crypto.pbkdf2('password', 'salt', 300, 64, digest, (e: unknown, key: Buffer) => (ok(returned, 'callback ran synchronously'), cb(e, key))))
    returned = true
    eq(await derived, refCrypto.pbkdf2Sync('password', 'salt', 300, 64, digest), 'callback')
  })
  check('kdf', `hkdf ${digest}`, async () => {
    for (const [salt, info, length] of [['salt', 'info', 42], ['', '', 16], ['a longer salt value', 'context', 200]] as [string, string, number][]) {
      eq(crypto.hkdfSync(digest, 'key material', salt, info, length), refCrypto.hkdfSync(digest, 'key material', salt, info, length), `length ${length}`)
    }
    eq(await call<ArrayBuffer>((cb) => crypto.hkdf(digest, Buffer.from('k'), Buffer.from('s'), Buffer.from('i'), 32, cb)), refCrypto.hkdfSync(digest, Buffer.from('k'), Buffer.from('s'), Buffer.from('i'), 32), 'callback')
  })
}
check('kdf', 'scrypt', async () => {
  eq(crypto.scryptSync('password', 'salt', 64, { N: 1024 }), refCrypto.scryptSync('password', 'salt', 64, { N: 1024 }), 'N=1024')
  eq(crypto.scryptSync('pw', Buffer.from('NaCl'), 32, { N: 16, r: 2, p: 3 }), refCrypto.scryptSync('pw', Buffer.from('NaCl'), 32, { N: 16, r: 2, p: 3 }), 'r=2 p=3')
  eq(crypto.scryptSync('password', 'salt', 32), refCrypto.scryptSync('password', 'salt', 32), 'defaults')
  eq(await call<Buffer>((cb) => crypto.scrypt('password', 'salt', 24, { cost: 256 }, cb)), refCrypto.scryptSync('password', 'salt', 24, { N: 256 }), 'callback with options')
  eq(await call<Buffer>((cb) => crypto.scrypt('password', 'salt', 24, cb)), refCrypto.scryptSync('password', 'salt', 24), 'callback')
  ok(thrown(() => crypto.scryptSync('p', 's', 8, { N: 1 << 20 })) instanceof RangeError, 'memory limit')
  ok(thrown(() => crypto.pbkdf2Sync('p', 's', 1, 8, 'nope')), 'unknown digest throws')
})

const plaintexts: [string, Buffer][] = [['empty', Buffer.alloc(0)], ['15 bytes', oneMB.subarray(0, 15)], ['16 bytes', oneMB.subarray(0, 16)], ['100 KB', oneMB.subarray(0, 100_003)]]
for (const bits of [128, 192, 256]) {
  for (const mode of ['cbc', 'ctr', 'gcm']) {
    const name = `aes-${bits}-${mode}`
    const key = pseudoRandom(bits / 8, bits)
    const iv = pseudoRandom(mode === 'gcm' ? 12 : 16, 99)
    const aad = Buffer.from('associated data')
    const seal = (lib: any, data: Buffer, chunk: number) => {
      const cipher = lib.createCipheriv(name, key, iv)
      if (mode === 'gcm') cipher.setAAD(aad)
      const parts = split(data, chunk).map((piece) => cipher.update(piece))
      parts.push(cipher.final())
      return { data: Buffer.concat(parts), tag: mode === 'gcm' ? cipher.getAuthTag() : undefined }
    }
    const unseal = (lib: any, data: Buffer, tag: Buffer | undefined, chunk: number) => {
      const decipher = lib.createDecipheriv(name, key, iv)
      if (mode === 'gcm') decipher.setAAD(aad).setAuthTag(tag)
      const parts = split(data, chunk).map((piece) => decipher.update(piece))
      parts.push(decipher.final())
      return Buffer.concat(parts)
    }
    check('cipher', name, () => {
      for (const [label, data] of plaintexts) {
        const theirs = seal(refCrypto, data, 1 << 20)
        for (const chunk of [1 << 20, 7, 16, 1000]) {
          const mine = seal(crypto, data, chunk)
          eq(mine.data, theirs.data, `${label} ciphertext in ${chunk}-byte updates`)
          if (mode === 'gcm') eq(mine.tag, theirs.tag, `${label} tag`)
          eq(unseal(crypto, theirs.data, theirs.tag, chunk), data, `${label} decrypt in ${chunk}-byte updates`)
        }
        eq(unseal(refCrypto, seal(crypto, data, 33).data, seal(crypto, data, 33).tag, 1 << 20), data, `${label} reference decrypts mine`)
      }
    })
  }
}
check('cipher', 'gcm authentication', () => {
  const key = pseudoRandom(32)
  const iv = pseudoRandom(12, 5)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update('attack at dawn', 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  eq(tag.length, 16, 'tag length')
  const open = (data: Buffer, t: Buffer, aad?: string) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv).setAuthTag(t)
    if (aad) decipher.setAAD(Buffer.from(aad))
    return decipher.update(data, undefined, 'utf8') + decipher.final('utf8')
  }
  eq(open(sealed, tag), 'attack at dawn')
  const flipped = Buffer.from(sealed)
  flipped[3] ^= 1
  ok(thrown(() => open(flipped, tag)), 'tampered ciphertext is rejected')
  const badTag = Buffer.from(tag)
  badTag[15] ^= 0x80
  ok(thrown(() => open(sealed, badTag)), 'tampered tag is rejected')
  ok(thrown(() => open(sealed, tag, 'unexpected aad')), 'wrong AAD is rejected')
  ok(thrown(() => crypto.createDecipheriv('aes-256-gcm', key, iv).final()), 'final without a tag throws')
  // A 16-byte IV takes the GHASH-derived counter path.
  const longIv = pseudoRandom(16, 3)
  const a = crypto.createCipheriv('aes-128-gcm', key.subarray(0, 16), longIv)
  const b = refCrypto.createCipheriv('aes-128-gcm', key.subarray(0, 16), longIv)
  eq(Buffer.concat([a.update(short), a.final()]), Buffer.concat([b.update(short), b.final()]), '16-byte IV ciphertext')
  eq(a.getAuthTag(), b.getAuthTag(), '16-byte IV tag')
})
check('cipher', 'encodings, padding, errors', async () => {
  const key = pseudoRandom(32)
  const iv = pseudoRandom(16, 2)
  const text = 'päyload with ünicode ✓ that spans several blocks of the cipher'
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const hex = cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
  const ref = refCrypto.createCipheriv('aes-256-cbc', key, iv)
  eq(hex, ref.update(text, 'utf8', 'hex') + ref.final('hex'), 'hex ciphertext')
  // Feed the ciphertext in pieces that cut multi-byte characters in half.
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  let plain = ''
  for (let at = 0; at < hex.length; at += 34) plain += decipher.update(hex.slice(at, at + 34), 'hex', 'utf8')
  eq(plain + decipher.final('utf8'), text, 'utf8 output across updates')
  const raw = crypto.createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false)
  const refRaw = refCrypto.createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false)
  eq(Buffer.concat([raw.update(oneMB.subarray(0, 64)), raw.final()]), Buffer.concat([refRaw.update(oneMB.subarray(0, 64)), refRaw.final()]), 'no padding')
  const wrongKey = crypto.createDecipheriv('aes-256-cbc', pseudoRandom(32, 77), iv)
  ok(thrown(() => Buffer.concat([wrongKey.update(hex, 'hex'), wrongKey.final()])), 'bad decrypt throws')
  eq(thrown(() => crypto.createCipheriv('aes-256-cbc', key.subarray(1), iv))?.code, 'ERR_CRYPTO_INVALID_KEYLEN', 'key length')
  eq(thrown(() => crypto.createCipheriv('aes-256-cbc', key, iv.subarray(1)))?.code, 'ERR_CRYPTO_INVALID_IV', 'iv length')
  ok(thrown(() => crypto.createCipheriv('rc4', key, null)), 'unknown cipher throws')
  const piped = await through(crypto.createCipheriv('aes-256-ctr', key, iv), split(oneMB, 50_001))
  const refCtr = refCrypto.createCipheriv('aes-256-ctr', key, iv)
  eq(piped, Buffer.concat([refCtr.update(oneMB), refCtr.final()]), 'cipher as a stream')
})

check('random', 'randomBytes, randomFill, getRandomValues', async () => {
  const a = crypto.randomBytes(32)
  ok(Buffer.isBuffer(a) && a.length === 32 && !a.equals(crypto.randomBytes(32)), 'randomBytes(32)')
  eq(crypto.randomBytes(0).length, 0)
  ok(crypto.randomBytes(200_000).subarray(150_000).some((byte: number) => byte !== 0), 'more than one 64 KiB quota')
  let returned = false
  const later = call<Buffer>((cb) => crypto.randomBytes(16, (e: unknown, bytes: Buffer) => (ok(returned, 'callback ran synchronously'), cb(e, bytes))))
  returned = true
  eq((await later).length, 16)
  const target = Buffer.alloc(64)
  ok(crypto.randomFillSync(target, 8, 16) === target, 'randomFillSync returns its buffer')
  ok(target.subarray(0, 8).every((b) => b === 0) && target.subarray(24).every((b) => b === 0) && target.subarray(8, 24).some((b) => b !== 0), 'randomFillSync range')
  const words = await call<Uint32Array>((cb) => crypto.randomFill(new Uint32Array(8), cb))
  ok(words.some((w) => w !== 0), 'randomFill')
  ok(crypto.getRandomValues(new Uint8Array(8)).some((b: number) => b !== 0), 'getRandomValues')
  ok(thrown(() => crypto.randomBytes(-1)) instanceof RangeError, 'negative size')
})
check('random', 'randomInt, randomUUID, timingSafeEqual', async () => {
  const seen = new Set<number>()
  for (let i = 0; i < 2000; i++) {
    const value = crypto.randomInt(3, 9)
    ok(Number.isInteger(value) && value >= 3 && value < 9, `randomInt(3, 9) gave ${value}`)
    seen.add(value)
  }
  eq(seen.size, 6, 'all values of the range appear')
  const big = crypto.randomInt(2 ** 40)
  ok(big >= 0 && big < 2 ** 40, 'randomInt(max)')
  const value = await call<number>((cb) => crypto.randomInt(10, cb))
  ok(value >= 0 && value < 10, 'randomInt callback')
  ok(thrown(() => crypto.randomInt(5, 5)) instanceof RangeError, 'empty range')
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()), 'randomUUID format')
  ok(crypto.randomUUID() !== crypto.randomUUID(), 'randomUUID differs')
  ok(crypto.timingSafeEqual(Buffer.from('same'), Buffer.from('same')), 'equal')
  ok(!crypto.timingSafeEqual(Buffer.from('same'), Buffer.from('sane')), 'different')
  eq(thrown(() => crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('ab')))?.code, 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH')
})
check('surface', 'webcrypto, stubs', async () => {
  ok(crypto.webcrypto === globalThis.crypto && crypto.subtle === globalThis.crypto.subtle, 'webcrypto and subtle are the globals')
  const digest = await crypto.subtle.digest('SHA-256', short)
  eq(Buffer.from(digest), crypto.createHash('sha256').update(short).digest(), 'subtle.digest agrees')
  ok(typeof crypto.constants === 'object', 'constants')
  for (const name of ['createSign', 'createVerify', 'generateKeyPair', 'generateKeyPairSync', 'publicEncrypt', 'createPublicKey', 'createPrivateKey', 'createECDH', 'createDiffieHellman', 'X509Certificate']) {
    const error = thrown(() => crypto[name]())
    eq(error?.code, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', name)
    ok(error.message.includes(name), `${name} named in the message`)
  }
})

// ----------------------------------------------------------------------- zlib

const formats = [
  { name: 'gzip', compress: 'gzip', decompress: 'gunzip', Compress: 'Gzip', Decompress: 'Gunzip' },
  { name: 'deflate', compress: 'deflate', decompress: 'inflate', Compress: 'Deflate', Decompress: 'Inflate' },
  { name: 'deflateRaw', compress: 'deflateRaw', decompress: 'inflateRaw', Compress: 'DeflateRaw', Decompress: 'InflateRaw' },
  { name: 'brotli', compress: 'brotliCompress', decompress: 'brotliDecompress', Compress: 'BrotliCompress', Decompress: 'BrotliDecompress' },
]
const BR = refZlib.constants
/** Brotli at its default quality 11 is slow on megabytes; the bulk checks use quality 5. */
const fast = (format: { name: string }, extra: object = {}) => (format.name === 'brotli' ? { params: { [BR.BROTLI_PARAM_QUALITY]: 5 }, ...extra } : extra)
const payloads: [string, Buffer][] = [['empty', Buffer.alloc(0)], ['short', short], ['1 MB text', oneMB], ['100 KB noise', noise]]

for (const f of formats) {
  for (const [label, data] of payloads) {
    check(`${f.name} sync`, label, () => {
      const mine = zlib[`${f.compress}Sync`](data, fast(f))
      ok(Buffer.isBuffer(mine), 'returns a Buffer')
      eq(refZlib[`${f.decompress}Sync`](mine), data, 'mine -> reference')
      eq(zlib[`${f.decompress}Sync`](refZlib[`${f.compress}Sync`](data, fast(f))), data, 'reference -> mine')
      eq(zlib[`${f.decompress}Sync`](mine), data, 'mine -> mine')
      if (data.length > 1000 && label !== '100 KB noise') {
        const theirs = refZlib[`${f.compress}Sync`](data, fast(f))
        ok(mine.length < theirs.length * 1.15, `compressed size ${mine.length} is within 15% of the reference's ${theirs.length}`)
      }
    })
    check(`${f.name} callback`, label, async () => {
      let returned = false
      const mine = call<Buffer>((cb) => zlib[f.compress](data, fast(f), (e: unknown, out: Buffer) => (ok(returned, 'callback ran synchronously'), cb(e, out))))
      returned = true
      const packed = await mine
      eq(await call<Buffer>((cb) => refZlib[f.decompress](packed, cb)), data, 'mine -> reference')
      const theirs = await call<Buffer>((cb) => refZlib[f.compress](data, fast(f), cb))
      eq(await call<Buffer>((cb) => zlib[f.decompress](theirs, cb)), data, 'reference -> mine (no options)')
      eq(await call<Buffer>((cb) => zlib[f.decompress](theirs, {}, cb)), data, 'reference -> mine (options)')
    })
    check(`${f.name} stream`, label, async () => {
      const mine = await through(zlib[`create${f.Compress}`](fast(f)), split(data, 70_001))
      eq(refZlib[`${f.decompress}Sync`](mine), data, 'mine -> reference')
      const theirs = refZlib[`${f.compress}Sync`](data, fast(f))
      eq(await through(zlib[`create${f.Decompress}`](), split(theirs, 1013)), data, 'reference -> mine in 1013-byte writes')
      eq(await through(new zlib[f.Decompress]({ chunkSize: 64 }), split(theirs, 50_000)), data, 'reference -> mine with chunkSize 64')
      eq(await through(refZlib[`create${f.Decompress}`](), split(mine, 4096)), data, 'mine -> reference stream')
    })
  }
  check(`${f.name} stream`, 'one byte at a time', async () => {
    const packed = refZlib[`${f.compress}Sync`](short)
    eq(await through(zlib[`create${f.Decompress}`](), split(packed, 1)), short, 'decompress')
    eq(refZlib[`${f.decompress}Sync`](await through(zlib[`create${f.Compress}`](), split(short, 1))), short, 'compress')
  })
  check(`${f.name} stream`, 'class shape', async () => {
    const s = zlib[f.Compress]()
    ok(s instanceof zlib[f.Compress] && s instanceof stream.Transform, 'callable without new, a Transform')
    ok(zlib[`create${f.Compress}`]() instanceof zlib[f.Compress], 'factory makes the class')
    const out = through(s, [oneMB.subarray(0, 5000), oneMB.subarray(5000, 12345)])
    await out
    eq(s.bytesWritten, 12345, 'bytesWritten')
    const closing = zlib[`create${f.Compress}`]()
    closing.write('abc')
    await new Promise<void>((done) => closing.close(() => done()))
    ok(closing.destroyed, 'close() destroys')
  })
  check(`${f.name} stream`, 'flush emits data', async () => {
    const flushKind = f.name === 'brotli' ? BR.BROTLI_OPERATION_FLUSH : BR.Z_SYNC_FLUSH
    for (const explicit of [true, false]) {
      const s = zlib[`create${f.Compress}`](fast(f))
      const out: Buffer[] = []
      s.on('data', (chunk: Buffer) => out.push(chunk))
      const events = ['data: one\n\n', 'data: two\n\n', 'data: three\n\n']
      for (let i = 0; i < events.length; i++) {
        s.write(events[i])
        await new Promise<void>((done) => (explicit ? s.flush(flushKind, done) : s.flush(done)))
        // Everything written so far must be recoverable from what was emitted so far.
        const soFar = Buffer.concat(out)
        const partial = refZlib[`${f.decompress}Sync`](soFar, { finishFlush: flushKind })
        eq(partial.toString(), events.slice(0, i + 1).join(''), `after flush ${i + 1} (${explicit ? 'explicit kind' : 'default kind'})`)
        eq(zlib[`${f.decompress}Sync`](soFar, { finishFlush: flushKind }).toString(), partial.toString(), 'mine reads the partial stream too')
      }
      const ended = new Promise<void>((done) => s.on('end', done))
      s.end()
      await ended
      eq(refZlib[`${f.decompress}Sync`](Buffer.concat(out)).toString(), events.join(''), 'complete stream')
    }
  })
  check(`${f.name} stream`, 'options.flush = sync flush on every write', async () => {
    const flushKind = f.name === 'brotli' ? BR.BROTLI_OPERATION_FLUSH : BR.Z_SYNC_FLUSH
    const s = zlib[`create${f.Compress}`](fast(f, { flush: flushKind }))
    const out: Buffer[] = []
    s.on('data', (chunk: Buffer) => out.push(chunk))
    await new Promise<void>((done) => s.write('hello, ', () => done()))
    await new Promise<void>((done) => s.write('world', () => done()))
    eq(refZlib[`${f.decompress}Sync`](Buffer.concat(out), { finishFlush: flushKind }).toString(), 'hello, world')
    s.destroy()
  })
  check(`${f.name} errors`, 'truncated input', async () => {
    for (const data of [short, oneMB.subarray(0, 300_000)]) {
      const packed = refZlib[`${f.compress}Sync`](data, fast(f))
      for (const keep of [0, 1, 5, Math.floor(packed.length / 2), packed.length - 1]) {
        const cut = packed.subarray(0, keep)
        sameFailure(() => zlib[`${f.decompress}Sync`](cut), () => refZlib[`${f.decompress}Sync`](cut), `sync, ${keep} of ${packed.length} bytes`)
        const mine = await through(zlib[`create${f.Decompress}`](), split(cut, 999)).then(() => undefined, (e) => e)
        const theirs = await through(refZlib[`create${f.Decompress}`](), split(cut, 999)).then(() => undefined, (e) => e)
        eq(mine?.code, theirs?.code, `stream, ${keep} of ${packed.length} bytes`)
        const viaCallback = await call((cb) => zlib[f.decompress](cut, cb)).then(() => undefined, (e) => e)
        eq(viaCallback?.code, theirs?.code, `callback, ${keep} of ${packed.length} bytes`)
      }
      // With a non-finishing finishFlush a truncated stream yields what it has.
      const flushKind = f.name === 'brotli' ? BR.BROTLI_OPERATION_FLUSH : BR.Z_SYNC_FLUSH
      const half = packed.subarray(0, Math.floor(packed.length / 2))
      const partial = zlib[`${f.decompress}Sync`](half, { finishFlush: flushKind })
      ok(data.subarray(0, partial.length).equals(partial), 'partial output is a prefix of the data')
      if (f.name !== 'brotli') eq(partial.length, refZlib[`${f.decompress}Sync`](half, { finishFlush: flushKind }).length, 'partial output length')
    }
  })
  check(`${f.name} errors`, 'corrupt input', () => {
    const garbage = Buffer.from('this is certainly not compressed data, not at all')
    // Raw deflate and brotli have no header to reject: the two decoders trip over different details of the same garbage.
    if (f.name === 'gzip' || f.name === 'deflate') sameFailure(() => zlib[`${f.decompress}Sync`](garbage), () => refZlib[`${f.decompress}Sync`](garbage), 'garbage')
    else if (f.name === 'brotli') ok(/^ERR__ERROR_/.test(thrown(() => zlib.brotliDecompressSync(garbage))?.code), 'garbage: a decoder error code')
    else eq(thrown(() => zlib.inflateRawSync(garbage))?.code, 'Z_DATA_ERROR', 'garbage')
    eq(thrown(() => zlib[`${f.compress}Sync`](42))?.code, 'ERR_INVALID_ARG_TYPE', 'bad argument type')
    ok(thrown(() => zlib[f.compress](short)) instanceof TypeError, 'missing callback throws')
  })
}

check('gzip sync', 'levels, strings, typed arrays', () => {
  const sizes: number[] = []
  for (const level of [0, 1, 6, 9, -1]) {
    for (const kind of ['gzip', 'deflate', 'deflateRaw']) {
      const packed = zlib[`${kind}Sync`](oneMB, { level })
      eq(refZlib[`${kind.replace('gzip', 'gunzip').replace('deflate', 'inflate')}Sync`](packed), oneMB, `${kind} level ${level}`)
      if (kind === 'gzip') sizes.push(packed.length)
    }
  }
  ok(sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] >= sizes[3] && sizes[4] === sizes[2], `sizes by level: ${sizes.join(' ')}`)
  eq(refZlib.gunzipSync(zlib.gzipSync('a string ✓')).toString(), 'a string ✓', 'string input')
  eq(refZlib.gunzipSync(zlib.gzipSync(new Uint16Array([1, 2, 3]))), Buffer.from(new Uint16Array([1, 2, 3]).buffer), 'Uint16Array input')
  eq(refZlib.gunzipSync(zlib.gzipSync(short.buffer.slice(short.byteOffset, short.byteOffset + short.length))), short, 'ArrayBuffer input')
  ok(thrown(() => zlib.gzipSync(short, { level: 12 })) instanceof RangeError, 'level out of range')
  eq(thrown(() => zlib.gunzipSync(zlib.gzipSync(oneMB), { maxOutputLength: 1000 }))?.code, 'ERR_BUFFER_TOO_LARGE', 'maxOutputLength')
})
check('gzip sync', 'unzip detects gzip and zlib', async () => {
  eq(zlib.unzipSync(refZlib.gzipSync(oneMB)), oneMB, 'gzip')
  eq(zlib.unzipSync(refZlib.deflateSync(oneMB)), oneMB, 'zlib')
  eq(await call<Buffer>((cb) => zlib.unzip(refZlib.gzipSync(short), cb)), short, 'callback')
  eq(await through(zlib.createUnzip(), split(refZlib.deflateSync(oneMB), 777)), oneMB, 'stream')
  eq(await through(zlib.createUnzip(), split(refZlib.gzipSync(short), 1)), short, 'stream, gzip one byte at a time')
})
check('gzip sync', 'gzip header fields and members', () => {
  // FEXTRA, FNAME, FCOMMENT and FHCRC set, as other tools write them.
  const body = refZlib.deflateRawSync(short)
  const header = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 4 | 8 | 16 | 2, 0, 0, 0, 0, 0, 3]), Buffer.from([3, 0, 1, 2, 3]), Buffer.from('name.txt\0'), Buffer.from('a comment\0'), Buffer.from([0, 0])])
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(refZlib.crc32 ? refZlib.crc32(short) : zlib.crc32(short), 0)
  trailer.writeUInt32LE(short.length, 4)
  const full = Buffer.concat([header, body, trailer])
  eq(zlib.gunzipSync(full), short, 'optional header fields')
  const two = Buffer.concat([refZlib.gzipSync('first,'), refZlib.gzipSync('second')])
  eq(zlib.gunzipSync(two).toString(), refZlib.gunzipSync(two).toString(), 'concatenated members')
  const junk = Buffer.concat([refZlib.gzipSync('data'), Buffer.from('trailing junk')])
  sameFailure(() => zlib.gunzipSync(junk), () => refZlib.gunzipSync(junk), 'trailing junk')
  const padded = Buffer.concat([refZlib.gzipSync('data'), Buffer.alloc(700)])
  eq(zlib.gunzipSync(padded).toString(), refZlib.gunzipSync(padded).toString(), 'zero padding after the member')
  const badCrc = Buffer.from(refZlib.gzipSync(short))
  badCrc[badCrc.length - 6] ^= 1
  sameFailure(() => zlib.gunzipSync(badCrc), () => refZlib.gunzipSync(badCrc), 'bad CRC')
  const badLength = Buffer.from(refZlib.gzipSync(short))
  badLength[badLength.length - 1] ^= 1
  sameFailure(() => zlib.gunzipSync(badLength), () => refZlib.gunzipSync(badLength), 'bad length')
  const mine = zlib.gzipSync(short)
  eq(mine.subarray(0, 4), Buffer.from([0x1f, 0x8b, 8, 0]), 'header written')
})
check('gzip stream', 'pipeline and reset', async () => {
  const collected: Buffer[] = []
  await new Promise<void>((done, fail) =>
    stream.pipeline(
      stream.Readable.from(split(threeMB, 65536)),
      zlib.createGzip({ level: 1 }),
      refZlib.createGunzip(),
      new stream.Writable({ write(chunk: Buffer, _e: string, cb: () => void) { collected.push(chunk); cb() } }),
      (error: unknown) => (error ? fail(error) : done()),
    ),
  )
  eq(Buffer.concat(collected), threeMB, 'pipeline round trip')
  const promisified = await require('node:util').promisify(zlib.gzip)(short)
  eq(refZlib.gunzipSync(promisified), short, 'util.promisify(gzip)')
})
check('constants', 'values match the reference', () => {
  const missing: string[] = []
  for (const [name, value] of Object.entries(zlib.constants)) {
    if (!(name in refZlib.constants)) missing.push(name)
    else eq(value, refZlib.constants[name], name)
  }
  eq(missing.join(' '), '', 'constants the reference does not have')
  const absent = Object.keys(refZlib.constants).filter((name) => !(name in zlib.constants) && !name.startsWith('ZSTD'))
  eq(absent.join(' '), '', 'reference constants missing here (zstd aside)')
  for (const name of ['Z_NO_FLUSH', 'Z_SYNC_FLUSH', 'Z_FINISH', 'Z_BEST_COMPRESSION', 'Z_DEFAULT_COMPRESSION', 'Z_BUF_ERROR']) eq(zlib[name], refZlib.constants[name], `top-level ${name}`)
  eq(zlib.BROTLI_PARAM_QUALITY, undefined, 'no top-level brotli constants')
  for (const [name, value] of Object.entries(refZlib.codes ?? {})) eq(zlib.codes[name], value, `codes.${name}`)
  eq(zlib.codes.Z_DATA_ERROR, -3)
  eq(zlib.codes[-5], 'Z_BUF_ERROR')
})
check('constants', 'crc32', () => {
  eq(zlib.crc32('hello'), 0x3610a686, 'known value')
  eq(zlib.crc32(''), 0, 'empty')
  eq(zlib.crc32(oneMB.subarray(500_000), zlib.crc32(oneMB.subarray(0, 500_000))), zlib.crc32(oneMB), 'chained')
  if (typeof refZlib.crc32 === 'function') {
    eq(zlib.crc32(oneMB), refZlib.crc32(oneMB), 'vs reference')
    eq(zlib.crc32(short, 12345), refZlib.crc32(short, 12345), 'vs reference with a start value')
  }
})

// ---------------------------------------------------------------- measurement

function time(fn: () => void, minMs = 300): number {
  fn()
  let runs = 0
  const start = performance.now()
  let elapsed = 0
  do {
    fn()
    runs++
    elapsed = performance.now() - start
  } while (elapsed < minMs)
  return elapsed / runs
}

function bench(): void {
  const rows: [string, string, string][] = []
  const mbps = (bytes: number, ms: number) => `${(bytes / 1048576 / (ms / 1000)).toFixed(0)} MB/s`
  const start = performance.now()
  const module = new WebAssembly.Module(wasmBytes)
  const compiledAt = performance.now()
  const instances = 20
  for (let i = 0; i < instances; i++) new WebAssembly.Instance(module, {})
  const instantiated = performance.now()
  rows.push(['Wasm size', `${(wasmBytes.length / 1024).toFixed(0)} KiB`, ''])
  rows.push(['Wasm compile (sync)', `${(compiledAt - start).toFixed(1)} ms`, ''])
  rows.push(['Wasm instantiate', `${((instantiated - compiledAt) / instances).toFixed(3)} ms`, ''])
  for (const alg of ['sha256', 'md5', 'sha1', 'sha512']) {
    rows.push([
      `${alg} 1 MB`,
      mbps(oneMB.length, time(() => crypto.createHash(alg).update(oneMB).digest())),
      mbps(oneMB.length, time(() => refCrypto.createHash(alg).update(oneMB).digest())),
    ])
  }
  const block = pseudoRandom(64)
  const loop = (lib: any) => () => {
    for (let i = 0; i < 1000; i++) lib.createHash('sha1').update(block).digest('hex')
  }
  rows.push(['sha1 64-byte one-shot hex', `${(time(loop(crypto)) * 1000).toFixed(0)} ns`, `${(time(loop(refCrypto)) * 1000).toFixed(0)} ns`])
  const textLoop = (lib: any) => () => {
    for (let i = 0; i < 1000; i++) lib.createHash('sha256').update('export default function component() { return 1 }').digest('hex')
  }
  rows.push(['sha256 48-char string hex', `${(time(textLoop(crypto)) * 1000).toFixed(0)} ns`, `${(time(textLoop(refCrypto)) * 1000).toFixed(0)} ns`])
  const packed = refZlib.gzipSync(js)
  rows.push([`gzip level 6, ${js.length >> 20} MB JS`, mbps(js.length, time(() => zlib.gzipSync(js), 1500)), mbps(js.length, time(() => refZlib.gzipSync(js), 1500))])
  rows.push([`gzip level 1, ${js.length >> 20} MB JS`, mbps(js.length, time(() => zlib.gzipSync(js, { level: 1 }), 1000)), mbps(js.length, time(() => refZlib.gzipSync(js, { level: 1 }), 1000))])
  rows.push([`gunzip, ${js.length >> 20} MB JS`, mbps(js.length, time(() => zlib.gunzipSync(packed), 1000)), mbps(js.length, time(() => refZlib.gunzipSync(packed), 1000))])
  const q = { params: { [BR.BROTLI_PARAM_QUALITY]: 4 } }
  const brotli = refZlib.brotliCompressSync(js, q)
  rows.push([`brotli quality 4, ${js.length >> 20} MB JS`, mbps(js.length, time(() => zlib.brotliCompressSync(js, q), 1000)), mbps(js.length, time(() => refZlib.brotliCompressSync(js, q), 1000))])
  rows.push([`brotli decompress, ${js.length >> 20} MB JS`, mbps(js.length, time(() => zlib.brotliDecompressSync(brotli), 1000)), mbps(js.length, time(() => refZlib.brotliDecompressSync(brotli), 1000))])
  rows.push(['gzip ratio (level 6)', `${((zlib.gzipSync(js).length / js.length) * 100).toFixed(2)} %`, `${((packed.length / js.length) * 100).toFixed(2)} %`])
  console.log(`\n${'measurement'.padEnd(34)}${'this runtime'.padStart(14)}${'host'.padStart(14)}`)
  for (const [name, mine, theirs] of rows) console.log(`${name.padEnd(34)}${mine.padStart(14)}${theirs.padStart(14)}`)
}

await Promise.all(pending)
const host = (process.versions as any).bun ? `bun ${(process.versions as any).bun}` : `node ${process.versions.node}`
console.log(`native-check against ${host}\n`)
console.log(`${'group'.padEnd(22)}${'pass'.padStart(6)}${'fail'.padStart(6)}`)
let failed = 0
for (const [name, { pass, fail }] of groups) {
  console.log(`${name.padEnd(22)}${String(pass).padStart(6)}${String(fail.length).padStart(6)}`)
  failed += fail.length
}
for (const [name, { fail }] of groups) for (const line of fail) console.log(`FAIL ${name} / ${line}`)
if (!process.argv.includes('--no-bench')) bench()
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
