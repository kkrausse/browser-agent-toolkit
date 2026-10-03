/** LOCAL FIXTURE ONLY: explicitly enabled loopback admin, not an identity provider. */
export function authorizeEditing(request: Request) {
  const url = new URL(request.url)
  if (process.env.LOCAL_EDITOR_ADMIN !== '1') return false
  const origin = request.headers.get('origin')
  if (['localhost', '127.0.0.1'].includes(url.hostname)) return !origin || origin === url.origin
  // `tailscale serve` adds Tailscale-User-Login for signed-in tailnet users (never for Funnel
  // traffic). The server listens on loopback only, so the local tailscaled is the one sender.
  // The proxy terminates TLS and changes the port: match the page origin by hostname.
  return !!request.headers.get('tailscale-user-login') && (!origin || new URL(origin).hostname === url.hostname)
}
