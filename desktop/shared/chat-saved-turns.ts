export interface ChatSavedTurnInput {
  threadId: string;
  itemId: string;
  sessionTitle: string;
  userText: string;
  assistantText: string;
  createdAt: number;
}

export interface ChatSavedTurn extends ChatSavedTurnInput {
  id: string;
  savedAt: string;
}

export const CHAT_SAVED_TURN_MAX_TEXT = 1_000_000;

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid saved turn.');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new TypeError(`Invalid saved turn ${label}.`);
  }
  return value;
}

export function chatSavedTurnInput(value: unknown): ChatSavedTurnInput {
  const record = recordValue(value);
  const createdAt = record.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0 || createdAt > 8.64e15) {
    throw new TypeError('Invalid saved turn timestamp.');
  }
  return {
    threadId: text(record.threadId, 'thread id', 512),
    itemId: text(record.itemId, 'item id', 512),
    sessionTitle: text(record.sessionTitle, 'title', 10_000, true),
    userText: text(record.userText, 'question', CHAT_SAVED_TURN_MAX_TEXT, true),
    assistantText: text(record.assistantText, 'answer', CHAT_SAVED_TURN_MAX_TEXT),
    createdAt,
  };
}

export function chatSavedTurn(value: unknown): ChatSavedTurn {
  const record = recordValue(value);
  const input = chatSavedTurnInput(record);
  if (typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id)) throw new TypeError('Invalid saved turn id.');
  if (typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))) {
    throw new TypeError('Invalid saved turn save date.');
  }
  return { ...input, id: record.id, savedAt: record.savedAt };
}
