import { attachKernel, type KernelInstance } from '../runtime/src/kernel/attach'

let k: KernelInstance
self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (m.type === 'attach') {
    k = await attachKernel({ module: m.module, memory: m.memory, canBlock: true })
    postMessage({ type: 'ready', tid: k.tid })
  } else if (m.type === 'hammer') {
    k.x.bat_spike_count(m.n)
    k.x.bat_spike_map(m.mapBase, m.mapN)
    postMessage({ type: 'done', tid: k.tid })
  } else if (m.type === 'block') {
    const value = k.x.bat_spike_block()
    postMessage({ type: 'woke', value, tid: k.tid })
  }
}
