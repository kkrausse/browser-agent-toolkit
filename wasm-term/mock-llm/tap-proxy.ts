#!/usr/bin/env bun
// Logging reverse proxy for working out what a client says to its server.
// Handles plain HTTP, SSE (each event logged as it passes) and WebSocket
// (each frame logged in both directions).
//
//   bun tap-proxy.ts <listen-port> <target-url> [log-file]
//   bun tap-proxy.ts 4795 http://127.0.0.1:4792 .state/logs/opencode-tap.log
//   bun tap-proxy.ts 4796 ws://127.0.0.1:4793   .state/logs/codex-tap.log

import { appendFileSync } from "node:fs";

const [portArg, targetArg, logFile] = process.argv.slice(2);
if (!portArg || !targetArg) {
  console.error("usage: tap-proxy.ts <listen-port> <target-url> [log-file]");
  process.exit(2);
}
const target = new URL(targetArg);
const httpTarget = `${target.protocol.replace("ws", "http")}//${target.host}`;
const wsTarget = `${target.protocol.replace("http", "ws")}//${target.host}`;
const MAX = Number(process.env.TAP_MAX_CHARS ?? 600);

function log(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
  console.log(stamped);
  if (logFile) appendFileSync(logFile, `${stamped}\n`);
}

const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}...(+${s.length - MAX})` : s);

function headerSummary(h: Headers): string {
  const out: string[] = [];
  h.forEach((value, key) => {
    if (["host", "connection", "accept-encoding", "content-length"].includes(key)) return;
    // Keep the auth scheme, drop the credential.
    const shown = key === "authorization" || key === "cookie" ? `${value.split(" ")[0]} <redacted>` : value;
    out.push(`${key}=${shown}`);
  });
  return out.join(" | ");
}

interface WsData {
  id: number;
  path: string;
  headers: Record<string, string>;
  upstream?: WebSocket;
  pending: (string | Uint8Array)[];
}

let seq = 0;
const show = (m: string | ArrayBuffer | Uint8Array | Buffer) => (typeof m === "string" ? clip(m) : `<binary ${(m as Uint8Array).byteLength} bytes>`);

const server = Bun.serve<WsData, never>({
  port: Number(portArg),
  // TAP_HOST=0.0.0.0 inside the codex container, where the edge forwarder connects from another address.
  hostname: process.env.TAP_HOST ?? "127.0.0.1",
  idleTimeout: 0,
  async fetch(req, srv) {
    const id = ++seq;
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      log(`#${id} WS-UPGRADE ${path} :: ${headerSummary(req.headers)}`);
      const headers: Record<string, string> = {};
      // Origin is deliberately not forwarded: codex app-server rejects any request that has one.
      for (const k of ["authorization", "user-agent", "sec-websocket-protocol"]) {
        const v = req.headers.get(k);
        if (v) headers[k] = v;
      }
      if (srv.upgrade(req, { data: { id, path, headers, pending: [] } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    log(`#${id} > ${req.method} ${path} :: ${headerSummary(req.headers)}${body ? ` :: body=${clip(body)}` : ""}`);
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    let res: Response;
    try {
      res = await fetch(httpTarget + path, { method: req.method, headers, body, redirect: "manual" });
    } catch (err) {
      log(`#${id} < upstream error ${err}`);
      return new Response(`tap-proxy: ${err}`, { status: 502 });
    }
    const type = res.headers.get("content-type") ?? "";
    const outHeaders = new Headers(res.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    log(`#${id} < ${res.status} ${type} :: ${headerSummary(res.headers)}`);

    if (type.includes("text/event-stream") && res.body) {
      const dec = new TextDecoder();
      let buf = "";
      const tapped = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            buf += dec.decode(chunk, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const event = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (event.trim()) log(`#${id} < SSE ${clip(event.replace(/\n/g, " ⏎ "))}`);
            }
            controller.enqueue(chunk);
          },
          flush() {
            log(`#${id} < SSE stream closed`);
          },
        }),
      );
      return new Response(tapped, { status: res.status, headers: outHeaders });
    }
    const buffer = await res.arrayBuffer();
    if (/json|text\/plain/.test(type)) log(`#${id} < body=${clip(new TextDecoder().decode(buffer))}`);
    else log(`#${id} < body=<${buffer.byteLength} bytes>`);
    return new Response(buffer, { status: res.status, headers: outHeaders });
  },
  websocket: {
    open(ws) {
      const d = ws.data;
      // Bun's WebSocket client accepts a headers option (non-standard).
      const up = new WebSocket(wsTarget + d.path, { headers: d.headers } as any);
      d.upstream = up;
      up.binaryType = "arraybuffer";
      up.onopen = () => {
        log(`#${d.id} WS upstream open`);
        for (const m of d.pending) up.send(m);
        d.pending = [];
      };
      up.onmessage = (ev) => {
        log(`#${d.id} WS < ${show(ev.data)}`);
        ws.send(ev.data);
      };
      up.onclose = (ev) => {
        log(`#${d.id} WS upstream closed code=${ev.code} reason=${ev.reason}`);
        ws.close();
      };
      up.onerror = () => log(`#${d.id} WS upstream error`);
    },
    message(ws, message) {
      const d = ws.data;
      log(`#${d.id} WS > ${show(message)}`);
      if (d.upstream?.readyState === WebSocket.OPEN) d.upstream.send(message);
      else d.pending.push(message);
    },
    close(ws, code, reason) {
      log(`#${ws.data.id} WS client closed code=${code} reason=${reason}`);
      ws.data.upstream?.close();
    },
  },
});

log(`tap-proxy ${server.hostname}:${server.port} -> ${httpTarget} / ${wsTarget}`);
