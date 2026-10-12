(() => {
  // runtime/src/host/stream-port.ts
  var transferable;
  var forced = false;
  function canTransferStreams() {
    if (forced)
      return false;
    if (transferable !== undefined)
      return transferable;
    try {
      const { port1, port2 } = new MessageChannel;
      const probe = new ReadableStream;
      port1.postMessage(probe, [probe]);
      port1.close();
      port2.close();
      transferable = true;
    } catch {
      transferable = false;
    }
    return transferable;
  }
  function portToStream(port) {
    let answered;
    return new ReadableStream({
      start(controller) {
        port.onmessage = (e) => {
          const said = e.data;
          if (said.t === "chunk")
            controller.enqueue(said.data);
          else {
            if (said.t === "end")
              controller.close();
            else
              controller.error(new Error(said.message));
            port.close();
          }
          answered?.();
        };
      },
      pull() {
        port.postMessage("pull");
        return new Promise((resolve) => {
          answered = resolve;
        });
      },
      cancel() {
        port.postMessage("cancel");
        port.close();
      }
    });
  }

  // runtime/src/sw/preview-shim.ts
  function previewShim(prefix = "/preview/") {
    const w = globalThis;
    if (w.__batPreviewShim)
      return;
    w.__batPreviewShim = true;
    const Native = w.WebSocket;
    let report = () => {};
    try {
      if (w.parent !== w && w.parent.__batPreviewReport) {
        const words = (value) => {
          try {
            return String(value instanceof Error ? `${value.name}: ${value.message}
${value.stack ?? ""}` : typeof value === "object" && value ? JSON.stringify(value) : value).slice(0, 2000);
          } catch {
            return String(value).slice(0, 2000);
          }
        };
        report = (kind, text) => {
          try {
            w.parent.postMessage({ t: "bat-preview", kind, text: words(text) }, location.origin);
          } catch {}
        };
        addEventListener("error", (e) => {
          const target = e.target;
          if (target && target !== w && (target.src || target.href))
            report("error", `${String(target.tagName).toLowerCase()} failed to load: ${target.src || target.href}`);
          else
            report("error", e.error instanceof Error ? e.error : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
        }, true);
        addEventListener("unhandledrejection", (e) => report("rejection", e.reason));
        const original = console.error.bind(console);
        console.error = (...args) => {
          report("console.error", args.map(words).join(" "));
          original(...args);
        };
        report("state", `shim ran in ${location.pathname}, readyState ${document.readyState}`);
        addEventListener("DOMContentLoaded", () => report("state", "DOMContentLoaded"));
        addEventListener("load", () => report("state", "load"));
      }
    } catch {}
    const socketState = (url, protocols, state) => {
      const said = `${state} ${new URL(url).pathname}${protocols.length ? ` (${protocols.join(",")})` : ""}`;
      w.__batPreviewWs = said;
      report("ws", said);
    };
    const guestPath = { test: (path) => path.startsWith(prefix) && /^\d+(\/|$)/.test(path.slice(prefix.length)) };
    const CONNECTING = 0;
    const OPEN = 1;
    const CLOSING = 2;
    const CLOSED = 3;

    class GuestSocket extends EventTarget {
      _url;
      _state = CONNECTING;
      _protocol = "";
      _extensions = "";
      _buffered = 0;
      _binaryType = "blob";
      _port;
      _protocols = [];
      _order = Promise.resolve();
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      constructor(url, protocols) {
        super();
        this._url = url.href;
        const channel = new MessageChannel;
        this._port = channel.port1;
        this._port.onmessage = (e) => this._receive(e.data);
        this._protocols = protocols;
        socketState(this._url, protocols, "connecting");
        const message = { t: "bat-ws", url: url.href, protocols, channel: channel.port2 };
        const controller = navigator.serviceWorker.controller;
        if (controller)
          controller.postMessage(message, [channel.port2]);
        else {
          navigator.serviceWorker.ready.then((registration) => registration.active.postMessage(message, [channel.port2]), () => this._receive({ t: "close", code: 1006, reason: "", wasClean: false }));
        }
        addEventListener("pagehide", () => {
          if (this._state !== CLOSED)
            this._port.postMessage({ t: "close", code: 1001, reason: "" });
        });
      }
      _emit(name, event) {
        const handler = this[`on${name}`];
        if (typeof handler === "function") {
          try {
            handler.call(this, event);
          } catch (e) {
            setTimeout(() => {
              throw e;
            });
          }
        }
        this.dispatchEvent(event);
      }
      _receive(m) {
        if (this._state === CLOSED)
          return;
        if (m.t === "open") {
          this._state = OPEN;
          this._protocol = m.protocol;
          this._extensions = m.extensions;
          socketState(this._url, this._protocols, "open");
          this._emit("open", new Event("open"));
        } else if (m.t === "message") {
          const data = typeof m.data === "string" || this._binaryType === "arraybuffer" ? m.data : new Blob([m.data]);
          this._emit("message", new MessageEvent("message", { data, origin: new URL(this._url).origin }));
        } else if (m.t === "error") {
          this._emit("error", new Event("error"));
        } else if (m.t === "close") {
          const failed = this._state === CONNECTING;
          this._state = CLOSED;
          this._port.close();
          socketState(this._url, this._protocols, failed ? "failed to connect" : `closed (${m.code})`);
          if (failed)
            this._emit("error", new Event("error"));
          this._emit("close", new CloseEvent("close", { code: m.code, reason: m.reason, wasClean: m.wasClean }));
        }
      }
      get url() {
        return this._url;
      }
      get readyState() {
        return this._state;
      }
      get bufferedAmount() {
        return this._buffered;
      }
      get extensions() {
        return this._extensions;
      }
      get protocol() {
        return this._protocol;
      }
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(v) {
        if (v === "blob" || v === "arraybuffer")
          this._binaryType = v;
      }
      send(data) {
        if (this._state === CONNECTING)
          throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
        if (this._state !== OPEN)
          return;
        if (typeof data === "string") {
          this._order = this._order.then(() => this._port.postMessage({ t: "send", data }));
        } else if (data instanceof Blob) {
          const bytes = data.arrayBuffer();
          this._order = this._order.then(async () => {
            const buffer = await bytes;
            this._port.postMessage({ t: "send", data: buffer }, [buffer]);
          });
        } else {
          const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
          const buffer = view.slice().buffer;
          this._order = this._order.then(() => this._port.postMessage({ t: "send", data: buffer }, [buffer]));
        }
      }
      close(code, reason) {
        if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
          throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, "InvalidAccessError");
        }
        if (this._state === CLOSING || this._state === CLOSED)
          return;
        this._state = CLOSING;
        this._order = this._order.then(() => this._port.postMessage({ t: "close", code, reason }));
      }
    }
    for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
      Object.defineProperty(GuestSocket.prototype, name, { value, enumerable: true });
    }
    Object.setPrototypeOf(GuestSocket.prototype, Native.prototype);
    const Replacement = function WebSocket(url, protocols) {
      if (!new.target)
        throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      let parsed;
      try {
        parsed = new URL(String(url), location.href);
      } catch {}
      if (parsed) {
        if (parsed.protocol === "http:")
          parsed.protocol = "ws:";
        else if (parsed.protocol === "https:")
          parsed.protocol = "wss:";
      }
      if (parsed && (parsed.protocol === "ws:" || parsed.protocol === "wss:") && parsed.host === location.host && guestPath.test(parsed.pathname)) {
        const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)];
        return new GuestSocket(parsed, list);
      }
      return protocols === undefined ? new Native(url) : new Native(url, protocols);
    };
    Replacement.prototype = Native.prototype;
    for (const [name, value] of [["CONNECTING", CONNECTING], ["OPEN", OPEN], ["CLOSING", CLOSING], ["CLOSED", CLOSED]]) {
      Object.defineProperty(Replacement, name, { value, enumerable: true });
    }
    w.WebSocket = Replacement;
    try {
      Object.defineProperty(w, "SharedWorker", { value: undefined, configurable: true, writable: true });
    } catch {}
  }

  // runtime/src/sw/sw.ts
  var ISOLATION = [
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ...self.__batPreviewHeaders ?? []
  ];
  var scopePath = new URL(self.registration.scope).pathname;
  var PREFIX = scopePath.endsWith("/preview/") ? scopePath : `${scopePath}${scopePath.endsWith("/") ? "" : "/"}preview/`;
  var SHIM = `<script>(${previewShim.toString()})(${JSON.stringify(PREFIX)})</script>`;
  var route = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)(\\/.*)?$`);
  var bridge;
  var bridgeWaiters = [];
  var hostPaths = new Map;
  var guestPaths = new Map;
  var setGuestPaths = (all) => {
    guestPaths.clear();
    for (const [port, routes] of Object.entries(all ?? {}))
      guestPaths.set(Number(port), Object.entries(routes));
  };
  var under = (path, p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(`${p}?`);
  var jars = new Map;
  var pending = new Map;
  var nextId = 1;
  function setBridge(port) {
    bridge?.close();
    bridge = port;
    port.onmessage = (e) => {
      const m = e.data;
      if (m.t === "response" && m.body && !(m.body instanceof ArrayBuffer) && !(m.body instanceof ReadableStream))
        m.body = portToStream(m.body.port);
      const p = pending.get(m.id);
      if (!p)
        return void (m.t === "response" && m.body instanceof ReadableStream && m.body.cancel().catch(() => {}));
      pending.delete(m.id);
      if (m.t === "response")
        p.resolve(m);
      else
        p.reject(Object.assign(new Error(m.message), { code: m.code }));
    };
    port.onclose = () => {
      if (bridge === port)
        dropBridge();
    };
    for (const wake of bridgeWaiters.splice(0))
      wake(port);
  }
  function dropBridge() {
    bridge = undefined;
    for (const p of pending.values())
      p.reject(Object.assign(new Error("The editor runtime closed"), { code: "ECLOSED" }));
    pending.clear();
  }
  async function getBridge() {
    if (bridge)
      return bridge;
    const waiter = new Promise((resolve) => {
      bridgeWaiters.push(resolve);
      setTimeout(() => resolve(undefined), 4000);
    });
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      client.postMessage({ t: "bat-need-port" });
    return waiter;
  }
  self.addEventListener("install", () => void self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || typeof m.t !== "string")
      return;
    if (m.t === "bat-port") {
      hostPaths.clear();
      for (const [port, list] of Object.entries(m.hostPaths))
        hostPaths.set(Number(port), list);
      setGuestPaths(m.guestPaths);
      setBridge(m.port);
    } else if (m.t === "bat-host-paths") {
      hostPaths.clear();
      for (const [port, list] of Object.entries(m.hostPaths))
        hostPaths.set(Number(port), list);
    } else if (m.t === "bat-guest-paths") {
      setGuestPaths(m.guestPaths);
    } else if (m.t === "bat-closed") {
      dropBridge();
    } else if (m.t === "bat-ws") {
      event.waitUntil(openWebSocket(m));
    }
  });
  async function openWebSocket(m) {
    const url = new URL(m.url);
    const match = route.exec(url.pathname);
    const port = await getBridge();
    if (!match || !port) {
      m.channel.postMessage({ t: "close", code: 1006, reason: "", wasClean: false });
      return;
    }
    const guestPort = Number(match[1]);
    const headers = [
      ["origin", self.location.origin],
      ["user-agent", navigator.userAgent]
    ];
    const cookie = cookieHeader(guestPort);
    if (cookie)
      headers.push(["cookie", cookie]);
    const message = { t: "ws", port: guestPort, path: url.pathname + url.search, protocols: m.protocols, headers, channel: m.channel };
    port.postMessage(message, [m.channel]);
  }
  function cookieHeader(port) {
    const jar = jars.get(port);
    return jar ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  }
  function storeCookie(port, line) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0)
      return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let jar = jars.get(port);
    if (!jar)
      jars.set(port, jar = new Map);
    let expired = false;
    for (const attr of attrs) {
      const [k, v = ""] = attr.trim().split("=");
      if (/^max-age$/i.test(k) && Number(v) <= 0)
        expired = true;
      if (/^expires$/i.test(k) && Date.parse(v) <= Date.now())
        expired = true;
    }
    if (expired)
      jar.delete(name);
    else
      jar.set(name, value);
  }
  function injectShim(body) {
    const decoder = new TextDecoder("latin1");
    const shim = new TextEncoder().encode(SHIM);
    let held = [];
    let heldBytes = 0;
    let done = false;
    const flush = (controller, final) => {
      const all = new Uint8Array(heldBytes);
      let at = 0;
      for (const c of held) {
        all.set(c, at);
        at += c.length;
      }
      const text = decoder.decode(all);
      const head = /<head(?:\s[^>]*)?>/i.exec(text);
      let cut = -1;
      if (head)
        cut = head.index + head[0].length;
      else if (final || heldBytes >= 16384) {
        const html = /<html(?:\s[^>]*)?>/i.exec(text);
        const doctype = /<!doctype[^>]*>/i.exec(text);
        cut = html ? html.index + html[0].length : doctype ? doctype.index + doctype[0].length : 0;
      }
      if (cut < 0)
        return;
      done = true;
      held = [];
      controller.enqueue(all.subarray(0, cut));
      controller.enqueue(shim);
      if (cut < all.length)
        controller.enqueue(all.subarray(cut));
    };
    return body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        if (done)
          return controller.enqueue(chunk);
        held.push(chunk);
        heldBytes += chunk.length;
        flush(controller, false);
      },
      flush(controller) {
        if (!done)
          flush(controller, true);
      }
    }));
  }
  function plain(status, text) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Preview</title><body style="font:14px system-ui;padding:2rem;color:#555">${text}</body>`, {
      status,
      headers: [...ISOLATION, ["Content-Type", "text/html; charset=utf-8"], ["Cache-Control", "no-store"]]
    });
  }
  async function toGuest(event, guestPort, url) {
    const request = event.request;
    const port = await getBridge();
    if (!port)
      return plain(503, "The editor is not running in this browser tab.");
    const headers = [];
    request.headers.forEach((value, name) => headers.push([name, value]));
    if (!request.headers.has("user-agent"))
      headers.push(["user-agent", navigator.userAgent]);
    headers.push(["x-forwarded-host", url.host], ["x-forwarded-proto", url.protocol.slice(0, -1)]);
    const cookie = cookieHeader(guestPort);
    if (cookie)
      headers.push(["cookie", cookie]);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
    const id = nextId++;
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const sent = !hasBody ? null : canTransferStreams() && request.body ? request.body : await request.arrayBuffer();
    const message = { t: "fetch", id, port: guestPort, method: request.method, path: url.pathname + url.search, headers, body: sent };
    port.postMessage(message, sent ? [sent] : []);
    request.signal.addEventListener("abort", () => {
      port.postMessage({ t: "abort", id });
      pending.get(id)?.reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      pending.delete(id);
    });
    let res;
    try {
      res = await answer;
    } catch (e) {
      const code = e?.code;
      if (code === "ECONNREFUSED")
        return plain(503, `Nothing is listening on port ${guestPort} in the editor yet.`);
      return plain(502, `The preview server did not answer (${code ?? "error"}).`);
    }
    const out = new Headers;
    let html = false;
    for (const [name, value] of res.headers) {
      const lower = name.toLowerCase();
      if (lower === "set-cookie") {
        storeCookie(guestPort, value);
        continue;
      }
      if (lower === "content-type" && /^text\/html\b/i.test(value))
        html = true;
      if (lower === "location") {
        try {
          const target = new URL(value, url);
          if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(target.hostname) && Number(target.port || 80) === guestPort) {
            out.append(name, url.origin + target.pathname + target.search + target.hash);
            continue;
          }
        } catch {}
      }
      try {
        out.append(name, value);
      } catch {}
    }
    for (const [name, value] of ISOLATION)
      out.set(name, value);
    if (!/\b(max-age|s-maxage|immutable)\b/i.test(out.get("cache-control") ?? ""))
      out.set("Vary", "*");
    const discard = () => res.body instanceof ReadableStream ? res.body.cancel().catch(() => {}) : undefined;
    if (res.status < 200 || res.status > 599) {
      await discard();
      return plain(502, `The preview server answered with status ${res.status}.`);
    }
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304 || request.method === "HEAD";
    let body = nullBody ? null : res.body;
    if (nullBody)
      discard();
    if (body && html && res.status !== 206) {
      body = injectShim(body instanceof ReadableStream ? body : new Response(body).body);
      out.delete("content-length");
    }
    return new Response(body, { status: res.status, statusText: /^[\t\x20-\x7e]*$/.test(res.statusText) ? res.statusText : "", headers: out });
  }
  function toHost(request, target) {
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
    const init = {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      credentials: "same-origin",
      cache: request.cache === "only-if-cached" ? "default" : request.cache,
      redirect: request.mode === "navigate" ? "manual" : request.redirect,
      referrer: request.referrer,
      signal: request.signal
    };
    if (hasBody)
      init.duplex = "half";
    return fetch(target, init);
  }
  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin)
      return;
    const match = route.exec(url.pathname);
    if (!match) {
      if (!event.request.referrer)
        return;
      let from = null;
      try {
        const referrer = new URL(event.request.referrer);
        if (referrer.origin === url.origin)
          from = route.exec(referrer.pathname);
      } catch {}
      if (!from)
        return;
      const previewPort = Number(from[1]);
      const find = () => guestPaths.get(previewPort)?.find(([p]) => under(url.pathname, p));
      const target = find();
      if (target)
        event.respondWith(toGuest(event, target[1], url));
      else if (!bridge)
        event.respondWith(getBridge().then(() => {
          const found = find();
          return found ? toGuest(event, found[1], url) : fetch(event.request);
        }));
      return;
    }
    const guestPort = Number(match[1]);
    const below = match[2] ?? "/";
    if (below === "/__bat/ping")
      return event.respondWith(new Response("pong", { headers: [...ISOLATION, ["Cache-Control", "no-store"]] }));
    const prefixes = hostPaths.get(guestPort);
    if (prefixes?.some((p) => under(below, p))) {
      event.respondWith(toHost(event.request, url.origin + below + url.search));
      return;
    }
    event.respondWith(toGuest(event, guestPort, url));
  });
})();
