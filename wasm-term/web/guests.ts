// What the dev page knows about a guest. Wasm guests are just files in
// guests/dist; a JavaScript guest (a port) describes itself with one of these
// and the server serves its directory under /guests/<name>/.

export interface GuestParam {
  /** Query parameter on the page URL, e.g. `server`. */
  query: string;
  /** Environment variable the program receives it as. */
  env?: string;
  /** Arguments it adds to the program's argv, `{}` replaced by the value; nothing is added for an empty value. */
  args?: string[];
  label: string;
  default: string;
  secret?: boolean;
  /** The value is a URL; one starting with `/` is a path on the page's own origin
   * (the dev server's reverse proxy) and reaches the program as an absolute URL.
   * "ws": as a WebSocket URL (ws:// on an http page, wss:// on an https one). */
  url?: boolean | "ws";
  hint?: string;
}

export interface GuestInfo {
  name: string;
  kind: "wasm" | "js";
  description?: string;
  params?: GuestParam[];
  /** Directories kept across reloads (default for wasm guests: the home directory). */
  persist?: { roots: string[]; exclude?: string[] };
  /** Environment the guest always gets (the page's `?env=` wins). */
  env?: Record<string, string>;
  /** A wasm guest's module, when it is not /guests/<name>.wasm; other builds of it by name (`?build=`). */
  module?: string;
  builds?: Record<string, string>;
}

/** A wasm guest that is a port: packaged into a directory with a manifest
 * (content-hashed, precompressed files) instead of one file in guests/dist. */
export interface WasmGuest extends GuestInfo {
  kind: "wasm";
  /** Directory with manifest.json: build name -> { file, size, ... }; `default` is the module to run. */
  site: string;
  /** Shown when `site` has not been built. */
  build?: string;
}

export interface JsGuest extends GuestInfo {
  kind: "js";
  /** Built files; `guest.js` in it is the module the machine imports. */
  dir?: string;
  /** Shown when `dir` has not been built. */
  build?: string;
  /** Instead of `dir`: a TypeScript entry the dev server bundles into guest.js on every load. */
  entry?: string;
}
