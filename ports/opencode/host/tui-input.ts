// Builds the `TuiInput` that opencode's CLI normally assembles in
// packages/cli/src/commands/handlers/default.ts, for a client that only ever
// attaches to a remote server: no background service, no updater, no npm.
import type { TuiInput } from "@opencode/tui"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export interface RemoteTuiOptions {
  serverUrl: string
  /** HTTP Basic password of `opencode serve` (username is always "opencode"). */
  password?: string
  version: string
  prompt?: string
  log?: TuiInput["log"]
  /** Where the TUI's settings (theme, keybinds, ...) are kept: the native CLI's `<config>/cli.json`.
   * Without it settings last only as long as the process. */
  configFile?: string
}

/** The native CLI keeps this file as JSONC and edits it in place to preserve
 * comments (packages/cli/src/config/config.ts). Nobody hand-edits the
 * browser's copy, so this reads and writes plain JSON; a file that does not
 * parse counts as empty and is left alone until the first change. */
function readConfig(file: string | undefined): Record<string, unknown> {
  if (!file) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeConfig(file: string, config: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file + ".tmp", JSON.stringify(config, null, 2) + "\n")
  renameSync(file + ".tmp", file)
}

export function remoteTuiInput(options: RemoteTuiOptions): TuiInput {
  const file = options.configFile
  let config = readConfig(file)
  return {
    app: { name: "wasm-term", version: options.version, channel: "wasm-term" },
    server: {
      endpoint: {
        url: options.serverUrl,
        auth: options.password
          ? { type: "basic", username: "opencode", password: options.password }
          : undefined,
      },
    },
    args: { prompt: options.prompt },
    config: {
      path: file,
      get: async () => config,
      update: async (update: (draft: Record<string, unknown>) => void) => {
        const next = structuredClone(config)
        update(next)
        config = next
        if (file) writeConfig(file, config)
        return config
      },
    },
    packages: {
      prepare: async (spec: string) => {
        throw new Error(`wasm-term: installing packages is not available in the browser client (${spec})`)
      },
    },
    log: options.log,
  } as unknown as TuiInput
}
