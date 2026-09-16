import type { ChatUserInputRequest } from '../../../../shared/chat-user-input';
import type { ChatTimelineItem } from './model';

const CHOICE_QUESTION = /(?:고르|골라|선택|어느.+(?:좋|원|할)|어떤.+(?:좋|원|할)|\b(?:choose|select|pick|prefer)\b|\bwhich\b|\bwould you like\b)/i;

export type FallbackQuestionRequest = ChatUserInputRequest & { sourceItemId?: string; legacyQuestionId?: string; delivery?: 'async' };

function questionIdentity(item: ChatTimelineItem, threadId: string) {
  const turnId = item.turnId ?? null;
  const legacyQuestionId = `question:${threadId}:${item.id}`;
  return { id: turnId ? `question:${JSON.stringify([threadId, turnId, item.id])}` : legacyQuestionId,
    threadId, turnId, sourceItemId: item.id, legacyQuestionId };
}

/** A structured question belongs to its message, regardless of later conversation turns. */
export function asyncQuestionRequest(item: ChatTimelineItem, threadId: string | null): FallbackQuestionRequest | null {
  if (!threadId || item.kind !== 'assistant' || !item.asyncQuestions?.length) return null;
  return { ...questionIdentity(item, threadId), kind: 'questions', isBlocking: false, delivery: 'async',
    questions: item.asyncQuestions.map((question, index) => ({ id: `answer-${index + 1}`, header: '', question: question.title,
      isOther: true, isSecret: false, options: question.options?.map(label => ({ label, description: '' })) ?? null })) };
}

/** Recognize a choice question with a flat numbered or bulleted list. */
export function plainTextQuestion(text: string): { question: string; options: string[] } | null {
  const lines = text.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const options: string[] = [];
  let list: { indent: number; style: string } | null = null;
  let index = lines.length - 1;
  for (; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const match = /^( {0,3})(\d+[.)]|[-*+•])[ \t]+([^\n]+)$/.exec(line);
    if (!match) break;
    const style = /^\d/.test(match[2]!) ? 'numbered' : match[2]!;
    const indent = match[1]!.length;
    if (list && (list.indent !== indent || list.style !== style)) return null;
    list = { indent, style };
    const label = match[3]!.trim().replace(/^(\*\*|__|`|\*|_|~~)(.+)\1$/, '$2');
    if (!label || label.length > 240 || /[\[\]<>]/.test(label)) return null;
    options.unshift(label);
  }
  if (options.length < 2 || options.length > 8 || new Set(options).size !== options.length) return null;
  const question = lines[index]?.trim() ?? '';
  if (!/^[^>#`~].*[?？]$/.test(question) || !CHOICE_QUESTION.test(question) || /^ {4}|^\t/.test(lines[index]!)) return null;
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines.slice(0, index)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { marker: match[1]![0]!, length: match[1]!.length };
    else if (match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = null;
  }
  return fence ? null : { question, options };
}

export function fallbackQuestionRequest(items: ChatTimelineItem[], threadId: string | null): FallbackQuestionRequest | null {
  if (!threadId) return null;
  let latestTurnId: string | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === 'user') return null;
    if (item.turnId) {
      if (latestTurnId && latestTurnId !== item.turnId) return null;
      latestTurnId = item.turnId;
    }
    if (item.kind !== 'assistant') continue;
    const structured = asyncQuestionRequest(item, threadId);
    if (structured) return structured;
    const choice = plainTextQuestion(item.text);
    if (!choice) continue;
    return { ...questionIdentity(item, threadId), kind: 'questions', isBlocking: false,
      questions: [{ id: 'answer', header: '', question: choice.question, isOther: true, isSecret: false,
        options: choice.options.map(label => ({ label, description: '' })) }] };
  }
  return null;
}

export function composerQuestionRequest(items: ChatTimelineItem[], threadId: string | null): FallbackQuestionRequest | null {
  const request = fallbackQuestionRequest(items, threadId);
  return request?.delivery === 'async' ? null : request;
}
