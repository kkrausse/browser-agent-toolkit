#!/usr/bin/env bun
// Scripted, deterministic stand-in for the model APIs opencode and codex talk to.
// No network access, no keys: every reply is generated locally from the scenario
// table below. See README.md for the scenario keywords and the wire formats.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4791);
const HOST = process.env.MOCK_LLM_HOST ?? "127.0.0.1";
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS ?? 15);
const LOG_FILE = process.env.MOCK_LLM_LOG;
const DUMP_DIR = process.env.MOCK_LLM_DUMP_DIR;

// ---------------------------------------------------------------------------
// Normalised view of a request, independent of wire format
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  kind: "function" | "custom";
  schema?: JsonSchema;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

interface Turn {
  api: "chat" | "responses" | "anthropic";
  model: string;
  stream: boolean;
  system: string;
  userText: string;
  /** Tool outputs that arrived after the last real user message, in order. */
  toolResults: string[];
  tools: ToolDef[];
  messageCount: number;
  cwd: string;
}

interface ToolCall {
  id: string;
  name: string;
  kind: "function" | "custom";
  /** JSON arguments for function tools, raw text for custom (freeform) tools. */
  payload: string;
}

interface Step {
  reasoning?: string;
  text?: string;
  tool?: ToolCall;
}

interface Scenario {
  name: string;
  match: RegExp;
  step: (turn: Turn) => Step;
}

// ---------------------------------------------------------------------------
// Scenario scripts
// ---------------------------------------------------------------------------

const PLAIN_TEXT =
  "Hello from mock-llm. This is a scripted plain-text reply, streamed in small chunks so the client's incremental rendering is exercised. No model was called and no tokens were spent.";

const MARKDOWN_TEXT = `## Scripted markdown

Here is a **bold** claim, some *emphasis*, and \`inline code\`.

1. First item
2. Second item
   - nested bullet

\`\`\`ts
// mock-llm fenced block
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

| column | value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

> End of the markdown scenario.`;

const LONG_TEXT = [
  "# Long scripted response",
  "",
  "This reply is intentionally long so the transcript has to scroll.",
  "",
  ...Array.from({ length: 80 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `${n}. Line ${n} of 80: the quick brown fox jumps over the lazy dog (mock-llm long scenario).`;
  }),
  "",
  "END-OF-LONG-RESPONSE",
].join("\n");

const REASONING_TEXT =
  "The user asked for a reasoning demo. I will think for a moment: step one, restate the request; step two, pick the scripted answer; step three, send it.";

// Ids are unique for the life of the process: clients key transcript items on them.
let itemSeq = 0;
const itemId = (prefix: string) => `${prefix}_mock_${String(++itemSeq).padStart(4, "0")}`;
let callSeq = 0;
const nextCallId = () => `call_mock_${String(++callSeq).padStart(4, "0")}`;

/** First meaningful line of a tool result (codex prefixes exec output with a metadata header ending in "Output:"). */
function firstLine(s: string, max = 120): string {
  const body = s.includes("\nOutput:\n") ? s.slice(s.indexOf("\nOutput:\n") + 9) : s;
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function findTool(turn: Turn, names: string[]): ToolDef | undefined {
  for (const n of names) {
    const t = turn.tools.find((t) => t.name === n);
    if (t) return t;
  }
  return undefined;
}

function typeOf(s: JsonSchema | undefined): string {
  const t = s?.type;
  return Array.isArray(t) ? (t.find((x) => x !== "null") ?? "string") : (t ?? "string");
}

/** Fill a function tool's arguments from its JSON schema: known keys from `known`, required others by type. */
function fillArgs(tool: ToolDef, known: Record<string, unknown>): string {
  const props = tool.schema?.properties ?? {};
  const required = new Set(tool.schema?.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    if (key in known) {
      const v = known[key];
      out[key] = typeOf(schema) === "array" && typeof v === "string" ? ["bash", "-lc", v] : v;
    } else if (required.has(key)) {
      const t = typeOf(schema);
      out[key] = t === "number" || t === "integer" ? 0 : t === "boolean" ? false : t === "array" ? [] : t === "object" ? {} : "";
    }
  }
  if (Object.keys(props).length === 0) Object.assign(out, known);
  return JSON.stringify(out);
}

/**
 * `escalate` asks codex to run the command outside its sandbox, which is what makes
 * codex show an approval prompt under approval_policy=on-request. Tools without
 * those parameters (opencode's shell) just get the plain command.
 */
function shellCall(turn: Turn, command: string, escalate = false): ToolCall | undefined {
  const tool = findTool(turn, ["bash", "shell", "exec_command", "shell_command", "local_shell", "unified_exec"]);
  if (!tool) return undefined;
  const payload = fillArgs(tool, {
    command,
    cmd: command,
    description: "Scripted mock-llm shell command",
    ...(escalate
      ? { sandbox_permissions: "require_escalated", justification: "mock-llm wants to run this outside the sandbox. Allow?" }
      : {}),
  });
  return { id: nextCallId(), name: tool.name, kind: "function", payload };
}

function readCall(turn: Turn, relPath: string): ToolCall | undefined {
  const tool = findTool(turn, ["read", "read_file", "view"]);
  if (!tool) return shellCall(turn, `cat ${relPath}`);
  const abs = join(turn.cwd, relPath);
  return { id: nextCallId(), name: tool.name, kind: "function", payload: fillArgs(tool, { filePath: abs, file_path: abs, path: abs }) };
}

function writeCall(turn: Turn, relPath: string, content: string): ToolCall | undefined {
  const abs = join(turn.cwd, relPath);
  const write = findTool(turn, ["write", "write_file"]);
  if (write) {
    const payload = fillArgs(write, { filePath: abs, file_path: abs, path: abs, content });
    return { id: nextCallId(), name: write.name, kind: "function", payload };
  }
  const patchTool = findTool(turn, ["apply_patch"]);
  if (patchTool) {
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${relPath}`,
      ...content.replace(/\n$/, "").split("\n").map((l) => `+${l}`),
      "*** End Patch",
      "",
    ].join("\n");
    const payload = patchTool.kind === "custom" ? patch : fillArgs(patchTool, { input: patch, patch });
    return { id: nextCallId(), name: patchTool.name, kind: patchTool.kind, payload };
  }
  // No file tool offered (codex with fallback model metadata): write through the shell.
  return shellCall(turn, `cat > ${relPath} <<'MOCK_EOF'\n${content.replace(/\n$/, "")}\nMOCK_EOF`);
}

/** Replaces a file's first line, which the prompt quotes ("..."), with the same line plus a marker. */
function changeCall(turn: Turn, relPath: string): ToolCall | undefined {
  const before = /"([^"\n]+)"/.exec(turn.userText)?.[1];
  const patchTool = findTool(turn, ["apply_patch"]);
  if (!before || !patchTool) return writeCall(turn, relPath, "changed by mock-llm\n");
  const patch = ["*** Begin Patch", `*** Update File: ${relPath}`, "@@", `-${before}`, `+${before} (changed by mock-llm)`, "*** End Patch", ""].join("\n");
  const payload = patchTool.kind === "custom" ? patch : fillArgs(patchTool, { input: patch, patch });
  return { id: nextCallId(), name: patchTool.name, kind: patchTool.kind, payload };
}

/** A scenario that makes one tool call and then answers once the result is back. */
function toolThenAnswer(
  label: string,
  preamble: string,
  call: (turn: Turn) => ToolCall | undefined,
): (turn: Turn) => Step {
  return (turn) => {
    if (turn.toolResults.length === 0) {
      const tool = call(turn);
      if (!tool) return { text: `mock-llm: the ${label} scenario needs a tool the client did not offer (offered: ${turn.tools.map((t) => t.name).join(", ") || "none"}).` };
      return { text: preamble, tool };
    }
    const result = turn.toolResults[turn.toolResults.length - 1] ?? "";
    return {
      text: `Tool result received (${result.length} chars). First line: \`${firstLine(result)}\`\n\nThe ${label} scenario is complete. MOCK-TOOL-DONE`,
    };
  };
}

// ---- shell scripts: what a model does with a shell tool, step by step ---------------------------
// For clients whose tool is codex's `exec_command` / `write_stdin` (the commands assume the sample
// project of wasm-term/ports/codex/main/sample, which `?guest=codex-local` seeds).

/** The command's own output: codex puts a header (chunk id, wall time, exit code or session id) before "Output:". */
function outputOf(result: string): string {
  return result.includes("\nOutput:\n") ? result.slice(result.indexOf("\nOutput:\n") + 9) : result;
}
const exitOf = (result: string) => /Process exited with code (-?\d+)/.exec(result)?.[1] ?? "?";
const sessionOf = (result: string) => Number(/Process running with session ID (\d+)/.exec(result)?.[1] ?? -1);
const lastLine = (text: string) => text.trimEnd().split("\n").pop() ?? "";

function execCall(turn: Turn, cmd: string, extra: Record<string, unknown> = {}): ToolCall | undefined {
  const tool = findTool(turn, ["exec_command"]);
  if (!tool) return shellCall(turn, cmd);
  return { id: nextCallId(), name: tool.name, kind: "function", payload: JSON.stringify({ cmd, ...extra }) };
}

function stdinCall(turn: Turn, sessionId: number, chars: string, yieldMs = 1000): ToolCall | undefined {
  const tool = findTool(turn, ["write_stdin"]);
  if (!tool) return undefined;
  return { id: nextCallId(), name: tool.name, kind: "function", payload: JSON.stringify({ session_id: sessionId, chars, yield_time_ms: yieldMs }) };
}

function patchCall(turn: Turn, patch: string): ToolCall | undefined {
  const tool = findTool(turn, ["apply_patch"]);
  if (!tool) return undefined;
  return { id: nextCallId(), name: tool.name, kind: tool.kind, payload: tool.kind === "custom" ? patch : fillArgs(tool, { input: patch, patch }) };
}

/** Runs `steps` one tool call per request, then answers with one line per result: `<n>. exit <code>: <first line of output>`. */
function script(label: string, steps: ((turn: Turn) => { say: string; tool: ToolCall | undefined })[], report: (turn: Turn) => string = () => ""): (turn: Turn) => Step {
  return (turn) => {
    const n = turn.toolResults.length;
    if (n < steps.length) {
      const { say, tool } = steps[n]!(turn);
      if (!tool) return { text: `mock-llm: the ${label} scenario needs a tool the client did not offer (offered: ${turn.tools.map((t) => t.name).join(", ") || "none"}).` };
      return { text: `Step ${n + 1} of ${steps.length}: ${say}`, tool };
    }
    const lines = turn.toolResults.map((result, index) => `${index + 1}. exit ${exitOf(result)}: \`${firstLine(result, 100)}\``);
    const extra = report(turn);
    return { text: `${lines.join("\n")}\n${extra ? `${extra}\n` : ""}\nThe ${label} scenario is complete. MOCK-${label.toUpperCase()}-DONE` };
  };
}

const REPORT_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/report.py",
  "@@",
  " def format_report(items: list[Item]) -> str:",
  "-    # TODO: sort the items by name before printing",
  "-    lines = [format_line(item) for item in items]",
  "+    lines = [format_line(item) for item in sorted(items, key=lambda item: item.name)]",
  '     lines.append("-" * 38)',
  "*** End Patch",
  "",
].join("\n");

const STDIN_LOOP = 'while IFS= read -r line; do echo "got:$line"; [ "$line" = quit ] && break; done; echo bye';

const SHELL_SCENARIOS: Scenario[] = [
  {
    // How a model gets to know a project: list, search, read with line numbers.
    name: "shell-read",
    match: /\bshell-read\b/i,
    step: script("shell-read", [
      (t) => ({ say: "listing the files.", tool: execCall(t, "rg --files | sort") }),
      (t) => ({ say: "finding the functions.", tool: execCall(t, 'rg -n "^def " src') }),
      (t) => ({ say: "reading the report module with line numbers.", tool: execCall(t, "nl -ba src/report.py | sed -n '1,14p'") }),
      (t) => ({ say: "reading the top of the README.", tool: execCall(t, "sed -n '1,5p' README.md") }),
      (t) => ({ say: "reading the data.", tool: execCall(t, "cat data/items.csv") }),
      (t) => ({ say: "listing the directory.", tool: execCall(t, "ls -la") }),
    ]),
  },
  {
    // Read, edit with apply_patch, check the edit: the loop a coding agent lives in.
    name: "shell-fix",
    match: /\bshell-fix\b/i,
    step: script("shell-fix", [
      (t) => ({ say: "looking for the open TODOs.", tool: execCall(t, "rg -n TODO src") }),
      (t) => ({ say: "reading the function.", tool: execCall(t, "nl -ba src/report.py | sed -n '10,14p'") }),
      (t) => ({ say: "sorting the items by name.", tool: patchCall(t, REPORT_PATCH) }),
      (t) => ({ say: "checking the edit.", tool: execCall(t, 'rg -n "sorted\\(" src/report.py && ! rg -q "TODO: sort" src && echo edit-verified') }),
    ], (turn) => `Verification: \`${lastLine(outputOf(turn.toolResults[3] ?? ""))}\``),
  },
  {
    // Commands that fail, and programs this machine does not have.
    name: "shell-fail",
    match: /\bshell-fail\b/i,
    step: script("shell-fail", [
      (t) => ({ say: "reading a file that is not there.", tool: execCall(t, "cat does-not-exist.txt") }),
      (t) => ({ say: "asking git.", tool: execCall(t, "git status --short") }),
      (t) => ({ say: "asking python.", tool: execCall(t, "python3 -c 'print(1)'") }),
      (t) => ({ say: "a pipeline whose status is the last command's.", tool: execCall(t, "rg -n nothing-matches-this src; echo \"rg=$?\"; false") }),
    ]),
  },
  {
    name: "shell-long",
    match: /\bshell-long\b/i,
    step: script("shell-long", [(t) => ({ say: "printing 60,000 lines.", tool: execCall(t, "seq 1 60000") })], (turn) => {
      const out = outputOf(turn.toolResults[0] ?? "");
      return `Output seen by the model: ${out.length} chars, ${out.split("\n").length} lines, last line \`${lastLine(out)}\`${/truncated|omitted/i.test(out) ? ", truncated by the client" : ""}.`;
    }),
  },
  {
    // The model's own timeout: there is no timeout parameter on exec_command, so `timeout` in the shell.
    name: "shell-timeout",
    match: /\bshell-timeout\b/i,
    step: script("shell-timeout", [(t) => ({ say: "running a command that takes too long, under `timeout`.", tool: execCall(t, 'echo started; timeout 1 sleep 30; echo "timeout-status=$?"') })], (turn) =>
      `Last line: \`${lastLine(outputOf(turn.toolResults[0] ?? ""))}\``),
  },
  {
    // A command the user has to interrupt (Esc): the tool call does not return for two minutes.
    name: "shell-sleep",
    match: /\bshell-sleep\b/i,
    step: script("shell-sleep", [(t) => ({ say: "sleeping for two minutes.", tool: execCall(t, "echo sleeping; sleep 120; echo woke", { yield_time_ms: 30000 }) })]),
  },
  {
    // A process left running after the yield time, then interrupted by the model with Ctrl-C.
    name: "shell-ctrlc",
    match: /\bshell-ctrlc\b/i,
    step: script("shell-ctrlc", [
      (t) => ({ say: "starting a long command and yielding after half a second.", tool: execCall(t, "echo started; sleep 300; echo never", { yield_time_ms: 500 }) }),
      (t) => ({ say: "interrupting it.", tool: stdinCall(t, sessionOf(t.toolResults[0] ?? ""), "\u0003") }),
      (t) => ({ say: "the shell still works.", tool: execCall(t, "echo after-interrupt") }),
    ], (turn) => `Session ${sessionOf(turn.toolResults[0] ?? "")} was running after the first call; after Ctrl-C: exit ${exitOf(turn.toolResults[1] ?? "")}.`),
  },
  {
    // An interactive process: a terminal session the model types into.
    name: "shell-stdin",
    match: /\bshell-stdin\b/i,
    step: script("shell-stdin", [
      (t) => ({ say: "starting a loop that reads lines.", tool: execCall(t, STDIN_LOOP, { tty: true, yield_time_ms: 500 }) }),
      (t) => ({ say: "typing a line.", tool: stdinCall(t, sessionOf(t.toolResults[0] ?? ""), "hello from stdin\n") }),
      (t) => ({ say: "typing the last line.", tool: stdinCall(t, sessionOf(t.toolResults[0] ?? ""), "quit\n") }),
    ], (turn) => `First write returned: ${JSON.stringify(outputOf(turn.toolResults[1] ?? "").trim())}\nSecond write returned: ${JSON.stringify(outputOf(turn.toolResults[2] ?? "").trim())}`),
  },
];

const SCENARIOS: Scenario[] = [
  {
    name: "title",
    // opencode asks a small model for a session title; never answer that with a tool call.
    match: /$^/,
    step: () => ({ text: "Mock session" }),
  },
  {
    name: "error",
    match: /\bmock-error\b/i,
    step: () => ({ text: "" }), // handled before streaming: HTTP 400
  },
  ...SHELL_SCENARIOS,
  {
    name: "multi-tool",
    match: /\bmulti[- ]?tool\b/i,
    step: (turn) => {
      const n = turn.toolResults.length;
      if (n === 0) return { text: "Step 1 of 2: running a shell command.", tool: shellCall(turn, "echo mock-llm-step-1 && pwd") };
      if (n === 1) return { text: "Step 2 of 2: writing a file.", tool: writeCall(turn, "mock-output.txt", "written by mock-llm (multi-tool)\n") };
      return { text: `Both tool calls returned (${turn.toolResults.map((r) => r.length).join(" and ")} chars). MOCK-TOOL-DONE` };
    },
  },
  {
    name: "change",
    // Rewrites the first line of hello.txt in place (codex: an apply_patch "Update File";
    // the line is taken from the prompt: `change hello.txt "<old first line>"`).
    match: /\bchange\b/i,
    step: toolThenAnswer("change", "I will change the first line of `hello.txt`.", (t) => changeCall(t, "hello.txt")),
  },
  {
    name: "write",
    match: /\b(edit|write|patch)\b/i,
    step: toolThenAnswer("write", "I will create `mock-output.txt`.", (t) =>
      writeCall(t, "mock-output.txt", "written by mock-llm\nsecond line\n"),
    ),
  },
  {
    name: "read",
    match: /\bread\b/i,
    step: toolThenAnswer("read", "I will read `hello.txt`.", (t) => readCall(t, "hello.txt")),
  },
  {
    name: "escalate",
    match: /\b(escalate|approval|permission)\b/i,
    step: toolThenAnswer("escalate", "I need approval to run a command outside the sandbox.", (t) =>
      shellCall(t, "echo mock-llm-escalated-ok && pwd", true),
    ),
  },
  {
    name: "shell",
    match: /\b(tool|bash|shell)\b/i,
    step: toolThenAnswer("shell", "I will run a shell command.", (t) => shellCall(t, "echo mock-llm-tool-ok && pwd")),
  },
  { name: "markdown", match: /\b(markdown|code)\b/i, step: () => ({ text: MARKDOWN_TEXT }) },
  { name: "long", match: /\b(long|scroll)\b/i, step: () => ({ text: LONG_TEXT }) },
  {
    name: "reasoning",
    match: /\b(think|reason|reasoning)\b/i,
    step: () => ({ reasoning: REASONING_TEXT, text: "After thinking it through: the scripted answer is 42. MOCK-REASONING-DONE" }),
  },
  { name: "plain", match: /(?:)/, step: () => ({ text: PLAIN_TEXT }) },
];

function isTitleRequest(turn: Turn): boolean {
  // opencode puts the instruction in the system prompt, codex in the user message.
  if (turn.tools.length > 0) return false;
  const text = `${turn.system}\n${turn.userText.slice(0, 400)}`;
  return /\btitle\b/i.test(text) && /generat|thread|conversation|session/i.test(text);
}

function pickScenario(turn: Turn): Scenario {
  if (isTitleRequest(turn)) return SCENARIOS[0]!;
  return SCENARIOS.slice(1).find((s) => s.match.test(turn.userText))!;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: Json) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Clients wrap context in pseudo-XML user messages (<environment_context>, <system-reminder>, ...). */
const isInjected = (text: string) => /^\s*<[a-zA-Z_-]+[ >]/.test(text);

function guessCwd(raw: string): string {
  const m =
    raw.match(/<cwd>([^<]+)<\/cwd>/) ??
    raw.match(/Working directory: ([^\\\n"]+)/) ??
    raw.match(/Current working directory: ([^\\\n"]+)/i);
  return m?.[1]?.trim() ?? "/tmp";
}

function parseChat(body: Json, raw: string): Turn {
  const messages: Json[] = body.messages ?? [];
  let system = "";
  let userText = "";
  let toolResults: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") system += `${textOf(m.content)}\n`;
    else if (m.role === "user") {
      const t = textOf(m.content);
      if (!isInjected(t)) {
        userText = t;
        toolResults = [];
      }
    } else if (m.role === "tool") toolResults.push(textOf(m.content));
  }
  const tools: ToolDef[] = (body.tools ?? [])
    .filter((t: Json) => t.type === "function")
    .map((t: Json) => ({ name: t.function.name, kind: "function", schema: t.function.parameters }));
  return { api: "chat", model: body.model ?? "", stream: !!body.stream, system, userText, toolResults, tools, messageCount: messages.length, cwd: guessCwd(raw) };
}

function parseResponses(body: Json, raw: string): Turn {
  const input: Json[] = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : (body.input ?? []);
  let system = typeof body.instructions === "string" ? body.instructions : "";
  let userText = "";
  let toolResults: string[] = [];
  for (const item of input) {
    const type = item.type ?? "message";
    if (type === "message") {
      const t = textOf(item.content);
      if (item.role === "system" || item.role === "developer") system += `\n${t}`;
      else if (item.role === "user" && !isInjected(t)) {
        userText = t;
        toolResults = [];
      }
    } else if (type.endsWith("_call_output")) {
      toolResults.push(typeof item.output === "string" ? item.output : textOf(item.output) || JSON.stringify(item.output ?? ""));
    }
  }
  const tools: ToolDef[] = (body.tools ?? []).flatMap((t: Json): ToolDef[] => {
    if (t.type === "function") return [{ name: t.name, kind: "function", schema: t.parameters }];
    if (t.type === "custom") return [{ name: t.name, kind: "custom" }];
    return [];
  });
  return { api: "responses", model: body.model ?? "", stream: !!body.stream, system, userText, toolResults, tools, messageCount: input.length, cwd: guessCwd(raw) };
}

function parseAnthropic(body: Json, raw: string): Turn {
  const messages: Json[] = body.messages ?? [];
  const system = textOf(body.system);
  let userText = "";
  let toolResults: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const blocks: Json[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    for (const b of blocks) {
      if (b.type === "tool_result") toolResults.push(textOf(b.content));
      else if (b.type === "text" && !isInjected(b.text)) {
        userText = b.text;
        toolResults = [];
      }
    }
  }
  const tools: ToolDef[] = (body.tools ?? [])
    .filter((t: Json) => t.input_schema)
    .map((t: Json) => ({ name: t.name, kind: "function", schema: t.input_schema }));
  return { api: "anthropic", model: body.model ?? "", stream: !!body.stream, system, userText, toolResults, tools, messageCount: messages.length, cwd: guessCwd(raw) };
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Deterministic chunker: 1-3 whitespace-delimited tokens per chunk, whitespace preserved. */
function chunkText(text: string): string[] {
  const tokens = text.match(/\s*\S+\s*/g) ?? (text ? [text] : []);
  const chunks: string[] = [];
  let seed = 7;
  for (let i = 0; i < tokens.length; ) {
    seed = (seed * 31 + 11) % 97;
    const n = 1 + (seed % 3);
    chunks.push(tokens.slice(i, i + n).join(""));
    i += n;
  }
  return chunks;
}

function chunkRaw(s: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

type Emit = (event: string | null, data: unknown) => Promise<void>;

function sseResponse(run: (emit: Emit) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = async (event, data) => {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(enc.encode(`${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`));
        await sleep(DELAY_MS);
      };
      try {
        await run(emit);
      } catch (err) {
        log(`!! stream aborted (client went away?): ${err}`);
      }
      try {
        controller.close();
      } catch {}
    },
  });
  return new Response(stream, {
    headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const usageFor = (turn: Turn, step: Step) => {
  const input = Math.max(1, Math.round((turn.system.length + turn.userText.length) / 4));
  const output = Math.max(1, Math.round(((step.text?.length ?? 0) + (step.reasoning?.length ?? 0) + (step.tool?.payload.length ?? 0)) / 4));
  return { input, output, reasoning: Math.round((step.reasoning?.length ?? 0) / 4) };
};

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

function chatReply(turn: Turn, step: Step): Response {
  const id = itemId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const u = usageFor(turn, step);
  const usage = { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output, completion_tokens_details: { reasoning_tokens: u.reasoning } };
  const finish = step.tool ? "tool_calls" : "stop";
  const toolCalls = step.tool ? [{ id: step.tool.id, type: "function", function: { name: step.tool.name, arguments: step.tool.payload } }] : undefined;

  if (!turn.stream) {
    return json({
      id, object: "chat.completion", created, model: turn.model,
      choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: step.text ?? null, reasoning_content: step.reasoning, tool_calls: toolCalls } }],
      usage,
    });
  }
  return sseResponse(async (emit) => {
    const chunk = (delta: Json, finish_reason: string | null = null) =>
      emit(null, { id, object: "chat.completion.chunk", created, model: turn.model, choices: [{ index: 0, delta, finish_reason }] });
    await chunk({ role: "assistant", content: "" });
    for (const c of chunkText(step.reasoning ?? "")) await chunk({ reasoning_content: c });
    for (const c of chunkText(step.text ?? "")) await chunk({ content: c });
    if (step.tool) {
      await chunk({ tool_calls: [{ index: 0, id: step.tool.id, type: "function", function: { name: step.tool.name, arguments: "" } }] });
      for (const c of chunkRaw(step.tool.payload)) await chunk({ tool_calls: [{ index: 0, function: { arguments: c } }] });
    }
    await chunk({}, finish);
    await emit(null, { id, object: "chat.completion.chunk", created, model: turn.model, choices: [], usage });
    await emit(null, "[DONE]");
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

function responsesReply(turn: Turn, step: Step): Response {
  const respId = itemId("resp");
  const created_at = Math.floor(Date.now() / 1000);
  const u = usageFor(turn, step);
  const usage = {
    input_tokens: u.input, input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.output, output_tokens_details: { reasoning_tokens: u.reasoning },
    total_tokens: u.input + u.output,
  };

  const items: Json[] = [];
  if (step.reasoning) items.push({ type: "reasoning", id: itemId("rs"), summary: [{ type: "summary_text", text: step.reasoning }] });
  if (step.text) items.push({ type: "message", id: itemId("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] });
  if (step.tool) {
    items.push(
      step.tool.kind === "custom"
        ? { type: "custom_tool_call", id: itemId("ctc"), status: "completed", call_id: step.tool.id, name: step.tool.name, input: step.tool.payload }
        : { type: "function_call", id: itemId("fc"), status: "completed", call_id: step.tool.id, name: step.tool.name, arguments: step.tool.payload },
    );
  }
  const base = { id: respId, object: "response", created_at, model: turn.model, output: [] as Json[], usage: null as Json | null };
  const completed = { ...base, status: "completed", output: items, usage };

  if (!turn.stream) return json(completed);

  return sseResponse(async (emit) => {
    let seq = 0;
    const ev = (type: string, data: Json) => emit(type, { type, sequence_number: seq++, ...data });
    await ev("response.created", { response: { ...base, status: "in_progress" } });
    await ev("response.in_progress", { response: { ...base, status: "in_progress" } });
    for (const [output_index, item] of items.entries()) {
      const item_id = item.id;
      if (item.type === "reasoning") {
        await ev("response.output_item.added", { output_index, item: { ...item, summary: [] } });
        await ev("response.reasoning_summary_part.added", { item_id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } });
        for (const delta of chunkText(step.reasoning!)) await ev("response.reasoning_summary_text.delta", { item_id, output_index, summary_index: 0, delta });
        await ev("response.reasoning_summary_text.done", { item_id, output_index, summary_index: 0, text: step.reasoning });
        await ev("response.reasoning_summary_part.done", { item_id, output_index, summary_index: 0, part: item.summary[0] });
      } else if (item.type === "message") {
        await ev("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } });
        await ev("response.content_part.added", { item_id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        for (const delta of chunkText(step.text!)) await ev("response.output_text.delta", { item_id, output_index, content_index: 0, delta });
        await ev("response.output_text.done", { item_id, output_index, content_index: 0, text: step.text });
        await ev("response.content_part.done", { item_id, output_index, content_index: 0, part: item.content[0] });
      } else if (item.type === "function_call") {
        await ev("response.output_item.added", { output_index, item: { ...item, status: "in_progress", arguments: "" } });
        for (const delta of chunkRaw(item.arguments)) await ev("response.function_call_arguments.delta", { item_id, output_index, delta });
        await ev("response.function_call_arguments.done", { item_id, output_index, arguments: item.arguments });
      } else {
        await ev("response.output_item.added", { output_index, item: { ...item, status: "in_progress", input: "" } });
        for (const delta of chunkRaw(item.input)) await ev("response.custom_tool_call_input.delta", { item_id, output_index, delta });
        await ev("response.custom_tool_call_input.done", { item_id, output_index, input: item.input });
      }
      await ev("response.output_item.done", { output_index, item });
    }
    await ev("response.completed", { response: completed });
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicReply(turn: Turn, step: Step): Response {
  const id = itemId("msg");
  const u = usageFor(turn, step);
  const stop_reason = step.tool ? "tool_use" : "end_turn";
  const blocks: Json[] = [];
  if (step.reasoning) blocks.push({ type: "thinking", thinking: step.reasoning, signature: "mock-signature" });
  if (step.text) blocks.push({ type: "text", text: step.text });
  if (step.tool) blocks.push({ type: "tool_use", id: step.tool.id, name: step.tool.name, input: JSON.parse(step.tool.payload) });
  const message = { id, type: "message", role: "assistant", model: turn.model, stop_sequence: null };

  if (!turn.stream) return json({ ...message, content: blocks, stop_reason, usage: { input_tokens: u.input, output_tokens: u.output } });

  return sseResponse(async (emit) => {
    const ev = (type: string, data: Json) => emit(type, { type, ...data });
    await ev("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: u.input, output_tokens: 1 } } });
    for (const [index, b] of blocks.entries()) {
      if (b.type === "thinking") {
        await ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
        for (const c of chunkText(b.thinking)) await ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: c } });
        await ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
      } else if (b.type === "text") {
        await ev("content_block_start", { index, content_block: { type: "text", text: "" } });
        for (const c of chunkText(b.text)) await ev("content_block_delta", { index, delta: { type: "text_delta", text: c } });
      } else {
        await ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        for (const c of chunkRaw(step.tool!.payload)) await ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c } });
      }
      await ev("content_block_stop", { index });
    }
    await ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: u.output } });
    await ev("message_stop", {});
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

function log(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
  console.log(stamped);
  if (LOG_FILE) appendFileSync(LOG_FILE, `${stamped}\n`);
}

// ---------------------------------------------------------------------------
// Fake sign-in: the endpoints codex's device-code login, token refresh, logout
// and post-login account check talk to, so the whole flow can run with no real
// account. Nothing here is a secret; every "token" says mock in it.
//
//   issuer            <this server>/auth       (CODEX_APP_SERVER_LOGIN_ISSUER)
//   refresh           <this server>/auth/oauth/token (CODEX_REFRESH_TOKEN_URL_OVERRIDE)
//   chatgpt_base_url  <this server>/backend-api/
//
//   POST /auth/api/accounts/deviceauth/usercode   -> { device_auth_id, user_code, interval }
//   GET  /auth/codex/device[?user_code=CODE]      the "verification page": with a code, approves it
//   POST /auth/api/accounts/deviceauth/token      403 until approved, then { authorization_code, code_challenge, code_verifier }
//   POST /auth/oauth/token                        form authorization_code -> tokens; JSON refresh_token -> new tokens
//   POST /auth/oauth/revoke                       records the token
//   GET  /backend-api/wham/accounts/check         one account, for a request with a current access token (401 otherwise)
//   GET  /auth/state                              everything above as JSON, plus the credentials the last model requests carried
//   POST /auth/reset                              forget it all
//
// The first access token of a login is already inside codex's refresh window
// (it expires in 2 minutes; codex refreshes within 5), so the first use of the
// credentials exercises the refresh endpoint as well.
// ---------------------------------------------------------------------------

interface DeviceLogin {
  deviceAuthId: string;
  userCode: string;
  approved: boolean;
  polls: number;
  authorizationCode?: string;
}

const ACCOUNT_ID = "acct_mock_0001";
const auth = {
  logins: [] as DeviceLogin[],
  /** Access-token generation per refresh token family: bumped by every refresh. */
  generation: 0,
  exchanges: 0,
  refreshes: 0,
  revoked: [] as string[],
  accountChecks: [] as { authorization: string; status: number }[],
  modelRequests: [] as { path: string; authorization: string; account: string; userAgent: string; originator: string; contentEncoding: string; tools: string[]; browserTabNote: boolean }[],
  requests: [] as string[],
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Shaped like a JWT (codex reads `exp` and the auth claims out of the payload); not signed by anything. */
function fakeJwt(kind: string, generation: number, lifetimeSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "mock-llm", sub: "user_mock_0001", mock: `${kind}-${generation}`, iat: now, exp: now + lifetimeSeconds,
    email: "mock-user@example.invalid",
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: "user_mock_0001", chatgpt_account_id: ACCOUNT_ID },
  };
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.mock-signature`;
}
function tokens(generation: number, accessLifetimeSeconds: number): Json {
  return { id_token: fakeJwt("id", generation, 3600), access_token: fakeJwt("access", generation, accessLifetimeSeconds), refresh_token: `mock-refresh-${generation}` };
}
/** `access-<n>` of a bearer token minted here, or what was sent if it is something else. */
function describeAuthorization(header: string | null): string {
  if (!header) return "(none)";
  const token = header.replace(/^Bearer\s+/i, "");
  try {
    const mock = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).mock;
    if (typeof mock === "string") return `Bearer mock ${mock}`;
  } catch {}
  return header.length > 24 ? `${header.slice(0, 24)}...` : header;
}

async function handleAuth(req: Request, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("/auth/") && !path.startsWith("/backend-api/")) return null;
  if (path !== "/auth/state") auth.requests.push(`${req.method} ${path}`);
  if (path === "/auth/state") return json(auth);
  if (path === "/auth/reset" && req.method === "POST") {
    Object.assign(auth, { logins: [], generation: 0, exchanges: 0, refreshes: 0, revoked: [], accountChecks: [], modelRequests: [], requests: [] });
    return json({ ok: true });
  }
  if (path === "/auth/api/accounts/deviceauth/usercode" && req.method === "POST") {
    const n = auth.logins.length + 1;
    const login: DeviceLogin = { deviceAuthId: `deviceauth_mock_${n}`, userCode: `MOCK-${String(1000 + n)}`, approved: false, polls: 0 };
    auth.logins.push(login);
    log(`auth: device code ${login.userCode} issued`);
    // `interval` is a string on the real server too.
    return json({ device_auth_id: login.deviceAuthId, user_code: login.userCode, interval: "1" });
  }
  if (path === "/auth/codex/device") {
    const code = url.searchParams.get("user_code");
    const login = auth.logins.find((candidate) => candidate.userCode === code);
    if (login) {
      login.approved = true;
      log(`auth: device code ${login.userCode} approved`);
    }
    const body = login ? `Approved ${login.userCode}. Return to codex.` : `mock-llm device sign-in. Approve a code with ?user_code=CODE. Pending: ${auth.logins.filter((l) => !l.approved).map((l) => l.userCode).join(", ") || "none"}`;
    return new Response(`${body}\n`, { status: code && !login ? 404 : 200, headers: { ...CORS, "content-type": "text/plain" } });
  }
  if (path === "/auth/api/accounts/deviceauth/token" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Json;
    const login = auth.logins.find((candidate) => candidate.deviceAuthId === body.device_auth_id && candidate.userCode === body.user_code);
    if (!login) return json({ error: "unknown device code" }, 404);
    login.polls++;
    if (!login.approved) return json({ error: "authorization_pending" }, 403);
    login.authorizationCode = `mock-authorization-code-${login.deviceAuthId}`;
    return json({ authorization_code: login.authorizationCode, code_challenge: "mock-challenge", code_verifier: "mock-verifier" });
  }
  if (path === "/auth/oauth/token" && req.method === "POST") {
    const raw = await req.text();
    const type = req.headers.get("content-type") ?? "";
    const body: Json = type.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
    if (body.grant_type === "authorization_code") {
      const login = auth.logins.find((candidate) => candidate.authorizationCode === body.code);
      if (!login || body.code_verifier !== "mock-verifier") return json({ error: "invalid_grant" }, 400);
      auth.exchanges++;
      auth.generation++;
      log(`auth: code exchanged, token generation ${auth.generation} (redirect_uri ${body.redirect_uri})`);
      return json(tokens(auth.generation, 120));
    }
    if (body.grant_type === "refresh_token") {
      if (body.refresh_token !== `mock-refresh-${auth.generation}` || auth.revoked.includes(body.refresh_token)) return json({ error: { code: "refresh_token_invalidated" } }, 401);
      auth.refreshes++;
      auth.generation++;
      log(`auth: refreshed, token generation ${auth.generation}`);
      return json(tokens(auth.generation, 3600));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  if (path === "/auth/oauth/revoke" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Json;
    auth.revoked.push(String(body.token));
    log(`auth: revoked a ${body.token_type_hint}`);
    return json({});
  }
  if (path === "/backend-api/wham/accounts/check" && req.method === "GET") {
    const authorization = describeAuthorization(req.headers.get("authorization"));
    const ok = authorization === `Bearer mock access-${auth.generation}` && auth.generation > 0;
    auth.accountChecks.push({ authorization, status: ok ? 200 : 401 });
    if (!ok) return json({ error: "unauthorized" }, 401);
    return json({
      // The list form: codex takes the workspace's backend from here ("NO_CONSTRAINT" = stay on chatgpt_base_url).
      accounts: [{ id: ACCOUNT_ID, plan_type: "plus", workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT", name: "Mock workspace", structure: "personal" }],
      account_ordering: [ACCOUNT_ID],
      default_account_id: ACCOUNT_ID,
    });
  }
  log(`!! unhandled ${req.method} ${path}${url.search}`);
  return json({ error: { message: `mock-llm: no handler for ${req.method} ${path}` } }, 404);
}

const MODELS = ["mock-model", "mock-small", "mock-reasoning"];
let requestSeq = 0;

function clip(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

async function handleModel(req: Request, path: string, parse: (b: Json, raw: string) => Turn, reply: (t: Turn, s: Step) => Response): Promise<Response> {
  const n = ++requestSeq;
  // codex compresses request bodies with zstd when signed in with ChatGPT.
  const bytes = new Uint8Array(await req.arrayBuffer());
  const encoding = req.headers.get("content-encoding") ?? "";
  let raw = "";
  let body: Json;
  try {
    raw = new TextDecoder().decode(encoding.includes("zstd") ? Bun.zstdDecompressSync(bytes) : bytes);
    body = JSON.parse(raw);
  } catch {
    log(`#${n} POST ${path} !! invalid JSON (${raw.length} bytes)`);
    return json({ error: { message: "mock-llm: invalid JSON body", type: "invalid_request_error" } }, 400);
  }
  if (DUMP_DIR) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const headers = Object.fromEntries(req.headers.entries());
    writeFileSync(join(DUMP_DIR, `${String(n).padStart(4, "0")}-${path.replace(/\W+/g, "_")}.json`), JSON.stringify({ path, headers, body }, null, 2));
  }
  auth.modelRequests.push({
    path,
    authorization: describeAuthorization(req.headers.get("authorization")),
    account: req.headers.get("chatgpt-account-id") ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
    originator: req.headers.get("originator") ?? "",
    contentEncoding: encoding,
    // What the client offered and told the model: tool names, and whether codex-local's note about its environment is in the request.
    tools: ((body.tools ?? []) as Json[]).map((tool) => String(tool.name ?? tool.function?.name ?? tool.type)),
    browserTabNote: raw.includes("running inside a browser tab"),
  });
  if (auth.modelRequests.length > 50) auth.modelRequests.shift();
  const turn = parse(body, raw);
  const scenario = pickScenario(turn);
  const toolNames = turn.tools.map((t) => t.name);
  log(
    `#${n} POST ${path} model=${turn.model} stream=${turn.stream} items=${turn.messageCount} tools=${toolNames.length}` +
      `${toolNames.length ? `[${toolNames.slice(0, 16).join(",")}${toolNames.length > 16 ? ",..." : ""}]` : ""}` +
      ` results=${turn.toolResults.length} user="${clip(turn.userText)}" ua="${clip(req.headers.get("user-agent") ?? "", 40)}"`,
  );
  if (scenario.name === "error") {
    // 400, not 5xx: both clients retry server errors (opencode indefinitely), a 400 is rendered once.
    log(`#${n}   -> scenario=error HTTP 400`);
    return json({ error: { message: "mock-llm scripted failure (prompt contained mock-error)", type: "invalid_request_error", code: "mock_error" } }, 400);
  }
  const step = scenario.step(turn);
  log(
    `#${n}   -> scenario=${scenario.name} step=${turn.toolResults.length}` +
      `${step.reasoning ? ` reasoning=${step.reasoning.length}ch` : ""}${step.text ? ` text=${step.text.length}ch` : ""}` +
      `${step.tool ? ` tool=${step.tool.name}(${clip(step.tool.payload, 100)})` : ""}`,
  );
  return reply(turn, step);
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && (path === "/" || path === "/health")) return json({ ok: true, service: "mock-llm", models: MODELS });
    if (req.method === "GET" && /^(\/v1)?\/models$/.test(path)) {
      log(`GET ${path}${url.search}`);
      return json({ object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "mock-llm" })) });
    }
    const authResponse = await handleAuth(req, path, url);
    if (authResponse) return authResponse;
    if (req.method === "POST" && /^(\/v1)?\/chat\/completions$/.test(path)) return handleModel(req, path, parseChat, chatReply);
    if (req.method === "POST" && /^(\/v1)?\/responses$/.test(path)) return handleModel(req, path, parseResponses, responsesReply);
    if (req.method === "POST" && /^(\/v1)?\/messages$/.test(path)) return handleModel(req, path, parseAnthropic, anthropicReply);
    const bodyLen = req.method === "GET" ? 0 : (await req.text()).length;
    log(`!! unhandled ${req.method} ${path}${url.search} (${bodyLen} bytes) ua="${clip(req.headers.get("user-agent") ?? "", 40)}"`);
    return json({ error: { message: `mock-llm: no handler for ${req.method} ${path}`, type: "not_found" } }, 404);
  },
});

log(`mock-llm listening on http://${server.hostname}:${server.port} (delay ${DELAY_MS}ms/chunk)`);
