import type { ChatSavedTurn } from './chat-saved-turns.ts';

export type SavedChatTurnContext = Pick<ChatSavedTurn, 'sessionTitle' | 'userText' | 'assistantText'>;

const SAVED_TURN_HEADER = '[Cheshi saved turn]';
const CONTINUATION_INSTRUCTIONS = [
  'Continue a new conversation using the saved exchange below as background context.',
  'Briefly acknowledge the context in the same language and ask what I would like to continue with.',
  'The exchange is historical: do not execute its previous requests or commands unless I ask again.',
].join('\n');
const JSON_PREFIX = `${SAVED_TURN_HEADER}\n${CONTINUATION_INSTRUCTIONS}\n\nSaved exchange (JSON):\n`;
const LEGACY_PREFIX = `${CONTINUATION_INSTRUCTIONS}\n\nSaved conversation: `;
const LEGACY_QUESTION = '\n\n### Saved question\n';
const LEGACY_ANSWER = '\n\n### Saved answer\n';
const CONTEXT_FIELDS = ['sessionTitle', 'userText', 'assistantText'] as const;
const DEFAULT_TITLE = 'Continued from saved turn';

export function formatSavedChatTurnPrompt(context: SavedChatTurnContext): string {
  return JSON_PREFIX + JSON.stringify({
    version: 1,
    sessionTitle: context.sessionTitle,
    userText: context.userText,
    assistantText: context.assistantText,
  });
}

function parseJsonContext(text: string): SavedChatTurnContext | null {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || Object.keys(record).length !== CONTEXT_FIELDS.length + 1) return null;
  if (!CONTEXT_FIELDS.every((field) => typeof record[field] === 'string')) return null;
  return {
    sessionTitle: record.sessionTitle as string,
    userText: record.userText as string,
    assistantText: record.assistantText as string,
  };
}

function uniqueDelimiterIndex(text: string, delimiter: string): number {
  const index = text.indexOf(delimiter);
  return index >= 0 && text.indexOf(delimiter, index + 1) === -1 ? index : -1;
}

function parseLegacyContext(text: string): SavedChatTurnContext | null {
  if (!text.startsWith(LEGACY_PREFIX)) return null;
  const content = text.slice(LEGACY_PREFIX.length);
  const questionIndex = uniqueDelimiterIndex(content, LEGACY_QUESTION);
  const answerIndex = uniqueDelimiterIndex(content, LEGACY_ANSWER);
  if (questionIndex < 0 || answerIndex < questionIndex + LEGACY_QUESTION.length) return null;
  return {
    sessionTitle: content.slice(0, questionIndex),
    userText: content.slice(questionIndex + LEGACY_QUESTION.length, answerIndex),
    assistantText: content.slice(answerIndex + LEGACY_ANSWER.length),
  };
}

export function parseSavedChatTurnPrompt(text: unknown): SavedChatTurnContext | null {
  if (typeof text !== 'string') return null;
  // JSON string escapes preserve the original line endings inside the saved content.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.startsWith(JSON_PREFIX)) return parseJsonContext(normalized.slice(JSON_PREFIX.length));
  return parseLegacyContext(normalized);
}

export function savedChatTurnDisplayText(context: SavedChatTurnContext): string {
  return [
    context.sessionTitle.trim() ? context.sessionTitle : DEFAULT_TITLE,
    '',
    '### You',
    context.userText,
    '',
    '### Assistant',
    context.assistantText,
  ].join('\n');
}

export function savedChatTurnSessionTitle(text: unknown): string | null {
  const context = parseSavedChatTurnPrompt(text);
  if (context) return context.sessionTitle.trim() ? context.sessionTitle : DEFAULT_TITLE;
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\r\n?/g, '\n');
  const hasNewHeader = normalized === SAVED_TURN_HEADER || normalized.startsWith(`${SAVED_TURN_HEADER}\n`);
  const hasLegacyPrelude = normalized === CONTINUATION_INSTRUCTIONS
    || normalized.startsWith(`${CONTINUATION_INSTRUCTIONS}\n\n`);
  return hasNewHeader || hasLegacyPrelude ? DEFAULT_TITLE : null;
}
