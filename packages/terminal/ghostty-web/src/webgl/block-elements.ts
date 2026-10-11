/** Block Elements geometry in eighths of a cell. Shades retain font rendering. */
export function blockElementRects(codepoint: number): readonly (readonly number[])[] | null {
  if (codepoint === 0x2580) return [[0, 0, 8, 4]];
  if (codepoint >= 0x2581 && codepoint <= 0x2588) return [[0, 8 - (codepoint - 0x2580), 8, 8]];
  if (codepoint >= 0x2589 && codepoint <= 0x258f) return [[0, 0, 0x2590 - codepoint, 8]];
  if (codepoint === 0x2590) return [[4, 0, 8, 8]];
  if (codepoint === 0x2594) return [[0, 0, 8, 1]];
  if (codepoint === 0x2595) return [[7, 0, 8, 8]];
  // Quadrants: upper left, upper right, lower left, lower right.
  const mask = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][codepoint - 0x2596];
  if (mask === undefined) return null;
  return [0, 1, 2, 3].filter(bit => mask & (1 << bit)).map(bit => {
    const x = (bit % 2) * 4;
    const y = Math.floor(bit / 2) * 4;
    return [x, y, x + 4, y + 4];
  });
}
