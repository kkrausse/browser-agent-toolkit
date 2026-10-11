// The opencode TUI on the wasm core, hosted by Bun: same UI code and same wasm
// renderer as the browser build, but with Bun's real process/fs/net. Used to
// separate "does the wasm core carry the real app" from "do the browser shims
// work". Loaded by demos/run-bun.ts after the wasm core is booted.
import { run } from "@opencode/tui"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { appendFileSync } from "node:fs"
import { remoteTuiInput } from "./tui-input"

declare const OPENCODE_VERSION: string

const serverUrl = process.env.OPENCODE_SERVER_URL
if (!serverUrl) throw new Error("OPENCODE_SERVER_URL is required")
const logFile = process.env.WASM_TERM_TUI_LOG

await Effect.runPromise(
  run(
    remoteTuiInput({
      serverUrl,
      password: process.env.OPENCODE_SERVER_PASSWORD,
      version: OPENCODE_VERSION,
      prompt: process.env.OPENCODE_PROMPT,
      log: logFile
        ? (level, message, tags) => appendFileSync(logFile, `${level} ${message} ${JSON.stringify(tags ?? {})}\n`)
        : undefined,
    }),
  ).pipe(Effect.provideService(Global.Service, Global.make())),
)
process.exit(0)
