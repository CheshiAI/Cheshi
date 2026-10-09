import { record, textValue } from './protocol.ts';
import type { AgentStore, Task } from './store.ts';

export const INTAKE_WORKSPACE = '@intake';
export function isIntakeWorkspace(key: string | null): key is `@intake:${string}` { return key !== null && /^@intake:[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(key); }
function targetKey(task: Task): string | null {
  if (task.workspaceKey === null) return null;
  if (task.dialogue && !task.goal) return INTAKE_WORKSPACE;
  return task.workspaceKey ?? task.id;
}
export interface WorkspaceRun { input: string; messages: string[]; intakeRetry: boolean }
export function parseWorkspaceKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !(value === INTAKE_WORKSPACE || isIntakeWorkspace(value) || /^[a-zA-Z0-9_-]{1,80}$/.test(value))) throw new TypeError('Invalid task workspace key.');
  return value;
}
export function parseWorkspaceRun(value: unknown): WorkspaceRun {
  const v = record(value);
  if (!Array.isArray(v.messages) || !v.messages.every(m => typeof m === 'string') || typeof v.intakeRetry !== 'boolean') {
    throw new TypeError('Invalid pending workspace run.');
  }
  return { input: textValue(v.input, 'pending task input'), messages: v.messages, intakeRetry: v.intakeRetry };
}

/** A durable handoff before any model call. Only the host can replace the Docker mount. */
export class TaskWorkspaceGate {
  private readonly store: AgentStore;
  private readonly key: string | null;
  frozen = false;
  constructor(store: AgentStore, key: string | null) {
    this.store = store; this.key = key;
    // Tasks predating this protocol keep their original shared workspace and native history.
    store.transaction(state => { for (const task of state.tasks) if (task.workspaceKey === undefined) task.workspaceKey = null; });
  }
  pending(): Task | undefined { return this.store.snapshot().tasks.find(t => t.workspaceRun !== undefined); }
  allows(task: Task): boolean {
    const target = targetKey(task);
    return !this.frozen && (target === INTAKE_WORKSPACE ? isIntakeWorkspace(this.key) : target === this.key);
  }
  defer(task: Task, run: WorkspaceRun): boolean {
    const workspaceKey = task.workspaceKey === undefined ? task.id : task.workspaceKey;
    if (this.allows({ ...task, workspaceKey })) {
      this.store.update(task.id, { workspaceKey, workspaceRun: undefined });
      return false;
    }
    this.store.update(task.id, { workspaceKey, workspaceRun: run, status: 'waiting', finishedAt: null });
    return true;
  }
  prepare(busy: boolean) {
    if (busy || this.store.snapshot().tasks.some(t => t.status === 'unknown')) throw new Error('Worker cannot switch workspaces during execution.');
    const task = this.pending();
    if (!task || task.workspaceKey === undefined) return null;
    this.frozen = true;
    return { taskId: task.id, key: targetKey(task) };
  }
}
