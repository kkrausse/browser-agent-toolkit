// A JavaScript guest's `fetch`, answered by the page instead of the network.
//
// For a server that is not on the network at all: one that runs in the same
// tab, behind an object only the page holds (browser-agent-toolkit's
// `endpoint(port).fetch`). The page names URL prefixes
// (`ProgramOptions.pageFetch`); in the guest's Worker, `fetch` of a URL under
// one of them crosses a MessagePort to the page, whose handler returns a
// `Response`, and the body comes back chunk by chunk as it arrives, so an
// event stream stays a stream. Everything else is the browser's own `fetch`.
//
// Only JavaScript guests: they return to the Worker's event loop, so a port
// can deliver to them. (A wasm guest's requests already run on the page, in
// net.ts.) Chunks are messages rather than a transferred ReadableStream, which
// Safari cannot transfer.

export interface PageFetchOptions {
  /** Absolute URL prefixes, without a trailing slash (`http://opencode.in-tab`): the URL itself and everything below it. */
  prefixes: string[];
  /** Answers one request. `init.body` is the whole request body; aborting `init.signal` means the guest gave up. */
  fetch(url: string, init: { method: string; headers: [string, string][]; body: Uint8Array | null; signal: AbortSignal }): Promise<Response>;
}

/** What the Worker gets in its `InitMessage`. */
export interface PageFetchInit {
  port: MessagePort;
  prefixes: string[];
}

type ToPage =
  | { t: "request"; id: number; url: string; method: string; headers: [string, string][]; body: Uint8Array | null }
  | { t: "abort"; id: number };
type ToGuest =
  | { t: "head"; id: number; status: number; statusText: string; headers: [string, string][] }
  | { t: "chunk"; id: number; data: Uint8Array }
  | { t: "end"; id: number }
  | { t: "error"; id: number; message: string };

/** Page side: answers the Worker's requests with `options.fetch`. Returns the dispose function. */
export function servePageFetch(port: MessagePort, options: PageFetchOptions): () => void {
  const running = new Map<number, AbortController>();
  const send = (message: ToGuest) => port.postMessage(message);
  async function answer(id: number, request: Extract<ToPage, { t: "request" }>, abort: AbortController): Promise<void> {
    try {
      const response = await options.fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: abort.signal });
      send({ t: "head", id, status: response.status, statusText: response.statusText, headers: [...response.headers] });
      const reader = response.body?.getReader();
      if (reader) {
        abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          send({ t: "chunk", id, data: value });
        }
      }
      send({ t: "end", id });
    } catch (error) {
      if (!abort.signal.aborted) send({ t: "error", id, message: String((error as Error)?.message ?? error) });
    } finally {
      running.delete(id);
    }
  }
  port.onmessage = event => {
    const message = event.data as ToPage;
    if (message.t === "request") {
      const abort = new AbortController();
      running.set(message.id, abort);
      void answer(message.id, message, abort);
    } else if (message.t === "abort") {
      running.get(message.id)?.abort();
    }
  };
  return () => {
    for (const abort of running.values()) abort.abort();
    running.clear();
    port.close();
  };
}

/** Worker side: replaces `globalThis.fetch` so that URLs under the prefixes go to the page. */
export function installPageFetch(init: PageFetchInit): void {
  const native = globalThis.fetch.bind(globalThis);
  const waiting = new Map<number, { head(message: Extract<ToGuest, { t: "head" }>): void; fail(error: Error): void; body?: ReadableStreamDefaultController<Uint8Array> }>();
  let nextId = 1;
  const matches = (url: string) => init.prefixes.some(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));

  init.port.onmessage = event => {
    const message = event.data as ToGuest;
    const entry = waiting.get(message.id);
    if (!entry) return;
    if (message.t === "head") entry.head(message);
    else if (message.t === "chunk") entry.body?.enqueue(message.data);
    else if (message.t === "end") {
      waiting.delete(message.id);
      try { entry.body?.close(); } catch { /* cancelled by the reader */ }
    } else {
      waiting.delete(message.id);
      const error = new TypeError(`Failed to fetch (page): ${message.message}`);
      if (entry.body) { try { entry.body.error(error); } catch { /* cancelled by the reader */ } }
      else entry.fail(error);
    }
  };

  async function relay(request: Request): Promise<Response> {
    const signal = request.signal;
    signal.throwIfAborted();
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;
    const id = nextId++;
    const give = () => {
      if (!waiting.delete(id)) return;
      init.port.postMessage({ t: "abort", id } satisfies ToPage);
    };
    return new Promise<Response>((resolve, reject) => {
      const entry: NonNullable<ReturnType<typeof waiting.get>> = {
        fail: reject,
        head(message) {
          const empty = message.status === 204 || message.status === 205 || message.status === 304 || request.method === "HEAD";
          const stream = empty ? null : new ReadableStream<Uint8Array>({
            start(controller) { entry.body = controller; },
            cancel: give,
          });
          resolve(new Response(stream, { status: message.status, statusText: message.statusText, headers: message.headers }));
        },
      };
      waiting.set(id, entry);
      signal.addEventListener("abort", () => {
        const error = signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
        if (entry.body) { try { entry.body.error(error); } catch { /* already closed */ } }
        else reject(error);
        give();
      }, { once: true });
      init.port.postMessage({ t: "request", id, url: request.url, method: request.method, headers: [...request.headers], body: body?.length ? body : null } satisfies ToPage);
    });
  }

  globalThis.fetch = ((input: RequestInfo | URL, options?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!matches(url)) return native(input, options);
    try { return relay(new Request(input, options)); }
    catch (error) { return Promise.reject(error); }
  }) as typeof fetch;
}
