/** The todo app is an editor demo: editing is always on. The server listens on loopback
 * only (reach it remotely through e.g. `tailscale serve`); refuse cross-site requests. */
export function authorizeEditing(request: Request) {
  const origin = request.headers.get('origin')
  // A TLS-terminating proxy changes scheme and port, so compare hostnames.
  return !origin || new URL(origin).hostname === new URL(request.url).hostname
}
