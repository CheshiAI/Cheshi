export const AGENT_CHANNELS = {
  engines: 'cheshi:agents:engines', snapshot: 'cheshi:agents:snapshot',
  details: 'cheshi:agents:details', control: 'cheshi:agents:control',
} as const;
export const AGENT_ACTIONS = ['start', 'stop', 'restart'] as const;
export type AgentAction = typeof AGENT_ACTIONS[number];
export interface AgentEngineInfo { id: string; name: string; supported: boolean; reason: string | null }
export interface AgentCatalog { engines: AgentEngineInfo[]; error: string | null }
export interface ManagedAgent { id: string; name: string; state: string; image: string }
export interface AgentSnapshot { engineId: string; online: boolean; error: string | null; agents: ManagedAgent[] }
export interface AgentTask {
  id: string; prompt: string; status: string; createdAt: string; output: string; error: string | null;
}
export interface AgentDetails {
  agent: ManagedAgent; ready: boolean; busy: boolean; authenticated: boolean | null;
  threadId: string | null; error: string | null; logs: string; tasks: AgentTask[];
}
export interface AgentManagementApi {
  terminal?: AgentTerminalApi;
  engines(): Promise<AgentCatalog>;
  snapshot(engineId: string): Promise<AgentSnapshot>;
  details(engineId: string, agentId: string): Promise<AgentDetails>;
  control(engineId: string, agentId: string, action: AgentAction): Promise<AgentSnapshot>;
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
  return { id: parseAgentId(v.id), name: agentText(v.name), state: agentText(v.state, 100), image: agentText(v.image) };
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
export function parseAgentTasks(value: unknown): AgentTask[] {
  return items(value, 10_000).map(raw => {
    const t = agentRecord(raw);
    const status = agentText(t.status, 30);
    if (!['accepted', 'running', 'completed', 'interrupted', 'failed', 'unknown'].includes(status)) throw new TypeError('Invalid task status.');
    return { id: parseAgentId(t.id), prompt: agentText(t.prompt, 20_000), status,
      createdAt: agentText(t.createdAt, 100), output: agentText(t.output, 500_000), error: agentNullableText(t.error, 20_000) };
  });
}
export function parseAgentDetails(value: unknown): AgentDetails {
  const v = agentRecord(value);
  return { agent: parseManagedAgent(v.agent), ready: agentBoolean(v.ready), busy: agentBoolean(v.busy),
    authenticated: v.authenticated === null ? null : agentBoolean(v.authenticated),
    threadId: agentNullableText(v.threadId), error: agentNullableText(v.error),
    logs: agentText(v.logs, 256_000), tasks: parseAgentTasks(v.tasks) };
}
import type { AgentTerminalApi } from './agent-terminal.ts';
