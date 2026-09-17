export interface ChatQuestionDismissal {
  questionId: string;
  turnId?: string | null;
  itemId?: string;
  action: 'skip' | 'close' | 'answered';
  answers?: Record<string, string[]>;
}

export interface ChatQuestionDismissalsApi {
  list(threadId: string): Promise<ChatQuestionDismissal[]>;
  save(threadId: string, record: ChatQuestionDismissal): Promise<ChatQuestionDismissal>;
}

export function questionThreadId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError('Invalid question thread id.');
  return value;
}

export function questionDismissal(value: unknown): ChatQuestionDismissal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid question dismissal.');
  const record = value as Record<string, unknown>;
  if (typeof record.questionId !== 'string' || !record.questionId.trim() || record.questionId.length > 2048
    || !['skip', 'close', 'answered'].includes(record.action as string)) throw new TypeError('Invalid question dismissal.');
  const hasSource = record.turnId !== undefined || record.itemId !== undefined;
  if (hasSource && ((record.turnId !== null && (typeof record.turnId !== 'string' || !record.turnId.trim() || record.turnId.length > 512))
    || typeof record.itemId !== 'string' || !record.itemId.trim() || record.itemId.length > 1024)) throw new TypeError('Invalid question source identity.');
  let answers: Record<string, string[]> | undefined;
  if (record.answers !== undefined) {
    if (record.action !== 'answered' || !record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) {
      throw new TypeError('Invalid saved question answers.');
    }
    const entries = Object.entries(record.answers);
    if (!entries.length || JSON.stringify(record.answers).length > 1_000_000
      || entries.some(([id, values]) => !id.trim() || id.length > 512 || !Array.isArray(values) || !values.length
        || values.some(value => typeof value !== 'string' || !value.trim()))) throw new TypeError('Invalid saved question answers.');
    answers = Object.fromEntries(entries.map(([id, values]) => [id, [...values]]));
  }
  return { questionId: record.questionId, action: record.action as ChatQuestionDismissal['action'],
    ...(answers ? { answers } : {}),
    ...(hasSource ? { turnId: record.turnId as string | null, itemId: record.itemId as string } : {}) };
}
