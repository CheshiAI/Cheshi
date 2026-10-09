import type { AgentRoom, ChatMember, RoomMessage } from './agent-chats.ts';
import type { SpecialistAgent } from './agent-registry.ts';

/** Refresh labels without rebinding saved membership or rewriting conversation history. */
export function resolveRoomMemberNames(room: AgentRoom, agents: SpecialistAgent[]): AgentRoom {
  const registered = new Map(agents.filter(agent => agent.assignments.some(assignment => assignment.workspaceRoot === room.workspace))
    .map(agent => [agent.id, agent]));
  const resolve = (member: ChatMember): ChatMember => {
    const agent = registered.get(member.id);
    return agent && agent.accountId === member.accountId && agent.name !== member.name
      ? { ...member, name: agent.name } : member;
  };
  const members = room.members.map(resolve), formerMembers = room.formerMembers?.map(resolve);
  if (members.every((member, index) => member === room.members[index])
    && formerMembers?.every((member, index) => member === room.formerMembers?.[index]) !== false) return room;
  return { ...room, members, ...(formerMembers ? { formerMembers } : {}) };
}

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
