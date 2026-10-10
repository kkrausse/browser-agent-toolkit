#!/usr/bin/env bash
# See webkit.ts. Uses the Playwright and the WebKit build that wasm-term/web already has.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
vendor="$(cd "$here/../../../vendor" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="$vendor/playwright-browsers"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export NODE_PATH="$here/../../../web/node_modules"
cd "$here/../../../web" && exec bun "$here/webkit.ts" "$@"
