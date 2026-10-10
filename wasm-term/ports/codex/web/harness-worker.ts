// Worker entry for harness.ts: wasm-term's own Worker runtime, with the one
// browser API Bun lacks filled in first. Static imports, so the runtime's
// message listener is installed before the queued init message is delivered.
import "./harness-polyfill";
import "../../../host/worker.ts";
