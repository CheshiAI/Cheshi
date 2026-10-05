import type { ChatMember, RoomMessage } from './agent-chats.ts';

export interface ChatRecipient { recipient: string | null; error: string | null }
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolve explicit addressing only. Merely discussing an agent never wakes it. */
export function resolveChatRecipient(text: string, members: ChatMember[], reply?: RoomMessage): ChatRecipient {
  const input = text.trim();
  const mention = input.startsWith('@');
  const matches = members.filter(member => {
    const name = escapePattern(member.name);
    return mention ? new RegExp(`^@${name}(?=$|[\\s,:：])`, 'u').test(input)
      : new RegExp(`^${name}\\s*(?:을|를)?\\s*호출(?:해서|하여|해줘|해주세요|해|해요|합니다|하자)(?=$|[\\s,.!?:：])`, 'u').test(input);
  });
  // Prefer the full name when one name is a prefix of another.
  const longest = matches.reduce((length, member) => Math.max(length, member.name.length), 0);
  const targets = matches.filter(member => member.name.length === longest);
  if (targets.length > 1) return { recipient: null, error: 'More than one participant has this name. Give the agents distinct names before calling them.' };
  if (targets[0]) return { recipient: targets[0].id, error: null };
  if (mention) return { recipient: null, error: 'Use the exact name of an invited agent after @.' };
  const recipient = reply ? reply.sender === 'user' ? reply.recipient : reply.sender : null;
  return { recipient, error: null };
}
