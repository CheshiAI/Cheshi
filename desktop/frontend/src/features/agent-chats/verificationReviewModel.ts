import type { RoomMessage } from '../../../../shared/agent-chats';
import { exchangeLabel } from './roomTimeline';

export interface VerificationReview {
  id: string;
  request?: RoomMessage;
  result?: RoomMessage;
  status: string;
}

function isReply(request: RoomMessage, result: RoomMessage) {
  return result.kind === 'verification_result' && result.roomId === request.roomId
    && result.questionId === (request.questionId ?? request.id)
    && result.sender === request.recipient && result.recipient === request.sender;
}

/** Join only explicitly linked peer exchanges, never neighboring messages or similar criteria. */
export function verificationReview(message: RoomMessage, messages: RoomMessage[]): VerificationReview | null {
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
