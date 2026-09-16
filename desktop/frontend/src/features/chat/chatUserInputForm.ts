import type { ChatInputField, ChatInputValue, ChatUserInputRequest, ChatUserInputResponse } from '../../../../shared/chat-user-input';

export type InputDraft = Record<string, string | string[]>;

export function resolvedQuestionDraft(request: ChatUserInputRequest, answers: Record<string, string[]> = {}): { draft: InputDraft; notes: InputDraft } {
  if (request.kind !== 'questions') return { draft: {}, notes: {} };
  const entries = request.questions.map(question => {
    const values = answers[question.id] ?? [];
    const selected = question.options?.find(option => values.includes(option.label))?.label ?? '';
    return { id: question.id, selected, notes: values.filter(value => value !== selected).join('\n\n') };
  });
  return { draft: Object.fromEntries(entries.map(entry => [entry.id, entry.selected])),
    notes: Object.fromEntries(entries.map(entry => [entry.id, entry.notes])) };
}

export function initialInputDraft(request: ChatUserInputRequest): InputDraft {
  if (request.kind !== 'form') return {};
  return Object.fromEntries(request.fields.filter((field) => field.default !== undefined)
    .map((field) => [field.name, Array.isArray(field.default) ? [...field.default] : String(field.default)]));
}

function fieldValue(field: ChatInputField, value: string | string[] | undefined): ChatInputValue | undefined {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    if (field.required) throw new Error(`Enter ${field.title || field.name}.`);
    return undefined;
  }
  if (field.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`Choose values for ${field.title}.`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`Enter a value for ${field.title}.`);
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`Choose a value for ${field.title}.`);
    return value === 'true';
  }
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
      throw new Error(`Enter a valid ${field.type} for ${field.title}.`);
    }
    return number;
  }
  return value;
}

export function inputResponse(request: ChatUserInputRequest, draft: InputDraft, notes: InputDraft = {}): ChatUserInputResponse {
  if (request.kind === 'questions') {
    const answers = Object.fromEntries(request.questions.map((question) => {
      const value = draft[question.id];
      const values = [...new Set([value, notes[question.id]].filter((text): text is string => typeof text === 'string' && Boolean(text.trim())))];
      if (!values.length) throw new Error(`Answer ${question.header || question.question}.`);
      return [question.id, values];
    }));
    return { action: 'accept', answers };
  }
  if (request.kind === 'form') {
    if (request.unsupportedReason) throw new Error(request.unsupportedReason);
    const content = Object.fromEntries(request.fields.flatMap((field) => {
      const value = fieldValue(field, draft[field.name]);
      return value === undefined ? [] : [[field.name, value]];
    }));
    return { action: 'accept', content };
  }
  return { action: 'accept' };
}

export function userInputLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch { return null; }
}
