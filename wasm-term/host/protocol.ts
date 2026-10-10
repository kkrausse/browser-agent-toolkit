// Shared between the page (main thread) and the program's Worker.
//
// Main → Worker traffic cannot use postMessage: the Worker is blocked in
// Atomics.wait inside a guest syscall and never returns to its event loop.
// So everything inbound (keystrokes, resizes, network events) is a frame in a
// SharedArrayBuffer ring. Worker → Main uses ordinary postMessage, which works
// from a thread that never yields.

/** Int32 slots at the start of the shared buffer. */
export const H_WRITE = 0; // bytes ever written to the ring (wraps at 2^32)
export const H_READ = 1; // bytes ever read
export const H_WAKE = 2; // bumped + notified on every write; the Worker waits on it
export const H_WRITER_WAITING = 3; // 1 while the main thread has frames it could not fit
export const H_OUT_ACK = 4; // terminal output bytes the page has consumed (flow control)
export const HEADER_INTS = 16;
export const HEADER_BYTES = HEADER_INTS * 4;

export const RING_BYTES = 1 << 20;
/** Largest payload of one frame; longer payloads are split with FRAME_MORE. */
export const MAX_FRAME_PAYLOAD = 32 * 1024;
/** Worker pauses output when this many bytes are un-acked by the page. */
export const OUT_WINDOW = 1 << 20;
/** Page pauses reading an HTTP body when this many bytes are un-acked by the guest. */
export const HTTP_WINDOW = 1 << 20;

// Frame types (main → worker). FRAME_MORE is or-ed in when more chunks follow.
export const FRAME_INPUT = 1; // payload: bytes typed at the terminal
export const FRAME_RESIZE = 2; // payload: u16 cols, rows, xpixel, ypixel
export const FRAME_SIGNAL = 3; // payload: u32 signo (sent by the page, e.g. kill)
export const FRAME_NET = 4; // payload: u32 handle, u32 kind, data
export const FRAME_CLIPBOARD = 5; // payload: u32 request id, u32 ok (1/0), then the text or the error (utf-8)
export const FRAME_MORE = 0x80;

// FRAME_NET kinds. 1-5 are also the `kind` values of the guest's ws_recv.
export const WS_OPEN = 1; // data: negotiated subprotocol (utf-8)
export const WS_TEXT = 2;
export const WS_BINARY = 3;
export const WS_CLOSE = 4; // data: u16 code (LE), then reason (utf-8)
export const WS_ERROR = 5; // data: message (utf-8)
export const HTTP_HEAD = 10; // data: u32 status (LE), then "name: value\r\n" lines
export const HTTP_BODY = 11;
export const HTTP_END = 12;
export const HTTP_ERROR = 13; // data: message (utf-8)

export interface InitMessage {
  t: "init";
  sab: SharedArrayBuffer;
  kernelUrl: string;
  guestUrl: string;
  args: string[];
  env: Record<string, string>;
  cols: number;
  rows: number;
  xpixel: number;
  ypixel: number;
  /** Files to place in the vfs before the program starts (absolute path → contents). */
  files?: Record<string, Uint8Array | string>;
  /** Directories whose files are reported to the page (`persist` messages) whenever they change. */
  persist?: PersistRoots;
}

export interface PersistRoots {
  /** Absolute directories; every regular file below them is persistent. */
  roots: string[];
  /** Paths containing any of these substrings are left out (lock directories, logs). */
  exclude?: string[];
}

export type WorkerMessage =
  | { t: "out"; data: Uint8Array }
  | { t: "exit"; code: number; signal?: number; error?: string }
  | { t: "drain" }
  | { t: "ws_open"; handle: number; url: string; protocols: string[] }
  | { t: "ws_send"; handle: number; data: Uint8Array | string }
  | { t: "ws_close"; handle: number; code: number; reason: string }
  | { t: "http_open"; handle: number; method: string; url: string; headers: [string, string][]; body: Uint8Array | null }
  | { t: "http_ack"; handle: number; bytes: number }
  | { t: "net_close"; handle: number }
  | { t: "log"; text: string }
  /** A persistent file changed (`data`) or went away (`null`). */
  | { t: "persist"; path: string; data: Uint8Array | null }
  | { t: "clipboard_write"; text: string }
  /** Answered with a FRAME_CLIPBOARD frame carrying the same id. */
  | { t: "clipboard_read"; id: number };
