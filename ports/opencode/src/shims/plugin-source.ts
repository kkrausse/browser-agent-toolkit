// Replaces @opencode/plugin `#plugin-source`, which transpiles and imports a
// plugin's source file from disk (Bun.Transpiler or node:module hooks). The
// browser client has no module loader for arbitrary files.
export async function prepareSource(entrypoint: string): Promise<never> {
  throw new Error(`wasm-term: loading local plugins is not available in the browser client (${entrypoint})`)
}
