// Shared by Bun build scripts and Node probes. Relative overrides use cwd.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeConfig = JSON.parse(readFileSync(resolve(integrationRoot, 'runtime-source.json'), 'utf8'));
export function resolveRuntimeSource(mode = 'patched') {
  if (mode === 'baseline') return resolve(process.env.VIVARI_BASELINE_SOURCE || resolve(integrationRoot, '.runtime/baseline'));
  if (mode !== 'patched' && mode !== 'fork') throw new Error(`Unknown runtime mode: ${mode}`);
  return process.env.VIVARI_SOURCE ? resolve(process.env.VIVARI_SOURCE) : resolve(integrationRoot, runtimeConfig.checkout);
}
export function runtimeSourcePath(...parts) { return resolve(resolveRuntimeSource(), ...parts); }
export function runtimeSourceUrl(...parts) { return pathToFileURL(runtimeSourcePath(...parts)); }
