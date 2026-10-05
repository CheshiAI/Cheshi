import { useEffect, useMemo, useState } from 'react';
import type { RoomMessage } from '../../../../shared/agent-chats';
import { roomTimeline } from './roomTimeline';

/** Older room journals omitted questionId; worker reply IDs still encode the exact request. */
export async function legacyReplyLinks(messages: RoomMessage[]): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const byId = new Map(messages.map(message => [message.id, message]));
  for (const question of messages) {
    const prefix = question.kind === 'question' ? 'reply' : question.kind === 'verification_request' ? 'result' : null;
    if (!prefix || !/^peer_[a-f0-9]{64}$/.test(question.id)) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${prefix}/${question.id.slice(5)}`));
    const replyId = `peer_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const reply = byId.get(replyId);
    if (question.taskId && reply && !reply.questionId && reply.roomId === question.roomId && reply.taskId === question.taskId
      && reply.sender === question.recipient && reply.recipient === question.sender
      && reply.kind === (question.kind === 'question' ? 'reply' : 'verification_result')) links.set(reply.id, question.id);
  }
  return links;
}

export function useRoomTimeline(all: RoomMessage[], roomId: string | null) {
  const messages = useMemo(() => roomTimeline(all, roomId), [all, roomId]);
  const [resolved, setResolved] = useState<{ source: RoomMessage[]; links: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!messages.some(message => ['reply', 'verification_result'].includes(message.kind) && !message.questionId)) return;
    let active = true;
    void legacyReplyLinks(messages).then(links => { if (active) setResolved({ source: messages, links }); }, () => {
      // Without a verified identity, the UI explicitly leaves the reply status unavailable.
      if (active) setResolved({ source: messages, links: new Map() });
    });
    return () => { active = false; };
  }, [messages]);
  return useMemo(() => resolved?.source === messages ? messages.map(message => {
    const questionId = resolved.links.get(message.id);
    return questionId ? { ...message, questionId } : message;
  }) : messages, [messages, resolved]);
}
