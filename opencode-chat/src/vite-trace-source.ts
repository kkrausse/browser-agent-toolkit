import { readFileSync } from 'node:fs';

/** Build-time macro: ship the guest Vite tracing entry (vite-trace-guest.cjs) as text. */
export function viteTraceSource(): string {
  return readFileSync(new URL('./vite-trace-guest.cjs', import.meta.url), 'utf8');
}
