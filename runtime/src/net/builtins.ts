// Registers the networking builtins with the process runtime
// (runtime/src/node/registry.ts; runtime/build.ts imports every
// `src/<part>/builtins.ts` into the process bundle).
//
// `bat:net-globals` is a hidden module whose only job is to install the
// routed global `fetch`; the host names it in the runtime's `prewarm` list so
// every process has it before guest code runs. Requiring `net`, `http` or
// `https` installs it too, for a host that does not.
import { registerBuiltin } from '../node/registry'
import type { Runtime } from '../process/runtime'
import { installFetch } from './fetch'
import { getHttp } from './http'
import { getNet } from './net'

export const NET_GLOBALS = 'bat:net-globals'

function globals(rt: Runtime) {
  installFetch(rt)
}

registerBuiltin('net', (rt) => {
  globals(rt)
  return getNet(rt).net
})
registerBuiltin('http', (rt) => {
  globals(rt)
  return getHttp(rt).http
})
registerBuiltin('https', (rt) => {
  globals(rt)
  return getHttp(rt).https
})
registerBuiltin(
  NET_GLOBALS,
  (rt) => {
    globals(rt)
    return {}
  },
  { hidden: true },
)
