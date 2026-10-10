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

export interface NetOptions {
  /** `ws(s)://` URL of the TCP relay endpoint (`/proxy/tcp` of web/server.ts); absent: `tcp_connect` fails with NOSYS. */
  tcpRelay?: string;
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
      sockets.delete(handle);
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
      streams.delete(handle);
      // After the peer's end of file the relay closing is the stream's ordinary end (reads see the end
      // of file; a write would be into a closed connection); before it, a reset.
      if (state.ended) fail("pipe", `${host}:${port}: the connection is closed`);
      else fail(state.open ? "reset" : "unreachable", `${host}:${port}: the relay closed the connection (${close.code} ${close.reason})`);
    });
  }

  async function request(handle: number, message: Extract<WorkerMessage, { t: "http_open" }>): Promise<void> {
    const state: HttpState = { abort: new AbortController(), sent: 0, acked: 0, resume: null };
    requests.set(handle, state);
    try {
      const response = await fetch(message.url, {
        method: message.method,
        headers: message.headers,
        body: message.body as BodyInit | null,
        signal: state.abort.signal,
      });
      const lines = [...response.headers].map(([name, value]) => `${name}: ${value}\r\n`).join("");
      const head = encoder.encode(`\0\0\0\0${lines}`);
      new DataView(head.buffer).setUint32(0, response.status, true);
      event(handle, HTTP_HEAD, head);
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
      if (!state.abort.signal.aborted) event(handle, HTTP_ERROR, encoder.encode(error instanceof Error ? error.message : String(error)));
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
