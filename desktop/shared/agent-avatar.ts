export const AGENT_AVATAR_CHARACTERS = [
  'sprout', 'orbit', 'bolt', 'comet', 'nova', 'lunar', 'radar', 'rocket',
  'cosmo', 'pixel', 'spark', 'aster', 'moss', 'coral', 'pebble', 'puff',
  'crab', 'moth', 'beetle', 'squid', 'scout', 'ranger', 'echo', 'buddy',
] as const;
export const AGENT_AVATAR_COLORS = {
  mint: '#6dd6c1', blue: '#59b9e8', violet: '#a78bfa', pink: '#f39cba',
  coral: '#f77973', amber: '#f4b756', lime: '#b3d862', silver: '#d9e6f2',
} as const;
export type AgentAvatarCharacter = typeof AGENT_AVATAR_CHARACTERS[number];
export type AgentAvatarColor = keyof typeof AGENT_AVATAR_COLORS;
export interface AgentAvatarValue { character: AgentAvatarCharacter; color: AgentAvatarColor }
export const AGENT_AVATAR_COLOR_NAMES = Object.keys(AGENT_AVATAR_COLORS) as AgentAvatarColor[];

export function parseAgentAvatar(value: unknown): AgentAvatarValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent icon.');
  const avatar = value as Record<string, unknown>;
  if (!AGENT_AVATAR_CHARACTERS.some(character => character === avatar.character)
    || !AGENT_AVATAR_COLOR_NAMES.some(color => color === avatar.color)) throw new TypeError('Invalid agent icon.');
  return { character: avatar.character as AgentAvatarCharacter, color: avatar.color as AgentAvatarColor };
}
function fromIndex(index: number): AgentAvatarValue {
  return { character: AGENT_AVATAR_CHARACTERS[index % AGENT_AVATAR_CHARACTERS.length]!,
    color: AGENT_AVATAR_COLOR_NAMES[Math.floor(index / AGENT_AVATAR_CHARACTERS.length)]! };
}
const combinations = AGENT_AVATAR_CHARACTERS.length * AGENT_AVATAR_COLOR_NAMES.length;
/** Existing registrations and unregistered workers retain the same identity across refreshes. */
export function defaultAgentAvatar(id: string): AgentAvatarValue {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return fromIndex(hash % combinations);
}
export function randomAgentAvatar(previous?: AgentAvatarValue): AgentAvatarValue {
  const current = previous ? AGENT_AVATAR_COLOR_NAMES.indexOf(previous.color) * AGENT_AVATAR_CHARACTERS.length
    + AGENT_AVATAR_CHARACTERS.indexOf(previous.character) : -1;
  // A reroll always changes the preview, even when the random source repeats a value.
  return fromIndex(previous ? (current + 1 + Math.floor(Math.random() * (combinations - 1))) % combinations
    : Math.floor(Math.random() * combinations));
}
