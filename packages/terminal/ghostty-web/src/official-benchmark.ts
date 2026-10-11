/** Run with bun src/official-benchmark.ts [legacy-source.ts legacy.wasm]. */
import { Ghostty } from './ghostty';
const legacySource = process.argv[2];
const Engine = legacySource ? (await import(legacySource)).Ghostty : Ghostty;
const engine = await Engine.load(process.argv[3]);
const cols = 120, rows = 40;
const frames = {
  plain: '\x1b[H' + Array.from({ length: rows }, (_, y) => `\x1b[${y + 1};1H` + 'abcdefghijklmnopqrstuvwx'.repeat(5)).join(''),
  styled: '\x1b[H' + Array.from({ length: rows }, (_, y) => `\x1b[${y + 1};1H` + Array.from({ length: 12 }, (_, x) => `\x1b[${x % 2 ? 1 : 22};38;2;${x * 20};${y * 6};128;48;5;${16 + x}mabcdefghij`).join('')).join(''),
};
const results: Record<string, unknown> = {};
for (const [name, frame] of Object.entries(frames)) {
  const t = engine.createTerminal(cols, rows);
  const sample = () => { t.write(frame); t.update(); t.getViewport(); t.markClean(); };
  for (let i = 0; i < 150; i++) sample();
  const times = [];
  for (let i = 0; i < 500; i++) { const start = performance.now(); sample(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  results[name] = { medianMs: times[250], p95Ms: times[475], meanMs: times.reduce((a, b) => a + b) / times.length };
  const start = performance.now();
  for (let i = 0; i < 100000; i++) { t.update(); t.getViewport(); }
  results[`${name}IdleUs`] = (performance.now() - start) * 1000 / 100000;
  t.free();
}
console.log(JSON.stringify({ engine: legacySource ? 'legacy' : 'official', cols, rows, warmup: 150, samples: 500, results }, null, 2));
