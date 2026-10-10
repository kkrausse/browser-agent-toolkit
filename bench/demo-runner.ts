// A stand-in for the node runtime: what a spawned process runs in the kernel
// harness pages. argv[1] selects a behaviour.
import type { ProcessContext } from '../runtime/src/kernel/process-worker'

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function run({ kernel: k, info, pid }: ProcessContext): Promise<number> {
  const mode = info.argv[1]
  if (mode === 'echo') {
    k.write(1, enc.encode(`pid=${pid} cwd=${k.getcwd()} argv=${info.argv.join(',')} env=${info.env.GREETING}\n`))
    const buf = new Uint8Array(4096)
    for (;;) {
      const n = k.read(0, buf) // blocks in the kernel until the parent writes or closes
      if (n === 0) break
      k.write(1, enc.encode(dec.decode(buf.subarray(0, n)).toUpperCase()))
    }
    return 3
  }
  if (mode === 'server') {
    const l = k.listen(Number(info.argv[2]))
    k.write(1, enc.encode('listening\n'))
    const s = k.accept(l)! // blocks
    const buf = new Uint8Array(4096)
    const n = k.read(s, buf)
    k.write(s, enc.encode(`HTTP/1.1 200 OK\r\n\r\nyou said: ${dec.decode(buf.subarray(0, n))}`))
    k.close(s)
    k.close(l)
    return 0
  }
  if (mode === 'hang') {
    const [r] = k.pipe()
    k.write(1, enc.encode('hanging\n'))
    k.read(r, new Uint8Array(1)) // never returns
    return 0
  }
  if (mode === 'child-writes') {
    k.writeFile('/workspace/from-child.txt', `written by pid ${pid}`)
    const st = k.stat('/workspace/node_modules')
    k.write(1, enc.encode(`kind=${st.kind}\n`))
    return 0
  }
  k.write(2, enc.encode(`unknown mode ${mode}\n`))
  return 64
}
