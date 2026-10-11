/**
 * Public API for @random/ghostty-web
 *
 * Local browser wrapper around official Ghostty WASM. Selected API conventions
 * follow xterm.js; this is not a full xterm.js compatibility implementation.
 */

import { Ghostty } from './ghostty';

// Module-level Ghostty instance (initialized by init())
let ghosttyInstance: Ghostty | null = null;
let initialization: Promise<void> | null = null;

export interface InitOptions {
  /** URL of the official Ghostty WASM artifact. The first successful init wins. */
  wasmUrl?: string;
}

/**
 * Initialize the ghostty-web library by loading the WASM module.
 * Must be called before creating any Terminal instances.
 *
 * This creates a shared WASM instance that all Terminal instances will use.
 * For test isolation, pass a Ghostty instance directly to Terminal constructor.
 * Concurrent calls share one load; later URLs are ignored after success.
 * Failed loads can be retried with a new URL.
 *
 * @example
 * ```typescript
 * import { init, Terminal } from '@random/ghostty-web';
 *
 * await init({ wasmUrl: '/ghostty-vt.wasm' }); // Or init('/ghostty-vt.wasm')
 * const term = new Terminal();
 * term.open(document.getElementById('terminal'));
 * ```
 */
export function init(options: InitOptions | string = {}): Promise<void> {
  if (ghosttyInstance) {
    return Promise.resolve();
  }
  if (!initialization) {
    const wasmUrl = typeof options === 'string' ? options : options.wasmUrl;
    initialization = Ghostty.load(wasmUrl).then(
      (instance) => { ghosttyInstance = instance; },
      (error) => {
        initialization = null; // Permit retry after a failed download/instantiation.
        throw error;
      }
    );
  }
  return initialization;
}

/**
 * Get the initialized Ghostty instance.
 * Throws if init() hasn't been called.
 * @internal
 */
export function getGhostty(): Ghostty {
  if (!ghosttyInstance) {
    throw new Error(
      'ghostty-web not initialized. Call init() before creating Terminal instances.\n' +
        'Example:\n' +
        '  import { init, Terminal } from "@random/ghostty-web";\n' +
        '  await init();\n' +
        '  const term = new Terminal();\n\n' +
        'For tests, pass a Ghostty instance directly:\n' +
        '  import { Ghostty, Terminal } from "@random/ghostty-web";\n' +
        '  const ghostty = await Ghostty.load();\n' +
        '  const term = new Terminal({ ghostty });'
    );
  }
  return ghosttyInstance;
}

// Main Terminal class
export { Terminal } from './terminal';

// Supported terminal interfaces (xterm-style naming)
export type {
  ITerminalOptions,
  ITheme,
  ITerminalAddon,
  ITerminalCore,
  IDisposable,
  IEvent,
  IBufferRange,
  IKeyEvent,
  IUnicodeVersionProvider,
} from './interfaces';

// Ghostty WASM components (for advanced usage)
export {
  Ghostty,
  GhosttyTerminal,
  KeyEncoder,
  CellFlags,
  DirtyState,
  KeyEncoderOption,
} from './ghostty';
export { Key, KeyAction, Mods } from './types';
export type { KeyEvent, GhosttyCell, RGB, Cursor, TerminalHandle } from './types';

// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { RendererOptions, FontMetrics, IRenderable } from './renderer';
export { WebglRenderer } from './webgl/webgl-renderer';
export type { WebglRendererOptions, ImagePlacement } from './webgl/webgl-renderer';
export { createRenderer } from './renderer-factory';
export type { RendererType } from './renderer-factory';
export type { ITerminalRenderer, IScrollbackProvider } from './renderer-interface';
export { InputHandler } from './input-handler';
export { EventEmitter } from './event-emitter';
export { SelectionManager } from './selection-manager';
export type { SelectionCoordinates } from './selection-manager';

// Addons
export { FitAddon } from './addons/fit';
export type { ITerminalDimensions } from './addons/fit';

// Link providers
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export { LinkDetector } from './link-detector';
export type { ILink, ILinkProvider, IBufferCellPosition } from './types';
