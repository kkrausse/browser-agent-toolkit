import { readFileSync } from 'node:fs';

/** Build-time macro: ship the guest tracing entry (opencode-trace-guest.cjs) as text. */
export function openCodeTraceSource(): string {
  return readFileSync(new URL('./opencode-trace-guest.cjs', import.meta.url), 'utf8');
}
