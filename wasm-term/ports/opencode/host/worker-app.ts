// Browser-side application entry: the real opencode TUI (`run` from
// packages/tui) with a remote-only host. Loaded by host/guest.ts after the
// machine's node shim (process, fs) and the wasm OpenTUI core are in place,
// because all of those are read at module evaluation.
import { run } from "@opencode/tui"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { remoteTuiInput } from "./tui-input"

declare const OPENCODE_VERSION: string

export interface StartOptions {
  serverUrl: string
  password?: string
  /** The project directory: a path on the server's machine. Default: the directory the server runs in. */
  directory?: string
  prompt?: string
  log(level: string, message: string, tags?: unknown): void
}

export async function start(options: StartOptions): Promise<void> {
  const global = Global.make()
  for (const directory of [global.data, global.config, global.state, global.cache, global.log, global.tmp]) {
    mkdirSync(directory, { recursive: true })
  }
  const input = remoteTuiInput({ ...options, version: OPENCODE_VERSION, configFile: path.join(global.config, "cli.json") })
  // The native client sends its own working directory, which is also a path
  // on the server's machine. A browser has no such directory: it is given
  // one, or adopts the one the server was started in.
  let directory = options.directory
  if (!directory) {
    const api = OpenCode.make({ baseUrl: options.serverUrl, headers: Service.headers(input.server.endpoint) })
    directory = (await api.location.get()).directory
  }
  mkdirSync(directory, { recursive: true })
  process.chdir(directory)

  await Effect.runPromise(run(input).pipe(Effect.provideService(Global.Service, global)))
}
