import { agentRecord, agentText, parseAgentDetails, parseAgentEngineId } from './agent-management.ts';
import type { AgentDetails } from './agent-management.ts';
import { parseQuestionDeadline } from './agent-question.ts';

export const AGENT_RUNTIME_CHANNEL = 'cheshi:agent-registry:runtime';
export interface AgentRuntimeRequest {
  agentId: string; engineId: string; action: 'application-inspect' | 'status' | 'start' | 'submit' | 'cancel' | 'recover' | 'question' | 'question-deadline';
  candidateId?: string; hash?: string; taskId?: string; prompt?: string; roomId?: string; questionId?: string; recipient?: string | null; expiresAt?: string | null;
}
export interface AgentRuntimeState {
  details: AgentDetails | null;
  unavailable?: { kind: 'engine-unavailable'; message: string };
}
export function parseAgentRuntimeRequest(value: unknown): AgentRuntimeRequest {
  const v = agentRecord(value), agentId = agentText(v.agentId, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(agentId)) throw new TypeError('Invalid specialist ID.');
  if (!['application-inspect', 'status', 'start', 'submit', 'cancel', 'recover', 'question', 'question-deadline'].includes(String(v.action))) throw new TypeError('Invalid runtime action.');
  const action = v.action as AgentRuntimeRequest['action'];
  const result: AgentRuntimeRequest = { agentId, engineId: parseAgentEngineId(v.engineId), action };
  if (['application-inspect', 'submit', 'cancel', 'recover', 'question', 'question-deadline'].includes(action)) {
    result.taskId = agentText(v.taskId, 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(result.taskId)) throw new TypeError('Invalid task ID.');
  }
  if (action === 'application-inspect' || action === 'recover' || action === 'question' || action === 'question-deadline') {
    result.roomId = agentText(v.roomId, 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(result.roomId)) throw new TypeError('Invalid room ID.');
  }
  if (action === 'question' || action === 'question-deadline') {
    result.questionId = agentText(v.questionId, 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(result.questionId)) throw new TypeError('Invalid question control.');
    if (action === 'question-deadline') result.expiresAt = parseQuestionDeadline(v.expiresAt);
    else {
      result.recipient = v.recipient === null ? null : agentText(v.recipient, 80);
      if (result.recipient !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(result.recipient)) throw new TypeError('Invalid question control.');
    }
  }
  if (action === 'application-inspect') {
    result.candidateId = agentText(v.candidateId, 64); result.hash = agentText(v.hash, 64);
    if (![result.candidateId, result.hash].every(id => /^[a-f0-9]{64}$/.test(id))) throw new TypeError('Invalid application identity.');
  }
  if (action === 'submit') {
    result.prompt = agentText(v.prompt, 20_000);
    if (!result.prompt.trim()) throw new TypeError('Enter a task.');
  }
  return result;
}
export function parseAgentRuntimeState(value: unknown): AgentRuntimeState {
  const v = agentRecord(value);
  const details = v.details === null ? null : parseAgentDetails(v.details);
  if (v.unavailable === undefined) return { details };
  const unavailable = agentRecord(v.unavailable);
  if (unavailable.kind !== 'engine-unavailable' || details !== null) throw new TypeError('Invalid runtime availability.');
  return { details, unavailable: { kind: 'engine-unavailable', message: agentText(unavailable.message, 1000) } };
}
