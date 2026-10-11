const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' }
Bun.serve({ port: Number(process.argv[2]), hostname: '127.0.0.1', fetch(req) {
  const p = new URL(req.url).pathname
  if (p === '/') return new Response(Bun.file(import.meta.dir + '/index.html'), { headers: { ...h, 'content-type': 'text/html' } })
  if (p === '/worker.js') return new Response(Bun.file(import.meta.dir + '/worker.js'), { headers: { ...h, 'content-type': 'text/javascript' } })
  return new Response('no', { status: 404, headers: h })
} })
