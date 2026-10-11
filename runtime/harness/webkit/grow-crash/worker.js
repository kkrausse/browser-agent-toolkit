// A module that only imports a shared memory: every instance of it is anchored to that memory.
const bytes = new Uint8Array([0,97,115,109,1,0,0,0, 2,11,1,1,101,1,109,2,3,1,128,128,4])
const mod = new WebAssembly.Module(bytes)
onmessage = (e) => {
  const { memory, grow } = e.data
  if (grow) {
    // The grower: grows the shared memory a page at a time.
    let n = 0
    const step = () => { try { for (let i = 0; i < 20; i++) { memory.grow(1); n++ } } catch (err) { postMessage({ done: n }); return } setTimeout(step, 0) }
    step()
    return
  }
  let keep = []
  for (let i = 0; i < 50; i++) keep.push(new WebAssembly.Instance(mod, { e: { m: memory } }))
  postMessage({ ready: true })
}
