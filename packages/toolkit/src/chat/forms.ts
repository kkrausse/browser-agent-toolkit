// Forms: what a session asks the user through a structured request. A form has one or more
// fields of type string (free text, or one of `options`), number, integer, boolean,
// multiselect, or external (a URL to open and acknowledge). The question tool's forms are
// one shape of it (`questionFromForm`), kept for the legacy question view.
//
// `validateAnswer` and `isFieldActive` are OpenCode 2.0.26's own rules
// (`packages/core/src/form.ts`, MIT, see ../../NOTICES.md), so an answer is refused here,
// with the field named, for exactly the reasons the server would refuse it.
import type { FormField, FormInfo } from '@opencode/client';
import type { FormAnswer, QuestionRequest, QuestionAnswers } from './types';

type InputField = Exclude<FormField, { type: 'external' }>;
type When = NonNullable<InputField['when']>[number];

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: When, value: FormAnswer[string] | undefined) {
  if (value === undefined) return false;
  const hit = Array.isArray(value) ? value.some(item => item === when.value) : value === when.value;
  return when.op === 'eq' ? hit : !hit;
}
/** Inactive fields are neither required nor answerable: a view hides them. */
export function isFieldActive(field: FormField, answer: FormAnswer): boolean {
  if (field.type === 'external' || !field.when) return true;
  return field.when.every(when => matches(when, answer[when.key]));
}
/** The answer a form starts from: every field's declared default. */
export function defaultAnswer(form: Pick<FormInfo, 'fields'>): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of form.fields) {
    if (field.type === 'external' || field.default === undefined) continue;
    // A number's default may be the JSON spelling of a non-finite value, which no answer may be.
    if ((field.type === 'number' || field.type === 'integer') && typeof field.default !== 'number') continue;
    answer[field.key] = field.default as FormAnswer[string];
  }
  return answer;
}
/** Why the server would refuse the answer; undefined when it would not. */
export function validateAnswer(fields: readonly FormField[], answer: FormAnswer): string | undefined {
  const known = new Map(fields.map(field => [field.key, field] as const));
  for (const key of Object.keys(answer)) if (!known.has(key)) return `Unknown form field: ${key}`;
  for (const field of fields) {
    const value = answer[field.key];
    if (field.type === 'external') {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`;
      continue;
    }
    const active = isFieldActive(field, answer);
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`;
      continue;
    }
    if (!active) return `Form field is not active: ${field.key}`;
    const invalid = validateField(field, value);
    if (invalid) return invalid;
  }
  return undefined;
}
function validateField(field: InputField, value: FormAnswer[string]): string | undefined {
  if (field.type === 'string') {
    if (typeof value !== 'string') return `Expected string for form field: ${field.key}`;
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`;
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`;
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`;
    if (field.pattern !== undefined) {
      try { if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`; }
      catch { return `Form field has invalid pattern: ${field.key}`; }
    }
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `Expected email for form field: ${field.key}`;
    if (field.format === 'uri' && !URL.canParse(value)) return `Expected URI for form field: ${field.key}`;
    if (field.format === 'date' && !isDate(value)) return `Expected date for form field: ${field.key}`;
    if (field.format === 'date-time' && Number.isNaN(new Date(value).getTime())) return `Expected date-time for form field: ${field.key}`;
    if (field.options && !field.custom && !field.options.some(option => option.value === value)) return `Invalid option for form field: ${field.key}`;
    return undefined;
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`;
    if (field.type === 'integer' && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`;
    if (typeof field.minimum === 'number' && value < field.minimum) return `Form field is too small: ${field.key}`;
    if (typeof field.maximum === 'number' && value > field.maximum) return `Form field is too large: ${field.key}`;
    return undefined;
  }
  if (field.type === 'boolean') return typeof value === 'boolean' ? undefined : `Expected boolean for form field: ${field.key}`;
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return `Expected string array for form field: ${field.key}`;
  if (field.required && value.length === 0) return `Missing required form field: ${field.key}`;
  if (field.minItems !== undefined && value.length < field.minItems) return `Too few selections for form field: ${field.key}`;
  if (field.maxItems !== undefined && value.length > field.maxItems) return `Too many selections for form field: ${field.key}`;
  if (!field.custom && value.some(item => !field.options.some(option => option.value === item))) return `Invalid option for form field: ${field.key}`;
  return undefined;
}
function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Only the exact question-tool projection is representable by the legacy question UI.
 * Do not discard constraints from arbitrary forms. */
export function questionFromForm(form: FormInfo): QuestionRequest | undefined {
  if (form.metadata?.kind !== 'question' || !form.fields.length) return;
  const questions: QuestionRequest['questions'] = [];
  for (const [index, field] of form.fields.entries()) {
    if ((field.type !== 'string' && field.type !== 'multiselect') ||
        field.key !== `q${index}` || !field.options?.length ||
        field.options.some(o => o.value !== o.label) ||
        Object.keys(field).some(key => !['key', 'title', 'description', 'type', 'options', 'custom'].includes(key))) return;
    questions.push({ header: field.title ?? 'Question', question: field.description ?? '',
      options: field.options.map(o => ({ label: o.label, description: o.description ?? '' })),
      multiple: field.type === 'multiselect', custom: field.custom === true });
  }
  const tool = form.metadata?.tool;
  return { id: form.id, sessionID: form.sessionID, questions,
    ...(tool && typeof tool === 'object' && !Array.isArray(tool) &&
      typeof tool.messageID === 'string' && typeof tool.id === 'string'
      ? { tool: { messageID: tool.messageID, id: tool.id } } : {}) };
}

export function formAnswer(request: QuestionRequest, answers: QuestionAnswers): FormAnswer {
  return Object.fromEntries(answers.map((answer, index) =>
    [`q${index}`, request.questions[index]!.multiple ? answer : answer[0]!]));
}
