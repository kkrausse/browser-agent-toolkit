import type { Endpoint, Execution } from "../../src/index.js";
import { assert, browserCase, capture, mount, type BrowserTest } from "./harness.js";

const port = 3211;
const totalBytes = 8 * 1024 * 1024;
const bufferingBudget = 1024 * 1024;
const timeoutMs = 10_000;

// State requests and Vivari's GET / readiness probes use separate connections.
// Only the target socket contributes to `closed`; neither control traffic nor
// readiness traffic can satisfy cancellation.
const serverSource = `
  const http = require('node:http');
  const state = { entered: false, closed: 0, produced: 0, blocked: false,
    backpressures: 0, drains: 0, finished: false };
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.end('ready'); return; }
    if (req.url === '/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state));
      return;
    }
    state.entered = true;
    req.socket.once('close', () => { state.closed++; });
    if (req.url === '/never') return;
    if (req.url === '/open') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.from([0, 255, 128, 65]));
      return; // Deliberately no EOF: only client cancellation closes this socket.
    }
    if (req.url !== '/large') throw new Error('Unexpected path: ' + req.url);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.on('finish', () => { state.finished = true; });
    function pump() {
      state.blocked = false;
      while (state.produced < ${totalBytes}) {
        const bytes = Buffer.alloc(32768);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (state.produced + i) % 251;
        state.produced += bytes.length;
        if (!res.write(bytes)) {
          state.blocked = true;
          state.backpressures++;
          res.once('drain', () => { state.drains++; pump(); });
          return;
        }
      }
      res.end();
    }
    pump();
  }).listen(${port});
  process.stdin.resume();
  process.stdin.on('end', () => server.close());
`;

interface State {
  entered: boolean;
  closed: number;
  produced: number;
  blocked: boolean;
  backpressures: number;
  drains: number;
  finished: boolean;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function stateOf(endpoint: Endpoint): Promise<State> {
  const response = await endpoint.fetch('/state', { signal: AbortSignal.timeout(timeoutMs) });
  assert(response.status === 200, `State request returned ${response.status}`);
  return response.json();
}

async function waitForState(endpoint: Endpoint, predicate: (state: State) => boolean, label: string) {
  return bounded((async () => {
    const deadline = Date.now() + timeoutMs;
    let state = await stateOf(endpoint);
    while (!predicate(state)) {
      assert(Date.now() < deadline, `${label}: ${JSON.stringify(state)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
      state = await stateOf(endpoint);
    }
    return state;
  })(), label);
}

// Capture only process diagnostics, never the HTTP response under test.
function diagnostics(execution: Execution) {
  const result = capture(execution, 64 * 1024);
  // Keep an early capture failure handled while the HTTP assertions run.
  void result.catch(() => {});
  return result;
}

async function finish(execution: Execution, result: ReturnType<typeof diagnostics>, endpoint: Endpoint) {
  execution.closeStdin();
  const { exit, stderr } = await bounded(result, 'HTTP fixture natural exit');
  assert(exit.exitCode === 0 && exit.signal === null && !exit.forced,
    `HTTP fixture did not exit naturally: ${JSON.stringify(exit)}`);
  assert(stderr.length === 0, `HTTP fixture stderr: ${new TextDecoder().decode(stderr)}`);
  await bounded(endpoint.closed, 'endpoint closure');
}

export const httpTests: BrowserTest[] = [
  {
    name: 'HTTP request abort before headers closes the guest socket',
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { '/http.cjs': serverSource });
      const execution = await runtime.node({ entry: '/workspace/http.cjs' });
      const result = diagnostics(execution);
      const endpoint = await runtime.expose(port, { signal: AbortSignal.timeout(timeoutMs) });
      const abort = new AbortController();
      const reason = new Error('intentional request abort');
      const pending = endpoint.fetch('/never', { signal: abort.signal }).then(
        response => ({ response, error: undefined }), error => ({ response: undefined, error }));
      await waitForState(endpoint, state => state.entered, 'guest accepted request before abort');
      abort.abort(reason);
      const outcome = await bounded(pending, 'aborted fetch rejection');
      assert(!outcome.response && outcome.error === reason, 'Fetch did not reject with the abort reason');
      const state = await waitForState(endpoint, state => state.closed === 1, 'aborted guest socket closed');
      assert(state.entered, 'Abort was not exercised on an accepted guest connection');
      await finish(execution, result, endpoint);
    })],
  },
  {
    name: 'HTTP response reader cancellation closes the guest socket',
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { '/http.cjs': serverSource });
      const execution = await runtime.node({ entry: '/workspace/http.cjs' });
      const result = diagnostics(execution);
      const endpoint = await runtime.expose(port, { signal: AbortSignal.timeout(timeoutMs) });
      // A timed abort here could close the socket and falsely credit cancel().
      const response = await bounded(endpoint.fetch('/open'), 'open response headers');
      assert(response.status === 200 && response.body, 'Expected an open response body');
      const reader = response.body.getReader();
      try {
        const first = await bounded(reader.read(), 'first response bytes');
        assert(!first.done && first.value.length > 0, 'Response ended before cancellation');
        assert((await stateOf(endpoint)).closed === 0, 'Guest socket closed before cancellation');
        await bounded(reader.cancel('intentional reader cancellation'), 'reader cancellation');
        assert((await bounded(reader.read(), 'cancelled reader EOF')).done, 'Cancelled reader remained readable');
        await waitForState(endpoint, state => state.closed === 1, 'cancelled guest socket closed');
      } finally { reader.releaseLock(); }
      await finish(execution, result, endpoint);
    })],
  },
  {
    name: 'HTTP slow reader bounds producer buffering and resumes with exact bytes',
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { '/http.cjs': serverSource });
      const execution = await runtime.node({ entry: '/workspace/http.cjs' });
      const result = diagnostics(execution);
      const endpoint = await runtime.expose(port, { signal: AbortSignal.timeout(timeoutMs) });
      const response = await endpoint.fetch('/large', { signal: AbortSignal.timeout(25_000) });
      assert(response.status === 200 && response.body, 'Expected a streaming response');
      // Observe guest progress over several completed control requests while no
      // body reads are issued. This is a buffering-budget observation, not a
      // claim that a particular wall-clock delay proves permanent quiescence.
      await waitForState(endpoint, state => state.blocked, 'producer backpressure');
      for (let i = 0; i < 8; i++) {
        const state = await stateOf(endpoint);
        assert(state.produced > 0 && state.produced <= bufferingBudget && !state.finished,
          `Unread producer exceeded buffering budget: ${JSON.stringify(state)}`);
      }
      const reader = response.body.getReader();
      let received = 0;
      let reads = 0;
      try {
        for (;;) {
          const next = await bounded(reader.read(), 'slow-reader chunk');
          if (next.done) break;
          assert(received + next.value.length <= totalBytes, 'Response exceeded expected length');
          assert(next.value.every((byte, i) => byte === (received + i) % 251),
            `Response byte mismatch at chunk starting ${received}`);
          received += next.value.length;
          // Yield to a real guest control round trip rather than eagerly drain.
          if (++reads % 16 === 0) {
            const state = await stateOf(endpoint);
            assert(state.produced - received <= bufferingBudget,
              `Slow-reader producer read-ahead exceeded budget: ${JSON.stringify({ received, ...state })}`);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      assert(received === totalBytes, `Truncated response: ${received}/${totalBytes}`);
      const state = await waitForState(endpoint, state => state.finished, 'response finish');
      assert(state.produced === totalBytes && state.backpressures > 0 && state.drains > 0,
        `Producer did not resume after backpressure: ${JSON.stringify(state)}`);
      await finish(execution, result, endpoint);
    })],
  },
  {
    name: 'HTTP stale endpoint cannot reach a replacement listener on the same port',
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      const source = (version: string) => `
        let requests = 0;
        const server = require('node:http').createServer((req, res) => {
          if (req.url === '/') { res.end('ready'); return; }
          if (req.url !== '/identity') throw new Error('Unexpected path: ' + req.url);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ version: '${version}', requests: ++requests }));
        }).listen(${port});
        process.stdin.resume();
        process.stdin.on('end', () => server.close());
      `;
      await mount(workspace, { '/old.cjs': source('old'), '/new.cjs': source('new') });
      const oldExecution = await runtime.node({ entry: '/workspace/old.cjs' });
      const oldResult = diagnostics(oldExecution);
      const oldEndpoint = await runtime.expose(port, { signal: AbortSignal.timeout(timeoutMs) });
      const first = await (await oldEndpoint.fetch('/identity', { signal: AbortSignal.timeout(timeoutMs) })).json();
      assert(first.version === 'old' && first.requests === 1, 'Old listener did not serve the first request');
      await finish(oldExecution, oldResult, oldEndpoint);

      const newExecution = await runtime.node({ entry: '/workspace/new.cjs' });
      const newResult = diagnostics(newExecution);
      const newEndpoint = await runtime.expose(port, { signal: AbortSignal.timeout(timeoutMs) });
      assert(oldEndpoint.url !== newEndpoint.url, 'Replacement reused the stale listener identity');
      const stalePreview = new URL(oldEndpoint.url);
      stalePreview.pathname += 'identity';
      for (const path of ['/identity', stalePreview.href]) {
        const error = await oldEndpoint.fetch(path, { signal: AbortSignal.timeout(timeoutMs) }).then(
          () => undefined, error => error);
        assert(error && error.code === 'CLOSED', `Stale endpoint did not reject CLOSED: ${String(error)}`);
      }
      const replacement = await (await newEndpoint.fetch('/identity', { signal: AbortSignal.timeout(timeoutMs) })).json();
      assert(replacement.version === 'new' && replacement.requests === 1,
        `Stale endpoint reached replacement listener: ${JSON.stringify(replacement)}`);
      await finish(newExecution, newResult, newEndpoint);
    })],
  },
];
