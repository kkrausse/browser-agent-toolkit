# Ghostty Web

A local browser terminal package (`@random/ghostty-web`) around **official Ghostty WASM**, with an xterm.js-style TypeScript interface and WebGL2 rendering. Its first consumer is [bun-web-terminal](../bun-web-terminal/README.md).

The public API follows familiar terminal operations: `open`, `write`, `resize`, `focus`, `dispose`, `onData`, `onResize`, selection, and addons. This is an xterm.js-style subset, not a promise of drop-in compatibility with every xterm.js API or addon.

## Use

In this repository, `bun-web-terminal` depends on `file:../ghostty-web`. Bun bundles the TypeScript directly. Serve `@random/ghostty-web/ghostty-vt.wasm` as `/ghostty-vt.wasm` alongside your application, with the `application/wasm` content type.

```ts
import { init, Terminal } from "@random/ghostty-web";

await init();
const terminal = new Terminal({
  cols: 80,
  rows: 24,
  rendererType: "webgl",
  copyOnSelect: false,
});
await terminal.open(document.getElementById("terminal")!);
terminal.onData(data => socket.send(data));
socket.addEventListener("message", event => terminal.write(event.data));
terminal.write("Hello from official Ghostty WASM\r\n");
```

Give the container a size and resize the terminal when its layout changes, either with `FitAddon` or measured cell dimensions. Use the terminal's bracketed-paste path for pasted text. The application owns the PTY, transport, authentication, and session lifecycle.

Use `init({ wasmUrl: "/assets/ghostty-vt.wasm" })` for a different asset route.
Concurrent initialization calls share one load; a failed load can be retried.

The active buffer exposes text/graphemes, cell styles, and absolute scrollback
coordinates. Reading an inactive named buffer is currently unsupported: it
returns empty state rather than the active screen's contents. History-line wrap
metadata is not yet exposed through this API. Low-level `wasmTerm` and `renderer`
access are package extensions rather than xterm.js compatibility guarantees.

## Architecture and provenance

- **Engine:** checked-in `vendor/ghostty-vt.wasm`, downloaded from the official `ghostty-org/ghostty` release. No patched Ghostty source, Zig compiler, or Coder npm WASM is needed at install or runtime.
- **Bridge:** `src/ghostty.ts` and the official ABI helpers translate the official C API into browser-friendly terminal state, rendering data, keyboard encoding, and terminal replies.
- **Browser layer:** rendering, input, selection, and addons live under `src/`. This layer preserves useful MIT-licensed code from [Coder's ghostty-web](https://github.com/coder/ghostty-web) and our former [`kkrausse/ghostty-web`](https://github.com/kkrausse/ghostty-web) fork at `a169a863599517272533b9c70789a09556a55b06`. It is maintained here as ordinary source, without the fork/submodule dependency. See [LICENSE](LICENSE).

The official artifact's release asset ID, SHA-256, source revision, and license are retained under `vendor/`. The `tip` release URL is mutable: an upgrade must pin a new artifact and adapt/test the matching ABI together. Never replace the binary from `tip` automatically during installation.

The bridge uses native bulk-row reads, dirty-state tracking, pooled cell objects,
and cached style decoding. See [measured engine/bridge performance](docs/performance.md)
for the comparison with the retired implementation and the benchmark's limits.

## Rendering quality and directions

Official Ghostty WASM supplies terminal state and protocol handling. Our browser
renderer is separate from native Ghostty's font and GPU rendering stack: ordinary
text is rasterized with Canvas2D `fillText`, cached in an atlas, then drawn by WebGL.

The first targeted improvement is procedural **Block Elements** rendering in
WebGL: full, fractional, and quadrant blocks use pixel-aligned cell geometry instead
of font glyphs. Masks share the background grid's rounded device-pixel boundaries,
including at fractional scaling. They use the existing glyph pass for foreground
colors, selection, faint/inverse styles, cursor accents, and image layering.
Shade characters and box drawing still use the font. CanvasRenderer retains its
existing font rendering.

This helps TUIs and pictures made from Unicode blocks. Actual terminal images
(Kitty graphics) have their own image pass; this does not change their rendering.

Possible next steps, with rough one-engineer estimates including verification:

| Direction | Scope | Rough effort |
| --- | --- | --- |
| Seamless terminal graphics | Extend procedural drawing to box drawing, shades, and common legacy-computing symbols; verify scaling | Several days–2 weeks |
| Native-like browser rendering | Graphics above, font/cell metrics and fallback, clipping/overhang, decorations, cursor/selection, Unicode edge cases, visual regression coverage | 3–6 weeks total |
| Native-stack convergence | Investigate adapting upstream rendering code, explicit font management, shaping/rasterization such as HarfBuzz/FreeType in WASM | 2–4+ months, highly uncertain |

These are planning ranges, not commitments or promises of macOS pixel parity.
The preferred incremental direction is native-like browser rendering while retaining
the official engine/ABI bridge, public API, input/clipboard/selection, WebGL passes,
and consumer integration. Audit upstream reuse opportunities before a larger effort.
Use adjacent background fills and block glyphs to isolate seams, then compare real
TUIs across fonts, Retina/non-Retina displays, and browser zoom. Geometry unit tests
alone do not establish screenshot-level parity.

## Development

```sh
cd ghostty-web
bun install --frozen-lockfile
bun run typecheck
bun test
```

Run `bun run dev` and open `http://127.0.0.1:3108` for a minimal WebGL demo with
Unicode/color samples, scrollback, resizing, and local keyboard/IME echo. It
exposes `window.terminal` for inspecting engine state in the browser console.
Use `bun-web-terminal` for real shell/tmux integration.

Also run the consuming app's checks after bridge or input changes:

```sh
cd ../bun-web-terminal
bun install --frozen-lockfile
bun run typecheck
bun run test
```

DOM unit tests use Happy DOM and a mocked Canvas2D context. They do not establish visual correctness of the WebGL renderer; verify the app in a real WebGL2 browser, including resizing, scrolling, reconnects, selection/copy/paste, keyboard shortcuts, and IME. Real mobile software keyboards need a device check.
