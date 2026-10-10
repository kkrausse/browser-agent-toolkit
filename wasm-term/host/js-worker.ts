// Worker entry for a JavaScript guest (see node/runtime.ts). The page starts
// it exactly like worker.ts: `startProgram({ workerUrl: <this, bundled>,
// guestUrl: <the guest module>, ... })`.

import { runJsGuest } from "./node/runtime";
import type { InitMessage, WorkerMessage } from "./protocol";

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(message, transfer);

self.addEventListener("message", event => {
  const message = (event as MessageEvent<InitMessage>).data;
  if (message.t !== "init") return;
  runJsGuest(message, post).catch(thrown => {
    console.error(thrown);
    post({ t: "exit", code: 127, error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) });
  });
});
