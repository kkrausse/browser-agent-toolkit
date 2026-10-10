// Replaces packages/tui `#zed-sqlite` (bun:sqlite / node:sqlite), used only to
// read the Zed editor's selection database when running inside Zed's terminal.
export function Database(file: string): never {
  throw new Error(`wasm-term: sqlite is not available in the browser client (${file})`)
}
