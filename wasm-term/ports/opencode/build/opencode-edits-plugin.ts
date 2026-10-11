// Bun bundler plugin: the edits this port makes to opencode's own TUI source. Each is an
// exact-match replacement that fails the build when upstream moved the anchor, like the
// OpenTUI edits in opentui-wasm-plugin.ts. The checkout under vendor/ is never written to.
//
//   1. packages/tui/src/component/prompt/index.tsx: a submit waits for the agents.
//      The home screen is drawn and takes keys before the location's agents have arrived
//      from the server (`data.location.sync`, started after the first frame), and
//      `submitInner` returns without a word when there is no current agent: an Enter in
//      that window does nothing and the typed prompt just stays. Against a server on the
//      same machine the window is a few milliseconds; with the server in a browser tab it
//      is 0.3 to 0.7 s (measured: "Ask anything" on screen at 2312 ms, the agent's name at
//      2974 ms), long enough to type `hello` and Enter into. The submit now waits for the
//      agent list of its location to be loaded (at most ten seconds, after which it gives
//      up as before). `submitting` is already set, so further Enters meanwhile are ignored.
import type { BunPlugin } from "bun"
import path from "node:path"
import { OPENTUI_ROOT } from "./opentui-wasm-plugin"

const { transformSolidSource } = (await import(path.join(OPENTUI_ROOT, "packages/solid/scripts/solid-transform.ts"))) as {
  transformSolidSource(code: string, options: { filename: string; moduleName: string }): Promise<string>
}

interface Edit {
  find: string
  replace: string
}

const prompt: Edit[] = [
  {
    find: `    submitting = true
    try {
      return await submitInner(delivery)`,
    replace: `    submitting = true
    try {
      for (let waited = 0; waited < 10_000 && !disposed && data.location.agent.list(currentLocation.ref) === undefined; waited += 20)
        await new Promise((resolve) => setTimeout(resolve, 20))
      return await submitInner(delivery)`,
  },
]

/** Must come before the Solid transform plugin: the first `onLoad` that answers for a file wins, so this one transforms too. */
export function opencodeEditsPlugin(): BunPlugin {
  return {
    name: "opencode-edits",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/]tui[\\/]src[\\/]component[\\/]prompt[\\/]index\.tsx$/ }, async (args) => {
        let source = await Bun.file(args.path).text()
        for (const edit of prompt) {
          if (!source.includes(edit.find)) throw new Error(`opencode-edits-plugin: anchor not found in ${args.path}:\n  ${edit.find}`)
          source = source.replace(edit.find, edit.replace)
        }
        return { loader: "js", contents: await transformSolidSource(source, { filename: args.path, moduleName: "@opentui/solid" }) }
      })
    },
  }
}
