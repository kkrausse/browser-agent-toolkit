// First look at load time and input latency of the opencode guest. Numbers,
// not pass/fail. Run: web/verify/run.sh opencode-perf (dev server and mock-llm up).
//
// Latency here is "event on the page -> the next bytes from the program reach
// terminal.write": page -> ring -> Worker -> TUI update -> wasm renderer ->
// postMessage -> page. The emulator's own paint (next animation frame) comes
// on top and is not included.

const waitFor = (needle, timeout = 30000) =>
  page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
};

await page.setViewportSize({ width: 1200, height: 800 });
const loads = [];
let resources;
for (let run = 0; run < 3; run++) {
  await page.goto(`${BASE}/?guest=opencode&persist=0`);
  await waitFor("Ask anything");
  // From navigation start, by the page's own clock.
  loads.push(await page.evaluate(() => performance.now()));
  resources = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => ({
    name: new URL(entry.name).pathname, kB: Math.round(entry.encodedBodySize / 1024), ms: Math.round(entry.responseEnd),
  })));
}

// Marks: every input event and every terminal.write, on one clock.
await page.evaluate(() => {
  const terminal = window.wasmTerm.terminal;
  const marks = (window.__marks = { input: [], output: [] });
  const write = terminal.write.bind(terminal);
  terminal.write = (data) => { marks.output.push([performance.now(), data.length]); return write(data); };
  for (const type of ["keydown", "wheel"]) window.addEventListener(type, () => marks.input.push(performance.now()), { capture: true });
  terminal.focus();
});
const latencies = () => page.evaluate(() => {
  const { input, output } = window.__marks;
  const result = input.map(at => (output.find(([t]) => t >= at)?.[0] ?? NaN) - at).filter(Number.isFinite);
  window.__marks.input.length = 0;
  window.__marks.output.length = 0;
  return result;
});

for (const char of "the quick brown fox jumps over the lazy dog") { await page.keyboard.press(char === " " ? "Space" : char); await page.waitForTimeout(70); }
const typing = stats(await latencies());
await page.keyboard.press("Enter");
await waitFor("tok/s");

await page.keyboard.type("long scroll"); await page.keyboard.press("Enter");
await waitFor("END-OF-LONG-RESPONSE", 40000); await waitFor("tok/s");
const streamed = await page.evaluate(() => {
  const output = window.__marks.output;
  const span = output[output.length - 1][0] - output[0][0];
  return { frames: output.length, bytes: output.reduce((sum, [, n]) => sum + n, 0), seconds: +(span / 1000).toFixed(1) };
});
await latencies();
const [w, h] = await page.evaluate(() => { const m = window.wasmTerm.terminal.renderer.getMetrics(); return [m.width, m.height]; });
await page.mouse.move(40 * w, 15 * h);
for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? -120 : 120); await page.waitForTimeout(70); }
const scrolling = stats(await latencies());

await page.keyboard.press("Control+c"); await page.keyboard.press("Control+c");
return {
  note: "ms; latency = input event -> next program output at terminal.write (excludes the emulator's paint)",
  loadToPromptMs: loads.map(Math.round),
  largest: resources.filter(entry => entry.kB > 100).sort((a, b) => b.kB - a.kB),
  typing, scrolling, streamed,
};
