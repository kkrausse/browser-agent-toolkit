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
export const H_OUT_WAITING = 5; // 1 while the Worker waits for H_OUT_ACK to advance: the page then also bumps H_WAKE with each ack
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
export const FRAME_FILE = 6; // payload: u32 request id, u32 op (FILE_READ / FILE_LIST), then the path (utf-8)
export const FRAME_PROC = 7; // payload: u32 slot, u32 ok (1/0): whether the shell Worker asked for with `proc_need` / `proc_replace` could be started
export const FRAME_MORE = 0x80;

export const FILE_READ = 0;
export const FILE_LIST = 1;

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
// A TCP stream carried by the relay (docs/abi.md 3.3, "TCP").
export const TCP_OPEN = 20; // the relay's TCP connection is established
export const TCP_DATA = 21; // data: bytes from the peer
export const TCP_END = 22; // the peer closed its sending side; nothing more arrives
export const TCP_ERROR = 23; // data: u32 errno (LE), then a message (utf-8); the stream is dead
export const TCP_ACK = 24; // data: u32 count (LE) of sent bytes the relay has written to its socket

/** A TCP write is refused (EAGAIN) while this many bytes are not yet written to the relay's socket;
 * the relay stops reading its socket while this many received bytes are unread by the guest. */
export const TCP_WINDOW = 256 * 1024;

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
  /** Child processes (`proc_*`): the shell the guest may run commands in. Absent: `proc_spawn` fails with NOSYS. */
  proc?: ProcInit;
  /** JavaScript guests: `fetch` of URLs under these prefixes goes to the page over this port (page-fetch.ts). */
  pageFetch?: import("./page-fetch").PageFetchInit;
}

export interface ProcInit {
  /** `bat_sh.wasm`, compiled by the page. */
  module: WebAssembly.Module;
  /** `worker`: each child in a shell Worker the page starts on request. `inline`: inside `proc_spawn`, in the guest's own Worker. */
  mode: "worker" | "inline";
  /** Shell Workers at most, so children that run at once; more wait their turn. */
  slots: number;
  /** Shell Workers asked for before the first command. */
  prewarm: number;
  /** How long each side of a channel stays awake for the other's next move before sleeping, in microseconds. */
  spinUs: number;
}

/** What the page sends a shell Worker (host/shell-worker.ts) it has just created. */
export interface ShellWorkerInit {
  t: "shell-init";
  channel: SharedArrayBuffer;
  /** The program's page->Worker ring: its header holds the wake counter the shell bumps. */
  parent: SharedArrayBuffer;
  module: WebAssembly.Module;
  spinUs: number;
}

export interface PersistRoots {
  /** Absolute directories; every regular file below them is persistent. */
  roots: string[];
  /** Paths containing any of these substrings are left out (lock directories, logs). */
  exclude?: string[];
}

export type WorkerMessage =
  | { t: "out"; data: Uint8Array }
  /** `lingers`: the Worker still answers `FileRequest` messages; the page keeps it until `Program.kill()`. */
  | { t: "exit"; code: number; signal?: number; error?: string; lingers?: boolean }
  | { t: "drain" }
  | { t: "ws_open"; handle: number; url: string; protocols: string[] }
  | { t: "ws_send"; handle: number; data: Uint8Array | string }
  | { t: "ws_close"; handle: number; code: number; reason: string }
  | { t: "http_open"; handle: number; method: string; url: string; headers: [string, string][]; body: Uint8Array | null }
  | { t: "http_ack"; handle: number; bytes: number }
  | { t: "net_close"; handle: number }
  /** Open a TCP stream to `host:port` through the page's relay; answered with TCP_OPEN or TCP_ERROR. */
  | { t: "tcp_open"; handle: number; host: string; port: number }
  | { t: "tcp_send"; handle: number; data: Uint8Array }
  /** No more data will be sent (half-close); the peer's data still arrives. */
  | { t: "tcp_end"; handle: number }
  /** The guest has read this many received bytes (read back-pressure). */
  | { t: "tcp_ack"; handle: number; bytes: number }
  | { t: "log"; text: string }
  /** A persistent file changed (`data`) or went away (`null`). */
  | { t: "persist"; path: string; data: Uint8Array | null }
  | { t: "clipboard_write"; text: string }
  /** Answered with a FRAME_CLIPBOARD frame carrying the same id. */
  | { t: "clipboard_read"; id: number }
  /** Answer to a FRAME_FILE frame (or, after exit, a `file` message): the file's bytes, a JSON listing, or null when there is no such path. */
  | { t: "file"; id: number; data: Uint8Array | null }
  /** No shell Worker serves this channel yet: the page starts one (`ShellWorkerInit`). */
  | { t: "proc_need"; slot: number; channel: SharedArrayBuffer }
  /** The shell Worker of this slot will not stop: the page terminates it and starts another on the new channel. */
  | { t: "proc_replace"; slot: number; channel: SharedArrayBuffer }
  /** One child ended: what it was and what it cost (`Program.procs`, for measurements and tests). */
  | { t: "proc_stat"; command: string; status: number; signal: number; calls: number; queueMs: number; runMs: number }
  /** Where a wasm guest is in starting up: fetching the module (bytes so far, of `total` when known), compiling it, running. */
  | { t: "load"; phase: "download" | "compile" | "start"; loaded: number; total: number };

/** After exit a wasm guest's Worker stays to answer these (its vfs outlives the program). */
export interface FileRequest {
  t: "file";
  id: number;
  op: number;
  path: string;
}
