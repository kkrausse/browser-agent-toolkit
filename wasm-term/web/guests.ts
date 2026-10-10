// What the dev page knows about a guest. Wasm guests are just files in
// guests/dist; a JavaScript guest (a port) describes itself with one of these
// and the server serves its directory under /guests/<name>/.

export interface GuestParam {
  /** Query parameter on the page URL, e.g. `server`. */
  query: string;
  /** Environment variable the program receives it as. */
  env: string;
  label: string;
  default: string;
  secret?: boolean;
  hint?: string;
}

export interface GuestInfo {
  name: string;
  kind: "wasm" | "js";
  description?: string;
  params?: GuestParam[];
  /** Directories kept across reloads (default for wasm guests: the home directory). */
  persist?: { roots: string[]; exclude?: string[] };
}

export interface JsGuest extends GuestInfo {
  kind: "js";
  /** Built files; `guest.js` in it is the module the machine imports. */
  dir: string;
  /** Shown when `dir` has not been built. */
  build: string;
}
