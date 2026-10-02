import { isCodexAccountId } from './codex-accounts.ts';
import type { AgentModel, AgentModelSelection } from './agent-models.ts';

export const AGENT_REGISTRY_CHANNELS = {
  list: 'cheshi:agent-registry:list', save: 'cheshi:agent-registry:save', changed: 'cheshi:agent-registry:changed',
  models: 'cheshi:agent-registry:models',
  remove: 'cheshi:agent-registry:remove',
} as const;
export const SPECIALIST_ROLES = ['planning', 'research', 'frontend', 'development', 'verification', 'custom'] as const;
export type SpecialistRole = typeof SPECIALIST_ROLES[number];
export interface SpecialistProfile extends AgentModelSelection {
  name: string; role: SpecialistRole; instructions: string;
  accountId: string | null;
  permissions: { fileWrite: boolean; commandExecution: boolean };
}
export interface SpecialistAssignment { workspaceRoot: string; instructions: string; }
export interface SpecialistAgent extends SpecialistProfile {
  id: string; revision: number; createdAt: string; updatedAt: string; assignments: SpecialistAssignment[];
}
export interface AgentRegistrySnapshot { agents: SpecialistAgent[]; workspaceRoot: string; }
export interface SaveSpecialistAgent {
  id: string | null; revision: number | null; profile: SpecialistProfile;
  assignment: { assigned: boolean; instructions: string };
}
export interface AgentRegistryApi {
  remove?(request: DeleteSpecialistAgent): Promise<AgentRegistrySnapshot>;
  runtime?(request: import('./agent-runtime.ts').AgentRuntimeRequest): Promise<import('./agent-runtime.ts').AgentRuntimeState>;
  models(accountId: string): Promise<AgentModel[]>;
  list(): Promise<AgentRegistrySnapshot>;
  save(input: SaveSpecialistAgent): Promise<{ agentId: string; snapshot: AgentRegistrySnapshot }>;
  onDidChange(listener: (snapshot: AgentRegistrySnapshot) => void): () => void;
}

export interface DeleteSpecialistAgent { id: string; revision: number; deleteData: boolean }
export function parseDeleteSpecialistAgent(value: unknown): DeleteSpecialistAgent {
  const data = record(value);
  return { id: agentId(data.id), revision: revision(data.revision), deleteData: flag(data.deleteData) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent configuration.');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (required && !value.trim())) {
    throw new TypeError('Invalid agent configuration text.');
  }
  return value;
}
function flag(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid agent permission.');
  return value;
}
function agentId(value: unknown): string {
  const id = text(value, 36, true);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new TypeError('Invalid specialist agent ID.');
  return id;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid agent revision.');
  return value;
}
function profile(value: unknown): SpecialistProfile {
  const data = record(value), permissions = record(data.permissions);
  if (!SPECIALIST_ROLES.some(role => role === data.role)) throw new TypeError('Invalid specialist role.');
  if (data.accountId !== null && !isCodexAccountId(data.accountId)) throw new TypeError('Invalid agent account.');
  return { name: text(data.name, 100, true).trim(), role: data.role as SpecialistRole,
    instructions: text(data.instructions, 20_000, true), accountId: data.accountId as string | null,
    model: data.model === null ? null : text(data.model, 200, true).trim(),
    reasoningEffort: data.reasoningEffort == null ? null : text(data.reasoningEffort, 100, true).trim(),
    serviceTier: data.serviceTier == null ? null : text(data.serviceTier, 100, true).trim(),
    permissions: { fileWrite: flag(permissions.fileWrite), commandExecution: flag(permissions.commandExecution) } };
}
export function parseSaveSpecialistAgent(value: unknown): SaveSpecialistAgent {
  const data = record(value), assignment = record(data.assignment);
  if ((data.id === null) !== (data.revision === null)) throw new TypeError('Agent ID and revision must be supplied together.');
  return { id: data.id === null ? null : agentId(data.id), revision: data.revision === null ? null : revision(data.revision),
    profile: profile(data.profile), assignment: { assigned: flag(assignment.assigned), instructions: text(assignment.instructions, 20_000) } };
}
export function parseSpecialistAgents(value: unknown): SpecialistAgent[] {
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError('Invalid specialist agent registry.');
  const ids = new Set<string>();
  return value.map(raw => {
    const data = record(raw), id = agentId(data.id);
    if (ids.has(id)) throw new TypeError('Duplicate specialist agent ID.');
    ids.add(id);
    if (!Array.isArray(data.assignments) || data.assignments.length > 1000) throw new TypeError('Invalid agent assignments.');
    const roots = new Set<string>();
    const assignments = data.assignments.map(rawAssignment => {
      const assignment = record(rawAssignment), workspaceRoot = text(assignment.workspaceRoot, 4096, true);
      if (roots.has(workspaceRoot)) throw new TypeError('Duplicate agent assignment.');
      roots.add(workspaceRoot);
      return { workspaceRoot, instructions: text(assignment.instructions, 20_000) };
    });
    const createdAt = text(data.createdAt, 40, true), updatedAt = text(data.updatedAt, 40, true);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new TypeError('Invalid agent timestamp.');
    return { ...profile(data), id, revision: revision(data.revision), createdAt, updatedAt, assignments };
  });
}
export function parseAgentRegistrySnapshot(value: unknown): AgentRegistrySnapshot {
  const data = record(value);
  return { agents: parseSpecialistAgents(data.agents), workspaceRoot: text(data.workspaceRoot, 4096, true) };
}
export function parseAgentRegistrySaveResult(value: unknown): { agentId: string; snapshot: AgentRegistrySnapshot } {
  const data = record(value), id = agentId(data.agentId), snapshot = parseAgentRegistrySnapshot(data.snapshot);
  if (!snapshot.agents.some(agent => agent.id === id)) throw new TypeError('Saved agent is missing from registry.');
  return { agentId: id, snapshot };
}
