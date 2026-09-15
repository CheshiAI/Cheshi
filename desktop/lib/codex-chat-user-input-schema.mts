import { inputRecord } from '../shared/chat-user-input.ts';
import type { ChatInputField, ChatInputQuestion, ChatUserInputRequest, ChatUserInputResponse } from '../shared/chat-user-input.ts';

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function assertSupportedKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('This form contains unsupported schema constraints.');
}
const FIELD_KEYS: Record<ChatInputField['type'], string[]> = {
  string: ['minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf'],
  number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'], boolean: [], array: ['items', 'minItems', 'maxItems'],
};
function choices(value: unknown, labels?: unknown): { value: string; label: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError('Unsupported form choices.');
  return value.map((item, index) => {
    if (typeof item === 'string') return { value: item, label: Array.isArray(labels) ? text(labels[index]) || item : item };
    const option = inputRecord(item);
    if (!option || typeof option.const !== 'string') throw new TypeError('Unsupported form choices.');
    assertSupportedKeys(option, ['const', 'title']);
    return { value: option.const, label: text(option.title) || option.const };
  });
}
function formFields(value: unknown): ChatInputField[] {
  const schema = inputRecord(value);
  const properties = inputRecord(schema?.properties);
  if (!schema || schema.type !== 'object' || !properties) throw new TypeError('This form uses an unsupported schema.');
  assertSupportedKeys(schema, ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties']);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new TypeError('This form allows unsupported additional fields.');
  if (schema.required != null && !Array.isArray(schema.required)) throw new TypeError('This form has invalid required fields.');
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name))) throw new TypeError('This form has invalid required fields.');
  return Object.entries(properties).map(([name, value]) => {
    const property = inputRecord(value);
    if (!property || !['string', 'number', 'integer', 'boolean', 'array'].includes(text(property.type))) {
      throw new TypeError('This form contains unsupported nested or complex fields.');
    }
    const field: ChatInputField = { name, title: text(property.title) || name, description: text(property.description),
      type: property.type as ChatInputField['type'], required: required.includes(name) };
    assertSupportedKeys(property, ['type', 'title', 'description', 'default', ...FIELD_KEYS[field.type]]);
    if (property.format != null && !['email', 'uri', 'date', 'date-time'].includes(text(property.format))) throw new TypeError('This form uses an unsupported text format.');
    if (property.enum !== undefined && property.oneOf !== undefined) throw new TypeError('This form contains overlapping selection constraints.');
    const items = inputRecord(property.items);
    if (items) {
      assertSupportedKeys(items, ['type', 'enum', 'anyOf']);
      if ((items.type !== undefined && items.type !== 'string') || (items.enum !== undefined && items.anyOf !== undefined)) throw new TypeError('This form contains unsupported array choices.');
    }
    const options = field.type === 'array' ? choices(items?.enum ?? items?.anyOf) : choices(property.enum ?? property.oneOf, property.enumNames);
    if (field.type === 'array' && !options) throw new TypeError('This form contains an unsupported array field.');
    if (options) field.options = options;
    for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
      const limit = property[key];
      if (limit == null) continue;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || (!['minimum', 'maximum'].includes(key) && (!Number.isInteger(limit) || limit < 0))) throw new TypeError('This form has an invalid bound.');
      field[key] = limit;
    }
    if (typeof property.format === 'string') field.format = property.format;
    const defaultValue = property.default;
    if (typeof defaultValue === 'string' || typeof defaultValue === 'boolean' || (typeof defaultValue === 'number' && Number.isFinite(defaultValue))
      || (Array.isArray(defaultValue) && defaultValue.every(item => typeof item === 'string'))) field.default = defaultValue;
    return field;
  });
}
export function userInputRequest(id: string, method: string, params: Record<string, unknown>): ChatUserInputRequest {
  const threadId = text(params.threadId);
  if (!threadId) throw new TypeError('The input request has no thread.');
  const identity = { id, threadId, turnId: text(params.turnId) || null };
  if (method === 'item/tool/requestUserInput') {
    if (!Array.isArray(params.questions)) throw new TypeError('The input questions are invalid.');
    const seen = new Set<string>();
    const questions: ChatInputQuestion[] = params.questions.map(value => {
      const question = inputRecord(value);
      const id = text(question?.id);
      if (!question || !id || seen.has(id) || typeof question.question !== 'string') throw new TypeError('The input question is invalid.');
      seen.add(id);
      const options = Array.isArray(question.options) ? question.options.map(value => {
        const option = inputRecord(value);
        if (!option || typeof option.label !== 'string') throw new TypeError('The input option is invalid.');
        return { label: option.label, description: text(option.description) };
      }) : null;
      return { id, header: text(question.header), question: question.question, isOther: question.isOther === true, isSecret: question.isSecret === true, options };
    });
    return { ...identity, kind: 'questions', isBlocking: params.isBlocking === true, questions };
  }
  const common = { ...identity, serverName: text(params.serverName), message: text(params.message) };
  if (params.mode === 'url') {
    const url = new URL(text(params.url));
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('The input URL must use HTTP or HTTPS.');
    return { ...common, kind: 'url', url: url.href, elicitationId: text(params.elicitationId) };
  }
  if (!['form', 'openai/form', 'openaiForm'].includes(text(params.mode))) {
    return { ...common, kind: 'form', fields: [], unsupportedReason: 'This MCP input mode is not supported.' };
  }
  try { return { ...common, kind: 'form', fields: formFields(params.requestedSchema) }; }
  catch (error) { return { ...common, kind: 'form', fields: [], unsupportedReason: error instanceof Error ? error.message : 'Unsupported form.' }; }
}
function assertFormValue(field: ChatInputField, value: unknown) {
  if (value === undefined) {
    if (field.required) throw new TypeError(`${field.title} is required.`);
    return;
  }
  const valid = field.type === 'array' ? Array.isArray(value) && value.every(item => typeof item === 'string')
    : field.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : typeof value === field.type;
  if (!valid) throw new TypeError(`${field.title} has an invalid value.`);
  if (typeof value === 'string') {
    if ((field.minLength !== undefined && [...value].length < field.minLength) || (field.maxLength !== undefined && [...value].length > field.maxLength)) throw new TypeError(`${field.title} has an invalid length.`);
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new TypeError(`${field.title} must be an email address.`);
    if (field.format === 'uri') { try { new URL(value); } catch { throw new TypeError(`${field.title} must be a URL.`); } }
    if (['date', 'date-time'].includes(field.format ?? '') && Number.isNaN(Date.parse(value))) throw new TypeError(`${field.title} must be a date.`);
  }
  if (typeof value === 'number' && ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) throw new TypeError(`${field.title} is out of range.`);
  if (Array.isArray(value) && ((field.minItems !== undefined && value.length < field.minItems) || (field.maxItems !== undefined && value.length > field.maxItems))) throw new TypeError(`${field.title} has an invalid selection count.`);
  if (field.options && (Array.isArray(value) ? value : [value]).some(item => !field.options?.some(option => option.value === item))) throw new TypeError(`${field.title} contains an invalid choice.`);
}
export function userInputResult(request: ChatUserInputRequest, response: ChatUserInputResponse): Record<string, unknown> {
  if (request.kind === 'questions') {
    if (response.action !== 'accept') return { answers: {} };
    const answers = response.answers ?? {};
    if (Object.keys(answers).some(id => !request.questions.some(question => question.id === id))) throw new TypeError('An answer refers to an unknown question.');
    for (const question of request.questions) {
      const values = answers[question.id];
      if (!values?.length || values.some(value => !value.trim())) throw new TypeError(`Answer ${question.header || question.id}.`);
      // Choice labels are suggestions; the question card also accepts custom answers and additional details.
    }
    return { answers: Object.fromEntries(Object.entries(answers).map(([id, answers]) => [id, { answers }])) };
  }
  if (response.action !== 'accept') return { action: response.action };
  if (request.kind === 'url') return { action: 'accept' };
  if (request.unsupportedReason) throw new TypeError(request.unsupportedReason);
  const content = response.content ?? {};
  if (Object.keys(content).some(name => !request.fields.some(field => field.name === name))) throw new TypeError('The form contains an unknown field.');
  for (const field of request.fields) assertFormValue(field, content[field.name]);
  return { action: 'accept', content };
}
