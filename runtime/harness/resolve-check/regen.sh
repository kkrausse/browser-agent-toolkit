#!/bin/sh
# usage: regen.sh [extra-conds]   (default module-sync, which Node 24 always has on)
T=/home/kkrausse/devfs/repos/kkrausse/browser-agent-toolkit/examples/todo-app
cd /tmp && node --experimental-import-meta-resolve /tmp/bat-resolve-cases/gen.mjs $T /tmp/bat-resolve-cases/fx /tmp/bat-resolve-cases "${1-module-sync}" 2>&1 | grep -v Deprecation | head -14
cd /tmp/bat-resolve-cases && for f in package.json vite.config.ts tsconfig.json react-router.config.ts; do printf 'F\t/workspace/%s\t%s\n' $f $T/$f >> overlay.tsv; done
