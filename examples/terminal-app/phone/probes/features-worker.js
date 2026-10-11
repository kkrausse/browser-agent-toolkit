// The questions of runtime/harness/webkit/probe.ts that need a worker, asked one at a time.
const say = (name, value) => postMessage({ name, value })
const err = e => `FAILED ${e && e.name}: ${e && e.message}`
onmessage = async ({ data }) => {
  if (data.memory) {
    // A shared memory as the kernel makes it: `pages` at once, never grown (or growable to `maximum`).
    const { pages, maximum, touch } = data.memory
    const t = performance.now()
    try {
      const memory = new WebAssembly.Memory({ initial: pages, maximum, shared: true })
      let note = `ok in ${(performance.now() - t).toFixed(1)} ms, ${memory.buffer.byteLength / 1048576} MiB`
      if (touch) { const t1 = performance.now(); new Uint8Array(memory.buffer, 0, touch * 1048576).fill(1); note += `; wrote ${touch} MiB in ${Math.round(performance.now() - t1)} ms` }
      say(data.label, note)
    } catch (e) { say(data.label, err(e)) }
    return postMessage({ done: true })
  }
  try {
    const d = await navigator.storage.getDirectory()
    const f = await d.getFileHandle('probe', { create: true })
    let h
    try { h = await f.createSyncAccessHandle(); say('sync access handle', 'ok') } catch (e) { say('sync access handle', err(e)); h = await f.createSyncAccessHandle({ mode: 'readwrite-unsafe' }) }
    say('  its mode property', String(h.mode ?? 'none (exclusive handles: expected in WebKit)'))
    try { const h2 = await f.createSyncAccessHandle({ mode: 'readwrite-unsafe' }); say('  a second handle on the same file', 'ok (shared handles, as in Chrome)'); h2.close() } catch (e) { say('  a second handle on the same file', `refused, ${e.name} (expected in WebKit: the runtime reads through its supervisor)`) }
    h.write(new TextEncoder().encode('snapshot-me'), { at: 0 }); h.flush()
    // What the arriving image is read through where handles are exclusive (webkit-perf, section 4).
    try { const file = await f.getFile(); say('  getFile() while the handle is held', `ok, ${file.size} bytes, reads ${JSON.stringify(new FileReaderSync().readAsText(file.slice(0, 11)))}`) } catch (e) { say('  getFile() while the handle is held', err(e)) }
    h.close()
    try { const g = await d.getFileHandle('probe-moved', { create: true }); await g.move(d, 'probe-moved-2'); say('  FileSystemFileHandle.move(dir, name)', 'ok'); await d.removeEntry('probe-moved-2') } catch (e) { say('  FileSystemFileHandle.move(dir, name)', err(e)) }
    await d.removeEntry('probe').catch(() => {})
  } catch (e) { say('origin private file system', err(e)) }
  say('Atomics.waitAsync', typeof Atomics.waitAsync)
  try { new Worker('features-worker.js').terminate(); say('nested worker', 'ok') } catch (e) { say('nested worker', err(e)) }
  try { new Request('/', { method: 'POST', body: new ReadableStream(), duplex: 'half' }); say('streamed request body (duplex: half)', 'ok') } catch (e) { say('streamed request body (duplex: half)', err(e)) }
  say('navigator.serviceWorker in a worker', String(!!navigator.serviceWorker) + (navigator.serviceWorker ? `, controlled: ${!!navigator.serviceWorker.controller}` : ''))
  postMessage({ done: true })
}
