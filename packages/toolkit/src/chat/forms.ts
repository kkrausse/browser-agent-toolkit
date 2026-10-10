import type { FormInfo } from "./vendor/types";
import type { QuestionRequest, QuestionAnswers } from "./types";

/** Only the exact question-tool projection in beta-19425 is representable by
 * the legacy question UI. Do not discard constraints from arbitrary forms. */
export function questionFromForm(form: FormInfo): QuestionRequest | undefined {
  if (form.metadata?.kind !== "question" || !form.fields.length) return;
  const questions: QuestionRequest["questions"] = [];
  for (const [index, field] of form.fields.entries()) {
    if ((field.type !== "string" && field.type !== "multiselect") ||
        field.key !== `q${index}` || !field.options?.length ||
        field.options.some(o => o.value !== o.label) ||
        Object.keys(field).some(key => !["key", "title", "description", "type", "options", "custom"].includes(key))) return;
    questions.push({ header: field.title ?? "Question", question: field.description ?? "",
      options: field.options.map(o => ({ label: o.label, description: o.description ?? "" })),
      multiple: field.type === "multiselect", custom: field.custom === true });
  }
  const tool = form.metadata?.tool;
  return { id: form.id, sessionID: form.sessionID, questions,
    ...(tool && typeof tool === "object" && !Array.isArray(tool) &&
      typeof tool.messageID === "string" && typeof tool.id === "string"
      ? { tool: { messageID: tool.messageID, id: tool.id } } : {}) };
}

export function formAnswer(request: QuestionRequest, answers: QuestionAnswers) {
  return Object.fromEntries(answers.map((answer, index) =>
    [`q${index}`, request.questions[index]!.multiple ? answer : answer[0]!]));
}
