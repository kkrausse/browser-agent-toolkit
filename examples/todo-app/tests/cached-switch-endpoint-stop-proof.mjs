// Concrete shutdown characterization, not a runtime ownership receipt.
// Run against a separately built, committed @vivari/core/host entrypoint.
// Only the transport is a fixture: Endpoint and HTTP stream code are shipped bytes.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

if (!process.argv[2]) throw Error('Usage: cached-switch-endpoint-stop-proof.mjs <built-host-index.js>');
const {createEndpoint} = await import(pathToFileURL(process.argv[2]).href);
globalThis.location = new URL('http://localhost:12345/');
let releaseCancel;
let cancelStarted = false, cancelJoined = false;
const heldCancel = new Promise(resolve => { releaseCancel = resolve; });
const body = new ReadableStream({
  async cancel() {
    cancelStarted = true;
    await heldCancel;
    cancelJoined = true;
  },
});
const channels = [];
const lifetime = new AbortController();
// No kernel/browser/server is started. This stand-in only accepts stream ports.
const transport = {
  listeners: new Map([[5173, 'fixture-listener']]),
  on() { return () => {}; },
  post(type, _message, ports) {
    assert.equal(type, 'workspace-http-stream');
    channels.push(...ports);
  },
};
const endpoint = createEndpoint(transport, 5173, 'fixture-listener', lifetime.signal);
const fetch = endpoint.fetch('/', {method: 'POST', body, duplex: 'half'});
const rejected = assert.rejects(fetch, /Runtime stopped/);
try {
  lifetime.abort(Error('Runtime stopped'));
  await endpoint.closed;
  await rejected;
  assert.equal(cancelStarted, true);
  assert.equal(cancelJoined, false);
  // The public endpoint close and fetch rejection are already observable while
  // the source's cancellation owns unfinished work. Neither exports a join.
  console.log(JSON.stringify({endpointClosed: true, fetchRejected: true,
    uploadCancelStarted: cancelStarted, uploadCancelJoinedAtClose: cancelJoined,
    stoppedOwnershipProven: false}));
} finally {
  releaseCancel();
  await heldCancel;
  await Promise.resolve();
  for (const channel of channels) channel.close();
  delete globalThis.location;
}
assert.equal(cancelJoined, true);
