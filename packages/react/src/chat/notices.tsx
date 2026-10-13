// The transcript's lines that are not conversation: a run that stopped or failed, a retry,
// a compaction, a change of model. Each is a sentence; none prints the event behind it.
import { memo, useState, type ReactNode } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import type { ChatController, Message, StructuredError } from "@kkrausse/browser-agent-toolkit/browser";
import { clock, useChatState } from "./hooks";
import type { Retry } from "./layout";
import { Markdown } from "./markdown";
import { Output } from "./tools";

function Line({ children, tone, label }: { children: ReactNode; tone?: "danger" | "warn"; label?: string }) {
  return <div className="oc-notice" data-tone={tone} role="status" aria-label={label}><span>{children}</span></div>;
}

/** A provider's error: its message, with the response behind it on request. */
export function ErrorNotice({ error, title = "The model request failed" }: { error: StructuredError; title?: string }) {
  const [open, setOpen] = useState(false);
  const body = error.response?.body?.trim();
  return <div className="oc-alert" role="alert">
    <CircleAlert aria-hidden="true" />
    <div>
      <strong>{title}{error.status ? ` (HTTP ${error.status})` : ""}</strong>
      <p>{error.message}</p>
      {body && body !== error.message && <>
        <button type="button" className="oc-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the response" : "Show the response"}</button>
        {open && <Output text={body} />}
      </>}
    </div>
  </div>;
}

/** The step failed and waits to be tried again: which attempt, and the moment of the next. */
export function RetryNotice({ retry }: { retry: Retry }) {
  return <div className="oc-alert" data-tone="warn" role="status">
    <RotateCw aria-hidden="true" />
    <div>
      <strong>The request failed. Attempt {retry.attempt} starts at {clock(retry.at)}.</strong>
      <p>{retry.error.message}</p>
    </div>
  </div>;
}

const modelLabel = (controller: ChatController, ref: { id: string; providerID: string; variant?: string }) => {
  const model = controller.store.get().models.find(item => item.id === ref.id && item.providerID === ref.providerID);
  return `${model?.name ?? ref.id}${ref.variant ? ` (${ref.variant})` : ""}`;
};

export const Notice = memo(function Notice({ controller, message }: { controller: ChatController; message: Message }) {
  // The catalog may arrive after the transcript: the model's name is read when it does.
  useChatState(controller, state => state.models);
  switch (message.type) {
    case "idle":
      return message.outcome === "interrupted"
        ? <Line label="Run interrupted">Stopped</Line>
        : message.outcome === "failed" ? <Line tone="danger" label="Run failed">The run failed</Line> : null;
    case "model-switched": return <Line label="Model switched">Model changed to {modelLabel(controller, message.model)}</Line>;
    case "agent-switched": return <Line>Agent changed to {message.agent}</Line>;
    case "location-switched": return <Line>Working directory changed{message.subpath ? ` to ${message.subpath}` : ""}</Line>;
    case "skill": return <Line>Loaded the skill {message.name}</Line>;
    case "compaction": return <Compaction message={message} />;
    case "shell": return <div className="oc-console oc-shell-message">
      <pre className="oc-pre">$ {message.command}</pre>
      {message.output?.output && <Output text={message.output.output} />}
      {message.status !== "running" && message.status !== "exited" && <p className="oc-muted">The command was {message.status === "timeout" ? "stopped at its time limit" : "killed"}.</p>}
    </div>;
    case "synthetic": {
      const metadata = message.metadata;
      if (metadata?.source === "subagent")
        return <Line>Subagent {typeof metadata.agent === "string" ? metadata.agent : ""} reported back{typeof metadata.state === "string" ? `: ${metadata.state}` : ""}</Line>;
      return <Line>{message.description || "A message was added for the model"}</Line>;
    }
    default: return null;
  }
});

function Compaction({ message }: { message: Extract<Message, { type: "compaction" }> }) {
  const [open, setOpen] = useState(false);
  if (message.status === "failed") return <ErrorNotice error={message.error} title="The conversation could not be compacted" />;
  if (message.status === "running") return <Line>Compacting the conversation…</Line>;
  return <div className="oc-compaction">
    <Line>Earlier conversation was compacted{message.reason === "auto" ? " to fit the model's context" : ""} · <button type="button" className="oc-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "hide the summary" : "show the summary"}</button></Line>
    {open && <div className="oc-compaction-summary"><Markdown text={message.summary} /></div>}
  </div>;
}
