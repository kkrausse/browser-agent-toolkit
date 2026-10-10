// Post-link fix-ups for dist/opentui.wasm.
//
// 1. Strip: the linked module carries 7.3 MB of DWARF (.debug_*) next to
//    1.5 MB of code and 1.4 MB of data. No wasm-strip/wasm-opt is installed
//    here, and dropping custom sections is a few lines. The `name` section
//    (function names, 0.1 MB) stays so that traps have readable stacks.
//    `--keep-debug` keeps everything.
// 2. wasm-ld emits the indirect function table with max == initial. JS callbacks
// (log sink, event bus, Yoga measure functions) need fresh table slots at
// runtime, so drop the maximum to make `table.grow()` legal.
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

export function makeTableGrowable(bytes: Uint8Array): Uint8Array {
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
  while (pos < bytes.length) {
    const sectionStart = pos
    const id = bytes[pos++]!
    const size = u32()
    const bodyStart = pos
    if (id !== 4) {
      pos = bodyStart + size
      continue
    }
    const count = u32()
    if (count !== 1) throw new Error(`expected one table, found ${count}`)
    const elementType = bytes[pos++]!
    const flags = bytes[pos++]!
    const initial = u32()
    if ((flags & 1) === 0) return bytes
    u32()
    if (pos !== bodyStart + size) throw new Error("unexpected table section layout")
    const body = [1, elementType, 0x00, ...uleb(initial)]
    const section = [4, ...uleb(body.length), ...body]
    const out = new Uint8Array(bytes.length - (pos - sectionStart) + section.length)
    out.set(bytes.subarray(0, sectionStart), 0)
    out.set(section, sectionStart)
    out.set(bytes.subarray(pos), sectionStart + section.length)
    return out
  }
  throw new Error("no table section")
}

/** Removes custom sections whose name `drop` accepts. */
export function stripCustomSections(bytes: Uint8Array, drop: (name: string) => boolean): Uint8Array {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]
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
  while (pos < bytes.length) {
    const sectionStart = pos
    const id = bytes[pos++]!
    const size = u32()
    const bodyStart = pos
    let dropped = false
    if (id === 0) {
      const nameLength = u32()
      dropped = drop(new TextDecoder().decode(bytes.subarray(pos, pos + nameLength)))
    }
    pos = bodyStart + size
    if (!dropped) kept.push(bytes.subarray(sectionStart, pos))
  }
  const out = new Uint8Array(kept.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of kept) {
    out.set(part, at)
    at += part.length
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const [input, output] = args.filter((arg) => !arg.startsWith("--"))
  if (!input || !output) throw new Error("usage: postprocess.ts <in.wasm> <out.wasm> [--keep-debug]")
  let result = makeTableGrowable(new Uint8Array(await Bun.file(input).arrayBuffer()))
  if (!args.includes("--keep-debug")) result = stripCustomSections(result, (name) => name.startsWith(".debug_") || name === "producers")
  new WebAssembly.Module(result)
  await Bun.write(output, result)
}
