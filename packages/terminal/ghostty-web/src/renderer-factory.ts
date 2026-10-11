/**
 * Renderer selection. `rendererType: 'webgl'` opts into the GPU backend and
 * falls back to Canvas2D if the context can't be created (no WebGL2, blocklisted
 * driver, too many live contexts) — a terminal that renders slowly beats one
 * that doesn't render.
 */

import type { ITheme } from './interfaces';
import { CanvasRenderer } from './renderer';
import type { ITerminalRenderer } from './renderer-interface';
import { WebglRenderer } from './webgl/webgl-renderer';

export type RendererType = 'canvas' | 'webgl';

export interface CreateRendererOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  theme?: ITheme;
  devicePixelRatio?: number;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions,
  type: RendererType = 'canvas'
): ITerminalRenderer {
  // Probe on a throwaway canvas: a canvas that has handed out a webgl2 context
  // can never return a 2d one, so the fallback has to be decided before the
  // real canvas is touched.
  if (type === 'webgl' && supportsWebgl2()) {
    try {
      return new WebglRenderer(canvas, options);
    } catch (error) {
      console.warn('ghostty-web: WebGL renderer failed to initialize.', error);
      throw error;
    }
  }
  if (type === 'webgl') {
    console.warn('ghostty-web: WebGL2 unavailable, falling back to the canvas renderer.');
  }
  return new CanvasRenderer(canvas, options);
}

function supportsWebgl2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}
