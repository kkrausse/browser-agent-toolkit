# Matched mounted-controller lifecycle comparison

Report absolute path:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/docs/experiments/2026-09-30-opencode-matched-mounted-lifecycle.md`

## Prospective freeze (before either navigation)

One pair, two fresh origins: restart first on 43230, reuse second on 43231.
These ports were absent from the listener inventory. All retained resources,
including 43222–43227 and their existing PIDs/browser sessions, remain untouched.
One exclusive serial global initiator, Bun-backed Browser Control CLI only.

Five measured transitions each, ten total; zero rearm transitions. Each origin
starts at A0, then switches B1, A2, B3, A4, B5. The same incoming source/config
and accumulated persisted session store are used in both conditions. A fresh
empty root session is mounted through the actual unchanged ChatController on
every generation. No workspace reset, dependency installation, bootstrap overlap,
model inference, tools, shell, PTY or execution RPC is permitted.

Each transition and initial cold launch has the same 150 s enclosing budget;
finite calls/drain 20 s, service listen 60 s/connect 90 s/overall 150 s,
EOF shutdown 10 s, healthy final cleanup 15 s. Per-origin observation watchdog
300 s. Budgets are fixed, never renewed by progress. First failure stops the
whole pair: no action retries, replacement origins or extensions. The second
origin is not started unless the first has passed and zero guest work is proven.
Short serial status observations do not retry actions.

The metric ends at actual `ChatController.ready`, not subsequent proof requests.
Activation/plugin/config/project/catalog qualification remains inside the metric;
independent root/history/source/plugin/PID/process proofs run after ready and must
pass before the next transition and final acceptance. Cold/environment delivery,
proof and healthy cleanup times are separate; this is not a full workspace SLA.

Both outgoing paths freeze/join normally consumed finite requests, then await
local controller disposal/global SSE cancellation. Restart stops/drains only the
owned OpenCode service, proves zero guest work, writes config/source, and launches
with unchanged environment/dependencies. Reuse awaits DELETE with zero refs inferred
from the already-reviewed exclusive finite-handler fence, writes config/source,
then reacquires. Remote zero-ref receipts are not fabricated. Cancellation,
semantic failure, pending finite work or timeout blocks eviction and stops the pair.

Pinned clean runtime `446df00f86d5d6d5d856a2e5deec0fac49f242fa`, server 2.0.3
SHA-256 `1df4bc41c0f6c7350da9d5953f3139586f760a7931fe411bdcabb3460098a929`;
10,528 managed payload hashes verified. Isolated client preparation and targeted
strict TypeScript checks passed. Contract/fence/controller preflight: 61 tests,
350 assertions, zero failures, including actual pinned HttpApi nullable-cursor
schema decode/encode/transport serialization. Runtime/artifacts/pins remain unchanged.

Private evidence directory:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit/.diagnostics/opencode-matched-lifecycle-2026-09-30T05-24-21-330Z/`

Results pending. Restricted finite-owned admission is not production concurrent
or cancelled-reader safety; those gates remain separate.
