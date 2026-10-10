// Boots the real runtime the way the toolkit does (manifest → runtime/host.js
// → bootRuntime) and exposes it for scripted checks:
//   batHost.host                       the RuntimeHost
//   batHost.node(files, args, opts)    write files, spawn `node …`, collect output
const out = document.getElementById('out')!
const params = new URLSearchParams(location.search)

async function main() {
  const manifestUrl = new URL('/editor/manifest.json', location.href).href
  const manifest = await (await fetch(manifestUrl, { cache: 'no-store' })).json()
  const { bootRuntime } = await import(/* @vite-ignore */ new URL(manifest.runtime?.entry ?? 'runtime/host.js', manifestUrl).href)
  const progress: unknown[] = []
  const t0 = performance.now()
  const host = await bootRuntime({
    manifestUrl,
    manifest,
    namespace: params.get('ns') ?? 'bat-net',
    persist: params.get('persist') !== '0',
    onProgress: (p: any) => {
      progress.push({ ...p, at: Math.round(performance.now() - t0) })
      if (p.phase === 'image' && p.total) out.textContent = `image ${((p.loaded / p.total) * 100).toFixed(0)}%`
    },
  })
  out.textContent = `ready ${JSON.stringify(host.timings)}`
  const decoder = () => new TextDecoder()
  const collect = async (stream: ReadableStream<Uint8Array>, sink: { text: string }) => {
    const d = decoder()
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.text += d.decode(value, { stream: true })
    }
  }
  const procs: any[] = []
  async function node(files: Record<string, string>, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    for (const [path, text] of Object.entries(files)) {
      await host.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/')
      await host.fs.writeFile(path, text)
    }
    const p = await host.spawn({
      argv: ['node', ...args],
      cwd: opts.cwd ?? '/workspace',
      env: { PATH: '/workspace/node_modules/.bin:/usr/local/bin:/bin', HOME: '/home/user', TMPDIR: '/tmp', ...opts.env },
    })
    const stdout = { text: '' }
    const stderr = { text: '' }
    void collect(p.stdout, stdout)
    void collect(p.stderr, stderr)
    const entry = { process: p, stdout, stderr, exit: undefined as unknown }
    void p.exited.then((e: unknown) => (entry.exit = e))
    procs.push(entry)
    return entry
  }
  ;(window as any).batHost = { host, node, procs, progress, manifest }
}
main().catch((e) => {
  out.textContent = `error: ${e?.code ?? ''} ${e?.stack ?? e}`
  ;(window as any).batHostError = e
})
