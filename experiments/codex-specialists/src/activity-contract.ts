import { record } from './protocol.ts';

export interface TaskFileChange {
  path: string; kind: 'add' | 'delete' | 'update' | 'unknown'; diff: string; movePath: string | null;
}

export interface TaskActivity {
  id: string; turnId: string; kind: 'message' | 'command' | 'file' | 'tool';
  title: string; text: string; status: 'running' | 'completed' | 'failed' | 'unknown';
  createdAt: string; final: boolean; truncated: boolean;
  changes?: TaskFileChange[];
}
export const ACTIVITY_LIMIT = 400;
export const TEXT_LIMIT = 16000;
export const FILE_CHANGE_LIMIT = 100;

function parseFileChanges(value: unknown): TaskFileChange[] {
  if (!Array.isArray(value) || value.length > FILE_CHANGE_LIMIT) throw new TypeError('Invalid file changes.');
  let size = 0;
  return value.map(entry => {
    const v = record(entry);
    if (typeof v.path !== 'string' || !v.path || typeof v.diff !== 'string'
      || typeof v.kind !== 'string' || !['add', 'delete', 'update', 'unknown'].includes(v.kind)
      || (v.movePath !== null && typeof v.movePath !== 'string')) throw new TypeError('Invalid file change.');
    size += v.path.length + v.diff.length + (typeof v.movePath === 'string' ? v.movePath.length : 0);
    if (size > TEXT_LIMIT) throw new TypeError('File changes exceed the retained excerpt limit.');
    return { path: v.path, diff: v.diff, kind: v.kind as TaskFileChange['kind'], movePath: v.movePath as string | null };
  });
}

export function parseTaskActivity(value: unknown): TaskActivity {
  const v = record(value);
  for (const [key, limit] of [['id', 200], ['turnId', 200], ['title', 1000], ['text', TEXT_LIMIT], ['createdAt', 100]] as const) {
    if (typeof v[key] !== 'string' || v[key].length > limit) throw new TypeError('Invalid activity text.');
  }
  if (!v.id || !v.turnId || !Number.isFinite(Date.parse(v.createdAt as string))
    || !['message', 'command', 'file', 'tool'].includes(String(v.kind))
    || !['running', 'completed', 'failed', 'unknown'].includes(String(v.status))
    || typeof v.final !== 'boolean' || typeof v.truncated !== 'boolean') throw new TypeError('Invalid task activity.');
  return { id: v.id as string, turnId: v.turnId as string, kind: v.kind as TaskActivity['kind'], title: v.title as string,
    text: v.text as string, status: v.status as TaskActivity['status'], createdAt: v.createdAt as string, final: v.final, truncated: v.truncated,
    ...(v.changes === undefined ? {} : { changes: parseFileChanges(v.changes) }) };
}
export function parseTaskActivities(value: unknown): TaskActivity[] {
  if (!Array.isArray(value) || value.length > ACTIVITY_LIMIT) throw new TypeError('Invalid task activity list.');
  return value.map(parseTaskActivity);
}
