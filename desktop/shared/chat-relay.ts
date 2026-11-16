// Compatibility for messages already saved by the retired session relay feature.
export type ChatRelayMode = 'review' | 'debate' | 'consensus';
export type ChatRelayPhase = 'proposal' | 'review' | 'revision' | 'discussion' | 'confirmation' | 'synthesis';
export const CHAT_RELAY_MAX_ROUNDS = 5;
export const CHAT_RELAY_MAX_TRANSCRIPT = 650_000;
export const CHAT_RELAY_MODERATOR_TITLE = 'Debate summary';

export interface ChatRelayMessageProvenance {
  relayId: string;
  step: number;
  sourceThreadId: string;
  role: ChatRelayPhase;
  sourceThreadIds?: string[];
  mode?: ChatRelayMode;
  round?: number;
  displayText?: string;
}

export interface ChatRelayConsensusReply {
  kind: 'cheshi-relay-consensus';
  version: number;
  decision: 'agree' | 'revise' | 'disagree';
  proposal: string | null;
  issues: string[];
  summary: string;
}

const RELAY_PREFIX = '[Cheshi relay]\n';
// Old messages remain in Codex history even when Cheshi's local data is reset.
const LEGACY_RELAY_PREFIX = '[Studio relay]\n';
const RELAY_PHASES: readonly string[] = ['proposal', 'review', 'revision', 'discussion', 'confirmation', 'synthesis'];
const MAX_TEXT = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is ChatRelayMode {
  return value === 'review' || value === 'debate' || value === 'consensus';
}

function isIntegerWithin(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= limit;
}

function isText(value: unknown, limit = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isIssues(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 && value.every((issue) => isText(issue, 2_000));
}

export function formatChatRelayMessage(provenance: ChatRelayMessageProvenance, body: string): string {
  return `${RELAY_PREFIX}${JSON.stringify(provenance)}\n\n${body}`;
}

/** Provider previews and generated names may truncate or flatten the relay envelope. */
export function chatRelaySessionTitle(text: string): string | null {
  const normalized = text.trim().replace(/\r\n?/gu, '\n').replace(/(?:\.\.\.|…)$/u, '').trimEnd();
  const header = [RELAY_PREFIX, LEGACY_RELAY_PREFIX].map(prefix => prefix.trimEnd())
    .find(candidate => normalized === candidate || normalized.startsWith(`${candidate}\n`) || normalized.startsWith(`${candidate} `));
  if (!header) return null;
  const remainder = normalized.slice(header.length).trimStart();
  if (remainder && !remainder.startsWith('{')) return null;
  const message = parseChatRelayMessage(normalized);
  if (message?.provenance.role === 'synthesis') return CHAT_RELAY_MODERATOR_TITLE;
  switch (message?.provenance.mode) {
    case 'review': return 'Review conversation';
    case 'debate': return 'Debate conversation';
    case 'consensus': return 'Consensus conversation';
    default: return 'Connected conversation';
  }
}

export function parseChatRelayMessage(text: string): { provenance: ChatRelayMessageProvenance; body: string } | null {
  const prefix = [RELAY_PREFIX, LEGACY_RELAY_PREFIX].find((candidate) => text.startsWith(candidate));
  if (!prefix) return null;
  const end = text.indexOf('\n\n', prefix.length);
  if (end === -1) return null;
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length, end));
    if (!isRecord(value) || !isText(value.relayId, 128) || !isText(value.sourceThreadId, 256)) return null;
    if (!isIntegerWithin(value.step, CHAT_RELAY_MAX_ROUNDS * 3)) return null;
    if (typeof value.role !== 'string' || !RELAY_PHASES.includes(value.role)) return null;
    if (value.mode !== undefined && !isMode(value.mode)) return null;
    if (value.round !== undefined && !isIntegerWithin(value.round, CHAT_RELAY_MAX_ROUNDS)) return null;
    if (value.sourceThreadIds !== undefined && (value.role !== 'synthesis' || !Array.isArray(value.sourceThreadIds)
      || value.sourceThreadIds.length !== 2 || !value.sourceThreadIds.every((id) => isText(id, 256))
      || new Set(value.sourceThreadIds).size !== 2 || !value.sourceThreadIds.includes(value.sourceThreadId))) return null;
    if (value.role === 'synthesis' && (value.mode !== 'debate' || value.sourceThreadIds === undefined)) return null;
    if (value.displayText !== undefined && !isText(value.displayText, value.role === 'synthesis' ? CHAT_RELAY_MAX_TRANSCRIPT : MAX_TEXT)) return null;
    return { provenance: { relayId: value.relayId, step: value.step, sourceThreadId: value.sourceThreadId,
      role: value.role as ChatRelayPhase,
      ...(Array.isArray(value.sourceThreadIds) ? { sourceThreadIds: [...value.sourceThreadIds] as string[] } : {}),
      ...(value.mode !== undefined ? { mode: value.mode as ChatRelayMode } : {}),
      ...(value.round !== undefined ? { round: value.round as number } : {}),
      ...(value.displayText !== undefined ? { displayText: value.displayText as string } : {}),
    }, body: text.slice(end + 2) };
  } catch { return null; }
}

export function parseChatRelayConsensusReply(text: string): ChatRelayConsensusReply | null {
  const match = /^\s*```(?:cheshi|studio)-relay\r?\n([\s\S]+?)\r?\n```\s*$/.exec(text);
  if (!match || text.length > MAX_TEXT) return null;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!isRecord(value) || (value.kind !== 'cheshi-relay-consensus' && value.kind !== 'studio-relay-consensus')) return null;
    if (!isIntegerWithin(value.version, CHAT_RELAY_MAX_ROUNDS)) return null;
    if (value.decision !== 'agree' && value.decision !== 'revise' && value.decision !== 'disagree') return null;
    if (!isNullableText(value.proposal) || !isIssues(value.issues) || !isText(value.summary)) return null;
    return { kind: 'cheshi-relay-consensus', version: value.version, decision: value.decision,
      proposal: value.proposal, issues: [...value.issues], summary: value.summary };
  } catch { return null; }
}

export function formatChatRelayConsensusReply(reply: ChatRelayConsensusReply): string {
  return `\`\`\`cheshi-relay\n${JSON.stringify(reply)}\n\`\`\``;
}

export function chatRelayConsensusDisplay(reply: ChatRelayConsensusReply): string {
  const decision = reply.decision === 'agree' ? 'Agree' : reply.decision === 'revise' ? 'Changes requested' : 'Disagree';
  return [`${decision} · Proposal v${reply.version}`, reply.summary, reply.proposal,
    reply.issues.length ? `Open issues:\n${reply.issues.map((issue) => `- ${issue}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
}
