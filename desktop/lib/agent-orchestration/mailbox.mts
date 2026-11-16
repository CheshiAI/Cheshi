import { collaborationTextLimit, collaborationBatch, isWorkKind, parseWorkMessage, parseWorkRequest, parseWorkResult, parseWorkReview, assertWorkRequest, assertWorkResult, assertWorkRevision, type WorkKind } from '../../shared/agent-work.ts';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { validateCandidateRequest, validateCandidateResult } from './candidate-verification.mts';
import { agentRecord, agentText, parseAgentId } from '../../shared/agent-management.ts';

export interface Binding {
  id: string; scope: string; workspace: string; engineId: string; agentId: string; accountId: string;
}
export interface Peer { id: string; name: string; role: string; fileWrite?: boolean; workProtocol?: 1 }
export interface Message {
  closureReason?: 'expired';
  roomId?: string; id: string; kind: WorkKind | 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result'; from: string; to: string; taskId: string; questionId: string; text: string;
}
interface Envelope { scope: string; message: Message; delivered: boolean }
interface State { version: 1; bindings: Binding[]; envelopes: Envelope[] }
function identifier(value: unknown): string {
  const id = parseAgentId(value);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid collaboration identifier.');
  return id;
}
function parseMessage(value: unknown): Message {
  const v = agentRecord(value);
  if (!isWorkKind(v.kind) && !['question', 'question_closed', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid collaboration message kind.');
  const text = agentText(v.text, collaborationTextLimit(v.kind));
  if (isWorkKind(v.kind)) {
    if (!v.roomId || !/^[a-f0-9]{64}$/.test(String(v.questionId))) throw new Error('Invalid delegated work identity.');
    parseWorkMessage(v.kind, JSON.parse(text));
  }
  if (!text.trim()) throw new Error('Empty collaboration message.');
  if (v.closureReason !== undefined && (v.kind !== 'question_closed' || v.closureReason !== 'expired')) throw new Error('Invalid question closure reason.');
  return { id: identifier(v.id), kind: v.kind as Message['kind'], from: identifier(v.from), to: identifier(v.to),
    ...(v.closureReason === 'expired' ? { closureReason: 'expired' as const } : {}),
    ...(v.roomId === undefined ? {} : { roomId: identifier(v.roomId) }), taskId: identifier(v.taskId), questionId: identifier(v.questionId), text };
}
export const bindingFor = (workspace: string, engineId: string, agentId: string, accountId: string): Binding => {
  const scope = createHash('sha256').update(`${engineId}\0${workspace}`).digest('hex');
  return { id: `${scope}:${agentId}`, scope, workspace, engineId, agentId, accountId };
};

/** One main-process owner. Never acknowledge delivery before this journal is persisted. */
export class AgentMailbox {
  private state: State;
  private readonly filename: string;
  constructor(filename: string) {
    this.filename = filename;
    try {
      const value = agentRecord(JSON.parse(readFileSync(filename, 'utf8')));
      if (value.version !== 1 || !Array.isArray(value.bindings) || !Array.isArray(value.envelopes)) throw new Error('Invalid orchestration journal.');
      this.state = { version: 1, bindings: value.bindings.map(raw => {
        const b = agentRecord(raw);
        const binding = bindingFor(agentText(b.workspace, 4096), agentText(b.engineId, 200), identifier(b.agentId), agentText(b.accountId, 200));
        if (binding.id !== b.id || binding.scope !== b.scope) throw new Error('Invalid saved worker binding.');
        return binding;
      }), envelopes: value.envelopes.map(raw => {
        const e = agentRecord(raw);
        if (typeof e.delivered !== 'boolean') throw new Error('Invalid message receipt.');
        return { scope: identifier(e.scope), message: parseMessage(e.message), delivered: e.delivered };
      }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, bindings: [], envelopes: [] };
    }
  }
  private commit(mutate: (state: State) => void): void {
    const next = structuredClone(this.state);
    mutate(next);
    if (next.envelopes.length > 10_000) throw new Error('Collaboration history limit reached.');
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flush: true });
    renameSync(temporary, this.filename);
    this.state = next;
  }
  messages(scope: string): Message[] { return structuredClone(this.state.envelopes.filter(e => e.scope === scope).map(e => e.message)); }
  bindings(): Binding[] { return structuredClone(this.state.bindings); }
  register(binding: Binding): void {
    const previous = this.state.bindings.find(b => b.id === binding.id);
    if (previous?.accountId === binding.accountId) return;
    if (previous && this.state.envelopes.some(e => e.scope === binding.scope && (e.message.from === binding.agentId || e.message.to === binding.agentId))) {
      throw new Error('This collaboration identity belongs to another account. Resolve its saved messages before changing accounts.');
    }
    this.commit(state => { state.bindings = [...state.bindings.filter(b => b.id !== binding.id), binding]; });
  }
  request(binding: Binding, peers: Peer[], allowed: (message: Message) => boolean = () => true) {
    const entries = this.state.envelopes.filter(e => e.scope === binding.scope && allowed(e.message));
    return { peers, messages: collaborationBatch(entries.filter(e => e.message.to === binding.agentId && !e.delivered).map(e => e.message)),
      // The worker filters these against its outgoing list; acknowledgements are bounded by exchange batches.
      acknowledged: entries.filter(e => e.message.from === binding.agentId).slice(-100).map(e => e.message.id) };
  }
  accept(binding: Binding, response: unknown, peers: Peer[], sentIds: string[], allowed: (message: Message) => boolean = () => true): void {
    const value = agentRecord(response);
    if (value.protocol !== 1 || !Array.isArray(value.outgoing) || value.outgoing.length > 100
      || !Array.isArray(value.received) || value.received.length > 100) throw new Error('Unsupported collaboration exchange.');
    const outgoing = value.outgoing.map(parseMessage), received = value.received.map(identifier);
    this.commit(state => {
      for (const id of received) {
        if (!sentIds.includes(id)) throw new Error('Invalid delivery acknowledgement.');
        const entry = state.envelopes.find(e => e.scope === binding.scope && e.message.to === binding.agentId && e.message.id === id);
        if (!entry) throw new Error('Unknown message receipt.');
        entry.delivered = true;
      }
      for (const item of outgoing) {
        if (!allowed(item)) throw new Error('Recipient is not invited to this room.');
        if (item.from !== binding.agentId || item.to === binding.agentId) throw new Error('Invalid collaboration sender.');
        const previous = state.envelopes.find(e => e.scope === binding.scope && e.message.id === item.id);
        if (previous) {
          if (JSON.stringify(previous.message) !== JSON.stringify(item)) throw new Error('Message identity conflict.');
          continue;
        }
        if (!peers.some(p => p.id === item.to)) throw new Error('Recipient is no longer assigned to this project.');
        if (['question', 'verification_request', 'work_request'].includes(item.kind) && item.questionId !== item.id) throw new Error('Invalid question identity.');
        if (item.kind === 'verification_request' && !peers.some(p => p.id === item.to && p.role === 'verification')) throw new Error('Recipient is not a verification agent.');
        if (item.kind === 'verification_request') validateCandidateRequest(item, state.envelopes.filter(e => e.scope === binding.scope).map(e => e.message));
        if (item.kind === 'verification_result' && !peers.some(p => p.id === item.from && p.role === 'verification')) throw new Error('Sender is not a verification agent.');
        if (item.kind === 'work_request') {
          if (!item.roomId || ![item.from, item.to].every(id => peers.some(p => p.id === id && p.fileWrite === true && p.workProtocol === 1))) throw new Error('Implementation delegation requires writable, updated room participants.');
          const request = parseWorkRequest(JSON.parse(item.text));
          assertWorkRequest(request, text => createHash('sha256').update(text).digest('hex'));
          if (request.previousRequestId) {
            const prior = state.envelopes.find(e => e.scope === binding.scope && e.message.id === request.previousRequestId)?.message;
            const result = state.envelopes.find(e => e.scope === binding.scope && e.message.kind === 'work_result' && e.message.questionId === request.previousRequestId)?.message;
            const review = state.envelopes.find(e => e.scope === binding.scope && e.message.kind === 'work_review' && e.message.questionId === request.previousRequestId)?.message;
            if (!prior || prior.kind !== 'work_request' || prior.from !== item.from || prior.to !== item.to || prior.taskId !== item.taskId || prior.roomId !== item.roomId
              || !result || !review || parseWorkReview(JSON.parse(review.text)).decision !== 'changes_requested') throw new Error('Invalid work revision lineage.');
            assertWorkRevision(parseWorkRequest(JSON.parse(prior.text)), parseWorkResult(JSON.parse(result.text)), request);
          }
        }
        if (item.kind === 'work_review') {
          const request = state.envelopes.find(e => e.scope === binding.scope && e.message.id === item.questionId)?.message;
          const result = state.envelopes.find(e => e.scope === binding.scope && e.message.questionId === item.questionId && e.message.kind === 'work_result')?.message;
          if (!request || request.kind !== 'work_request' || !result || request.from !== item.from || request.to !== item.to || request.taskId !== item.taskId || request.roomId !== item.roomId) throw new Error('Invalid work review scope.');
          if (parseWorkReview(JSON.parse(item.text)).decision === 'accepted' && parseWorkResult(JSON.parse(result.text)).status !== 'submitted') throw new Error('Cannot accept unsuccessful work.');
          if (state.envelopes.some(e => e.scope === binding.scope && e.message.kind === 'work_review' && e.message.questionId === item.questionId)) throw new Error('Work already reviewed.');
        }
        if (item.kind === 'question_closed') {
          const q = state.envelopes.find(e => e.scope === binding.scope && e.message.id === item.questionId)?.message;
          if (!q || q.kind !== 'question' || q.from !== item.from || q.to !== item.to || q.taskId !== item.taskId || q.roomId !== item.roomId) throw new Error('Invalid question closure.');
          if (state.envelopes.some(e => e.scope === binding.scope && e.message.kind === 'question_closed' && e.message.questionId === item.questionId)) throw new Error('Question already closed.');
        }
        if (item.kind === 'reply' || item.kind === 'verification_result' || item.kind === 'work_result') {
          const question = state.envelopes.find(e => e.scope === binding.scope && e.message.id === item.questionId)?.message;
          if (!question || question.kind !== (item.kind === 'reply' ? 'question' : item.kind === 'work_result' ? 'work_request' : 'verification_request') || question.from !== item.to || question.to !== item.from || question.taskId !== item.taskId || question.roomId !== item.roomId) {
            throw new Error('Reply does not belong to this peer and task.');
          }
          if (item.kind === 'work_result') assertWorkResult(parseWorkRequest(JSON.parse(question.text)), parseWorkResult(JSON.parse(item.text)), text => createHash('sha256').update(text).digest('hex'));
          if (item.kind === 'verification_result') validateCandidateResult(question, item);
          if (state.envelopes.some(e => e.scope === binding.scope && e.message.kind === item.kind && e.message.questionId === item.questionId)) {
            throw new Error('Question already has a reply.');
          }
        }
        state.envelopes.push({ scope: binding.scope, message: item, delivered: false });
      }
    });
  }
}
