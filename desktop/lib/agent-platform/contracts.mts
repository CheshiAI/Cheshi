import { workScopePath } from '../../shared/isolated-work.ts';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type CandidateStatus = 'preparing' | 'prepared' | 'conflict' | 'checking' | 'passed' | 'failed' | 'stale' | 'unknown';

export interface ExecutionPlan {
  image: string;
  command: string[];
  timeoutMs: number;
  cpus: number;
  memoryMb: number;
}
export interface TaskInput {
  id: string;
  assignee: string;
  goal: string;
  reason: string;
  criteria: string[];
  /** Exact repository-relative paths, or directory prefixes ending in /. */
  scope: string[];
  dependencies: string[];
  execution: ExecutionPlan;
}
export interface ExecutionRequest extends ExecutionPlan {
  id: string;
  workspace: string;
  writable: boolean;
  task?: Pick<TaskInput, 'assignee' | 'goal' | 'reason' | 'scope' | 'criteria'>;
}
export interface ExecutionReceipt {
  id: string;
  image: string;
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
  session?: { threadId: string; agentId: string; accountId: string; model: string | null };
}
export interface PlatformExecutor {
  /** Stable execution boundary; a state directory must not silently switch engines. */
  identity: string;
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionReceipt>;
  inspect(id: string): Promise<'running' | 'stopped' | 'missing'>;
}
export interface Attempt {
  id: string;
  ownerPid: number;
  baseCommit: string;
  inputCommit: string | null;
  resultCommit: string | null;
  dependencyCommits: string[];
  workspace: string;
  branch: string;
  receipt: ExecutionReceipt | null;
  error: string | null;
  status: Exclude<TaskStatus, 'queued'>;
  startedAt: string;
  finishedAt: string | null;
}
export interface PlatformTask extends TaskInput {
  status: TaskStatus;
  attempts: Attempt[];
}
export interface CandidateCheck {
  id: string;
  plan: ExecutionPlan;
  receipt: ExecutionReceipt | null;
}
export interface IntegrationCandidate {
  id: string;
  ownerPid: number;
  baseCommit: string;
  taskIds: string[];
  taskCommits: string[];
  workspace: string;
  branch: string;
  commit: string | null;
  status: CandidateStatus;
  checks: CandidateCheck[];
  error: string | null;
}
export interface PlatformEvent {
  at: string;
  kind: string;
  subject: string;
  detail: string;
}
export interface PlatformState {
  version: 2;
  repository: string;
  baseRef: string;
  maxConcurrent: number;
  executorIdentity: string;
  tasks: PlatformTask[];
  candidates: IntegrationCandidate[];
  events: PlatformEvent[];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}
export function identifier(value: unknown): string {
  const id = text(value, 'identifier', 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Use lowercase letters, numbers, hyphens or underscores for identifiers.');
  return id;
}
export function commitId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Invalid Git commit.');
  return value;
}
export function imageId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Use a resolved local Docker image ID.');
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid execution limit.');
  return value;
}
export function concurrency(value: unknown): number {
  const result = number(value, 1, 32);
  if (!Number.isInteger(result)) throw new Error('Concurrency must be an integer.');
  return result;
}
export function strings(value: unknown, parse: (value: unknown) => string, min = 0, max = 128): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('Invalid list.');
  return value.map(parse);
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) throw new Error('Duplicate list entries.');
  return values;
}
export const scopePath = workScopePath;
export function inScope(path: string, scope: string[]): boolean {
  return scope.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
}
export function executionPlan(value: unknown): ExecutionPlan {
  const v = record(value);
  return { image: imageId(v.image), command: strings(v.command, value => text(value, 'command argument', 16_000), 1, 128),
    timeoutMs: number(v.timeoutMs, 100, 3_600_000), cpus: number(v.cpus, 0.1, 32), memoryMb: number(v.memoryMb, 32, 65_536) };
}
export function taskInput(value: unknown): TaskInput {
  const v = record(value);
  const input = { id: identifier(v.id), assignee: identifier(v.assignee), goal: text(v.goal, 'goal'), reason: text(v.reason, 'reason'),
    criteria: unique(strings(v.criteria, value => text(value, 'criterion'), 1, 32)),
    scope: unique(strings(v.scope, scopePath, 1)), dependencies: unique(strings(v.dependencies, identifier, 0, 32)),
    execution: executionPlan(v.execution) };
  if (input.dependencies.includes(input.id)) throw new Error('A task cannot depend on itself.');
  return input;
}
export function executionReceipt(value: unknown, request: Pick<ExecutionRequest, 'id' | 'image'>): ExecutionReceipt {
  const v = record(value);
  if (v.id !== request.id || v.image !== request.image || !Number.isInteger(v.exitCode) || Number(v.exitCode) < 0
    || Number(v.exitCode) > 255 || typeof v.output !== 'string' || v.output.length > 256_000) throw new Error('Invalid execution receipt.');
  const startedAt = text(v.startedAt, 'start time'), finishedAt = text(v.finishedAt, 'finish time');
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Invalid execution timestamps.');
  }
  const s = v.session === undefined ? null : record(v.session);
  const session = s ? { threadId: text(s.threadId, 'thread ID', 200), agentId: identifier(s.agentId),
    accountId: text(s.accountId, 'account ID', 100), model: s.model === null ? null : text(s.model, 'model', 200) } : undefined;
  return { id: identifier(v.id), image: imageId(v.image), exitCode: Number(v.exitCode), output: v.output, startedAt, finishedAt,
    ...(session ? { session } : {}) };
}
