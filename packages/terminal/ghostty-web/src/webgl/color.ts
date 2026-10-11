/**
 * CSS color -> normalized RGBA, for theme strings only (cell colors arrive as
 * bytes and never go through here).
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i;

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(); else `fallback`. */
export function parseColor(input: string | undefined, fallback: Rgba): Rgba {
  if (!input) return fallback;
  const text = input.trim();

  const hex3 = HEX3.exec(text);
  if (hex3) {
    return {
      r: Number.parseInt(hex3[1] + hex3[1], 16) / 255,
      g: Number.parseInt(hex3[2] + hex3[2], 16) / 255,
      b: Number.parseInt(hex3[3] + hex3[3], 16) / 255,
      a: hex3[4] === undefined ? 1 : Number.parseInt(hex3[4] + hex3[4], 16) / 255,
    };
  }

  const hex6 = HEX6.exec(text);
  if (hex6) {
    return {
      r: Number.parseInt(hex6[1], 16) / 255,
      g: Number.parseInt(hex6[2], 16) / 255,
      b: Number.parseInt(hex6[3], 16) / 255,
      a: hex6[4] === undefined ? 1 : Number.parseInt(hex6[4], 16) / 255,
    };
  }

  const fn = RGB_FN.exec(text);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : parseAlpha(fn[4]);
    return {
      r: clamp01(Number.parseFloat(fn[1]) / 255),
      g: clamp01(Number.parseFloat(fn[2]) / 255),
      b: clamp01(Number.parseFloat(fn[3]) / 255),
      a: clamp01(alpha),
    };
  }

  return fallback;
}

function parseAlpha(text: string): number {
  return text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
