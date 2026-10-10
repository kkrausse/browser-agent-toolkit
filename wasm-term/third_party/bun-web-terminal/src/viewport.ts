/** Size in unzoomed CSS pixels: pinch zoom must not reflow the terminal grid. */
export function terminalViewport(viewport: Pick<VisualViewport, "height" | "scale" | "offsetTop"> | null, innerHeight: number) {
  if (!viewport) return { height: innerHeight, top: 0 };
  return {
    // A keyboard changes the available height even while zoomed. Ignoring all
    // non-1 scales leaves stale keyboard geometry after focus/blur or rotation.
    height: viewport.height * viewport.scale,
    // At normal scale follow keyboard-induced panning. At pinch scale let the
    // browser pan over the page rather than chasing its visual viewport.
    top: Math.abs(viewport.scale - 1) < 0.01 ? viewport.offsetTop : 0,
  };
}
