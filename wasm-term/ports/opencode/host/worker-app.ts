// Browser-side application entry: the real opencode TUI (`run` from
// packages/tui) with a remote-only host. Loaded by host/worker-main.ts after
// it has installed globalThis.process, the node shims' backing state and the
// wasm OpenTUI core, because all of those are read at module evaluation.
import { run } from "@opencode/tui"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { remoteTuiInput } from "./tui-input"

declare const OPENCODE_VERSION: string

export interface StartOptions {
  serverUrl: string
  password?: string
  prompt?: string
  log(level: string, message: string, tags?: unknown): void
}

export async function start(options: StartOptions): Promise<void> {
  const input = remoteTuiInput({ ...options, version: OPENCODE_VERSION })
  // The native client sends its own working directory, which is also a path
  // on the server's machine. A browser has no such directory, so adopt the
  // one the server was started in.
  const api = OpenCode.make({ baseUrl: options.serverUrl, headers: Service.headers(input.server.endpoint) })
  const location = await api.location.get()
  mkdirSync(location.directory, { recursive: true })
  process.chdir(location.directory)

  const global = Global.make()
  for (const directory of [global.data, global.config, global.state, global.cache, global.log, global.tmp]) {
    mkdirSync(directory, { recursive: true })
  }
  await Effect.runPromise(run(input).pipe(Effect.provideService(Global.Service, global)))
}
