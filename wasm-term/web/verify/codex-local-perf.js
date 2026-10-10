// Numbers for codex-local's two transports against mock-llm, in Chrome:
//   web/verify/run.sh codex-local-perf
// - a first request (new connection: for the tunnel a WebSocket to the relay, TCP, the TLS
//   handshake in the module and the HTTP/2 preface; for fetch one browser fetch through the
//   HTTP relay) and requests on the connection that is then open, from the module's probe mode
//   (ports/codex/main/src/local.rs, CODEX_WASM_TLS_PROBE);
// - time from Enter to the first byte of the reply reaching the terminal, for the first turn
//   of a session and for later ones, with the mock provider (HTTP stream in both transports)
//   and with codex's own provider signed in with an API key (tunnel: the Responses WebSocket;
//   fetch: the HTTP stream).
// The mock answers at once and sends a chunk every 15 ms, so these are transport costs.
// Returns the numbers; nothing is asserted.

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 10) / 10;
  return sorted.length ? { n: sorted.length, min: round(sorted[0]), median: round(sorted[Math.floor((sorted.length - 1) / 2)]), max: round(sorted.at(-1)) } : { n: 0 };
};
const text = async () => (await page.evaluate(() => window.wasmTerm.screen())).join("\n");
const waitFor = (needle, timeout = 60000) => page.waitForFunction((value) => window.wasmTerm?.screen().join("\n").includes(value), needle, { timeout });

async function probe(net, url, repeat) {
  await page.goto(`${BASE}/?guest=codex-local&net=${net}${BUILD_QUERY}&persist=0&shell=off&env=CODEX_WASM_TLS_PROBE=${encodeURIComponent(url)}&env=CODEX_WASM_TLS_PROBE_REPEAT=${repeat}`);
  await page.waitForFunction(() => window.wasmTerm?.exit, null, { timeout: 120000 });
  const flat = await page.evaluate(() => window.wasmTerm.screen().join("").replace(/\s+/g, ""));
  return [...flat.matchAll(/head([\d.]+)ms/g)].map(match => Number(match[1]));
}

/** Types a prompt, presses Enter, and times the first terminal output that contains `expect`. */
async function firstByte(prompt, expect) {
  await page.evaluate(() => {
    const terminal = window.wasmTerm.terminal;
    if (!window.__perf) {
      const write = terminal.write.bind(terminal);
      const decoder = new TextDecoder();
      window.__perf = { armed: null };
      terminal.write = (data) => {
        const armed = window.__perf.armed;
        if (armed && !armed.at) {
          armed.seen += typeof data === "string" ? data : decoder.decode(data, { stream: true });
          if (armed.seen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").includes(armed.expect)) armed.at = performance.now();
        }
        return write(data);
      };
    }
  });
  await page.keyboard.type(prompt, { delay: 8 });
  await page.waitForTimeout(400);
  await page.evaluate((expect) => {
    window.__perf.armed = { expect, seen: "", at: 0, from: performance.now() };
    window.wasmTerm.program.write("\r");
  }, expect);
  await page.waitForFunction(() => window.__perf.armed.at > 0, null, { timeout: 60000 });
  const ms = await page.evaluate(() => window.__perf.armed.at - window.__perf.armed.from);
  await page.waitForFunction(() => !/esc to interrupt/.test(window.wasmTerm.screen().join("\n")), null, { timeout: 90000 });
  await page.waitForTimeout(500);
  return ms;
}

// A different scripted reply each turn: the TUI repaints earlier replies when Enter is pressed,
// so the text waited for has to be one that is not on the screen yet.
// One word each: the TUI draws with cursor movements, so only the inside of a word is contiguous.
const TURNS = [["hi there", "Hello"], ["show me markdown", "Scripted"], ["long scroll", "intentionally"]];

async function turns(net, backend, sessions) {
  const first = [];
  const later = [];
  for (let session = 0; session < sessions; session++) {
    await page.goto(`${BASE}/?guest=codex-local&net=${net}${BUILD_QUERY}&backend=${backend}&reset=1&shell=off&env=CODEX_WASM_SHELL=0`);
    if (backend === "mock-auth") {
      await waitFor("Sign in with ChatGPT", 120000);
      await page.evaluate(() => window.wasmTerm.terminal.focus());
      await page.keyboard.press("3");
      await page.waitForTimeout(800);
      await page.keyboard.type("sk-mock-perf-not-a-real-key", { delay: 5 });
      await page.keyboard.press("Enter");
      for (let i = 0; i < 4 && !/Ask Codex/.test(await text()); i++) { await page.waitForTimeout(1500); if (!/Ask Codex/.test(await text())) await page.keyboard.press("Enter"); }
    }
    await waitFor("Ask Codex", 120000);
    await page.evaluate(() => window.wasmTerm.terminal.focus());
    // Whatever codex does by itself after starting (model list, prewarm) is over before the first prompt.
    await page.waitForTimeout(2500);
    for (const [index, [prompt, expect]] of TURNS.entries()) {
      const ms = await firstByte(prompt, expect);
      (index === 0 ? first : later).push(ms);
    }
  }
  return { firstTurnMs: stats(first), laterTurnsMs: stats(later) };
}

const out = {};
for (const net of ["tunnel", "fetch"]) {
  const url = net === "tunnel" ? "https://mock-llm.test/health" : "http://127.0.0.1:4791/health";
  const first = [];
  const reused = [];
  for (let run = 0; run < 7; run++) {
    const [head, ...rest] = await probe(net, url, 4);
    first.push(head);
    reused.push(...rest);
  }
  out[net] = {
    probe: { newConnectionMs: stats(first), openConnectionMs: stats(reused) },
    mockProvider: await turns(net, "mock", 4),
    openaiProviderWithApiKey: await turns(net, "mock-auth", 4),
  };
}
return out;
