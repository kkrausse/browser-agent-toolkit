import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Serves what `codex.ts` wrote (`.editor/codex/`) under `/codex/`: the terminal's page code, its Worker, and the
 * codex module, which exists only precompressed (`<name>.wasm.br`, `.gz`) and is sent in whichever the browser takes. */
export function createCodexFiles(directory: string) {
  const root = resolve(directory)
  const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', json: 'application/json' }
  return {
    /** False until `bun codex.ts` has run: the editor then offers OpenCode only. */
    available: () => existsSync(resolve(root, 'codex.json')),
    matches: (path: string) => path.startsWith('/codex/'),
    async fetch(request: Request): Promise<Response> {
      const name = decodeURIComponent(new URL(request.url).pathname.slice('/codex/'.length))
      const path = resolve(root, name)
      if (!path.startsWith(`${root}${sep}`) || name.includes('\0')) return new Response('Not found', { status: 404 })
      const headers: Record<string, string> = {
        'Content-Type': types[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
        // Only the module's name carries its hash.
        'Cache-Control': /-[0-9a-f]{16}\.wasm$/.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
      }
      const plain = Bun.file(path)
      if (await plain.exists()) return new Response(plain, { headers })
      const accepts = request.headers.get('accept-encoding') ?? ''
      for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
        const packed = Bun.file(path + suffix)
        if (!accepts.includes(encoding) || !(await packed.exists())) continue
        return new Response(packed, { headers: { ...headers, 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } })
      }
      return new Response('Not found', { status: 404 })
    },
  }
}
