import { parseTaskInspection, type TaskInspection } from './agent-task-inspection.ts';
import { parseTaskUsage, type TaskUsage } from '../../experiments/codex-specialists/src/usage-contract.ts';
import { parseAgentExecutionHealth, type AgentExecutionHealth } from './agent-execution-health.ts';
import { WORK_MESSAGE_LIMIT } from './agent-work.ts';

// Generated collaboration tasks include a bounded instruction prefix around the wire payload.
const TASK_PROMPT_LIMIT = WORK_MESSAGE_LIMIT + 1024;

export const AGENT_CHANNELS = {
  engines: 'cheshi:agents:engines', snapshot: 'cheshi:agents:snapshot',
  details: 'cheshi:agents:details', control: 'cheshi:agents:control',
  remove: 'cheshi:agents:remove',
} as const;
export const AGENT_ACTIONS = ['start', 'stop', 'restart'] as const;
export type AgentAction = typeof AGENT_ACTIONS[number];
export interface AgentEngineInfo { id: string; name: string; supported: boolean; reason: string | null }
export interface AgentCatalog { engines: AgentEngineInfo[]; error: string | null }
export interface ManagedAgent {
  id: string; name: string; state: string; image: string; profileId?: string;
  startedAt?: string;
  status?: WorkerStatusObservation;
  pendingDeletion?: { deleteData: boolean };
}
export interface WorkerLifecycleDisplay {
  phase: 'starting' | 'running' | 'draining' | 'sleeping' | 'disabled' | 'error';
  error: string | null;
  stopReason?: 'sleep' | 'manual' | 'unexpected';
}
/** Read-only observations. Never used for power management or persisted as lifecycle input. */
export interface WorkerStatusObservation {
  observedAt: number;
  lifecycle?: WorkerLifecycleDisplay;
  health?: { ready: boolean; busy: boolean; error: string | null };
}
export function parseWorkerStopReason(value: unknown): WorkerLifecycleDisplay['stopReason'] {
  if (value === undefined) return undefined;
  if (value !== 'sleep' && value !== 'manual' && value !== 'unexpected') throw new TypeError('Invalid worker stop reason.');
  return value;
}
export function parseWorkerStatus(value: unknown): WorkerStatusObservation {
  const v = agentRecord(value);
  if (typeof v.observedAt !== 'number' || !Number.isFinite(v.observedAt) || v.observedAt < 0) throw new TypeError('Invalid worker observation.');
  const result: WorkerStatusObservation = { observedAt: v.observedAt };
  if (v.lifecycle !== undefined) {
    const l = agentRecord(v.lifecycle);
    if (!['starting', 'running', 'draining', 'sleeping', 'disabled', 'error'].includes(String(l.phase))) throw new TypeError('Invalid worker lifecycle.');
    const stopReason = parseWorkerStopReason(l.stopReason);
    result.lifecycle = { phase: l.phase as WorkerLifecycleDisplay['phase'], error: agentNullableText(l.error, 20_000),
      ...(stopReason ? { stopReason } : {}) };
  }
  if (v.health !== undefined) {
    const h = agentRecord(v.health);
    result.health = { ready: agentBoolean(h.ready), busy: agentBoolean(h.busy), error: agentNullableText(h.error, 20_000) };
  }
  return result;
}
export interface AgentSnapshot { engineId: string; online: boolean; error: string | null; agents: ManagedAgent[] }
export interface ExecutionRecovery { threadId: string; turnId: string; status: 'completed' | 'interrupted' | 'failed'; checkedAt: string }
export interface AgentTask {
  usage?: TaskUsage;
  recovery?: ExecutionRecovery;
  roomId?: string; inputs?: { id: string; prompt: string; pending?: true }[]; responses?: { id: string; text: string; status: string }[];
  inspection?: TaskInspection;
  id: string; prompt: string; status: string; createdAt: string; output: string; error: string | null;
}
export interface AgentDetails {
  execution?: AgentExecutionHealth | null;
  agent: ManagedAgent; ready: boolean; busy: boolean; authenticated: boolean | null;
  threadId: string | null; error: string | null; logs: string; tasks: AgentTask[];
}
export interface AgentManagementApi {
  remove?(request: DeleteContainer): Promise<void>;
  terminal?: AgentTerminalApi;
  engines(): Promise<AgentCatalog>;
  snapshot(engineId: string): Promise<AgentSnapshot>;
  details(engineId: string, agentId: string): Promise<AgentDetails>;
  control(engineId: string, agentId: string, action: AgentAction): Promise<AgentSnapshot>;
}

export interface DeleteContainer { engineId: string; containerId: string; deleteData: boolean }
/** Expected deletion blocks reach the existing UI error display without an Electron handler failure. */
export function unwrapAgentDeletion(value: unknown): unknown {
  const result = agentRecord(value);
  if (result.status === 'busy' || result.status === 'blocked') throw new Error(agentText(result.message));
  if (result.status !== 'deleted') throw new TypeError('Invalid deletion response.');
  return result.value;
}
export function parseDeleteContainer(value: unknown): DeleteContainer {
  const v = agentRecord(value), containerId = parseAgentId(v.containerId);
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new TypeError('Expected a full Docker container ID.');
  return { engineId: parseAgentEngineId(v.engineId), containerId, deleteData: agentBoolean(v.deleteData) };
}

export function agentRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent data.');
  return value as Record<string, unknown>;
}
export function agentText(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError('Invalid agent text.');
  return value;
}
export function agentNullableText(value: unknown, limit = 1000): string | null {
  return value === null ? null : agentText(value, limit);
}
export function agentBoolean(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid agent flag.');
  return value;
}
function items(value: unknown, limit = 1000): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError('Invalid agent list.');
  return value;
}
export function parseAgentEngineId(value: unknown): string {
  const id = agentText(value, 200);
  if (!/^[a-z][a-z0-9-]*:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new TypeError('Invalid engine ID.');
  return id;
}
export function parseAgentId(value: unknown): string {
  const id = agentText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new TypeError('Invalid agent ID.');
  return id;
}
export function parseAgentAction(value: unknown): AgentAction {
  if (!AGENT_ACTIONS.some(action => action === value)) throw new TypeError('Invalid agent action.');
  return value as AgentAction;
}
export function parseManagedAgent(value: unknown): ManagedAgent {
  const v = agentRecord(value);
  return { id: parseAgentId(v.id), name: agentText(v.name), state: agentText(v.state, 100), image: agentText(v.image),
    ...(v.startedAt === undefined ? {} : { startedAt: agentText(v.startedAt, 100) }),
    ...(v.status === undefined ? {} : { status: parseWorkerStatus(v.status) }),
    ...(v.profileId === undefined ? {} : { profileId: parseAgentId(v.profileId) }),
    ...(v.pendingDeletion === undefined ? {} : { pendingDeletion: { deleteData: agentBoolean(agentRecord(v.pendingDeletion).deleteData) } }) };
}
export function parseAgentCatalog(value: unknown): AgentCatalog {
  const v = agentRecord(value);
  return { error: agentNullableText(v.error), engines: items(v.engines, 100).map(raw => {
    const e = agentRecord(raw);
    return { id: parseAgentEngineId(e.id), name: agentText(e.name), supported: agentBoolean(e.supported), reason: agentNullableText(e.reason) };
  }) };
}
export function parseAgentSnapshot(value: unknown): AgentSnapshot {
  const v = agentRecord(value);
  return { engineId: parseAgentEngineId(v.engineId), online: agentBoolean(v.online), error: agentNullableText(v.error),
    agents: items(v.agents).map(parseManagedAgent) };
}
export function parseExecutionRecovery(value: unknown): ExecutionRecovery {
  const v = agentRecord(value), threadId = agentText(v.threadId, 200), turnId = agentText(v.turnId, 200), checkedAt = agentText(v.checkedAt, 100);
  if (!threadId || !turnId || !Number.isFinite(Date.parse(checkedAt)) || !['completed', 'interrupted', 'failed'].includes(String(v.status))) throw new TypeError('Invalid execution inspection.');
  return { threadId, turnId, checkedAt, status: v.status as ExecutionRecovery['status'] };
}
export function parseAgentTasks(value: unknown): AgentTask[] {
  return items(value, 10_000).map(raw => {
    const t = agentRecord(raw);
    const status = agentText(t.status, 30);
    if (!['accepted', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'unknown'].includes(status)) throw new TypeError('Invalid task status.');
    return { ...(t.roomId === undefined ? {} : { roomId: parseAgentId(t.roomId),
      inputs: items(t.inputs ?? [], 100).map(raw => { const i = agentRecord(raw); if (i.pending !== undefined && i.pending !== true) throw new Error('Invalid pending input.'); return { id: parseAgentId(i.id), prompt: agentText(i.prompt, 20_000), ...(i.pending === true ? { pending: true as const } : {}) }; }),
      responses: items(t.responses ?? [], 100).map(raw => { const r = agentRecord(raw); return { id: parseAgentId(r.id), text: agentText(r.text, 500_000), status: agentText(r.status, 30) }; }) }),
      ...(t.recovery === undefined ? {} : { recovery: parseExecutionRecovery(t.recovery) }),
      ...(t.usage === undefined ? {} : { usage: parseTaskUsage(t.usage) }),
      id: parseAgentId(t.id), prompt: agentText(t.prompt, TASK_PROMPT_LIMIT), status,
      createdAt: agentText(t.createdAt, 100), output: agentText(t.output, 500_000), error: agentNullableText(t.error, 20_000),
      ...(t.inspection === undefined ? {} : { inspection: parseTaskInspection(t.inspection) }) };
  });
}
export function parseAgentDetails(value: unknown): AgentDetails {
  const v = agentRecord(value);
  return { ...(v.execution === undefined ? {} : { execution: parseAgentExecutionHealth(v.execution) }),
    agent: parseManagedAgent(v.agent), ready: agentBoolean(v.ready), busy: agentBoolean(v.busy),
    authenticated: v.authenticated === null ? null : agentBoolean(v.authenticated),
    threadId: agentNullableText(v.threadId), error: agentNullableText(v.error),
    logs: agentText(v.logs, 256_000), tasks: parseAgentTasks(v.tasks) };
}
import type { AgentTerminalApi } from './agent-terminal.ts';
