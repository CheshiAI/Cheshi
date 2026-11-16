import { record, textValue } from './protocol.ts';

export interface TokenTotals {
  inputTokens: number; cachedInputTokens: number | null; outputTokens: number; totalTokens: number;
}
export interface TurnUsage {
  threadId: string; turnId: string;
  // Counts only native responses with usage records, not unreported failed requests.
  modelCalls: number | null; tokens: TokenTotals | null;
  // Native notifications are cumulative for the thread, never additive task usage.
  threadTotals: TokenTotals | null;
}
export interface TaskUsage { turns: TurnUsage[] }
export const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseTokenTotals(value: unknown): TokenTotals {
  const v = record(value);
  if (![v.inputTokens, v.outputTokens, v.totalTokens].every(tokenCount)
    || (v.cachedInputTokens != null && (!tokenCount(v.cachedInputTokens) || v.cachedInputTokens > Number(v.inputTokens)))) throw new TypeError('Invalid token usage.');
  return { inputTokens: Number(v.inputTokens), cachedInputTokens: v.cachedInputTokens == null ? null : Number(v.cachedInputTokens),
    outputTokens: Number(v.outputTokens), totalTokens: Number(v.totalTokens) };
}
export function parseTaskUsage(value: unknown): TaskUsage {
  const v = record(value);
  if (!Array.isArray(v.turns)) throw new TypeError('Invalid task usage.');
  const seen = new Set<string>();
  return { turns: v.turns.map(raw => {
    const t = record(raw), threadId = textValue(t.threadId, 'usage thread'), turnId = textValue(t.turnId, 'usage turn');
    const key = JSON.stringify([threadId, turnId]);
    if (seen.has(key) || (t.modelCalls !== null && (!tokenCount(t.modelCalls) || t.modelCalls === 0))
      || (t.modelCalls === null) !== (t.tokens === null)) throw new TypeError('Invalid response usage.');
    seen.add(key);
    return { threadId, turnId, modelCalls: t.modelCalls as number | null,
      tokens: t.tokens === null ? null : parseTokenTotals(t.tokens),
      threadTotals: t.threadTotals === null ? null : parseTokenTotals(t.threadTotals) };
  }) };
}
export function mergeTurnUsage(previous: TaskUsage | undefined, next: TurnUsage): TaskUsage {
  const turns = [...(previous?.turns ?? [])];
  const index = turns.findIndex(t => t.threadId === next.threadId && t.turnId === next.turnId);
  if (index < 0) turns.push(next); else turns[index] = next;
  return { turns };
}
