// What the worker runtime (or any other embedder of the node shim) installs
// before a bundled program is evaluated. modules/*.ts read it at import time.

import type { NodeFs } from "./fs";

export interface NodeGlobals {
  fs: NodeFs;
  /** The `process` object (also installed as `globalThis.process`). */
  process: any;
}

export const NODE_GLOBAL = "__wasmTermNode";

export function installNodeGlobals(node: NodeGlobals): void {
  (globalThis as Record<string, unknown>)[NODE_GLOBAL] = node;
}

export function nodeGlobals(): NodeGlobals {
  const node = (globalThis as Record<string, unknown>)[NODE_GLOBAL] as NodeGlobals | undefined;
  if (!node) throw new Error("wasm-term: the node shim was not installed before a module that needs it was evaluated");
  return node;
}
