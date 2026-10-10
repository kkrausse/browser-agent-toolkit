// The registration point for builtin modules written in TypeScript.
//
//   import { registerBuiltin } from '../node/registry'
//   registerBuiltin('http', (rt) => createHttp(rt))
//
// A factory runs at most once per process, on the first `require` of its name
// (with or without the `node:` prefix), and returns `module.exports`. It gets
// the Runtime (kernel binding, event loop hooks, builtin require). Modules that
// belong to other parts of the tree (`net`, `http`, `https`, `sqlite`) register
// from `runtime/src/<part>/builtins.ts`; `runtime/build.ts` adds every such
// file to the process bundle, so nothing here names them.
import type { Runtime } from '../process/runtime'

export type BuiltinFactory = (rt: Runtime) => any

export interface BuiltinOptions {
  /** Only reachable with the `node:` prefix (`node:sqlite`, `node:sea`, `node:test`). */
  schemeOnly?: boolean
  /** Not listed in `module.builtinModules` (internal helpers). */
  hidden?: boolean
}

export const factories = new Map<string, { factory: BuiltinFactory; opts: BuiltinOptions }>()

export function registerBuiltin(name: string, factory: BuiltinFactory, opts: BuiltinOptions = {}): void {
  factories.set(name, { factory, opts })
}

/** A module that can be imported but throws when used (`http2`, `tls`, `inspector`). */
export function unsupported(name: string, what: string): never {
  const e = new Error(`${name}: ${what} is not supported in this runtime`) as Error & { code: string }
  e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
  throw e
}
