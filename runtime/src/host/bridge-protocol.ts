// Messages between the service worker, the preview frame's shim and the
// bridge worker (netd). Everything a guest listener sends or receives on
// behalf of a browser frame crosses these, never the page's main thread.

/** Service worker → netd, over the port the page handed to both. */
export type ToNetd =
  | { t: 'fetch'; id: number; port: number; method: string; path: string; headers: [string, string][]; body: ReadableStream<Uint8Array> | null }
  | { t: 'abort'; id: number }
  /** A WebSocket of the preview frame: `channel` is the frame's end. */
  | { t: 'ws'; port: number; path: string; protocols: string[]; headers: [string, string][]; channel: MessagePort }

/** netd → service worker. */
export type FromNetd =
  /** `body` is a transferred stream, or the whole body when it is small and its length was announced. */
  | { t: 'response'; id: number; status: number; statusText: string; headers: [string, string][]; body: ReadableStream<Uint8Array> | ArrayBuffer | null }
  | { t: 'error'; id: number; code: string; message: string }

/** Preview frame shim → netd, over the per-socket channel. */
export type WsToNetd = { t: 'send'; data: string | ArrayBuffer } | { t: 'close'; code?: number; reason?: string }
/** netd → preview frame shim. */
export type WsFromNetd =
  | { t: 'open'; protocol: string; extensions: string }
  | { t: 'message'; data: string | ArrayBuffer }
  | { t: 'error'; message: string }
  | { t: 'close'; code: number; reason: string; wasClean: boolean }

/** Page → service worker. */
export type ToServiceWorker =
  | { t: 'bat-port'; port: MessagePort; hostPaths: Record<number, string[]>; guestPaths?: Record<number, Record<string, number>> }
  | { t: 'bat-host-paths'; hostPaths: Record<number, string[]> }
  | { t: 'bat-guest-paths'; guestPaths: Record<number, Record<string, number>> }
  | { t: 'bat-closed' }
/** Service worker → page (any window client): the worker restarted and lost its port. */
export type FromServiceWorker = { t: 'bat-need-port' }
/** Preview frame shim → service worker. */
export type ShimToServiceWorker = { t: 'bat-ws'; url: string; protocols: string[]; channel: MessagePort }
