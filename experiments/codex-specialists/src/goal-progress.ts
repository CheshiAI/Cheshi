import { createHash } from 'node:crypto';
import { record, type JsonRecord } from './protocol.ts';

export type GoalProgress = { unchanged: number; observations: string[] };
export type GoalUsage = { reportedThroughTurn: number; inputTokens: number; outputTokens: number; totalTokens: number };
export const isStalled = (progress: GoalProgress | undefined): boolean => (progress?.unchanged ?? 0) >= 3;
export const STALLED_GOAL = 'No new observable result in three consecutive judgment turns. Review the repeated work and provide a follow-up before resuming.';
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseProgress(value: unknown): GoalProgress {
  const v = record(value);
  if (!count(v.unchanged) || !Array.isArray(v.observations) || v.observations.length > 64
    || v.observations.some(s => typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s))) throw new Error('Invalid goal progress.');
  return { unchanged: v.unchanged, observations: v.observations as string[] };
}
export function parseUsage(value: unknown): GoalUsage {
  const v = record(value);
  if (![v.reportedThroughTurn, v.inputTokens, v.outputTokens, v.totalTokens].every(count)) throw new Error('Invalid goal usage.');
  return { reportedThroughTurn: Number(v.reportedThroughTurn), inputTokens: Number(v.inputTokens), outputTokens: Number(v.outputTokens), totalTokens: Number(v.totalTokens) };
}

// Delivery identities and telemetry must not turn the same result into new progress.
const metadata = new Set(['id', 'callId', 'requestId', 'questionId', 'threadId', 'turnId', 'createdAt', 'updatedAt', 'checkedAt', 'durationMs', 'elapsedMs', 'usage', 'metrics', 'activity', 'evidenceIds']);
function content(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(content);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, content(v)]));
}

/** Observed changes are a loop signal, never proof of goal completion. */
export class GoalObservations {
  private readonly values = new Set<string>();
  add(value: unknown): void {
    if (this.values.size < 64) this.values.add(createHash('sha256').update(JSON.stringify(content(value))).digest('hex'));
  }
  item(method: string, item: JsonRecord): void {
    if (method !== 'item/completed') return;
    if (item.type === 'commandExecution' && ['completed', 'failed'].includes(String(item.status)) && Number.isSafeInteger(item.exitCode)) {
      this.add({ type: item.type, command: item.command, exitCode: item.exitCode, output: item.aggregatedOutput });
    } else if (item.type === 'fileChange' && item.status === 'completed') {
      this.add({ type: item.type, changes: item.changes });
    } else if (item.type === 'mcpToolCall' && item.status === 'completed' && item.error == null && item.result != null) {
      const result = record(item.result);
      if (result.isError !== true) this.add({ type: item.type, server: item.server, tool: item.tool, result });
    }
  }
  finish(previous: GoalProgress | undefined): GoalProgress {
    const known = previous?.observations ?? [];
    const changed = [...this.values].some(value => !known.includes(value));
    return { unchanged: changed ? 0 : (previous?.unchanged ?? 0) + 1,
      observations: [...new Set([...known, ...this.values])].slice(-64) };
  }
}
