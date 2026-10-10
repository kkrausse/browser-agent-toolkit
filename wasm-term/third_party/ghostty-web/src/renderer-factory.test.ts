import { describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './renderer';
import { createRenderer } from './renderer-factory';

describe('createRenderer', () => {
  test('defaults to the canvas renderer', () => {
    const canvas = document.createElement('canvas');
    expect(createRenderer(canvas, {})).toBeInstanceOf(CanvasRenderer);
  });

  test('falls back to canvas when WebGL2 is unavailable', () => {
    // happy-dom has no WebGL2. The fallback must leave the real canvas
    // untouched: a canvas that handed out a webgl2 context can never return a
    // 2d one, so the probe has to happen on a throwaway canvas.
    const canvas = document.createElement('canvas');
    const renderer = createRenderer(canvas, {}, 'webgl');
    expect(renderer).toBeInstanceOf(CanvasRenderer);
    expect(renderer.getCanvas()).toBe(canvas);
  });
});
