// Page-side network bridge. The program's Worker cannot run fetch/WebSocket
// itself: it is blocked synchronously, so their callbacks would never fire.
// The page performs the I/O and reports events as FRAME_NET frames.

import {
  FRAME_NET, HTTP_BODY, HTTP_END, HTTP_ERROR, HTTP_HEAD, HTTP_WINDOW, WS_BINARY, WS_CLOSE, WS_ERROR, WS_OPEN, WS_TEXT,
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

export function createNetBridge(ring: RingWriter): NetBridge {
  const encoder = new TextEncoder();
  const sockets = new Map<number, WebSocket>();
  const requests = new Map<number, HttpState>();

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
        case "net_close":
          sockets.get(message.handle)?.close();
          sockets.delete(message.handle);
          requests.get(message.handle)?.abort.abort();
          return true;
        default:
          return false;
      }
    },
    dispose() {
      for (const socket of sockets.values()) socket.close();
      for (const state of requests.values()) state.abort.abort();
      sockets.clear();
      requests.clear();
    },
  };
}
