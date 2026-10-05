import { createHash } from 'node:crypto';
import { record, type JsonRecord } from './protocol.ts';
import type { AgentStore, Task } from './store.ts';

import { ACTIVITY_LIMIT, FILE_CHANGE_LIMIT, TEXT_LIMIT, type TaskActivity, type TaskFileChange } from './activity-contract.ts';

const string = (value: unknown) => typeof value === 'string' ? value : '';

function retainFileChanges(value: unknown) {
  const source = Array.isArray(value) ? value : [], changes: TaskFileChange[] = [];
  let remaining = TEXT_LIMIT, truncated = false;
  for (const entry of source) {
    const v = record(entry), path = string(v.path);
    const kindData = v.kind && typeof v.kind === 'object' && !Array.isArray(v.kind) ? record(v.kind) : {};
    const rawKind = typeof v.kind === 'string' ? v.kind : kindData.type;
    const kind = rawKind === 'add' || rawKind === 'delete' || rawKind === 'update' ? rawKind : 'unknown';
    const movePath = string(kindData.move_path ?? kindData.movePath ?? v.movePath) || null;
    const metadataSize = path.length + (movePath?.length ?? 0);
    if (!path || metadataSize > remaining || changes.length >= FILE_CHANGE_LIMIT) { truncated = true; break; }
    remaining -= metadataSize;
    const sourceDiff = string(v.diff);
    let diff = sourceDiff.slice(0, remaining);
    if (diff.length < sourceDiff.length) {
      // Never count an unfinished line as a complete addition or deletion.
      diff = diff.slice(0, Math.max(0, diff.lastIndexOf('\n') + 1));
      truncated = true;
    }
    changes.push({ path, kind, movePath, diff }); remaining -= diff.length;
    if (truncated) break;
  }
  return { changes, truncated };
}

/** Public messages and tool receipts only. Exclude reasoning and raw protocol envelopes. */
export function recordTaskActivity(store: AgentStore, taskId: string, method: string, item: JsonRecord, turnId: string) {
  if (!['item/started', 'item/completed'].includes(method) || typeof item.id !== 'string') return;
  let kind: TaskActivity['kind'], title: string, text: string;
  switch (item.type) {
    case 'agentMessage':
      if (method !== 'item/completed' || !item.text) return;
      kind = 'message'; title = ''; text = string(item.text); break;
    case 'commandExecution': kind = 'command'; title = string(item.command); text = string(item.aggregatedOutput); break;
    case 'fileChange':
      kind = 'file'; title = 'File changes';
      text = (Array.isArray(item.changes) ? item.changes : []).map(value => {
        const change = record(value); return `${string(change.path)}\n${string(change.diff)}`;
      }).join('\n\n'); break;
    case 'mcpToolCall':
      kind = 'tool'; title = [string(item.server), string(item.tool)].filter(Boolean).join(' · ');
      text = item.error ? JSON.stringify(item.error) : item.result ? JSON.stringify(item.result) : ''; break;
    case 'webSearch': kind = 'tool'; title = 'Web search'; text = string(item.query); break;
    default: return;
  }
  const failed = item.status === 'failed' || item.status === 'declined' || item.error != null
    || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    || (item.result != null && typeof item.result === 'object' && 'isError' in item.result && item.result.isError === true);
  const status = failed ? 'failed' : method === 'item/started' ? 'running'
    : item.status === 'inProgress' ? 'unknown' : 'completed';
  const id = createHash('sha256').update(`${turnId}/${item.id}`).digest('hex');
  const task = store.task(taskId);
  if (!task) return;
  const activity = task.activity ?? [], previous = activity.find(entry => entry.id === id);
  if (previous && method === 'item/started') return;
  const files = kind === 'file' ? retainFileChanges(item.changes) : undefined;
  const entry: TaskActivity = { id, turnId, kind, title: title.slice(0, 1000), text: text.slice(0, TEXT_LIMIT), status,
    createdAt: previous?.createdAt ?? new Date().toISOString(), final: kind === 'message' && (item.phase == null || item.phase === 'final_answer'),
    truncated: title.length > 1000 || text.length > TEXT_LIMIT || files?.truncated === true,
    ...(files ? { changes: files.changes } : {}) };
  let next = previous ? activity.map(value => value.id === id ? entry : value) : [...activity, entry];
  let truncated = task.activityTruncated === true || next.length > ACTIVITY_LIMIT;
  next = next.slice(-ACTIVITY_LIMIT);
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next)) > 512_000) { next.shift(); truncated = true; }
  store.update(taskId, { activity: next, activityTruncated: truncated });
}

/** Keep execution excerpts within the existing bounded worker inspection response. */
export function projectTaskActivities(tasks: Task[]): Task[] {
  let remaining = 512_000;
  return [...tasks].reverse().map(task => {
    if (!task.activity) return task;
    const retained: TaskActivity[] = [];
    for (const entry of [...task.activity].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (size > remaining) break;
      remaining -= size; retained.push(entry);
    }
    return { ...task, activity: retained.reverse(), activityTruncated: task.activityTruncated === true || retained.length < task.activity.length };
  }).reverse();
}
