#!/usr/bin/env bun
// HTTP(S) proxy that refuses everything and logs what was attempted. The isolated
// opencode/codex launchers export HTTP_PROXY/HTTPS_PROXY pointing here (with
// NO_PROXY for loopback), so any attempt to reach a real endpoint (model
// provider, catalogue, telemetry, update check) fails fast and leaves a record.

import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const PORT = Number(process.env.EGRESS_TRAP_PORT ?? 4794);
const LOG_FILE = process.env.EGRESS_TRAP_LOG;

function log(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
  console.log(stamped);
  if (LOG_FILE) appendFileSync(LOG_FILE, `${stamped}\n`);
}

const server = createServer((socket) => {
  socket.once("data", (buf) => {
    const head = buf.toString("latin1").split("\r\n");
    const ua = head.find((h) => /^user-agent:/i.test(h)) ?? "";
    log(`BLOCKED ${head[0]} ${ua}`);
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nblocked by wasm-term egress trap\n");
  });
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => log(`egress trap listening on 127.0.0.1:${PORT}`));
