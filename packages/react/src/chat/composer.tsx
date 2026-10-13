// The composer: the draft and its attachments, the prompts waiting behind a run, how a
// prompt sent during a run is delivered, the model, and send or stop.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import {
  canSend, isPreparing, maxAttachmentBytes, maxPromptAttachmentBytes,
  type ChatController, type ChatSnapshot, type Delivery, type PendingPrompt,
} from "@kkrausse/browser-agent-toolkit/browser";
import { formatBytes, run, useChatSnapshot } from "./hooks";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ui/select";
import { Textarea } from "./ui/textarea";

interface Attached { id: number; file: File; preview?: string }
let nextAttachment = 0;
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The files of one draft. Each is checked against the caps when it is added, so a file
 * that cannot be sent is refused with its reason instead of failing the send. */
function useAttachments() {
  const [items, setItems] = useState<Attached[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const all = useRef(items); all.current = items;
  useEffect(() => () => { for (const item of all.current) if (item.preview) URL.revokeObjectURL(item.preview); }, []);
  const add = (files: Iterable<File>) => {
    const next = [...all.current], reasons: string[] = [];
    let total = next.reduce((sum, item) => sum + item.file.size, 0);
    for (const file of files) {
      if (file.size > maxAttachmentBytes) reasons.push(`${file.name} is ${mib(file.size)}: a file may be at most ${mib(maxAttachmentBytes)}.`);
      else if (total + file.size > maxPromptAttachmentBytes) reasons.push(`${file.name} does not fit: the files of one message may be at most ${mib(maxPromptAttachmentBytes)} together.`);
      else {
        total += file.size;
        next.push({ id: ++nextAttachment, file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined });
      }
    }
    all.current = next;
    setItems(next);
    setRefused(reasons);
  };
  const remove = (id: number) => {
    const item = all.current.find(entry => entry.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    setItems(all.current = all.current.filter(entry => entry.id !== id));
  };
  // After a send the previews stay valid for the page: the sent message shows its own copy.
  const clear = () => { setItems(all.current = []); setRefused([]); };
  return { items, refused, add, remove, clear, dismiss: () => setRefused([]) };
}

const waiting: Record<PendingPrompt["status"], string> = {
  sending: "Sending",
  starting: "Next",
  steering: "Joins the run at its next step",
  queued: "Queued until the run ends",
  stranded: "Not delivered: the run ended first",
};
/** The prompts the server holds and has not given to the run, each with a way to withdraw it. */
function Queue({ controller, pending }: { controller: ChatController; pending: readonly PendingPrompt[] }) {
  if (!pending.length) return null;
  return <ul className="oc-queue" aria-label="Waiting messages">
    {pending.map(prompt => <li key={prompt.id}>
      <span className="oc-queue-text">{prompt.text || "Files"}</span>
      <span className="oc-queue-status">{waiting[prompt.status]}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel this message" title="Cancel this message" disabled={prompt.status === "sending"}
        onClick={() => run(controller.cancelQueued(prompt.id, prompt.sessionID))}><X aria-hidden="true" /></Button>
    </li>)}
  </ul>;
}

const modelKey = (model: { providerID: string; id: string }) => JSON.stringify([model.providerID, model.id]);
/** Models by provider. A change during a run applies from the run's next step. */
export function ModelPicker({ controller, state }: { controller: ChatController; state: ChatSnapshot }) {
  const fallback = state.defaultModel;
  const name = (ref: { providerID: string; id: string } | undefined) => ref && (state.models.find(model => model.id === ref.id && model.providerID === ref.providerID)?.name ?? ref.id);
  return <ChoiceSelect label="Model" className="oc-model"
    disabled={!state.sessionID || state.connection !== "connected" || !!state.held || !!state.sessionOperationPending}
    value={state.model ? modelKey(state.model) : ""}
    placeholder={fallback ? name(fallback) : state.connection === "connecting" ? "Model…" : "No model"}
    onValueChange={value => { const [providerID, id] = JSON.parse(value) as [string, string]; run(controller.selectModel({ providerID, id })); }}
    items={state.models.filter(model => model.enabled || (state.model && modelKey(model) === modelKey(state.model)))
      .map(model => ({ value: modelKey(model), label: model.name, group: model.providerID }))} />;
}

export function Composer({ controller, showModels = true }: { controller: ChatController; showModels?: boolean }) {
  return <SessionComposer key={controllerIdentity(controller)} controller={controller} showModels={showModels} />;
}
function SessionComposer({ controller, showModels }: { controller: ChatController; showModels: boolean }) {
  const state = useChatSnapshot(controller);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [delivery, setDelivery] = useState<Delivery>("steer");
  const [failure, setFailure] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const attachments = useAttachments();
  const form = useRef<HTMLFormElement>(null), picker = useRef<HTMLInputElement>(null), area = useRef<HTMLTextAreaElement>(null);
  const key = state.draftKey ?? state.sessionID ?? "none";
  const text = drafts[key] ?? "";
  const ready = canSend(state), preparing = isPreparing(state);
  const busy = (state.execution === "running" || state.execution === "retrying") && !!state.sessionID;
  const hasContent = !!text.trim() || attachments.items.length > 0;
  // A send asked for while the chat is still preparing. The controller never queues
  // (it rejects until ready), so the intent is parked here, visibly, and delivered
  // once. It names the draft it was made for: other text or another chat is not it.
  const [queued, setQueued] = useState<{ key: string; text: string }>();
  const delivered = useRef<object>(undefined);
  const parked = !!queued && queued.key === key && queued.text === text;
  const deliver = (draft: string) => {
    const files = attachments.items.map(item => ({ name: item.file.name, data: item.file, mime: item.file.type || undefined }));
    setFailure(undefined);
    void controller.send({ text: draft, files, delivery: busy ? delivery : undefined }).then(
      () => {
        setDrafts(current => (current[key] === draft ? { ...current, [key]: "" } : current));
        attachments.clear();
      },
      // The draft and its files stay; why it was not sent is said beside them.
      error => setFailure(error instanceof Error ? error.message : String(error)),
    );
  };
  const send = () => {
    // While a send is parked the effect below owns its delivery: a repeated Enter
    // must neither park again nor race it with a second send.
    if (!hasContent || parked) return;
    if (preparing) setQueued({ key, text });
    else if (ready) deliver(text);
  };
  useEffect(() => {
    if (!queued || (parked && preparing)) return;
    // Preparation is over, or the parked draft is no longer the one on screen. Send
    // only into a ready chat; anything else leaves the text in the composer.
    setQueued(undefined);
    if (parked && ready && delivered.current !== queued) { delivered.current = queued; deliver(queued.text); }
  });
  // The text area is as tall as its text, up to a limit.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);
  // Files dropped anywhere on the chat are for the composer.
  useEffect(() => {
    const target: HTMLElement | null = form.current?.closest<HTMLElement>(".oc-chat") ?? form.current;
    if (!target) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth++; setDragging(true); } };
    const leave = (event: DragEvent) => { if (hasFiles(event) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer?.files.length) attachments.add(event.dataTransfer.files);
    };
    target.addEventListener("dragenter", enter); target.addEventListener("dragleave", leave);
    target.addEventListener("dragover", over); target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragenter", enter); target.removeEventListener("dragleave", leave);
      target.removeEventListener("dragover", over); target.removeEventListener("drop", drop);
    };
  }, []);
  return <form ref={form} className="oc-composer" data-dragging={dragging || undefined} onSubmit={event => { event.preventDefault(); send(); }}>
    <Queue controller={controller} pending={state.pending.filter(prompt => prompt.status !== "sending" && prompt.status !== "starting")} />
    <div className="oc-composer-box">
      {attachments.items.length > 0 && <div className="oc-chips">
        {attachments.items.map(item => <span className="oc-chip" key={item.id} title={item.file.name}>
          {item.preview ? <img src={item.preview} alt="" /> : <FileText aria-hidden="true" />}
          <span className="oc-chip-name">{item.file.name}</span>
          <span className="oc-chip-size">{formatBytes(item.file.size)}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${item.file.name}`} onClick={() => attachments.remove(item.id)}><X aria-hidden="true" /></Button>
        </span>)}
      </div>}
      {(attachments.refused.length > 0 || failure) && <div className="oc-refused" role="alert">
        <div>{attachments.refused.map((reason, index) => <p key={index}>{reason}</p>)}{failure && <p>Not sent: {failure}</p>}</div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => { attachments.dismiss(); setFailure(undefined); }}><X aria-hidden="true" /></Button>
      </div>}
      <Textarea ref={area} rows={1} aria-label="Message OpenCode"
        placeholder={dragging ? "Drop files to attach them" : busy ? (delivery === "steer" ? "Steer the run…" : "Queue a message…") : "Message OpenCode…"}
        value={text}
        onChange={event => {
          // Editing withdraws a parked send: text still being changed is never sent.
          setQueued(undefined);
          setDrafts(current => ({ ...current, [key]: event.target.value }));
        }}
        onPaste={event => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          attachments.add(files);
        }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            send();
          }
        }} />
      <div className="oc-composer-bar">
        <input ref={picker} type="file" multiple hidden onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}><Paperclip aria-hidden="true" /></Button>
        {showModels && <ModelPicker controller={controller} state={state} />}
        <span className="oc-composer-space" />
        {parked && <small role="status">Sends when the chat is ready</small>}
        {busy && <div className="oc-delivery" role="group" aria-label="While the run is going">
          {(["steer", "queue"] as const).map(mode => <Button key={mode} type="button" variant="ghost" size="sm" aria-pressed={delivery === mode}
            title={mode === "steer" ? "The message joins the run at its next step" : "The message waits until the run has ended"}
            onClick={() => setDelivery(mode)}>{mode === "steer" ? "Steer" : "Queue"}</Button>)}
        </div>}
        {parked
          ? <Button type="button" onClick={() => setQueued(undefined)}>Cancel send</Button>
          : <Button variant="default" size="icon" type="submit" disabled={(!ready && !preparing) || !hasContent}
              aria-label={busy ? (delivery === "steer" ? "Steer" : "Queue") : state.sending ? "Sending" : "Send"} title={busy ? (delivery === "steer" ? "Steer the run" : "Queue the message") : "Send"}>
              <ArrowUp aria-hidden="true" />
            </Button>}
        {busy && <Button type="button" variant="danger" disabled={state.connection !== "connected"}
          title={state.interruptRequested ? "Stop was requested and the run has not stopped yet. Press to ask again." : "Stop the run"}
          onClick={() => run(controller.interrupt())}>
          <Square aria-hidden="true" />{state.interruptRequested ? "Stopping…" : "Stop"}
        </Button>}
      </div>
    </div>
  </form>;
}
// Controller changes (e.g. workspace switches) must never inherit draft text.
const controllerIdentities = new WeakMap<ChatController, number>();
let nextControllerIdentity = 0;
function controllerIdentity(controller: ChatController) {
  let identity = controllerIdentities.get(controller);
  if (identity === undefined) controllerIdentities.set(controller, identity = ++nextControllerIdentity);
  return identity;
}
