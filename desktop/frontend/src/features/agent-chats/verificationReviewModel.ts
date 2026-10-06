import type { RoomMessage } from '../../../../shared/agent-chats';
import { exchangeLabel } from './roomTimeline';
import { lexer, type Tokens } from 'marked';
import { fileEvidence } from '../chat/fileEvidenceModel';
import type { SpecialistAgent } from '../../../../shared/agent-registry';

export interface VerificationReview {
  id: string;
  request?: RoomMessage;
  result?: RoomMessage;
  report?: { message: RoomMessage; fileContext: string };
  status: string;
}

export function verificationReportContext(message: RoomMessage, messages: RoomMessage[], agents: SpecialistAgent[]): string | undefined {
  if (message.kind !== 'message' || (message.activity && message.activity.kind !== 'message')
    || !agents.some(agent => agent.id === message.sender && agent.role === 'verification')) return undefined;
  return messages.find(request => request.sender === 'user' && request.recipient === message.sender
    && request.roomId === message.roomId && message.taskId && request.taskId === message.taskId)?.text ?? '';
}

/** Recognize report evidence or verdict tables, not a reviewer's ordinary progress messages. */
function isReport(text: string, context: string): boolean {
  return lexer(text).some(token => {
    if (token.type === 'code') return fileEvidence(token.text, token.lang || undefined, context) !== null;
    if (token.type !== 'table') return false;
    const table = token as Tokens.Table;
    const column = table.header.findIndex(cell => /^(?:판정|결과|verdict|result|status)$/i.test(cell.text.replace(/[*_]/g, '').trim()));
    return column >= 0 && table.rows.some(row => /^(?:pass(?:ed)?|fail(?:ed)?|inconclusive|통과|실패|미확정)$/i
      .test(row[column]?.text.replace(/[*_]/g, '').trim() ?? ''));
  });
}

function isReply(request: RoomMessage, result: RoomMessage) {
  return result.kind === 'verification_result' && result.roomId === request.roomId
    && result.questionId === (request.questionId ?? request.id)
    && result.sender === request.recipient && result.recipient === request.sender;
}

/** Join only explicitly linked peer exchanges, never neighboring messages or similar criteria. */
export function verificationReview(message: RoomMessage, messages: RoomMessage[], reportContext?: string): VerificationReview | null {
  if (message.kind === 'message' && reportContext !== undefined && isReport(message.text, reportContext)) {
    return { id: message.id, report: { message, fileContext: reportContext }, status: 'Report' };
  }
  if (message.kind !== 'verification_request' && message.kind !== 'verification_result') return null;
  const request = message.kind === 'verification_request' ? message
    : messages.find(candidate => candidate.kind === 'verification_request' && isReply(candidate, message));
  const result = message.kind === 'verification_result' ? message
    : request ? messages.filter(candidate => isReply(request, candidate)
      && !['failed', 'unknown', 'late reply · not applied'].includes(candidate.status ?? ''))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1) : undefined;
  return { id: message.id, request, result, status: exchangeLabel(message, messages)
    ?? (result ? 'Answered' : 'Reply status unavailable') };
}
