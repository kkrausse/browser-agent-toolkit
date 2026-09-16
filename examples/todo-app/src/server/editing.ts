/** LOCAL FIXTURE ONLY: explicitly enabled loopback admin, not an identity provider. */
export function authorizeEditing(request: Request) {
  const url = new URL(request.url)
  return process.env.LOCAL_EDITOR_ADMIN === '1'
    && ['localhost', '127.0.0.1'].includes(url.hostname)
    && (!request.headers.get('origin') || request.headers.get('origin') === url.origin)
}
