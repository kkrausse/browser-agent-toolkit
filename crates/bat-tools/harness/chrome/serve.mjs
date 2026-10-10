// Static server for the Chrome measurement of the esbuild shim (cross-origin isolated).
//   node serve.mjs <esbuild-trace.jsonl> <app dir with the shim installed> [port 4104]
// Then open http://127.0.0.1:<port>/ ; the page posts its result to /result and shows it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [traceFile, appDir, port = '4104'] = process.argv.slice(2);
const pkg = path.join(fs.realpathSync(path.resolve(appDir, 'node_modules/vite')), '../esbuild');
const records = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.api === 'transform').map(r => ({ input: r.input, options: r.options }));
const files = {
  '/': [path.join(here, 'index.html'), 'text/html'], '/worker.js': [path.join(here, 'worker.js'), 'text/javascript'],
  '/bat-main.js': [path.join(pkg, 'lib/bat-main.js'), 'text/javascript'], '/bat-oxc.js': [path.join(pkg, 'lib/bat-oxc.js'), 'text/javascript'],
  '/bat_esbuild.wasm': [path.join(pkg, 'lib/bat_esbuild.wasm'), 'application/wasm'],
  '/esbuild-browser.js': [path.join(pkg, 'lib/browser.min.js'), 'text/javascript'], '/esbuild.wasm': [path.join(pkg, 'esbuild.wasm'), 'application/wasm'],
};
http.createServer((request, response) => {
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  const url = request.url.split('?')[0];
  if (url === '/trace.json') return response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(records));
  if (url === '/result' && request.method === 'POST') { let body = ''; request.on('data', d => body += d); request.on('end', () => { fs.writeFileSync(path.join(process.cwd(), 'chrome-result.json'), body); response.writeHead(204, headers).end(); }); return; }
  const file = files[url];
  if (!file) return response.writeHead(404, headers).end();
  response.writeHead(200, { ...headers, 'content-type': file[1] }).end(fs.readFileSync(file[0]));
}).listen(+port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
