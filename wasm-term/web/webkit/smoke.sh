#!/usr/bin/env bash
# WebKit smoke test of the dev page: see smoke.ts.
#   web/webkit/smoke.sh [base URL]     default http://127.0.0.1:4790
#   PROFILE=desktop|iphone             one profile only
# Once before: web/webkit/install.sh
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$(cd "$web/../vendor" && pwd)"
# Playwright reads this while it is imported, so it cannot be set from smoke.ts.
export PLAYWRIGHT_BROWSERS_PATH="$vendor/playwright-browsers"
# Its host check also wants the GTK port's libraries; headless runs use the WPE port only.
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
mkdir -p "$web/../docs/screenshots"
cd "$web" && exec bun webkit/smoke.ts "$@"
