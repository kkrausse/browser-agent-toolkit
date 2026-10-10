// Builds the `TuiInput` that opencode's CLI normally assembles in
// packages/cli/src/commands/handlers/default.ts, for a client that only ever
// attaches to a remote server: no background service, no updater, no npm.
import type { TuiInput } from "@opencode/tui"

export interface RemoteTuiOptions {
  serverUrl: string
  /** HTTP Basic password of `opencode serve` (username is always "opencode"). */
  password?: string
  version: string
  prompt?: string
  log?: TuiInput["log"]
}

export function remoteTuiInput(options: RemoteTuiOptions): TuiInput {
  let config: Record<string, unknown> = {}
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
      get: async () => config,
      update: async (update: (draft: Record<string, unknown>) => void) => {
        const next = structuredClone(config)
        update(next)
        config = next
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
