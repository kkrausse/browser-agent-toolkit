// A shell Worker: bat_sh.wasm with its host calls carried to the program's
// Worker (sh/channel.ts), which owns the filesystem. It never returns to its
// event loop: between runs it sleeps on the channel, so starting a command is
// one Atomics.notify, not a Worker start. Created by the page (the only thread
// that is never blocked) when the program's Worker asks (`proc_need`), and
// terminated and replaced by the page when a run will not stop (`proc_replace`).

import { H_WAKE, HEADER_INTS, type ShellWorkerInit } from "./protocol";
import { createChannelClient } from "./sh/channel";
import { OP } from "./sh/host";
import { createShRunner, ShAbort } from "./sh/wasm";

self.addEventListener("message", event => {
  const init = (event as MessageEvent<ShellWorkerInit>).data;
  if (init.t !== "shell-init") return;
  const client = createChannelClient(init.channel, new Int32Array(init.parent, 0, HEADER_INTS), H_WAKE, init.spinUs);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const checkpoint = () => {
    const signal = client.killed();
    if (signal) throw new ShAbort(signal, false);
  };
  const runner = createShRunner({
    module: init.module,
    call: client.call,
    checkpoint,
    sleep(ms) {
      const until = performance.now() + ms;
      for (;;) {
        checkpoint();
        const left = until - performance.now();
        if (left <= 0) return;
        Atomics.wait(sleeper, 0, 0, Math.min(left, 20));
      }
    },
  });
  const decoder = new TextDecoder();
  client.ready();
  for (;;) {
    const job = client.nextJob();
    const view = new DataView(job.buffer);
    const argc = view.getUint32(0, true);
    const envc = view.getUint32(4, true);
    let at = 8;
    const text = () => {
      const length = view.getUint32(at, true);
      const value = decoder.decode(job.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      return value;
    };
    const cwd = text();
    const argv = Array.from({ length: argc }, text);
    const env = Array.from({ length: envc }, text);
    let status = 0;
    let signal = 0;
    try {
      status = runner.run({ argv, env, cwd });
    } catch (thrown) {
      if (thrown instanceof ShAbort) {
        signal = thrown.signal;
        status = 128 + signal;
      } else {
        status = 134;
        const message = new TextEncoder().encode(`sh: internal error: ${(thrown as Error)?.message ?? thrown}\n`);
        client.call(OP.WRITE, 2, 0, "", "", message);
      }
    }
    client.call(OP.EXIT, status, signal, "", "", null);
  }
});
