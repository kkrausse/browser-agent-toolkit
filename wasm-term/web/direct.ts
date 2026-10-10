// codex-local with `net=direct`: its requests go from this tab straight to OpenAI's hosts, so
// what works depends on what those hosts allow this page's origin to do (CORS). This file is
// what the page knows about that, and what it tells the user when a request is refused.
//
// Observed on 2026-10-10 with unauthenticated preflights (ports/codex/NOTES.md, section 12);
// someone else's servers, and it may change:
// - api.openai.com and auth.openai.com answer every origin (`access-control-allow-origin: *`):
//   an API key and the whole sign-in flow work from anywhere;
// - chatgpt.com/backend-api (what a ChatGPT sign-in uses for everything after the sign-in:
//   the account check, the model list, the model calls) answers a fixed list of origins and
//   refuses the preflight of every other with 400.

import type { HttpBlocked, HttpSeen } from "../host/index";

/** The origins `chatgpt.com/backend-api` accepted, of the ones tried. */
export const CHATGPT_ORIGINS = {
  observed: "2026-10-10",
  /** `http://localhost:<port>` only: not 127.0.0.1, not [::1], not https, not without a port. */
  localhostPorts: [3000, 3002, 3005, 5000, 5001, 5173, 8000, 8002],
  others: ["https://chatgpt.com", "https://chat.openai.com", "https://platform.openai.com", "https://auth.openai.com", "https://sora.com", "https://sora.chatgpt.com", "https://chatgpt-staging.com"],
};

export function chatgptAllows(origin: string): boolean {
  const local = /^http:\/\/localhost:(\d+)$/.exec(origin);
  return local ? CHATGPT_ORIGINS.localhostPorts.includes(Number(local[1])) : CHATGPT_ORIGINS.others.includes(origin);
}

/** A request to the ChatGPT backend (on chatgpt.com, a workspace's own backend host, or the mock's imitation of it). */
const isChatgptBackend = (url: string) => new URL(url).pathname.startsWith("/backend-api/");

export function originRefusedMessage(origin: string): string {
  return `chatgpt.com does not accept requests from this page's origin (${origin}). A ChatGPT subscription can only be used from a page at ` +
    `http://localhost:3000 (also :5173 or :8000): serve this directory there, e.g. "python3 -m http.server 3000" then open http://localhost:3000/ ` +
    `(127.0.0.1 is refused). Or sign in with an API key, which works from any origin, or use the build with the tunnel (net=tunnel).`;
}

/** What the page puts in the launcher about its own origin. */
export function originNote(origin: string): string {
  return chatgptAllows(origin)
    ? `This page's origin (${origin}) is one chatgpt.com accepted requests from on ${CHATGPT_ORIGINS.observed}: ChatGPT sign-in and an API key should both work.`
    : `This page's origin (${origin}) is not one chatgpt.com accepts requests from: an API key works here, and "Sign in with ChatGPT" reaches the sign-in server ` +
      `but then fails, because everything after it goes to chatgpt.com. For a ChatGPT subscription open this directory at http://localhost:3000 (also :5173 or :8000; not 127.0.0.1).`;
}

/** For the static build's launcher: how to get this same directory onto an origin chatgpt.com accepts. The archive
 * is offered when the directory was published with one beside the page (`wasm-term-codex-static.tgz`). */
export async function localhostNote(): Promise<Node> {
  const archive = new URL("wasm-term-codex-static.tgz", location.href).href;
  const has = await fetch(archive, { method: "HEAD", cache: "no-store" }).then(response => response.ok, () => false);
  const note = document.createElement("span");
  const commands = document.createElement("pre");
  commands.textContent = (has ? `curl -LO ${archive}\ntar xzf wasm-term-codex-static.tgz\n` : "") +
    `python3 -m http.server 3000 --bind 127.0.0.1 --directory ${has ? "wasm-term-codex-static" : "<this directory>"}\n# then open http://localhost:3000/  (localhost, not 127.0.0.1)`;
  note.append("To use a ChatGPT subscription, serve this directory on your own machine at http://localhost:3000 with any file server", has ? " (" : "", ...(has ? [Object.assign(document.createElement("a"), { href: archive, textContent: "the directory as an archive, 27 MB" }), ")"] : []), ":", commands);
  return note;
}

let notice: HTMLElement | undefined;
/** A bar across the top of the page, over the terminal; a click dismisses it. */
export function showNotice(text: string): void {
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "notice";
    notice.setAttribute("role", "alert");
    notice.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:10;padding:10px 14px;background:#43242b;color:#dcd7ba;border-bottom:1px solid #c34043;font:13px/1.45 system-ui,sans-serif;cursor:pointer;white-space:pre-wrap";
    notice.title = "Click to dismiss";
    notice.addEventListener("click", () => notice?.remove());
  }
  notice.textContent = text;
  if (!notice.isConnected) document.body.append(notice);
}

/** For `HttpOptions.blocked`: `fetch` rejected a request to another origin. A browser gives script no reason, so this
 * goes by what it can know: offline is the network; a ChatGPT-backend request from an origin outside the observed list
 * is that list, and the program gets a 400 whose body says so: the status chatgpt.com gives such a preflight, and one
 * codex prints as it is and does not retry (a transport error it retries five times and then reports without a
 * reason; a 403 it retries too). Anything else stays the transport error it was, with a notice, since the list may
 * have changed. */
export function explainBlocked(request: HttpBlocked, origin = location.origin): { status: number; body: string } | undefined {
  if (navigator.onLine === false) return undefined;
  const host = new URL(request.url).host;
  if (isChatgptBackend(request.url) && !chatgptAllows(origin)) {
    const message = originRefusedMessage(origin);
    showNotice(message);
    return { status: 400, body: message };
  }
  showNotice(`A request to ${host} failed before any answer (${request.error}): the network, or ${host} does not allow requests from ${origin}.` +
    (isChatgptBackend(request.url) ? ` This origin was accepted on ${CHATGPT_ORIGINS.observed}; that may have changed.` : ""));
  return undefined;
}

/** The last requests the program made, without values: `wasmTerm.requests` in the console. Shows which response
 * headers this origin was allowed to read (rate limits, request ids and the like are hidden unless the server exposes them). */
export function requestLog(limit = 200): { entries: HttpSeen[]; seen(entry: HttpSeen): void } {
  const entries: HttpSeen[] = [];
  return {
    entries,
    seen(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
  };
}
