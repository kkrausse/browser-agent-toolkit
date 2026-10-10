# Official bridge snapshot benchmark

Measured on Apple M4 Pro / macOS arm64, Bun 1.4.0 (`34cbb9a40`).
Harness: `bun src/official-benchmark.ts`; the legacy variant accepts the old
`lib/ghostty.ts` path and npm WASM path as its two arguments.

Each terminal is 120×40. Each case warms up for 150 iterations, then measures
500 iterations of `write(fullFrame); update(); getViewport(); markClean()`.
The styled frame has 12 ten-character spans per row, truecolor foreground,
palette background, and alternating bold. Explicit cursor addressing rewrites
every row. Frames are repeated, so this measures repeated complete screen
writes rather than changing style cardinality each iteration. Idle measures
100,000 calls to `update(); getViewport()` after the final clean frame.

| Engine | Plain median / p95 (ms) | Styled median / p95 (ms) | Plain / styled idle (µs) |
| --- | --- | --- | --- |
| Initial official per-cell bridge | 3.053 / 3.210 | 3.397 / 3.620 | 0.065 / 0.050 |
| Old fork + npm WASM, first run | 0.081 / 0.084 | 0.255 / 0.271 | 32.780 / 40.923 |
| Old fork + npm WASM, repeat | 0.079 / 0.086 | 0.247 / 0.267 | 32.502 / 40.842 |
| Final official bulk-row bridge | 0.036 / 0.066 | 0.172 / 0.239 | 0.036 / 0.044 |

The final styled median is about 20× lower than the initial official bridge
in this workload. It is also lower than the measured legacy median. These
are local engine/bridge timings, **not browser input-to-paint or tmux latency**.
Idle semantics differ intentionally: the new bridge returns its existing
snapshot when no write occurred; the old bridge still copies the viewport.
Earlier bulk-row runs before memory-view caching had styled p95 around
0.34 ms; tail timings are sensitive to allocation/GC and process scheduling.

Legacy artifact: 423,939 bytes, SHA-256
`794191ccd9f469ed0d49ebcb3e6b326d64279b91752b71ad80a3d89ff1f26416`.
Legacy source: `kkrausse/ghostty-web` at
`a169a863599517272533b9c70789a09556a55b06`, `lib/ghostty.ts`.
Legacy artifact: npm `ghostty-web@0.4.0-next.20.g1858a59`, `ghostty-vt.wasm`.
Pass local paths to those files to compare with the retired implementation.

## Implementation and correctness boundaries

- Bulk raw cells come from official row data key 5 (`GhosttyCellsView`).
- Numeric low/high-word extractors are constructed once from the official
  packed-cell manifest. The viewport path performs no BigInt decoding.
- Existing cell objects are updated directly. Style field offsets are cached.
- Each frame resolves its current palette once. Default cells require no
  per-cell WASM calls; styled runs decode once per style ID **within each row**.
  IDs are page-local, so caching across arbitrary rows/frames would be wrong.
- Grapheme cells still use official getters for their full cluster length.
  History retrieval continues to use grid references and is not benchmarked.
- Memory views are reused only while buffer identity and byte length match.
- A differential artifact test compares 14,400 cells with native per-cell
  getters after page churn, palette mutation, erasure and alternate-screen
  switching. It checks codepoints, widths, cluster lengths and resolved colors.

This workload benefits from repeated styles. Unique styling per cell or dense
multi-codepoint clusters will require more native getter calls. No throughput
claim for those workloads, browser rendering, or large scrollback traversal
is implied by these measurements.
