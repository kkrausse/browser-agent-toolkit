// Replaces OpenTUI's core/src/lib/host-clipboard.native.ts, whose backend
// drives X11/Wayland/AppKit/Win32 from native worker threads (dropped from the
// wasm build). The host clipboard of a browser client is the browser's: the
// embedder may install `globalThis.__wasmTermClipboard`; without it the host
// side reports "unsupported" and OpenTUI falls back to OSC 52 through the
// terminal, which ghostty-web can service.
export interface WasmTermClipboard {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

const bridge = () => (globalThis as { __wasmTermClipboard?: WasmTermClipboard }).__wasmTermClipboard
const failure = (error: unknown) => ({
  status: "failed" as const,
  error: error instanceof Error ? error : new Error(String(error)),
})

export const createNativeHostClipboardBackend = () => ({
  async read(options: { preferredTypes: readonly string[] }) {
    const clipboard = bridge()
    if (!clipboard || !options.preferredTypes.includes("text/plain")) return { status: "unsupported" as const }
    try {
      const text = await clipboard.readText()
      if (text.length === 0) return { status: "empty" as const }
      return {
        status: "read" as const,
        representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(text) },
      }
    } catch (error) {
      return failure(error)
    }
  },
  async writeText(text: string) {
    const clipboard = bridge()
    if (!clipboard) return { status: "unsupported" as const }
    try {
      await clipboard.writeText(text)
      return { status: "written" as const }
    } catch (error) {
      return failure(error)
    }
  },
  async clear() {
    return { status: "unsupported" as const }
  },
  async dispose() {},
})
