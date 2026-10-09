export interface WorkerWorkspaceInspection {
  state: 'ready' | 'missing' | 'unavailable';
  workspace: string | null; branch: string | null; baseCommit: string | null; baseBranch: string | null;
  kind: 'task' | 'intake' | 'legacy' | null;
  changes: { path: string; status: string }[];
  diff: string; truncated: boolean; error: string | null; checkedAt: string;
}

export function parseWorkerWorkspaceInspection(value: unknown): WorkerWorkspaceInspection {
  if (!value || typeof value !== 'object') throw new Error('Invalid worktree inspection.');
  const v = value as Record<string, unknown>;
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid worktree text.');
    return value;
  };
  const nullable = (value: unknown, max = 4096) => value === null ? null : text(value, max);
  if (!['ready', 'missing', 'unavailable'].includes(String(v.state)) || ![null, 'task', 'intake', 'legacy'].includes(v.kind as string | null)
    || typeof v.truncated !== 'boolean' || !Array.isArray(v.changes) || v.changes.length > 200) throw new Error('Invalid worktree inspection.');
  const baseCommit = nullable(v.baseCommit, 64), checkedAt = text(v.checkedAt, 100);
  if ((baseCommit !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) || !Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid worktree revision or time.');
  const workspace = nullable(v.workspace), branch = nullable(v.branch, 1000);
  if (v.state === 'ready' && (!workspace || !branch || !baseCommit || !v.kind)) throw new Error('Missing worktree identity.');
  return { state: v.state as WorkerWorkspaceInspection['state'], workspace, branch, baseCommit,
    baseBranch: nullable(v.baseBranch, 1000), kind: v.kind as WorkerWorkspaceInspection['kind'],
    changes: v.changes.map(raw => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid worktree change.');
      const change = raw as Record<string, unknown>;
      return { path: text(change.path, 4096), status: text(change.status, 20) };
    }), diff: text(v.diff, 160000), truncated: v.truncated, error: nullable(v.error), checkedAt };
}
import type { RoomMessage } from './agent-chats.ts';

export function workerWorkspaceTarget(message: RoomMessage): { agentId: string; taskId: string } | null {
  if (message.isolated) return null;
  if (message.relatedTask) return message.relatedTask;
  const agentId = message.sender === 'user' ? message.recipient : message.sender;
  return agentId && agentId !== 'user' && message.taskId ? { agentId, taskId: message.taskId } : null;
}
