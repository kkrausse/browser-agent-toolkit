// A `bun:ffi`-shaped backend whose "native library" is OpenTUI's Zig core
// compiled to wasm32-wasi (native/build.sh -> dist/opentui.wasm).
//
// OpenTUI routes every native call through packages/core/src/platform/ffi.ts,
// which expects the bun:ffi module shape: { dlopen, ptr, toArrayBuffer,
// JSCallback, suffix }. This file provides that shape. Nothing here knows about
// OpenTUI's symbols; it adapts calling conventions only.
//
// The semantic gap, and how each part is bridged:
//
//  * bun:ffi lets native code read and write JS-owned buffers in place. A wasm
//    module can only see its own linear memory. So every buffer argument is
//    copied into linear memory before the call and copied back after it
//    (`borrow`). That is correct for anything native uses only during the call.
//  * `ptr(view)` hands out an address that native code may keep. Here it pins
//    a linear-memory mirror of the view's whole ArrayBuffer (so pointer
//    arithmetic between views of one buffer still works), refreshes it on
//    every `ptr()` call, and frees it when the ArrayBuffer is collected.
//    Mirrors are one-way (JS -> wasm): right for retained text bytes and
//    struct sub-pointers, which is all OpenTUI uses `ptr()` for.
//  * `toArrayBuffer(address, offset, length)` aliases native memory in Bun.
//    Here it returns a copy, because an ArrayBuffer cannot alias a sub-range
//    of linear memory. See NOTES.md ("toArrayBuffer aliasing") for the one
//    upstream call site where that matters.
//  * Declared FFI types are bun's; the module's real signatures are wasm32's
//    (usize is 32-bit). Argument and return coercion follows the real wasm
//    signature, read from the binary's type section.
//  * JSCallback needs a function-table entry callable from wasm. A tiny
//    generated module re-exports the JS function with the right signature,
//    which makes it insertable into the indirect function table.

export type FfiType = string

export interface FfiFunction {
  readonly args?: readonly FfiType[]
  readonly returns?: FfiType
  readonly ptr?: number | bigint
  readonly threadsafe?: boolean
}

export interface FfiCallback {
  readonly ptr: number | null
  readonly threadsafe: boolean
  close(): void
}

export interface FfiLibrary {
  symbols: Record<string, (...args: any[]) => any>
  close(): void
}

/** The subset of `bun:ffi` that OpenTUI and bun-ffi-structs use. */
export interface WasmFfi {
  dlopen(path: string | URL | null, symbols: Record<string, FfiFunction>): FfiLibrary
  ptr(value: ArrayBufferLike | ArrayBufferView): number
  toArrayBuffer(pointer: number | bigint, offset: number | undefined, length: number): ArrayBuffer
  JSCallback: new (callback: (...args: any[]) => any, definition: FfiFunction) => FfiCallback
  suffix: string
  /** Not part of bun:ffi: introspection for tests and NOTES. */
  readonly stats: WasmFfiStats
  readonly memory: WebAssembly.Memory
}

export interface WasmFfiStats {
  calls: number
  borrowedBytes: number
  pinnedBytes: number
  missingSymbols: string[]
  unimplementedImports: Set<string>
}

/** What the wasm module needs from the outside world. */
export interface WasmFfiHost {
  /** Bytes the native renderer writes to a file descriptor (1 = the terminal). */
  write(fd: number, bytes: Uint8Array): void
  /** Optional: a complete `wasi_snapshot_preview1` import object (the wasm-term kernel's). */
  wasi?: Record<string, (...args: any[]) => any>
}

type ValType = "i32" | "i64" | "f32" | "f64"

interface FuncType {
  params: ValType[]
  results: ValType[]
}

const VAL_TYPES: Record<number, ValType> = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" }
const VAL_CODES: Record<ValType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c }

/** Reads each exported function's signature from the type/import/function/export sections. */
export function readExportSignatures(bytes: Uint8Array): Map<string, FuncType> {
  let pos = 8
  const u32 = () => {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = bytes[pos++]!
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result >>> 0
      shift += 7
    }
  }
  const name = () => {
    const length = u32()
    const text = new TextDecoder().decode(bytes.subarray(pos, pos + length))
    pos += length
    return text
  }
  const limits = () => {
    const flags = bytes[pos++]!
    u32()
    if (flags & 1) u32()
  }
  const types: FuncType[] = []
  const funcTypeIndexes: number[] = []
  const signatures = new Map<string, FuncType>()
  while (pos < bytes.length) {
    const id = bytes[pos++]!
    const size = u32()
    const end = pos + size
    if (id === 1) {
      for (let count = u32(); count > 0; count--) {
        if (bytes[pos++] !== 0x60) throw new Error("opentui wasm: unsupported type section entry")
        const params = Array.from({ length: u32() }, () => VAL_TYPES[bytes[pos++]!]!)
        const results = Array.from({ length: u32() }, () => VAL_TYPES[bytes[pos++]!]!)
        types.push({ params, results })
      }
    } else if (id === 2) {
      for (let count = u32(); count > 0; count--) {
        name()
        name()
        const kind = bytes[pos++]!
        if (kind === 0) funcTypeIndexes.push(u32())
        else if (kind === 1) {
          pos++
          limits()
        } else if (kind === 2) limits()
        else if (kind === 3) pos += 2
        else throw new Error("opentui wasm: unsupported import kind")
      }
    } else if (id === 3) {
      for (let count = u32(); count > 0; count--) funcTypeIndexes.push(u32())
    } else if (id === 7) {
      for (let count = u32(); count > 0; count--) {
        const exportName = name()
        const kind = bytes[pos++]!
        const index = u32()
        if (kind === 0) signatures.set(exportName, types[funcTypeIndexes[index]!]!)
      }
    }
    pos = end
  }
  return signatures
}

function uleb(value: number): number[] {
  const out: number[] = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    out.push(byte)
  } while (value !== 0)
  return out
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body]
}

/** `(module (import "e" "f" (func <type>)) (export "f" (func 0)))` */
function trampolineModule(type: FuncType): WebAssembly.Module {
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      1, 0x60,
      ...uleb(type.params.length), ...type.params.map((param) => VAL_CODES[param]),
      ...uleb(type.results.length), ...type.results.map((result) => VAL_CODES[result]),
    ]),
    ...section(2, [1, 1, 0x65, 1, 0x66, 0x00, 0x00]),
    ...section(7, [1, 1, 0x66, 0x00, 0x00]),
  ]
  return new WebAssembly.Module(new Uint8Array(bytes))
}

const POINTER_TYPES = new Set(["ptr", "pointer", "buffer", "cstring", "function", "callback"])

function wasmTypeOf(type: FfiType): ValType | undefined {
  switch (type) {
    case "void":
      return undefined
    case "i64":
    case "int64_t":
    case "u64":
    case "uint64_t":
      return "i64"
    case "f32":
    case "float":
      return "f32"
    case "f64":
    case "double":
      return "f64"
    default:
      return "i32"
  }
}

const WASI_ENOSYS = 52
const WASI_EBADF = 8

export async function createWasmFfi(wasm: BufferSource, host: WasmFfiHost): Promise<WasmFfi> {
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm as ArrayBuffer)
  const module = await WebAssembly.compile(bytes as BufferSource)
  const signatures = readExportSignatures(bytes)
  const stats: WasmFfiStats = {
    calls: 0,
    borrowedBytes: 0,
    pinnedBytes: 0,
    missingSymbols: [],
    unimplementedImports: new Set(),
  }

  let memory!: WebAssembly.Memory
  let cachedU8: Uint8Array | undefined
  const u8 = () => {
    if (cachedU8 === undefined || cachedU8.buffer !== memory.buffer) cachedU8 = new Uint8Array(memory.buffer)
    return cachedU8
  }
  const dataView = () => new DataView(memory.buffer)

  const wasi: Record<string, (...args: any[]) => any> = host.wasi ?? {
    fd_write(fd: number, iovs: number, iovsLen: number, written: number) {
      const view = dataView()
      let total = 0
      for (let index = 0; index < iovsLen; index++) {
        const base = view.getUint32(iovs + index * 8, true)
        const length = view.getUint32(iovs + index * 8 + 4, true)
        // Copy: the host may hold the bytes past this call, and memory can grow.
        if (length > 0) host.write(fd, u8().slice(base, base + length))
        total += length
      }
      dataView().setUint32(written, total, true)
      return 0
    },
    fd_read(_fd: number, _iovs: number, _iovsLen: number, read: number) {
      dataView().setUint32(read, 0, true)
      return 0
    },
    fd_close: () => 0,
    fd_fdstat_get(fd: number, stat: number) {
      if (fd > 2) return WASI_EBADF
      const view = dataView()
      view.setUint8(stat, 2) // character device
      view.setUint16(stat + 2, 0, true)
      view.setBigUint64(stat + 8, 0xffffffffffffffffn, true)
      view.setBigUint64(stat + 16, 0xffffffffffffffffn, true)
      return 0
    },
    fd_prestat_get: () => WASI_EBADF,
    clock_time_get(id: number, _precision: bigint, out: number) {
      const nanos =
        id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1_000_000))
      dataView().setBigUint64(out, nanos, true)
      return 0
    },
    clock_res_get(_id: number, out: number) {
      dataView().setBigUint64(out, 1000n, true)
      return 0
    },
    random_get(pointer: number, length: number) {
      const target = u8().subarray(pointer, pointer + length)
      // getRandomValues rejects views over 65536 bytes.
      for (let offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(target.subarray(offset, Math.min(length, offset + 65536)))
      }
      return 0
    },
    proc_exit(code: number) {
      throw new Error(`opentui wasm: proc_exit(${code})`)
    },
  }

  const imports: Record<string, Record<string, any>> = {}
  for (const entry of WebAssembly.Module.imports(module)) {
    const namespace = (imports[entry.module] ??= {})
    if (entry.kind !== "function") continue
    const key = `${entry.module}.${entry.name}`
    if (entry.module === "wasi_snapshot_preview1") {
      namespace[entry.name] =
        wasi[entry.name] ??
        (() => {
          stats.unimplementedImports.add(key)
          return WASI_ENOSYS
        })
      continue
    }
    // Everything else is a native symbol with no wasm implementation (C++
    // exception runtime, anything the generator could not drop).
    namespace[entry.name] = () => {
      stats.unimplementedImports.add(key)
      throw new Error(`opentui wasm: native import ${key} is not available in the browser build`)
    }
  }

  const instance = await WebAssembly.instantiate(module, imports)
  const exports = instance.exports as Record<string, any>
  memory = exports.memory as WebAssembly.Memory
  const table = exports.__indirect_function_table as WebAssembly.Table
  const malloc = exports.wasmTermAlloc as (size: number) => number
  const free = exports.wasmTermFree as (pointer: number) => void
  if (!malloc || !free) throw new Error("opentui wasm: wasmTermAlloc/wasmTermFree exports are missing")
  // WASI reactor: runs libc and C++ static constructors.
  exports._initialize?.()

  const allocate = (size: number) => {
    const pointer = malloc(size) >>> 0
    if (pointer === 0) throw new Error(`opentui wasm: out of memory allocating ${size} bytes`)
    return pointer
  }

  // --- pinned mirrors for ptr() ------------------------------------------
  interface Pin {
    address: number
    size: number
  }
  const pins = new WeakMap<ArrayBufferLike, Pin>()
  const pinCleanup = new FinalizationRegistry<Pin>((pin) => {
    stats.pinnedBytes -= pin.size
    free(pin.address)
  })

  const ptr = (value: ArrayBufferLike | ArrayBufferView): number => {
    const buffer = ArrayBuffer.isView(value) ? value.buffer : value
    const offset = ArrayBuffer.isView(value) ? value.byteOffset : 0
    // A view that already lives in linear memory is its own address.
    if (buffer === memory.buffer) return offset
    let pin = pins.get(buffer)
    if (pin === undefined || pin.size !== buffer.byteLength) {
      pin = { address: allocate(Math.max(buffer.byteLength, 1)), size: buffer.byteLength }
      pins.set(buffer, pin)
      pinCleanup.register(buffer, pin)
      stats.pinnedBytes += pin.size
    }
    u8().set(new Uint8Array(buffer), pin.address)
    return pin.address + offset
  }

  const toArrayBuffer = (pointer: number | bigint, offset: number | undefined, length: number): ArrayBuffer => {
    const start = Number(pointer) + (offset ?? 0)
    return (memory.buffer as ArrayBuffer).slice(start, start + length)
  }

  // --- calls ---------------------------------------------------------------
  interface Borrow {
    source: Uint8Array
    address: number
  }

  const bytesOf = (value: ArrayBufferLike | ArrayBufferView): Uint8Array =>
    ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value)

  const wrapSymbol = (name: string, definition: FfiFunction): ((...args: any[]) => any) => {
    const fn = exports[name] as ((...args: any[]) => any) | undefined
    const signature = signatures.get(name)
    if (typeof fn !== "function" || signature === undefined) {
      stats.missingSymbols.push(name)
      return () => {
        throw new Error(`opentui wasm: native symbol ${name} is not available in the browser build`)
      }
    }
    const declared = definition.args ?? []
    if (declared.length !== signature.params.length) {
      throw new Error(
        `opentui wasm: ${name} declares ${declared.length} args but the module takes ${signature.params.length}`,
      )
    }
    const pointerArg = declared.map((type) => POINTER_TYPES.has(type))
    const params = signature.params
    const returns = definition.returns ?? "void"
    const resultType = signature.results[0]
    const arity = params.length
    const anyPointer = pointerArg.includes(true)

    const convertResult = (result: any): any => {
      switch (returns) {
        case "void":
          return undefined
        case "bool":
          return result !== 0
        case "u8":
        case "uint8_t":
          return result & 0xff
        case "u16":
        case "uint16_t":
          return result & 0xffff
        case "u32":
        case "uint32_t":
        case "usize":
          return typeof result === "bigint" ? Number(result) : result >>> 0
        case "ptr":
        case "pointer":
        case "function":
        case "callback": {
          const address = typeof result === "bigint" ? Number(result) : result >>> 0
          return address === 0 ? null : address
        }
        case "u64":
        case "uint64_t":
          return resultType === "i64" ? BigInt.asUintN(64, result) : BigInt(result >>> 0)
        case "i64":
        case "int64_t":
          return resultType === "i64" ? result : BigInt(result)
        default:
          return result
      }
    }

    const convertScalar = (value: any, type: ValType): any => {
      if (type === "i64") return typeof value === "bigint" ? value : BigInt(value ?? 0)
      if (type === "i32") {
        if (typeof value === "number") return value
        if (typeof value === "bigint") return Number(BigInt.asUintN(32, value))
        if (typeof value === "boolean") return value ? 1 : 0
        return value ?? 0
      }
      return value ?? 0
    }

    if (!anyPointer) {
      return (...args: any[]) => {
        stats.calls++
        for (let index = 0; index < arity; index++) args[index] = convertScalar(args[index], params[index]!)
        args.length = arity
        return convertResult(fn(...args))
      }
    }

    return (...args: any[]) => {
      stats.calls++
      let borrows: Borrow[] | undefined
      for (let index = 0; index < arity; index++) {
        const value = args[index]
        if (!pointerArg[index]) {
          args[index] = convertScalar(value, params[index]!)
          continue
        }
        if (value == null) args[index] = 0
        else if (typeof value === "number") args[index] = value
        else if (typeof value === "bigint") args[index] = Number(value)
        else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
          const source = bytesOf(value)
          if (source.buffer === memory.buffer) args[index] = source.byteOffset
          else if (source.byteLength === 0) args[index] = 0
          else {
            const address = allocate(source.byteLength)
            u8().set(source, address)
            ;(borrows ??= []).push({ source, address })
            stats.borrowedBytes += source.byteLength
            args[index] = address
          }
        } else if (typeof value === "object" && "ptr" in value) args[index] = value.ptr ?? 0
        else throw new TypeError(`opentui wasm: ${name} argument ${index} is not a pointer`)
      }
      args.length = arity
      try {
        return convertResult(fn(...args))
      } finally {
        if (borrows !== undefined) {
          const memoryBytes = u8()
          for (const borrow of borrows) {
            borrow.source.set(memoryBytes.subarray(borrow.address, borrow.address + borrow.source.byteLength))
            free(borrow.address)
          }
        }
      }
    }
  }

  // --- callbacks -----------------------------------------------------------
  const trampolines = new Map<string, WebAssembly.Module>()
  const freeSlots: number[] = []

  function JSCallback(callback: (...args: any[]) => any, definition: FfiFunction): FfiCallback {
    const declared = definition.args ?? []
    const returns = definition.returns ?? "void"
    const result = wasmTypeOf(returns)
    const type: FuncType = {
      params: declared.map((arg) => wasmTypeOf(arg) ?? "i32"),
      results: result === undefined ? [] : [result],
    }
    const key = `${type.params.join(",")}>${type.results.join(",")}`
    let trampoline = trampolines.get(key)
    if (trampoline === undefined) trampolines.set(key, (trampoline = trampolineModule(type)))

    const unsigned = declared.map(
      (arg) => POINTER_TYPES.has(arg) || arg === "u32" || arg === "uint32_t" || arg === "usize",
    )
    const boolean = declared.map((arg) => arg === "bool")
    const entry = (...args: any[]) => {
      for (let index = 0; index < args.length; index++) {
        if (unsigned[index]) args[index] = args[index] >>> 0
        else if (boolean[index]) args[index] = args[index] !== 0
      }
      const value = callback(...args)
      if (result === undefined) return undefined
      if (result === "i64") return typeof value === "bigint" ? value : BigInt(value ?? 0)
      if (typeof value === "boolean") return value ? 1 : 0
      return value ?? 0
    }
    const exported = new WebAssembly.Instance(trampoline, { e: { f: entry } }).exports.f as Function
    const slot = freeSlots.pop() ?? table.grow(1)
    table.set(slot, exported)
    let address: number | null = slot
    return {
      get ptr() {
        return address
      },
      threadsafe: false,
      close() {
        if (address === null) return
        table.set(address, null)
        freeSlots.push(address)
        address = null
      },
    }
  }

  return {
    dlopen(_path, symbols) {
      const wrapped: Record<string, (...args: any[]) => any> = {}
      for (const [name, definition] of Object.entries(symbols)) wrapped[name] = wrapSymbol(name, definition)
      return { symbols: wrapped, close() {} }
    },
    ptr,
    toArrayBuffer,
    JSCallback: JSCallback as unknown as WasmFfi["JSCallback"],
    suffix: "wasm",
    stats,
    memory,
  }
}
