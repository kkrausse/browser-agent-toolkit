import { describe, expect, test } from 'bun:test';
import { parseColor } from './color';

const FALLBACK = { r: -1, g: -1, b: -1, a: -1 };

describe('parseColor', () => {
  test('parses 6-digit hex', () => {
    expect(parseColor('#1e1e1e', FALLBACK)).toEqual({
      r: 30 / 255,
      g: 30 / 255,
      b: 30 / 255,
      a: 1,
    });
  });

  test('parses 3-digit hex', () => {
    expect(parseColor('#fff', FALLBACK)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  test('parses hex with alpha', () => {
    expect(parseColor('#00000080', FALLBACK).a).toBeCloseTo(128 / 255, 5);
    expect(parseColor('#0008', FALLBACK).a).toBeCloseTo(136 / 255, 5);
  });

  test('parses rgb() and rgba()', () => {
    expect(parseColor('rgb(255, 0, 0)', FALLBACK)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 255, 0.5)', FALLBACK)).toEqual({ r: 0, g: 0, b: 1, a: 0.5 });
    expect(parseColor('rgba(0, 0, 0, 50%)', FALLBACK).a).toBe(0.5);
  });

  test('falls back on unsupported or missing input', () => {
    // Theme strings come from user config; an unparseable one must not paint
    // garbage, it must leave the default in place.
    expect(parseColor(undefined, FALLBACK)).toBe(FALLBACK);
    expect(parseColor('hsl(200 50% 50%)', FALLBACK)).toBe(FALLBACK);
    expect(parseColor('not a color', FALLBACK)).toBe(FALLBACK);
  });
});
