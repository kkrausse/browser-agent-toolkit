// What a session asks the user: a permission, or a form. Requests of subagent sessions are
// shown with the same cards as the conversation's own, and say which subagent asks.
import { useState, type ReactNode } from "react";
import { Bot, ExternalLink, ShieldQuestion } from "lucide-react";
import {
  defaultAnswer, isFieldActive, validateAnswer,
  type ChatController, type FormAnswer, type FormField, type FormInfo, type PermissionRequest, type RequestState,
} from "@kkrausse/browser-agent-toolkit/browser";
import { run, useChatState } from "./hooks";
import { Button } from "./ui/button";
import { Checkbox, ChoiceGroup } from "./ui/choice-group";
import { Input } from "./ui/input";

/** "Subagent explore: Find the heading" when the request is not the conversation's own. */
function Asker({ controller, sessionID }: { controller: ChatController; sessionID: string }) {
  const label = useChatState(controller, state => {
    const session = state.sessions[sessionID];
    if (!session?.parentID || sessionID === state.sessionID) return undefined;
    const agent = session.info?.agent, title = session.info?.title;
    return `Subagent${agent ? ` ${agent}` : ""}${title ? `: ${title}` : ""}`;
  });
  return label ? <p className="oc-asker"><Bot aria-hidden="true" />{label}</p> : null;
}

export function PermissionCard({ controller, entry }: { controller: ChatController; entry: RequestState<PermissionRequest> }) {
  const { request } = entry;
  return <section className="oc-request" aria-label="Permission request">
    <Asker controller={controller} sessionID={request.sessionID} />
    <strong className="oc-request-title"><ShieldQuestion aria-hidden="true" />Allow {request.action}?</strong>
    {request.message && <p>{request.message}</p>}
    {request.resources.length > 0 && <pre className="oc-pre oc-request-resources">{request.resources.join("\n")}</pre>}
    <div className="oc-actions">
      {([["once", "Allow once"], ["always", "Always allow"], ["reject", "Reject"]] as const).map(([decision, label]) =>
        <Button key={decision} variant={decision === "once" ? "default" : "outline"} disabled={entry.submitting} onClick={() => run(controller.replyPermission(request.id, decision))}>{label}</Button>)}
    </div>
    {entry.error && <p role="alert" className="oc-field-error">{entry.error}. Choose again to retry.</p>}
  </section>;
}

type Value = FormAnswer[string] | undefined;
const titleOf = (field: FormField) => field.title || field.key;

function Field({ field, value, disabled, onChange }: { field: FormField; value: Value; disabled: boolean; onChange(value: Value): void }) {
  const label = titleOf(field);
  let control: ReactNode;
  if (field.type === "external") {
    control = <>
      <a className="oc-external" href={field.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{field.url}</a>
      <label className="oc-option"><Checkbox checked={value === true} disabled={disabled} onCheckedChange={checked => onChange(checked ? true : undefined)} /><span>I have done this</span></label>
    </>;
  } else if (field.type === "boolean") {
    return <div className="oc-field">
      <label className="oc-option"><Checkbox checked={value === true} disabled={disabled} onCheckedChange={checked => onChange(checked)} />
        <span>{label}{field.required && <em aria-hidden="true"> *</em>}{field.description && <small>{field.description}</small>}</span></label>
    </div>;
  } else if (field.type === "number" || field.type === "integer") {
    control = <Input type="number" inputMode={field.type === "integer" ? "numeric" : "decimal"} step={field.type === "integer" ? 1 : "any"} aria-label={label} disabled={disabled}
      min={typeof field.minimum === "number" ? field.minimum : undefined} max={typeof field.maximum === "number" ? field.maximum : undefined}
      value={typeof value === "number" ? String(value) : ""} onChange={event => onChange(event.target.value === "" || Number.isNaN(event.target.valueAsNumber) ? undefined : event.target.valueAsNumber)} />;
  } else if (field.type === "multiselect" || field.options?.length) {
    const multiple = field.type === "multiselect";
    const chosen = multiple ? (Array.isArray(value) ? value : []) : typeof value === "string" ? [value] : [];
    const offered = field.options ?? [];
    const custom = chosen.filter(item => !offered.some(option => option.value === item));
    control = <>
      <ChoiceGroup label={label} name={field.key} options={offered} multiple={multiple} disabled={disabled}
        value={chosen.filter(item => !custom.includes(item))}
        onValueChange={next => onChange(multiple ? [...next, ...custom] : next[0])} />
      {field.custom && <Input aria-label={`${label}: another answer`} placeholder="Another answer" disabled={disabled} value={custom[0] ?? ""}
        onChange={event => {
          const typed = event.target.value;
          if (multiple) onChange([...chosen.filter(item => !custom.includes(item)), ...(typed ? [typed] : [])]);
          else onChange(typed || undefined);
        }} />}
    </>;
  } else {
    const type = field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : "text";
    control = <Input type={type} aria-label={label} placeholder={field.placeholder} disabled={disabled} minLength={field.minLength} maxLength={field.maxLength}
      value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value === "" ? undefined : event.target.value)} />;
  }
  return <div className="oc-field">
    <span className="oc-field-label">{label}{"required" in field && field.required && <em aria-hidden="true"> *</em>}</span>
    {field.description && <small className="oc-field-description">{field.description}</small>}
    {control}
  </div>;
}

/** Any form: every field type, the fields a `when` hides left out, the answer checked by
 * the server's own rules before it is sent. */
export function FormCard({ controller, entry }: { controller: ChatController; entry: RequestState<FormInfo> }) {
  const form = entry.request;
  const [answer, setAnswer] = useState<FormAnswer>(() => defaultAnswer(form));
  const [invalid, setInvalid] = useState<string>();
  // A hidden field keeps no answer: the server refuses one for a field that is not active.
  const settle = (next: FormAnswer): FormAnswer => {
    for (;;) {
      const inactive = form.fields.filter(field => field.key in next && !isFieldActive(field, next));
      if (!inactive.length) return next;
      next = Object.fromEntries(Object.entries(next).filter(([key]) => !inactive.some(field => field.key === key)));
    }
  };
  const change = (key: string, value: Value) => {
    setInvalid(undefined);
    setAnswer(current => {
      const { [key]: _old, ...rest } = current;
      return settle(value === undefined ? rest : { ...rest, [key]: value });
    });
  };
  const submit = () => {
    const problem = validateAnswer(form.fields, answer);
    // The rule names the field by its key; the user knows it by its title.
    if (problem) { setInvalid(form.fields.reduce((message, field) => message.replace(new RegExp(`: ${field.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), `: ${titleOf(field)}`), problem)); return; }
    run(controller.replyForm(form.id, answer));
  };
  return <form className="oc-request" noValidate aria-label={form.title || "Question"} onSubmit={event => { event.preventDefault(); submit(); }}>
    <Asker controller={controller} sessionID={form.sessionID} />
    {form.title && <strong className="oc-request-title">{form.title}</strong>}
    {form.fields.filter(field => field.type === "external" || (!field.hidden && isFieldActive(field, answer))).map(field =>
      <Field key={field.key} field={field} value={answer[field.key]} disabled={entry.submitting} onChange={value => change(field.key, value)} />)}
    {invalid && <p role="alert" className="oc-field-error">{invalid}</p>}
    {entry.error && <p role="alert" className="oc-field-error">{entry.error}. You can send it again.</p>}
    <div className="oc-actions">
      <Button type="submit" variant="default" disabled={entry.submitting}>{entry.submitting ? "Sending…" : "Send answer"}</Button>
      <Button type="button" disabled={entry.submitting} onClick={() => run(controller.cancelForm(form.id))}>Dismiss</Button>
    </div>
  </form>;
}
