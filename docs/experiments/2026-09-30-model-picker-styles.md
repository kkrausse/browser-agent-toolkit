# Model picker pointer interception in the source harness

## Observed reproduction

The parent browser session opened the model picker and found the visible
`Big Pickle · opencode` option. An ordinary Browser Control option click timed
out after 20 seconds. A shorter diagnostic retry reported that a heading in
the host `#root[data-base-ui-inert]` subtree intercepted pointer events. The
option existed once and was visible, but its computed position was `static`;
the option utility classes were present without their compiled CSS.

No forced click was used as proof of a fix. These browser observations were
provided by the parent session, not independently reproduced by this worker.
The Browser Control CLI version was not captured in this worker's diagnostics.

## Diagnosis and change

The source harness imported `src/styles.css` and `src/editor.css`, while the
library build concatenates compiled `ocui:` utilities into its public CSS
exports. Raw source CSS omits the portal positioner's `z-index: 50`, item
layout, backgrounds, and other Base UI styling. This is a consumer stylesheet
integration failure, not evidence of a failed session-model endpoint or a
provider credential requirement.

The library now exposes `bun run build:styles`, sharing the exact stylesheet
pipeline used by the full package build. Source harnesses can import generated
`dist/editor.css` without rebuilding the qualified OpenCode/runtime artifacts.
The consumer integration and live activation remain owned by the parent and
consumer worker.

## Worker verification

- Bun 1.4.0; Base UI 1.8.0; Tailwind CSS 4.3.3; OpenCode client 2.0.3.
- `bun run build:styles` succeeds.
- 37 focused tests pass (482 assertions): compiled popup stacking, item layout,
  background and isolation; controller model POST acceptance/rejection;
  fixture-backed persistence through session switching and reconnect; markup.
- Full package typechecking remains blocked by absent generated workspace peer
  exports (`@kev-browser-agent-kit/workspace`), with consequent existing type
  errors outside this change. No runtime build was performed to repair that.

Actual normal-pointer selection and persisted model state on the live browser
server still require parent verification. Unit fixture persistence is not that
live-server verification, and no inference request was performed here.
