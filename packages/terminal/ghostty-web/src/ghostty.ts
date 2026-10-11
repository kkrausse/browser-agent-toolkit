/** Public compatibility bridge backed exclusively by the official libghostty-vt C API. */
import type { GhosttyTerminalConfig } from './types';
import { OfficialABI } from './official-abi';
import { GhosttyTerminal } from './official-terminal';
import { KeyEncoder } from './official-key';
export { GhosttyTerminal, KeyEncoder };
export { CellFlags, DirtyState, KeyEncoderOption, type Cursor, type GhosttyCell,
  type GhosttyTerminalConfig, type RGB, type RenderStateColors, type RenderStateCursor } from './types';
export class Ghostty {
  private abi: OfficialABI;
  constructor(instance: WebAssembly.Instance) { this.abi = new OfficialABI(instance.exports); }
  createKeyEncoder(): KeyEncoder { return new KeyEncoder(this.abi.exports); }
  createTerminal(cols = 80, rows = 24, config?: GhosttyTerminalConfig): GhosttyTerminal {
    return new GhosttyTerminal(this.abi.exports, this.abi.memory, cols, rows, config);
  }
  static async load(path?: string): Promise<Ghostty> {
    const url = path ?? (typeof Bun !== 'undefined' || typeof window === 'undefined'
      ? new URL('../vendor/ghostty-vt.wasm', import.meta.url).href : '/ghostty-vt.wasm');
    let bytes: ArrayBuffer;
    if (url.startsWith('file:') || (!/^https?:/.test(url) && typeof window === 'undefined')) {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(url.startsWith('file:') ? new URL(url) : url);
      bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch official Ghostty WASM: ${response.status}`);
      bytes = await response.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Ghostty(instance);
  }
}
