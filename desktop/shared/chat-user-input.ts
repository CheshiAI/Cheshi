export type ChatInputValue = string | number | boolean | string[];
export type ChatInputQuestion = {
  id: string; header: string; question: string; isOther: boolean; isSecret: boolean;
  options: { label: string; description: string }[] | null;
};
export type ChatInputField = {
  name: string; title: string; description: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean; options?: { value: string; label: string }[]; default?: ChatInputValue;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; format?: string;
};
type RequestIdentity = { id: string; threadId: string; turnId: string | null };
export type ChatUserInputRequest = RequestIdentity & (
  | { kind: 'questions'; isBlocking: boolean; questions: ChatInputQuestion[] }
  | { kind: 'form'; serverName: string; message: string; fields: ChatInputField[]; unsupportedReason?: string }
  | { kind: 'url'; serverName: string; message: string; url: string; elicitationId: string }
);
export type ChatUserInputResponse = {
  action: 'accept' | 'decline' | 'cancel';
  answers?: Record<string, string[]>;
  content?: Record<string, ChatInputValue>;
};
export function inputRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function chatUserInputResponse(value: unknown): ChatUserInputResponse {
  const record = inputRecord(value);
  if (!record || (record.action !== 'accept' && record.action !== 'decline' && record.action !== 'cancel')) throw new TypeError('The input response action is invalid.');
  const response: ChatUserInputResponse = { action: record.action as ChatUserInputResponse['action'] };
  if (record.answers !== undefined) {
    const answers = inputRecord(record.answers);
    if (!answers || Object.values(answers).some(value => !Array.isArray(value) || value.some(answer => typeof answer !== 'string'))) {
      throw new TypeError('Question answers must be lists of text.');
    }
    response.answers = answers as Record<string, string[]>;
  }
  if (record.content !== undefined) {
    const content = inputRecord(record.content);
    if (!content || Object.values(content).some(value => !(typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(item => typeof item === 'string'))))) {
      throw new TypeError('The form response contains an invalid value.');
    }
    response.content = content as Record<string, ChatInputValue>;
  }
  if (JSON.stringify(response).length > 1_000_000) throw new TypeError('The input response is too large.');
  return response;
}

/** Validate normalized IPC events without exposing the original server envelope. */
export function chatUserInputRequest(value: unknown): ChatUserInputRequest | null {
  const request = inputRecord(value);
  if (!request || typeof request.id !== 'string' || !request.id || typeof request.threadId !== 'string' || !request.threadId
    || (request.turnId !== null && typeof request.turnId !== 'string')) return null;
  if (request.kind === 'questions') {
    if (typeof request.isBlocking !== 'boolean' || !Array.isArray(request.questions)) return null;
    for (const value of request.questions) {
      const question = inputRecord(value);
      if (!question || ['id', 'header', 'question'].some(key => typeof question[key] !== 'string')
        || typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean') return null;
      if (question.options !== null && (!Array.isArray(question.options) || question.options.some(value => {
        const option = inputRecord(value);
        return !option || typeof option.label !== 'string' || typeof option.description !== 'string';
      }))) return null;
    }
  } else {
    if (typeof request.serverName !== 'string' || typeof request.message !== 'string') return null;
    if (request.kind === 'url') {
      if (typeof request.url !== 'string' || typeof request.elicitationId !== 'string') return null;
      try { if (!['https:', 'http:'].includes(new URL(request.url).protocol)) return null; } catch { return null; }
    } else if (request.kind === 'form') {
      if (request.unsupportedReason !== undefined && typeof request.unsupportedReason !== 'string') return null;
      if (!Array.isArray(request.fields) || request.fields.some(value => {
        const field = inputRecord(value);
        return !field || ['name', 'title', 'description'].some(key => typeof field[key] !== 'string') || typeof field.required !== 'boolean'
          || !['string', 'number', 'integer', 'boolean', 'array'].includes(String(field.type))
          || (field.options !== undefined && (!Array.isArray(field.options) || field.options.some(value => {
            const option = inputRecord(value); return !option || typeof option.value !== 'string' || typeof option.label !== 'string';
          })));
      })) return null;
    } else return null;
  }
  return request as ChatUserInputRequest;
}
