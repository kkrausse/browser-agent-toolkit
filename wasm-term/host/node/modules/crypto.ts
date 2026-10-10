// `node:crypto` for a bundled program: the small part terminal programs use
// (content hashes for cache keys and lock names, random ids). Bun's browser
// polyfill is crypto-browserify, which is several hundred kB and whose
// `createHash` export came out undefined in the bundle. WebCrypto's digest is
// async only, so the two synchronous hashes are implemented here.
import { Buffer } from "node:buffer";

const rotl = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Message + 0x80 + zero padding + 64-bit big-endian bit length, as both hashes want it. */
function padded(message: Uint8Array): DataView {
  const length = (((message.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(length);
  block.set(message);
  block[message.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(length - 8, Math.floor(message.length / 0x2000_0000));
  view.setUint32(length - 4, (message.length << 3) >>> 0);
  return view;
}

function sha1(message: Uint8Array): Uint8Array {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const view = padded(message);
  const w = new Int32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = next;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0; h[4] = (h[4]! + e) | 0;
  }
  const out = new DataView(new ArrayBuffer(20));
  h.forEach((word, i) => out.setInt32(i * 4, word));
  return new Uint8Array(out.buffer);
}

const K256 = new Int32Array(64);
{
  // Fractional parts of the cube roots of the first 64 primes.
  let n = 0;
  for (let candidate = 2; n < 64; candidate++) {
    let prime = true;
    for (let d = 2; d * d <= candidate; d++) if (candidate % d === 0) prime = false;
    if (prime) K256[n++] = (Math.cbrt(candidate) % 1) * 0x1_0000_0000;
  }
}

function sha256(message: Uint8Array): Uint8Array {
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const view = padded(message);
  const w = new Int32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new DataView(new ArrayBuffer(32));
  h.forEach((word, i) => out.setInt32(i * 4, word));
  return new Uint8Array(out.buffer);
}

const HASHES: Record<string, (message: Uint8Array) => Uint8Array> = { sha1, sha256 };

export function createHash(algorithm: string) {
  const digestOf = HASHES[algorithm.toLowerCase().replace("-", "")];
  if (!digestOf) throw new Error(`wasm-term: crypto.createHash("${algorithm}") is not available (sha1 and sha256 are)`);
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: string | ArrayBufferView, encoding?: BufferEncoding) {
      parts.push(typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return hash;
    },
    digest(encoding?: BufferEncoding): any {
      const result = Buffer.from(digestOf(Buffer.concat(parts)));
      return encoding ? result.toString(encoding) : result;
    },
  };
  return hash;
}

export function randomBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  // getRandomValues refuses more than 65536 bytes per call.
  for (let at = 0; at < size; at += 65536) globalThis.crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  return bytes;
}

export function randomUUID(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomInt(min: number, max?: number): number {
  const [low, high] = max === undefined ? [0, min] : [min, max];
  return low + (randomBytes(6).readUIntBE(0, 6) % (high - low));
}

export const getRandomValues = <T extends ArrayBufferView>(array: T): T => globalThis.crypto.getRandomValues(array as never);
export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto.subtle;

const unavailable = (name: string) => () => {
  throw new Error(`wasm-term: node API crypto.${name} is not available in the browser client`);
};
export const createHmac = unavailable("createHmac");
export const createCipheriv = unavailable("createCipheriv");
export const createDecipheriv = unavailable("createDecipheriv");
export const pbkdf2Sync = unavailable("pbkdf2Sync");
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

export default {
  createCipheriv, createDecipheriv, createHash, createHmac, getRandomValues, pbkdf2Sync, randomBytes, randomInt,
  randomUUID, subtle, timingSafeEqual, webcrypto,
};
