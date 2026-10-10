# mock-llm

Token-free backend for `wasm-term`: a scripted model server, isolated launchers
for `opencode serve` and `codex app-server` pointed at it, and native baselines
of each TUI talking to its server. Verified with opencode 2.0.26 and
codex-cli 0.162.0 on Linux.

Everything below under "What a browser port needs to know" was observed (tap
proxy logs, `strace` of the clients, request dumps at the mock), not inferred
from documentation. Where something was read out of the binary instead, or not
exercised, it says so.

## Run it

Each script runs in the foreground; use one terminal per line.

```sh
mock-llm/run-mock.sh              # model server :4791 + egress trap :4794
mock-llm/run-opencode-server.sh   # opencode serve      http://127.0.0.1:4792
mock-llm/run-codex-server.sh      # codex app-server    ws://127.0.0.1:4793
mock-llm/run-opencode-client.sh   # native TUI: opencode --server http://127.0.0.1:4792
mock-llm/run-codex-client.sh      # native TUI: codex --remote ws://127.0.0.1:4793
mock-llm/run-taps.sh              # optional logging proxies :4795 (opencode) and :4796 (codex)
mock-llm/stop.sh                  # stop whatever listens on 4791-4796
```

Extra arguments pass through, e.g. `run-opencode-server.sh --cors http://my-host:4790`,
`run-opencode-client.sh --auto`, `run-codex-server.sh -c approval_policy='"never"'`.
To send a client through a tap: `OPENCODE_SERVER_URL=http://127.0.0.1:4795 run-opencode-client.sh`,
`CODEX_REMOTE_ADDR=ws://127.0.0.1:4796 run-codex-client.sh`.

| Port | What |
| --- | --- |
| 4791 | `server.ts`, the scripted model API |
| 4792 | isolated `opencode serve` (Basic auth `opencode` / `wasm-term-mock`) |
| 4793 | isolated `codex app-server` (WebSocket, no auth) |
| 4794 | `egress-trap.ts`, refuses and logs every non-loopback HTTP(S) request |
| 4795 | `tap-proxy.ts` in front of 4792 |
| 4796 | `tap-proxy.ts` in front of 4793; also strips `Origin` (a browser needs this, see codex) |

4794-4796 are outside the table in `../README.md`; they are only used here.

Files: `server.ts` (mock), `egress-trap.ts`, `tap-proxy.ts`, `env.sh` (isolated
homes and network guard, sourced by every launcher), `opencode.config.json`,
`codex.config.toml` (app-server home), `codex.client.config.toml` (TUI home),
`baseline/*.txt` (captures). Generated state is all under `../.state/`:
`opencode/{config,data,state,cache,tmp}`, `codex-server/`, `codex-client/`,
`workspace/` (a throwaway git repo with `hello.txt` that both agents run tools in)
and `logs/`.

## Scenarios

The mock picks a script from the last real user message (injected
`<environment_context>`-style messages are skipped). First match wins:

| Prompt contains | Scenario | What comes back |
| --- | --- | --- |
| `mock-error` | error | HTTP 400 with an OpenAI-style error body (5xx would make both clients retry) |
| `multi-tool` | multi-tool | shell call, then a file write, then a final answer |
| `edit`, `write`, `patch` | write | writes `mock-output.txt`, then answers |
| `read` | read | reads `hello.txt`, then answers |
| `escalate`, `approval`, `permission` | escalate | shell call asking to leave the sandbox (codex approval prompt), then answers |
| `tool`, `bash`, `shell` | shell | runs `echo mock-llm-tool-ok && pwd`, then answers |
| `markdown`, `code` | markdown | heading, list, fenced `ts` block, table, quote |
| `long`, `scroll` | long | 80 numbered lines ending `END-OF-LONG-RESPONSE` (about 11 s at the default delay) |
| `think`, `reason`, `reasoning` | reasoning | reasoning stream, then text ending `MOCK-REASONING-DONE` |
| anything else | plain | one paragraph of streamed text |

Tool scenarios end with `MOCK-TOOL-DONE` and quote the first line of the tool
result, so a test can assert the result made the round trip. The tool call is
built from the tools the client offered: the shell tool is `shell` for opencode
and `exec_command` for codex; file tools are `read`/`write` (argument `path`)
for opencode, and for codex (which offers no file tool with an unknown model)
`cat` / a heredoc through the shell. The step is derived from how many tool
results follow the last user message, so the server keeps no per-conversation
state. Requests that ask for a session title (no tools, "title" in the
instructions) always get `Mock session`.

Endpoints: `POST /v1/chat/completions` (what opencode uses here),
`POST /v1/responses` (what codex uses), `POST /v1/messages` (Anthropic; streaming
and JSON verified with curl only, no client is configured to use it),
`GET /v1/models`, `GET /health`. All three POSTs support `stream: true` (SSE)
and non-streaming JSON. The Responses stream emits `response.created`,
`response.in_progress`, then per item `response.output_item.added`, the deltas
(`response.reasoning_summary_text.delta`, `response.output_text.delta`,
`response.function_call_arguments.delta`) with their `.done` events,
`response.output_item.done`, and finally `response.completed` with usage.

Environment: `MOCK_LLM_PORT` (4791), `MOCK_LLM_DELAY_MS` (15, per chunk; 0 for
instant), `MOCK_LLM_LOG` (append the request log to a file; `run-mock.sh` sets
`.state/logs/mock-llm.log`), `MOCK_LLM_DUMP_DIR` (write every request's headers
and full body as JSON, one file per request).

Request log, one pair of lines per request:

```
05:06:18.975 #7 POST /v1/responses model=mock-model stream=true items=6 tools=7[exec_command,write_stdin,...] results=0 user="please use a tool" ua="codex-tui/0.162.0 ..."
05:06:18.975 #7   -> scenario=shell step=0 text=27ch tool=exec_command({"cmd":"echo mock-llm-tool-ok && pwd"})
```

## Native baselines

Driven with `termctrl` in a real PTY against the launchers above, no tap in
between. Captures are the visible screen as text (`termctrl`'s PNG output has no
glyphs on this machine, so no screenshots are checked in).

| Capture | Shows |
| --- | --- |
| `baseline/opencode-plain.txt` | `hello there` and the plain scripted reply |
| `baseline/opencode-tool-permission.txt` | `please use a tool`: the "Permission required" prompt (Allow once / Always allow / Reject) |
| `baseline/opencode-tool.txt` | same turn after "Allow once": command, its output, final answer |
| `baseline/codex-plain.txt` | `hello there` and the plain scripted reply |
| `baseline/codex-tool.txt` | `please use a tool`: `Ran echo mock-llm-tool-ok && pwd`, output, final answer |
| `baseline/codex-tool-approval.txt` | `run with approval`: the "Would you like to run the following command?" prompt |

Also driven by hand in both TUIs, not captured: write, read (opencode),
multi-tool (opencode), reasoning, markdown, long, error. Codex 0.162 streams the
reasoning summary over the wire (`item/reasoning/summaryTextDelta`) but its
transcript only shows the final answer; opencode shows a collapsed
`+ Thought` row.

To reproduce one:

```sh
export TERMCTRL_RUNTIME_DIR=/tmp/tc-wasmterm; mkdir -p $TERMCTRL_RUNTIME_DIR
termctrl start oc --host opentui --cols 110 --rows 36 -- $PWD/mock-llm/run-opencode-client.sh
termctrl wait oc "Ask anything" --timeout 20000
termctrl send oc "text:please use a tool"; termctrl send oc enter   # separate sends: a combined one can lose the enter
termctrl wait oc "Permission required" && termctrl send oc enter
termctrl wait oc MOCK-TOOL-DONE && termctrl show oc; termctrl stop oc
```

For codex: `termctrl start cx --cols 110 --rows 40 -- $PWD/mock-llm/run-codex-client.sh`,
wait for `Ask Codex`, same sends, quit with `/quit`.

## Isolation and what was blocked

- **opencode** honours `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME` (`opencode debug paths` confirms; open files of the running
  server and an `strace` of the client show nothing written outside `.state/`).
  Its scratch directory is `$TMPDIR/opencode`, outside XDG, so `env.sh` also sets
  `TMPDIR`. `home` stays the real home: the client probes `~/.claude/ide` and
  `.opencode/themes` in every parent directory up to `/`, read-only.
- Never run `opencode` without `--server` (or `--standalone`) in this
  environment: the plain form tries to start the managed background service. With
  the isolated homes that attempt failed harmlessly (its port 49374 is held by the
  user's real service, which was not touched), but it is not something to rely on.
- **codex** honours `CODEX_HOME`; it also looks for `/etc/codex/config.toml`,
  `/etc/codex/managed_config.toml`, `/etc/codex/requirements.toml` (absent here).
- `env.sh` unsets provider API key variables and exports `HTTP_PROXY`/`HTTPS_PROXY`
  pointing at the egress trap, with `NO_PROXY` for loopback. Both tools honour it.
  What the trap caught, and what was done:

  | Who | Tried to reach | Status |
  | --- | --- | --- |
  | codex app-server | `github.com` (`git ls-remote openai/plugins`), `api.github.com`, `chatgpt.com/backend-api/plugins/*` | gone: `[features] plugins/remote_plugin/plugin_sharing/apps = false` |
  | codex TUI, empty home | `api.github.com` (update check), `ab.chatgpt.com` | gone: `check_for_update_on_startup = false`, `[analytics] enabled = false` in the client home |
  | codex TUI | `raw.githubusercontent.com` (`openai/codex/main/announcement_tip.toml`) once per start | no switch found (`[tui] show_tooltips = false` does not stop it); refused by the trap |
  | opencode server and client | nothing | `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `"autoupdate": false`, `"share": "disabled"` are set; no attempt was ever logged |

- The trap only sees clients that honour proxy variables. Nothing here stops a
  raw socket; none was seen in the client `strace`s (only loopback connects).
- No model request ever left the machine: every completion in the mock's log
  comes from the two servers, and the provider configs contain no real key
  (`apiKey: "mock-key-not-real"` for opencode, none for codex).
- codex warns `Model metadata for 'mock-model' not found` on every turn
  ("1 warning" in the TUI footer). Harmless; with the fallback metadata codex
  offers no `apply_patch` tool, which is why the write scenario goes through the
  shell.

## What a browser port needs to know

### opencode

**Transport: HTTP/1.1 JSON requests plus one long-lived SSE stream. No WebSocket
in the chat flow.**

- Base URL is whatever follows `--server`. Every API route is under `/api/`;
  any other path returns the bundled web app's HTML (so a wrong path is a 200
  with `text/html`, not a 404). `/api/health` and `/api/doc` do not exist (404).
- **Auth**: HTTP Basic, user `opencode`, password from `OPENCODE_SERVER_PASSWORD`
  (`OPENCODE_PASSWORD` also read) on both sides. The server always requires one:
  with the variable unset `opencode serve` prints a random `server password ...`
  at startup. Any other username is 401. The server also accepts
  `?auth_token=<base64("opencode:<password>")>` in the query string instead of
  the header (verified), which is what makes a plain `EventSource` usable.
  401 responses are JSON `{"_tag":"UnauthorizedError",...}`.
- **CORS** (measured with `Origin` on preflight and on GET): origins on
  `localhost` and `127.0.0.1` (any port) and `https://app.opencode.ai` are
  echoed in `access-control-allow-origin`; `http://192.168.1.5:4790`,
  `http://diesel2:4790`, `https://example.com` and `null` get no CORS headers and
  need `opencode serve --cors <origin>` (repeatable). Preflight answers 204 with
  `access-control-allow-methods: GET, HEAD, PUT, PATCH, POST, DELETE`, echoes the
  requested headers (so `authorization` and `content-type` pass), max-age 86400.
  No `access-control-allow-credentials`, so use the `Authorization` header or
  `auth_token`, not cookies. The 401 response also carries the allow-origin header.
- **Requests the TUI sends** (`user-agent: opencode/latest/2.0.26/cli`,
  `accept: */*`, `content-type: application/json` on POST, nothing else):
  - Startup, all GET: `/api/info`, `/api/event` (SSE), `/api/session/active`,
    `/api/project`, `/api/session`, `/api/experimental/migration/v1`, and with
    `?location[directory]=<abs path>`: `/api/fs/list`, `/api/location`,
    `/api/vcs`, `/api/config`, `/api/agent`, `/api/command`, `/api/integration`,
    `/api/mcp`, `/api/mcp/resource`, `/api/model`, `/api/provider`,
    `/api/reference`, `/api/skill`, `/api/shell`, `/api/form`, `/api/plugin`,
    `/api/websearch/provider`.
  - First prompt: `POST /api/session`
    `{"id":"ses_...","agent":"build","model":{"providerID":"mock","id":"mock-model"},"location":{"directory":"<abs path>"}}`
    (the client generates the id), then `GET /api/session/{id}`,
    `GET /api/session/{id}/permission`, `/form`, `/message`, `/inbox`,
    `GET /api/experimental/session/{id}/terminal`,
    `POST /api/session/{id}/model {"model":{...}}`.
  - Each prompt: `POST /api/session/{id}/prompt`
    `{"id":"msg_...","text":"hello there","files":[],"agents":[],"delivery":"steer"}`;
    the JSON response only echoes the user message. `POST /api/session/{id}/view
    {"idle":<ms>}` follows.
  - Permission answer: `POST /api/session/{id}/permission/{per_id}/reply {"decision":"once"}`.
- **Everything the model does arrives on `GET /api/event`**: `text/event-stream`,
  unnamed events, one JSON object per `data:` line
  `{"id":"evt_...","created":<ms>,"type":"...","location":{"directory":...},"data":{...},"durable":{"aggregateID":"ses_...","seq":n,"version":1}}`,
  plus `: heartbeat` comments. First event is `server.connected`. Types seen:
  `session.created`, `session.renamed`, `session.inbox.enqueued/delivered`,
  `session.execution.started/succeeded`, `session.step.started/streamed/ended`,
  `session.text.started/delta/ended`, `session.reasoning.started/delta/ended`,
  `session.tool.input.started/ended`, `session.tool.called/progress/success`,
  `session.usage.updated`, `session.viewed`, `session.instructions.updated`,
  `permission.asked` (`data.id`, `action`, `resources`, `save`) and
  `permission.replied`, `shell.created/exited`, `vcs.branch.updated`, and
  `<thing>.updated` for provider, model, agent, command, skill, plugin,
  integration, reference, websearch. The server coalesces model chunks: the
  mock's ~40 chunks for the plain reply arrive as a handful of `session.text.delta` events.
- **The working directory is a client-supplied server-side path.** The TUI takes
  its own cwd and sends it as `location[directory]` on most requests and in
  `POST /api/session`. A browser client has no cwd and must be given a path that
  exists on the server.
- **Local to the client even with `--server`** (from `strace -f`, startup + one
  prompt + exit): no child processes; TCP only to the server. Reads/writes under
  its own XDG dirs: `config/opencode/{cli.json,tui.json,plugins/,themes/}`,
  `state/opencode/{prompt-history.jsonl,prompt-stash.jsonl,frecency.jsonl,kv.json,model.json,session.json}`,
  `state/opencode/latest/tui/{tabs.json,layout.json,system-theme.json,directory-recents.json,update-notifications.json,session-terminal-selection.json}`
  (tabs are restored from `tabs.json` on the next start), lock dirs under
  `state/opencode/locks/` and `latest/locks/`, its log `data/opencode/log/opencode.log`,
  and `$TMPDIR/opencode`. In the project: `<cwd>/.opencode/plugins`, and
  `.opencode/themes`, `.git`, `.hg` in every ancestor. Also `~/.claude/ide` and
  `/etc/localtime`. Git itself is run by the server (`git rev-parse` in its log),
  as are all tools, file reads/writes and snapshots.
- **Environment the client reads**: `XDG_*`, `TMPDIR`, `HOME`,
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_PASSWORD`, proxy variables, the usual
  terminal variables. The binary references many more `OPENCODE_*` names
  (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_TUI_CHANNEL`, ...); not exercised.
- **Config**: `opencode.config.json` uses the v1-shaped keys (`provider`,
  `model`, `small_model`, `permission`); 2.0.26 accepts them and reports its own
  shape back from `/api/config` (`providers`, `permissions:[{action,resource,effect}]`,
  `agents.title.model`). `"permission": {"bash":"ask","edit":"ask"}` is what
  produces the prompt; without it shell and write run unprompted.
  `opencode --auto` on the client auto-approves.
- **Not exercised**: clipboard, the terminal panel (`/api/pty` and
  `/api/experimental/persistent-pty/*` exist in the binary and `/api/info`
  reports `capabilities.persistentPty: true`; this may be a WebSocket), file
  attachments, MCP, `opencode pair`.

### codex

**Transport: one WebSocket, JSON-RPC-style text frames in both directions.**

- `codex --remote ws://host:port` opens `GET /` with only the standard upgrade
  headers: no `Origin`, no `Authorization`, no subprotocol. `wss://` and `unix://`
  are also accepted by the flag (not tested). The server also serves
  `GET /readyz` and `GET /healthz` (200, empty body) on the same port.
- **A browser cannot connect to `codex app-server` directly.** Any request that
  carries an `Origin` header is rejected: the WebSocket upgrade gets
  `400 Bad Request`, `/healthz` gets `403`, for `http://localhost:4790` and
  `https://example.com` alike. Browsers always send `Origin` on a WebSocket and
  no allow-list flag exists in `codex app-server --help`. The port needs a
  same-machine bridge that drops the header; `tap-proxy.ts` on :4796 does this,
  and a WebSocket opened with `Origin: http://localhost:4790` through it completed
  `initialize` (the same connect straight to :4793 failed).
- **Auth**: none by default; the server binds loopback only and says so at
  startup. Optional and not exercised: `codex app-server --ws-auth
  capability-token|signed-bearer-token` with `--ws-token-file` etc., matched on
  the client by `--remote-auth-token-env <ENV_VAR>` (a bearer token sent on the
  upgrade request, which a browser `WebSocket` cannot do; it would have to be
  added by the bridge).
- **Framing**: text frames only, one JSON object each, no `"jsonrpc"` member.
  Request `{"id":<number|string>,"method":"...","params":{...}}`, response
  `{"id":...,"result":{...}}`, notification `{"method":"...","params":{...}}`
  (server notifications also carry `emittedAtMs`). The server sends requests to
  the client too.
- **Handshake and startup**, in order:
  `initialize {"clientInfo":{"name":"codex-tui","title":null,"version":"0.162.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":null}}`
  → result `{"userAgent","codexHome","platformFamily","platformOs"}`; notification
  `initialized`; then `account/read`, `hooks/list {cwds}`,
  `config/read {"includeLayers":true,"cwd":"."}`, `model/list {"includeHidden":true}`,
  `configRequirements/read`, `collaborationMode/list`, `thread/start`,
  `thread/list`, `skills/list {cwds,forceReload}`, `thread/loaded/list`,
  `plugin/list {cwds}`.
- `thread/start` params that are not null: `approvalPolicy`, `approvalsReviewer`,
  `sandbox`, `ephemeral:false`, `historyMode:"paginated"`, `threadSource:"user"`,
  and `dynamicTools`: a `codex_tui` namespace of tools (`list_threads`,
  `list_archived_threads`, `read_thread`, ...) that the client declares and would
  have to execute itself when called. `model`, `modelProvider` and `cwd` are null
  here, so they come from the server's config.
- **Each prompt**: `turn/start {"threadId","clientUserMessageId","input":[{"type":"text","text":"hello there","text_elements":[]}],"turnTrigger":"user","cwd":"<abs path>","runtimeWorkspaceRoots":["<abs path>"],"approvalPolicy","approvalsReviewer","model","collaborationMode":{"mode":"default","settings":{"model":...}}}`.
  Notifications back: `turn/started`, `thread/status/changed`, `item/started` and
  `item/completed` (item types seen: `userMessage`, `agentMessage`, `reasoning`,
  `commandExecution`), `item/agentMessage/delta`,
  `item/reasoning/summaryPartAdded`, `item/reasoning/summaryTextDelta`,
  `thread/tokenUsage/updated`, `account/rateLimits/updated`, `warning`,
  `turn/completed`, and once per connection or thread `thread/started`,
  `thread/settings/updated`, `remoteControl/status/changed`. Unlike opencode, deltas are passed through one per model chunk.
- **Approval is a server-to-client request**:
  `{"method":"item/commandExecution/requestApproval","id":1,"params":{"kind":"command","threadId","turnId","itemId","environmentId":"local","reason":"...","command":"/usr/bin/zsh -lc '...'","cwd":"...","commandActions":[...],"proposedExecpolicyAmendment":...,"availableDecisions":[...]}}`,
  answered by the client with `{"id":1,"result":{"decision":"accept"}}`; the
  server then emits `serverRequest/resolved`.
- **The TUI generates the session title itself**: after each user prompt it runs
  `config/read`, `thread/start` with `ephemeral:true` and `sandbox:"read-only"`,
  a `turn/start` whose text begins "Generate a concise, single-line task title",
  then `thread/unsubscribe`. That is a second model request per prompt (the mock
  answers `Mock session`).
- **The model call is made by the app-server, not the client**, but it is labelled
  with the client's name: the mock sees `user-agent: codex-tui/0.162.0 (...)` and
  `originator: codex-tui`, taken from `initialize.clientInfo`.
- **The working directory is a client-supplied server-side path**, as with
  opencode: the TUI sends its own cwd in `turn/start.cwd`,
  `runtimeWorkspaceRoots`, `hooks/list`, `skills/list`, `plugin/list`. Commands
  and file access run on the server in that directory.
- **Local to the client even with `--remote`** (from `strace -f`, startup + one
  prompt + `/quit`):
  - Spawns one process at startup: `/usr/bin/bwrap --unshare-user --unshare-net
    --ro-bind / / /bin/true` (a sandbox probe). No git, no shell.
  - Connects to the session D-Bus socket `/run/user/<uid>/bus`. Purpose not
    established (the client then records `[tui] screen_reader_detection_done =
    true`, so an accessibility query is likely; keyring or notifications are
    also possible).
  - Reads its own `$CODEX_HOME/config.toml` and `$CODEX_HOME/auth.json`, and the
    `/etc/codex/*.toml` files. **The client's config matters**: `approvalPolicy`
    and `sandbox` in `thread/start`/`turn/start` come from it, and an empty
    client home sent `sandbox:"read-only"`. `codex.client.config.toml` sets them
    to match the server. Model and provider do not need to be in the client's
    config: with an empty client home the TUI still showed `mock-model`, from the
    server's `config/read`.
  - Writes in its own `$CODEX_HOME`: `config.toml` (it adds keys to it),
    `history.jsonl`, `tui-thread-reference-capabilities/<thread id>`,
    `tmp/arg0/`, and looks for `log/codex-tui.log`. When client and server shared
    one `CODEX_HOME` the client also opened `state_5.sqlite` and `logs_2.sqlite`
    directly; with separate homes it did not need them, and the baseline uses
    separate homes for that reason.
  - Stats its cwd and every ancestor for `.git`, and the cwd for `.codex`,
    `.agents`, `.aws`.
  - Makes its own HTTPS requests unless configured not to (see the egress table):
    update check, analytics, announcement tip.
  - No login screen and no directory-trust prompt appeared in remote mode with an
    empty client home.
- **Environment the client reads**: `CODEX_HOME`, `HOME`, proxy variables,
  terminal variables (`TERM` ends up in the user agent). Flags that matter:
  `--remote`, `--remote-auth-token-env`, `-c key=value`, `-C/--cd`,
  `--no-alt-screen`.
- **Not exercised**: clipboard and image paste, `apply_patch` (not offered with fallback model
  metadata, so no file-change approval request was seen), `request_user_input`, MCP, `/review`, resume/fork, the `codex_tui`
  dynamic tools being called, the server's "remote control" loop (it idles
  waiting for ChatGPT auth and made no request).
