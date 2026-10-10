// Page-side network bridge. The program's Worker cannot run fetch/WebSocket
// itself: it is blocked synchronously, so their callbacks would never fire.
// The page performs the I/O and reports events as FRAME_NET frames.

import {
  FRAME_NET, HTTP_BODY, HTTP_END, HTTP_ERROR, HTTP_HEAD, HTTP_WINDOW, TCP_ACK, TCP_DATA, TCP_END, TCP_ERROR, TCP_OPEN,
  WS_BINARY, WS_CLOSE, WS_ERROR, WS_OPEN, WS_TEXT,
  type WorkerMessage,
} from "./protocol";
import type { RingWriter } from "./ring";

interface HttpState {
  abort: AbortController;
  sent: number;
  acked: number;
  resume: (() => void) | null;
}

export interface NetBridge {
  /** Returns true when the message was a network request. */
  handle(message: WorkerMessage): boolean;
  /** Closes every socket and aborts every request. */
  dispose(): void;
}

/** One TCP stream: a binary WebSocket to the relay, which holds the real socket. */
interface TcpState {
  socket: WebSocket;
  /** The guest's bytes that arrived before the relay said the connection is open. */
  pending: Uint8Array[];
  open: boolean;
  /** An error or the end has been reported; whatever the socket says next is not news. */
  finished: boolean;
  /** The peer's end of file has arrived: the relay closing the socket afterwards is the normal end. */
  ended: boolean;
}

/** The relay's error codes (web/server.ts) as WASI errnos. */
const TCP_ERRNO: Record<string, number> = {
  denied: 2 /* ACCES */, refused: 14 /* CONNREFUSED */, reset: 15 /* CONNRESET */, unreachable: 23 /* HOSTUNREACH */,
  dns: 23, timeout: 73 /* TIMEDOUT */, limit: 29 /* IO */, norelay: 52 /* NOSYS */, pipe: 64 /* PIPE */,
};

/** What the page learns about one `http_open` request once its head has arrived (names only: no header values, no query). */
export interface HttpSeen {
  method: string;
  /** Origin and path of where the request went; the query is left out (it may carry secrets). */
  url: string;
  status: number;
  /** The response header names script was allowed to see: for another origin, the CORS-safelisted ones and what it exposed. */
  headers: string[];
  /** The page answered instead of the server (`HttpOptions.blocked`). */
  synthetic?: boolean;
}

/** A request to another origin that `fetch` rejected: the browser does not say whether the network or CORS stopped it. */
export interface HttpBlocked {
  method: string;
  url: string;
  /** The browser's own text ("Failed to fetch", "Load failed", ...). */
  error: string;
}

/** How `http_open` treats requests that go straight to another origin (docs/abi.md 3.3, "Direct requests"). */
export interface HttpOptions {
  /** Origins replaced before a request leaves, e.g. `{ "https://mock-llm.test": "http://127.0.0.1:4791" }`: for tests, where
   * a program insists on an https name this browser cannot reach. The caller decides what may be listed here. */
  rewrite?: Record<string, string>;
  /** Called when a cross-origin request was rejected. Return a response and the program gets that instead of a
   * transport error (which it would retry and then report without a reason); return nothing to pass the error on. */
  blocked?(request: HttpBlocked): { status: number; body: string } | undefined;
  /** Called with every response head. */
  seen?(response: HttpSeen): void;
}

export interface NetOptions {
  /** `ws(s)://` URL of the TCP relay endpoint (`/proxy/tcp` of web/server.ts); absent: `tcp_connect` fails with NOSYS. */
  tcpRelay?: string;
  http?: HttpOptions;
}

export function createNetBridge(ring: RingWriter, options: NetOptions = {}): NetBridge {
  const encoder = new TextEncoder();
  const sockets = new Map<number, WebSocket>();
  const requests = new Map<number, HttpState>();
  const streams = new Map<number, TcpState>();

  function event(handle: number, kind: number, data: Uint8Array = new Uint8Array(0)): void {
    const payload = new Uint8Array(8 + data.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, handle, true);
    view.setUint32(4, kind, true);
    payload.set(data, 8);
    ring.send(FRAME_NET, payload);
  }

  function openSocket(handle: number, url: string, protocols: string[]): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, protocols);
    } catch (error) {
      event(handle, WS_ERROR, encoder.encode(String(error)));
      return;
    }
    socket.binaryType = "arraybuffer";
    sockets.set(handle, socket);
    // The browser reports a failed connection as `error` then `close`; the
    // guest gets one terminal event either way.
    let finished = false;
    socket.addEventListener("open", () => event(handle, WS_OPEN, encoder.encode(socket.protocol)));
    socket.addEventListener("message", message => {
      if (typeof message.data === "string") event(handle, WS_TEXT, encoder.encode(message.data));
      else event(handle, WS_BINARY, new Uint8Array(message.data as ArrayBuffer));
    });
    socket.addEventListener("error", () => {
      if (finished) return;
      finished = true;
      event(handle, WS_ERROR, encoder.encode(`WebSocket error (${url})`));
    });
    socket.addEventListener("close", close => {
      if (sockets.get(handle) === socket) sockets.delete(handle);
      if (finished) return;
      finished = true;
      const reason = encoder.encode(close.reason);
      const data = new Uint8Array(2 + reason.length);
      new DataView(data.buffer).setUint16(0, close.code, true);
      data.set(reason, 2);
      event(handle, WS_CLOSE, data);
    });
  }

  function sendSocket(handle: number, data: Uint8Array | string): void {
    const socket = sockets.get(handle);
    if (!socket) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      // Guests may send right after ws_open; hold the message until the handshake completes.
      socket.addEventListener("open", () => socket.send(data), { once: true });
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }

  function tcpError(handle: number, code: string, message: string): void {
    const text = encoder.encode(message);
    const data = new Uint8Array(4 + text.length);
    new DataView(data.buffer).setUint32(0, TCP_ERRNO[code] ?? 29 /* IO */, true);
    data.set(text, 4);
    event(handle, TCP_ERROR, data);
  }

  /** The relay speaks binary frames for the stream's bytes and JSON text frames for everything
   * about it: `open`, `end` (the peer's FIN), `error`, `ack` (bytes written to its socket). */
  function openStream(handle: number, host: string, port: number): void {
    if (!options.tcpRelay) return tcpError(handle, "norelay", "tcp_connect: this page has no TCP relay");
    let socket: WebSocket;
    try {
      const url = new URL(options.tcpRelay, location.href);
      url.protocol = url.protocol.replace(/^http/, "ws");
      url.searchParams.set("host", host);
      url.searchParams.set("port", String(port));
      socket = new WebSocket(url);
    } catch (error) {
      return tcpError(handle, "unreachable", `tcp relay: ${String(error)}`);
    }
    socket.binaryType = "arraybuffer";
    const state: TcpState = { socket, pending: [], open: false, finished: false, ended: false };
    streams.set(handle, state);
    const fail = (code: string, message: string) => {
      if (state.finished) return;
      state.finished = true;
      tcpError(handle, code, message);
    };
    socket.addEventListener("message", message => {
      if (state.finished) return;
      if (typeof message.data !== "string") {
        event(handle, TCP_DATA, new Uint8Array(message.data as ArrayBuffer));
        return;
      }
      let control: { t?: string; bytes?: number; code?: string; message?: string };
      try { control = JSON.parse(message.data); } catch { return; }
      if (control.t === "open") {
        state.open = true;
        for (const data of state.pending.splice(0)) socket.send(data as BufferSource);
        event(handle, TCP_OPEN);
      } else if (control.t === "ack") {
        event(handle, TCP_ACK, new Uint8Array(new Uint32Array([control.bytes ?? 0]).buffer));
      } else if (control.t === "end") {
        state.ended = true;
        event(handle, TCP_END);
      } else if (control.t === "error") {
        fail(control.code ?? "", `${host}:${port}: ${control.message ?? "connection failed"}`);
      }
    });
    socket.addEventListener("error", () => fail("unreachable", `tcp relay: WebSocket error (${host}:${port})`));
    socket.addEventListener("close", close => {
      if (streams.get(handle) === state) streams.delete(handle);
      // After the peer's end of file the relay closing is the stream's ordinary end (reads see the end
      // of file; a write would be into a closed connection); before it, a reset.
      if (state.ended) fail("pipe", `${host}:${port}: the connection is closed`);
      else fail(state.open ? "reset" : "unreachable", `${host}:${port}: the relay closed the connection (${close.code} ${close.reason})`);
    });
  }

  async function request(handle: number, message: Extract<WorkerMessage, { t: "http_open" }>): Promise<void> {
    const state: HttpState = { abort: new AbortController(), sent: 0, acked: 0, resume: null };
    requests.set(handle, state);
    const http = options.http ?? {};
    let target = message.url;
    let where = message.url;
    let crossOrigin = false;
    try {
      const url = new URL(message.url, location.href);
      const rewritten = http.rewrite?.[url.origin];
      if (rewritten) target = `${rewritten}${url.pathname}${url.search}`;
      const final = new URL(target, location.href);
      crossOrigin = final.origin !== location.origin;
      where = `${final.origin}${final.pathname}`;
    } catch {
      // not a URL: fetch says so below
    }
    const head = (status: number, lines: string) => {
      const data = encoder.encode(`\0\0\0\0${lines}`);
      new DataView(data.buffer).setUint32(0, status, true);
      event(handle, HTTP_HEAD, data);
    };
    let answered = false;
    try {
      const response = await fetch(target, {
        method: message.method,
        headers: message.headers,
        body: message.body as BodyInit | null,
        signal: state.abort.signal,
        // Straight to another origin: a CORS request that carries nothing of the browser's own. No cookies either way
        // (`omit` also makes the browser ignore `Set-Cookie`), no `Referer` (the page URL holds the program's settings),
        // nothing from or into the HTTP cache. Redirects are followed by the browser, under the same rules.
        ...(crossOrigin ? { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "follow" } as const : {}),
      });
      answered = true;
      http.seen?.({ method: message.method, url: where, status: response.status, headers: [...response.headers.keys()] });
      head(response.status, [...response.headers].map(([name, value]) => `${name}: ${value}\r\n`).join(""));
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        event(handle, HTTP_BODY, value);
        state.sent += value.length;
        // Do not read faster than the guest consumes.
        if (state.sent - state.acked > HTTP_WINDOW) await new Promise<void>(resolve => (state.resume = resolve));
      }
      event(handle, HTTP_END);
    } catch (error) {
      if (state.abort.signal.aborted) return;
      const text = error instanceof Error ? error.message : String(error);
      // `fetch` rejects before any response only for the network or for CORS, and says the same for both.
      const answer = crossOrigin && error instanceof TypeError && !answered ? http.blocked?.({ method: message.method, url: where, error: text }) : undefined;
      if (answer) {
        http.seen?.({ method: message.method, url: where, status: answer.status, headers: ["content-type", "x-wasm-term-synthetic"], synthetic: true });
        head(answer.status, "content-type: text/plain; charset=utf-8\r\nx-wasm-term-synthetic: blocked\r\n");
        event(handle, HTTP_BODY, encoder.encode(answer.body));
        event(handle, HTTP_END);
      } else {
        event(handle, HTTP_ERROR, encoder.encode(crossOrigin ? `${text} (${where}: the network, or this page's origin is not allowed by the server's CORS policy)` : text));
      }
    } finally {
      requests.delete(handle);
    }
  }

  return {
    handle(message) {
      switch (message.t) {
        case "ws_open":
          openSocket(message.handle, message.url, message.protocols);
          return true;
        case "ws_send":
          sendSocket(message.handle, message.data);
          return true;
        case "ws_close":
          sockets.get(message.handle)?.close(message.code || undefined, message.reason || undefined);
          return true;
        case "http_open":
          void request(message.handle, message);
          return true;
        case "http_ack": {
          const state = requests.get(message.handle);
          if (state) {
            state.acked += message.bytes;
            if (state.resume && state.sent - state.acked <= HTTP_WINDOW) {
              state.resume();
              state.resume = null;
            }
          }
          return true;
        }
        case "tcp_open":
          openStream(message.handle, message.host, message.port);
          return true;
        case "tcp_send": {
          const state = streams.get(message.handle);
          if (!state || state.finished) return true;
          if (state.open) state.socket.send(message.data as BufferSource);
          else state.pending.push(message.data);
          return true;
        }
        case "tcp_end": {
          const state = streams.get(message.handle);
          if (state?.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ t: "end" }));
          return true;
        }
        case "tcp_ack": {
          const state = streams.get(message.handle);
          if (state?.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ t: "ack", bytes: message.bytes }));
          return true;
        }
        case "net_close": {
          sockets.get(message.handle)?.close();
          sockets.delete(message.handle);
          requests.get(message.handle)?.abort.abort();
          const state = streams.get(message.handle);
          if (state) {
            state.finished = true;
            state.socket.close();
            streams.delete(message.handle);
          }
          return true;
        }
        default:
          return false;
      }
    },
    dispose() {
      for (const socket of sockets.values()) socket.close();
      for (const state of requests.values()) state.abort.abort();
      for (const state of streams.values()) {
        state.finished = true;
        state.socket.close();
      }
      streams.clear();
      sockets.clear();
      requests.clear();
    },
  };
}
