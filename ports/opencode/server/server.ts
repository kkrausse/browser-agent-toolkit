// The OpenCode server as the runtime starts it: the published `@opencode/server` process
// entry on `node:http`, port 4096, Basic auth, ending on stdin EOF. The same shape as the
// 2.0.3 artefact (the old toolkit's `vivari/experiments/opencode-release-server`), with the
// environment switches the OpenCode CLI itself reads for the same options.
import { NodeServices } from '@effect/platform-node'
import { Effect, References } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { ServerProcess } from '@opencode/server/process'

declare const OPENCODE_SERVER_VERSION: string
// OPENCODE_LOG_LEVEL as the OpenCode CLI reads it (default INFO, where every bus event is a multi-line record on stdout).
const logLevel = ({ DEBUG: 'Debug', INFO: 'Info', WARN: 'Warn', ERROR: 'Error' } as const)[(process.env.OPENCODE_LOG_LEVEL ?? '').toUpperCase()] ?? 'Info'
const off = (name: string) => ['1', 'true'].includes((process.env[name] ?? '').toLowerCase())

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const server = yield* ServerProcess.start({
    app: { name: process.env.OPENCODE_CLIENT ?? 'bat-opencode-server', version: OPENCODE_SERVER_VERSION, channel: 'stable' },
    hostname: '127.0.0.1', port: 4096,
    password: process.env.OPENCODE_PASSWORD,
    database: { path: process.env.OPENCODE_DATABASE_PATH ?? '/workspace/.server/data/opencode.sqlite' },
    // The official catalog, refreshed; embedded model ids can be retired.
    models: { url: process.env.OPENCODE_MODELS_URL, file: process.env.OPENCODE_MODELS_PATH, fetch: !off('OPENCODE_DISABLE_MODELS_FETCH') },
    config: { project: false, content: process.env.OPENCODE_CONFIG_CONTENT ?? '{"snapshot":false}' },
    fs: { filewatcher: false, fff: false },
  }, {
    onListen: (_address, shutdown) => Effect.sync(() => {
      const stop = () => { void Effect.runPromise(shutdown) }
      process.stdin.once('end', stop)
      process.stdin.resume()
      return Effect.sync(() => { process.stdin.removeListener('end', stop) })
    }),
  })
  console.log('OPENCODE_SERVER_PROCESS_READY')
  yield* server.shutdown
})).pipe(
  // A browser's fetch carries these requests: CORS policies of public endpoints (the model
  // catalog) reject Effect's `b3` / `traceparent` headers.
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provideService(References.MinimumLogLevel, logLevel),
  Effect.provide(NodeServices.layer),
))
console.log('OPENCODE_SERVER_PROCESS_SHUTDOWN_COMPLETE')
