/** Framework deployment basename matching the workspace preview transport. */
export function browserPreviewBase() {
  return process.env.BROWSER_AGENT_GUEST === '1' ? `/preview/${process.env.BROWSER_AGENT_PORT ?? '5173'}/` : '/';
}
