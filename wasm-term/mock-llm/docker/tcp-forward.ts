#!/usr/bin/env bun
// Plain TCP forwarder: `tcp-forward.ts <listen-port>=<host>:<port> ...`.
// Used by the edge container (the published ports) and inside the codex
// container (app-server only listens on loopback). Bytes are not inspected.

import { connect, createServer } from "node:net";

for (const spec of process.argv.slice(2)) {
  const [listen, target] = spec.split("=");
  const [host, port] = target.split(":");
  createServer((client) => {
    const upstream = connect({ host, port: Number(port) });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
  }).listen(Number(listen), "0.0.0.0", () => console.log(`forward 0.0.0.0:${listen} -> ${target}`));
}
