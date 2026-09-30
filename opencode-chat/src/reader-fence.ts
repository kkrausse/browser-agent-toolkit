import type { ChatEndpoint } from "./types";

/** Local transport completion only: this is not a remote server-reader barrier. */
export function createReaderFence(endpoint: ChatEndpoint) {
  const pending = new Set<Promise<unknown>>();
  const readers = new Set<() => Promise<void>>();
  const failures: unknown[] = [];
  let closing = false;
  let completion: Promise<void> | undefined;
  function track<A>(promise: Promise<A>): Promise<A> {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  function body(response: Response): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (cancellation) return cancellation;
      if (finished) return Promise.resolve();
      cancellation = track(reader.cancel().then(() => {
        finished = true;
        readers.delete(cancel);
      }, error => {
        failures.push(error);
        throw error;
      }));
      // Effect's stream adapter suppresses cancellation errors. Retain them for close.
      void cancellation.catch(() => {});
      return cancellation;
    };
    readers.add(cancel);
    if (closing) void cancel().catch(() => {});
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await track(reader.read());
          if (item.done) {
            // A read may finish before an asynchronous cancel finalizer does.
            if (!cancellation) {
              finished = true;
              readers.delete(cancel);
            }
            controller.close();
          } else controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    // The official client uses body/status/headers, not Response URL metadata.
    return new Response(stream, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }
  return {
    endpoint: {
      url: endpoint.url,
      fetch(input, init = {}) {
        if (closing) return Promise.reject(new Error("Chat transport is disposed"));
        // Track the injected promise even when Effect stops awaiting it on interrupt.
        return track(Promise.resolve().then(() => {
          if (closing) throw new Error("Chat transport is disposed");
          return endpoint.fetch(input, init);
        }).then(body));
      },
    } satisfies ChatEndpoint,
    close() {
      if (completion) return completion;
      closing = true;
      completion = (async () => {
        for (const cancel of readers) void cancel().catch(() => {});
        // Late fetch responses register and cancel their body before leaving pending.
        while (pending.size) await Promise.allSettled([...pending]);
        if (failures.length) throw new AggregateError(failures, "Chat reader cleanup failed");
      })();
      return completion;
    },
  };
}
