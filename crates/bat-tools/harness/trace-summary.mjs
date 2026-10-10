// trace-summary.mjs <esbuild-trace.jsonl>: one line per recorded esbuild call.
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l));
let total = 0;
for (const r of lines) {
  total += r.ms ?? 0;
  const o = r.options ?? {};
  const what = r.api.startsWith('transform') ? `${(o.sourcefile ?? '').slice(-60)} in=${r.input.length} out=${r.result?.code.length} opts=${JSON.stringify({ ...o, sourcefile: undefined })}`
    : r.api === 'context' || r.api === 'build' ? JSON.stringify(o).slice(0, 1500) : r.api === 'context.rebuild' ? `outputs=${Object.keys(r.result?.metafile?.outputs ?? {}).length}` : JSON.stringify({ ...r, pid: undefined, at: undefined, api: undefined, ms: undefined }).slice(0, 300);
  console.log(`${String(r.pid).padStart(7)} ${String(r.at).padStart(8)} ${r.api.padEnd(16)} ${String(r.ms ?? '').padStart(8)}ms ${what}`);
}
console.log(`calls ${lines.length}, total ${total.toFixed(1)} ms`);
