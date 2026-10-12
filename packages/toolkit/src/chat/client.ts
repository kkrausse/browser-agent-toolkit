// The official OpenCode client (`@opencode/client`, the zero-Effect promise entry) over the
// toolkit's endpoint. The client builds absolute URLs from `baseUrl` and calls
// `fetch(url, init)`; the endpoint wants what the server sees (`/api/session?…`), so the
// base is a placeholder origin and only path and query are forwarded. Server-sent events
// are read from `response.body`, which the endpoint's fetch streams.
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import type { ChatEndpoint } from './types';

export type { OpenCodeClient };

/** Never fetched: the endpoint replaces the origin. */
const placeholder = 'http://opencode.invalid';

/** `track` sees every request the client starts (the controller joins them on dispose). */
export function createClient(endpoint: ChatEndpoint, track: <A>(request: Promise<A>) => Promise<A> = request => request): OpenCodeClient {
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return track(endpoint.fetch(url.pathname + url.search, init));
  };
  return OpenCode.make({ baseUrl: placeholder, fetch: fetch as typeof globalThis.fetch });
}
