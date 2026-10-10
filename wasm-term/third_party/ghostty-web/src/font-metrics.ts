/**
 * Cell metrics measurement, shared by every renderer backend.
 *
 * Both renderers MUST derive cell size from the same numbers: FitAddon converts
 * pixels to cols/rows with these, and the WASM grid is sized from that result.
 */

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from cell top to text baseline
}

/**
 * Measure a monospace cell from 'M' on a throwaway canvas.
 *
 * Height carries 2px of slack for glyphs that overflow the em box ('f', 'g',
 * descenders) and for antialiasing; baseline sits 1px into it.
 */
export function measureFontMetrics(fontSize: number, fontFamily: string): FontMetrics {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Headless/no-canvas environments: approximate rather than throw, so
    // constructing a renderer stays possible under test doubles.
    return {
      width: Math.ceil(fontSize * 0.6),
      height: Math.ceil(fontSize * 1.2) + 2,
      baseline: Math.ceil(fontSize * 0.8) + 1,
    };
  }

  ctx.font = `${fontSize}px ${fontFamily}`;
  const widthMetrics = ctx.measureText('M');
  const width = Math.ceil(widthMetrics.width);
  const ascent = widthMetrics.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = widthMetrics.actualBoundingBoxDescent || fontSize * 0.2;

  return {
    width,
    height: Math.ceil(ascent + descent) + 2,
    baseline: Math.ceil(ascent) + 1,
  };
}
