// Tool calls: one row per call, and one row for a run of finished calls. Which input and
// metadata fields a tool's row reads follows OpenCode 2.0.26's
// `session-ui/src/tools/tool-renderer.tsx` (MIT, see ../../NOTICES.md).
import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, FileText, Globe, ListTree, LoaderCircle, Pencil, Search, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";
import type { ToolPart } from "@kkrausse/browser-agent-toolkit/browser";
import { plural, type OpenFile } from "./hooks";
import { CopyButton } from "./markdown";
import { useChatTheme } from "./theme";
import { Button } from "./ui/button";

type Fields = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
/** While the call's arguments stream, the input is their unfinished JSON text. */
export const inputOf = (part: ToolPart): Fields => (typeof part.state.input === "object" ? part.state.input : {});
export const metadataOf = (part: ToolPart): Fields => ("metadata" in part.state && part.state.metadata) || {};
export function outputOf(part: ToolPart): string {
  const content = "content" in part.state ? part.state.content : undefined;
  return (content ?? []).map(item => (item.type === "text" ? item.text : `[file: ${item.name ?? item.uri}]`)).join("\n");
}
const pathOf = (input: Fields) => text(input.path) ?? text(input.filePath) ?? text(input.file_path);
/** As the agent sees the workspace: without the mount's prefix. */
export const shortPath = (path: string) => path.replace(/^\/workspace\//, "");
const isRunning = (part: ToolPart) => part.state.status === "running" || part.state.status === "streaming";

export interface FileChange { file: string; patch: string; additions: number; deletions: number }
/** `metadata.files` of an edit, write or patch call: one unified diff per changed file. */
export function changesOf(part: ToolPart): FileChange[] {
  const files = metadataOf(part).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap(value => {
    const file = value as Fields | null;
    return file && typeof file === "object" && typeof file.file === "string" && typeof file.patch === "string"
      ? [{ file: file.file, patch: file.patch, additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0 }] : [];
  });
}

type Kind = "shell" | "read" | "search" | "edit" | "web" | "other";
const kinds: Record<string, Kind> = { shell: "shell", read: "read", glob: "search", grep: "search", list: "search", edit: "edit", write: "edit", patch: "edit", webfetch: "web", websearch: "web" };
const icons: Record<Kind, LucideIcon> = { shell: SquareTerminal, read: FileText, search: Search, edit: Pencil, web: Globe, other: Wrench };
const kindOf = (part: ToolPart): Kind => kinds[part.name] ?? "other";

interface Summary { verb: string; subject?: string; extra?: string }
function summarise(part: ToolPart): Summary {
  const input = inputOf(part), metadata = metadataOf(part), running = isRunning(part);
  const firstLine = (value: string | undefined) => value?.trim().split("\n", 1)[0];
  switch (part.name) {
    case "shell": return { verb: running ? "Running" : "Ran", subject: firstLine(text(input.command) ?? text(metadata.command)) };
    case "execute": return { verb: running ? "Running code" : "Ran code", subject: firstLine(text(input.code)) };
    case "read": return { verb: running ? "Reading" : "Read", subject: pathOf(input) && shortPath(pathOf(input)!) };
    case "list": return { verb: running ? "Listing" : "Listed", subject: shortPath(pathOf(input) ?? "/") };
    case "glob": case "grep": return { verb: running ? "Searching" : "Searched", subject: text(input.pattern), extra: pathOf(input) && `in ${shortPath(pathOf(input)!)}` };
    case "webfetch": return { verb: running ? "Fetching" : "Fetched", subject: text(input.url) };
    case "websearch": return { verb: running ? "Searching the web" : "Searched the web", subject: text(input.query) };
    case "skill": return { verb: "Loaded skill", subject: text(input.name) };
    case "question": return { verb: running ? "Asking" : "Asked", subject: Array.isArray(input.questions) ? plural(input.questions.length, "question") : undefined };
    case "edit": case "write": case "patch": {
      const changes = changesOf(part), path = pathOf(input);
      const files = changes.length ? [...new Set(changes.map(change => shortPath(change.file)))] : path ? [shortPath(path)] : [];
      const added = changes.reduce((sum, change) => sum + change.additions, 0), removed = changes.reduce((sum, change) => sum + change.deletions, 0);
      return {
        verb: running ? (part.name === "write" ? "Writing" : "Editing") : part.name === "write" ? "Wrote" : "Edited",
        subject: files.length > 1 ? plural(files.length, "file") : files[0],
        extra: changes.length ? `+${added} −${removed}` : undefined,
      };
    }
    default: {
      const first = Object.values(input).find(value => typeof value === "string" && value) as string | undefined;
      return { verb: part.name, subject: firstLine(first) };
    }
  }
}

/** "Ran 6 shell commands", "Read 4 files", "Made 5 tool calls". */
export function countLabel(parts: readonly ToolPart[]): { label: string; kind: Kind } {
  const kind = kindOf(parts[0]!), count = parts.length;
  if (!parts.every(part => kindOf(part) === kind)) return { label: `Made ${plural(count, "tool call")}`, kind: "other" };
  switch (kind) {
    case "shell": return { label: `Ran ${plural(count, "shell command")}`, kind };
    case "read": return { label: `Read ${plural(count, "file")}`, kind };
    case "search": return { label: `Made ${plural(count, "search", "searches")}`, kind };
    case "web": return { label: `Made ${plural(count, "web request")}`, kind };
    default: {
      const name = parts[0]!.name;
      return { label: parts.every(part => part.name === name) ? `Made ${plural(count, `${name} call`)}` : `Made ${plural(count, "tool call")}`, kind: "other" };
    }
  }
}

/** Long text, cut to its first lines until asked for. */
export function Output({ text: value, lines = 14, tail = false }: { text: string; lines?: number; tail?: boolean }) {
  const [all, setAll] = useState(false);
  const rows = value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const cut = !all && rows.length > lines;
  const shown = cut ? (tail ? rows.slice(-lines) : rows.slice(0, lines)) : rows;
  return <div className="oc-output">
    <pre className="oc-pre">{shown.join("\n")}</pre>
    {rows.length > lines && <Button type="button" variant="ghost" size="sm" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${rows.length} lines`}</Button>}
  </div>;
}

// The diff view is a large module (a highlighter): loaded when the first diff opens. Until
// then, and if it cannot load, the patch is shown as coloured lines.
const PatchDiff = lazy(() => import("@pierre/diffs/react").then(
  module => ({ default: function Rendered({ patch, scheme }: { patch: string; scheme: "light" | "dark" }) {
    return <module.PatchDiff patch={patch} disableWorkerPool style={diffStyle} options={{ themeType: scheme, diffStyle: "unified", disableFileHeader: true, overflow: "wrap" }} />;
  } }),
  () => ({ default: PlainPatch }),
));
const diffStyle = { "--diffs-font-size": "12px", "--diffs-line-height": "18px" } as React.CSSProperties;
function PlainPatch({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, "").split("\n").filter(line => !/^(Index: |={5,}|--- |\+\+\+ |diff --git |index )/.test(line));
  return <pre className="oc-pre oc-patch">{lines.map((line, index) =>
    <span key={index} data-line={line[0] === "+" ? "add" : line[0] === "-" ? "del" : line.startsWith("@@") ? "hunk" : undefined}>{line || " "}{"\n"}</span>)}</pre>;
}
/** A patch needs its file header to be parsed; the edit tool's has one, a built one may not. */
const patchFor = (file: string, patch: string) => (/^(---|diff --git|Index:) /m.test(patch) ? patch : `--- a/${file}\n+++ b/${file}\n${patch}`);
export function Diff({ change, onOpenFile }: { change: FileChange; onOpenFile?: OpenFile }) {
  const scheme = useChatTheme();
  const patch = patchFor(change.file, change.patch);
  return <div className="oc-diff">
    <header>
      <span className="oc-diff-file">{shortPath(change.file)}</span>
      <span className="oc-diff-stat"><span data-line="add">+{change.additions}</span> <span data-line="del">−{change.deletions}</span></span>
      {onOpenFile && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenFile(change.file)}>Open</Button>}
    </header>
    <div className="oc-diff-body"><Suspense fallback={<PlainPatch patch={patch} />}><PatchDiff patch={patch} scheme={scheme} /></Suspense></div>
  </div>;
}

function Arguments({ input }: { input: Fields }) {
  const entries = Object.entries(input);
  if (!entries.length) return null;
  return <dl className="oc-fields">{entries.map(([key, value]) => <div key={key}>
    <dt>{key}</dt>
    <dd>{typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : Array.isArray(value) ? plural(value.length, "item") : value === null ? "none" : `${Object.keys(value as object).length} fields`}</dd>
  </div>)}</dl>;
}

function ToolBody({ part, onOpenFile }: { part: ToolPart; onOpenFile?: OpenFile }) {
  const input = inputOf(part), output = outputOf(part), path = pathOf(input);
  const open = path && onOpenFile && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenFile(path)}>Open {shortPath(path)}</Button>;
  if (part.name === "shell") {
    const command = text(input.command) ?? text(metadataOf(part).command) ?? "";
    return <div className="oc-console">
      <div className="oc-console-command"><pre className="oc-pre">$ {command}</pre><CopyButton text={command} label="Copy command" /></div>
      {output && <Output text={output} />}
    </div>;
  }
  if (part.name === "edit" || part.name === "write" || part.name === "patch") {
    const changes = changesOf(part);
    if (changes.length) return <>{changes.map((change, index) => <Diff key={index} change={change} onOpenFile={onOpenFile} />)}</>;
    // No diff reported (the call failed, or is still running): what was asked for.
    const before = text(input.oldString), after = text(input.newString) ?? text(input.content);
    const lines = (mark: string, value: string | undefined) => (value ?? "").split("\n").filter((line, index, all) => line || index < all.length - 1).map(line => `${mark}${line}`);
    return <>{open}{(before || after) ? <PlainPatch patch={[...lines("-", before), ...lines("+", after)].join("\n")} /> : output && <Output text={output} />}</>;
  }
  if (part.name === "read") return <>{open}{output && <Output text={output} />}</>;
  return <><Arguments input={input} />{output && <Output text={output} />}</>;
}

/** What a running call has to show without being opened. */
function liveBody(part: ToolPart): ReactNode {
  if (!isRunning(part)) return null;
  const metadata = metadataOf(part);
  const progress = text(metadata.output) ?? text(metadata.stdout) ?? outputOf(part);
  const command = part.name === "shell" ? text(inputOf(part).command) : undefined;
  if (!command && !progress) return null;
  const multiline = command?.includes("\n");
  if (!multiline && !progress) return null;
  return <div className="oc-console oc-console-live">
    {multiline && <pre className="oc-pre">$ {command}</pre>}
    {progress && <Output text={progress} lines={8} tail />}
  </div>;
}

export const ToolRow = memo(function ToolRow({ part, onOpenFile }: { part: ToolPart; onOpenFile?: OpenFile }) {
  const [opened, setOpened] = useState<boolean>();
  const summary = summarise(part), running = isRunning(part), failed = part.state.status === "error";
  const Icon = failed ? CircleAlert : running ? LoaderCircle : icons[kindOf(part)];
  const live = liveBody(part);
  const open = opened ?? false;
  return <div className="oc-tool" data-status={part.state.status} data-tool={part.name}>
    <button type="button" className="oc-tool-head" aria-expanded={open} onClick={() => setOpened(!open)}>
      <Icon aria-hidden="true" className={running ? "oc-spin" : undefined} />
      <span className="oc-tool-verb">{summary.verb}</span>
      {summary.subject && <code className="oc-tool-subject">{summary.subject}</code>}
      {summary.extra && <span className="oc-tool-extra">{summary.extra}</span>}
      <ChevronRight aria-hidden="true" className="oc-chevron" />
    </button>
    {failed && "error" in part.state && <p className="oc-tool-error" role="alert">{part.state.error.message}</p>}
    {open ? <div className="oc-tool-body"><ToolBody part={part} onOpenFile={onOpenFile} /></div> : live && <div className="oc-tool-body">{live}</div>}
  </div>;
});

export const ToolRun = memo(function ToolRun({ parts, onOpenFile }: { parts: readonly ToolPart[]; onOpenFile?: OpenFile }) {
  const [open, setOpen] = useState(false);
  const { label, kind } = countLabel(parts);
  const Icon = kind === "other" ? ListTree : icons[kind];
  return <div className="oc-tool oc-tool-run" data-count={parts.length}>
    <button type="button" className="oc-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon aria-hidden="true" />
      <span className="oc-tool-verb">{label}</span>
      <ChevronRight aria-hidden="true" className="oc-chevron" />
    </button>
    {open && <div className="oc-tool-list">{parts.map(part => <ToolRow key={part.id} part={part} onOpenFile={onOpenFile} />)}</div>}
  </div>;
});
