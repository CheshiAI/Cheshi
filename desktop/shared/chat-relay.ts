export type ChatRelayMode = 'review' | 'debate' | 'consensus';
export type ChatRelayPhase = 'proposal' | 'review' | 'revision' | 'discussion' | 'confirmation' | 'synthesis';
export type ChatRelayOutcome = 'reviewed' | 'debated' | 'agreed' | 'limit';
export const CHAT_RELAY_MAX_ROUNDS = 5;
export const CHAT_RELAY_MAX_TRANSCRIPT = 650_000;

export interface ChatRelayRequest {
  sourceContextId: string;
  sourceThreadId: string;
  targetContextId: string;
  targetThreadId: string;
  moderatorContextId?: string;
  moderatorThreadId?: string;
  objective: string;
  mode?: ChatRelayMode;
  maxRounds?: number;
}

export interface NormalizedChatRelayRequest extends ChatRelayRequest {
  mode: ChatRelayMode;
  maxRounds: number;
}

export interface ChatRelayState extends Omit<NormalizedChatRelayRequest, 'objective'> {
  id: string;
  status: 'running' | 'stopping' | 'completed' | 'stopped' | 'error';
  step: number;
  round: number;
  speaker: 'A' | 'B' | 'C';
  phase: ChatRelayPhase;
  outcome: ChatRelayOutcome | null;
  proposalVersion: number | null;
  proposal: string | null;
  issues: string[];
  summary: string | null;
  message: string | null;
  historyError?: string;
}

export interface ChatRelayHistoryRecord {
  id: string;
  objective: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  state: ChatRelayState;
}

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
const RELAY_OUTCOMES: readonly string[] = ['reviewed', 'debated', 'agreed', 'limit'];
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

function requiredText(value: unknown, label: string, limit: number): string {
  if (!isText(value, limit)) throw new TypeError(`${label} must be a non-empty string of at most ${limit} characters.`);
  return value.trim();
}

export function chatRelayRequest(value: unknown): NormalizedChatRelayRequest {
  if (!isRecord(value)) throw new TypeError('Relay request must be an object.');
  const sourceContextId = requiredText(value.sourceContextId, 'Source pane', 128);
  const targetContextId = requiredText(value.targetContextId, 'Target pane', 128);
  if (![sourceContextId, targetContextId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) throw new TypeError('Invalid relay pane id.');
  const sourceThreadId = requiredText(value.sourceThreadId, 'Source conversation', 256);
  const targetThreadId = requiredText(value.targetThreadId, 'Target conversation', 256);
  if (sourceContextId === targetContextId || sourceThreadId === targetThreadId) throw new TypeError('Choose two different conversations.');
  const mode = value.mode === undefined ? 'review' : value.mode;
  if (!isMode(mode)) throw new TypeError('Choose review, debate, or consensus.');
  let moderator: Pick<ChatRelayRequest, 'moderatorContextId' | 'moderatorThreadId'> = {};
  if (value.moderatorContextId !== undefined || value.moderatorThreadId !== undefined) {
    if (mode !== 'debate') throw new TypeError('A moderator is only available in debate mode.');
    const moderatorContextId = requiredText(value.moderatorContextId, 'Moderator pane', 128);
    const moderatorThreadId = requiredText(value.moderatorThreadId, 'Moderator conversation', 256);
    if (!/^[a-zA-Z0-9_-]+$/.test(moderatorContextId)) throw new TypeError('Invalid moderator pane id.');
    if ([sourceContextId, targetContextId].includes(moderatorContextId)
      || [sourceThreadId, targetThreadId].includes(moderatorThreadId)) throw new TypeError('Choose a separate conversation for moderator C.');
    moderator = { moderatorContextId, moderatorThreadId };
  }
  const maxRounds = value.maxRounds === undefined ? (mode === 'review' ? 1 : 3) : value.maxRounds;
  if (!isIntegerWithin(maxRounds, CHAT_RELAY_MAX_ROUNDS)) throw new TypeError(`Choose between one and ${CHAT_RELAY_MAX_ROUNDS} rounds.`);
  return { sourceContextId, sourceThreadId, targetContextId, targetThreadId, ...moderator,
    objective: requiredText(value.objective, 'Relay objective', 8_000), mode, maxRounds: mode === 'review' ? 1 : maxRounds };
}

export function chatRelayContextIds(state: ChatRelayState | null | undefined): string[] {
  return state ? [state.sourceContextId, state.targetContextId,
    ...(state.moderatorContextId ? [state.moderatorContextId] : [])] : [];
}

export function formatChatRelayMessage(provenance: ChatRelayMessageProvenance, body: string): string {
  return `${RELAY_PREFIX}${JSON.stringify(provenance)}\n\n${body}`;
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

export function chatRelayState(value: unknown): ChatRelayState | null {
  if (!isRecord(value) || !isText(value.id, 128)) return null;
  if (typeof value.status !== 'string' || !['running', 'stopping', 'completed', 'stopped', 'error'].includes(value.status)) return null;
  if (!isNullableText(value.message)) return null;
  if (value.historyError !== undefined && !isText(value.historyError, 2_000)) return null;
  try {
    const request = chatRelayRequest({ ...value, objective: 'Validate state' });
    const maxSteps = request.mode === 'debate' ? request.maxRounds * 2 + 1 : request.maxRounds * 3;
    if (!isIntegerWithin(value.step, maxSteps)) return null;
    // Pre-extension events can still arrive briefly while the preload is reloaded.
    const legacy = value.mode === undefined;
    const round = legacy ? 1 : value.round;
    const speaker = legacy ? (value.step === 2 ? 'B' : 'A') : value.speaker;
    const phase = legacy ? (value.step === 1 ? 'proposal' : value.step === 2 ? 'review' : 'revision') : value.phase;
    const outcome = legacy ? (value.status === 'completed' ? 'reviewed' : null) : value.outcome;
    const proposalVersion = legacy ? null : value.proposalVersion;
    const proposal = legacy ? null : value.proposal;
    const issues = legacy ? [] : value.issues;
    const summary = legacy ? null : value.summary;
    if (!isIntegerWithin(round, request.maxRounds) || (speaker !== 'A' && speaker !== 'B' && speaker !== 'C')) return null;
    if (typeof phase !== 'string' || !RELAY_PHASES.includes(phase)) return null;
    if ((speaker === 'C' || phase === 'synthesis') && (request.mode !== 'debate' || speaker !== 'C'
      || phase !== 'synthesis' || !request.moderatorThreadId || round !== request.maxRounds
      || value.step !== request.maxRounds * 2 + 1)) return null;
    if (outcome !== null && (typeof outcome !== 'string' || !RELAY_OUTCOMES.includes(outcome))) return null;
    if (proposalVersion !== null && !isIntegerWithin(proposalVersion, request.maxRounds)) return null;
    if (!isNullableText(proposal) || !isIssues(issues) || !isNullableText(summary)) return null;
    if (outcome === 'agreed' && (request.mode !== 'consensus' || value.status !== 'completed'
      || proposalVersion === null || proposal === null || issues.length !== 0)) return null;
    return { id: value.id, step: value.step, status: value.status as ChatRelayState['status'], message: value.message,
      sourceContextId: request.sourceContextId, sourceThreadId: request.sourceThreadId,
      targetContextId: request.targetContextId, targetThreadId: request.targetThreadId,
      ...(request.moderatorContextId ? { moderatorContextId: request.moderatorContextId, moderatorThreadId: request.moderatorThreadId } : {}),
      mode: request.mode, maxRounds: request.maxRounds, round, speaker, phase: phase as ChatRelayPhase,
      outcome: outcome as ChatRelayOutcome | null, proposalVersion, proposal, issues: [...issues], summary,
      ...(value.historyError !== undefined ? { historyError: value.historyError as string } : {}) };
  } catch { return null; }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function chatRelayHistoryRecord(value: unknown): ChatRelayHistoryRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)) return null;
  if (!isText(value.objective, 8_000) || !isTimestamp(value.startedAt) || !isTimestamp(value.updatedAt)) return null;
  const state = chatRelayState(value.state);
  if (!state || state.id !== value.id || value.startedAt > value.updatedAt) return null;
  const active = state.status === 'running' || state.status === 'stopping';
  if (active ? value.finishedAt !== null : !isTimestamp(value.finishedAt)) return null;
  if (typeof value.finishedAt === 'string' && (value.finishedAt < value.startedAt || value.finishedAt > value.updatedAt)) return null;
  return { id: value.id, objective: value.objective, startedAt: value.startedAt,
    updatedAt: value.updatedAt, finishedAt: value.finishedAt as string | null, state };
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
