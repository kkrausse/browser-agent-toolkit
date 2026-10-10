// Bootstrap of a process worker. kerneld creates these (one warm spare ahead
// of demand); each attaches to the kernel, opens its own read-only handles on
// the mounted images, and waits to be given a pid. What a process then *runs*
// is the runner module's business (the node runtime, a WASI tool, ...):
//   export async function run(ctx: ProcessContext): Promise<number | void>
import { attachKernel, type KernelInstance } from './attach'
import { createKernel, type Kernel, type ProcInfo } from './kernel'
import { openImageHandle, type SyncHandle } from './opfs'

export interface ProcessContext {
  kernel: Kernel
  pid: number
  info: ProcInfo
}

let inst: KernelInstance
let kernel: Kernel
let namespace = 'default'
const handles: (SyncHandle | undefined)[] = []

async function openImages() {
  const names = kernel.imageNames()
  for (let id = 0; id < names.length; id++) {
    const name = names[id]
    if (name !== undefined && !handles[id]) {
      try {
        handles[id] = await openImageHandle(namespace, name)
      } catch (e) {
        // Reads fall back to the supervisor proxy.
        console.warn(`process worker: no handle for image ${name}: ${e}`)
      }
    }
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  try {
    if (m.type === 'attach') {
      namespace = m.namespace
      inst = await attachKernel({
        module: m.module,
        memory: m.memory,
        canBlock: true,
        host: {
          imageRead(image, offset, dst) {
            const h = handles[image]
            return h ? h.read(dst, { at: offset }) : -11
          },
        },
      })
      kernel = createKernel(inst)
      await openImages()
      postMessage({ type: 'ready', thread: inst.thread, tid: inst.tid })
    } else if (m.type === 'images') {
      await openImages()
    } else if (m.type === 'run') {
      const pid: number = m.pid
      let code = 1
      try {
        if (kernel.x.bat_proc_attach(pid) < 0) throw new Error(`no such process ${pid}`)
        await openImages()
        const info = kernel.procInfo(pid)
        const runner = await import(/* @vite-ignore */ m.runnerUrl)
        code = (await runner.run({ kernel, pid, info } satisfies ProcessContext)) ?? 0
      } catch (err) {
        const text = new TextEncoder().encode(`${(err as Error)?.stack ?? err}\n`)
        try {
          kernel.write(2, text)
        } catch {
          console.error(err)
        }
      }
      kernel.exit(code)
      postMessage({ type: 'exited', pid, code })
    }
  } catch (err) {
    postMessage({ type: 'error', error: String((err as Error)?.stack ?? err) })
  }
}
