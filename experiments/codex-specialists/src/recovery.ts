import { record } from './protocol.ts';
import type { Task } from './store.ts';

const terminalStatuses = ['completed', 'interrupted', 'failed'];
export type RecoveryReceipt = { threadId: string; turnId: string; status: 'completed' | 'interrupted' | 'failed'; checkedAt: string };
export function recoveryReceipt(value: unknown): RecoveryReceipt {
  const v = record(value);
  if (typeof v.threadId !== 'string' || !v.threadId || v.threadId.length > 200 || typeof v.turnId !== 'string' || !v.turnId || v.turnId.length > 200
    || !terminalStatuses.includes(String(v.status)) || typeof v.checkedAt !== 'string'
    || !Number.isFinite(Date.parse(v.checkedAt))) throw new Error('Invalid recovery receipt.');
  return { threadId: v.threadId, turnId: v.turnId, status: v.status as RecoveryReceipt['status'], checkedAt: v.checkedAt };
}

/** Recover only the exact acknowledged turn, never a nearby turn or model claim. */
export function inspectRecovery(task: Task, response: unknown, workspace: string): { receipt: RecoveryReceipt; output: string } {
  if (!task.threadId || !task.turnId) throw new Error('The execution has no acknowledged turn ID. Its outcome remains unknown.');
  const thread = record(record(response).thread);
  if (thread.id !== task.threadId || thread.cwd !== workspace || thread.parentThreadId != null || thread.ephemeral === true
    || !Array.isArray(thread.turns)) throw new Error('Native conversation scope changed. Its outcome remains unknown.');
  const turns = thread.turns.map(record), matches = turns.filter(t => t.id === task.turnId);
  if (matches.length !== 1 || turns.at(-1)?.id !== task.turnId) throw new Error('The saved turn is missing or no longer the latest turn. Its outcome remains unknown.');
  const turn = matches[0]!;
  if (!terminalStatuses.includes(String(turn.status))) throw new Error('The saved turn has not ended. Its outcome remains unknown.');
  if (!Array.isArray(turn.items)) throw new Error('Native turn output is unavailable.');
  const output = turn.items.map(record).filter(i => i.type === 'agentMessage' && (i.phase == null || i.phase === 'final_answer'))
    .map(i => { if (typeof i.text !== 'string') throw new Error('Invalid native turn output.'); return i.text; }).join('\n\n');
  if (output.length > 500_000) throw new Error('Native turn output exceeds the inspection limit.');
  return { receipt: recoveryReceipt({ threadId: task.threadId, turnId: task.turnId, status: turn.status, checkedAt: new Date().toISOString() }), output };
}
