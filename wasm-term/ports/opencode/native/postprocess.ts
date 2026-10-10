// Post-link fix-up for dist/opentui.wasm.
//
// wasm-ld emits the indirect function table with max == initial. JS callbacks
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

if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error("usage: postprocess.ts <in.wasm> <out.wasm>")
  const result = makeTableGrowable(new Uint8Array(await Bun.file(input).arrayBuffer()))
  new WebAssembly.Module(result)
  await Bun.write(output, result)
}
