// node:url (Bun's browser polyfill lacks fileURLToPath / pathToFileURL).
export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams

export function fileURLToPath(url: string | URL): string {
  const parsed = typeof url === "string" ? new globalThis.URL(url) : url
  if (parsed.protocol !== "file:") return decodeURIComponent(parsed.pathname)
  return decodeURIComponent(parsed.pathname)
}

export function pathToFileURL(path: string): URL {
  const url = new globalThis.URL("file:///")
  url.pathname = path.split("/").map(encodeURIComponent).join("/")
  return url
}

export function format(url: URL | string): string {
  return String(url)
}

export function parse(input: string) {
  return new globalThis.URL(input, "file:///")
}

export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, format, parse }
