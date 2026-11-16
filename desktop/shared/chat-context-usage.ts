export interface ChatContextUsage {
  usedTokens: number;
  contextWindow: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeChatContextUsage(value: unknown): ChatContextUsage | null {
  const usage = record(value);
  if (!usage || !tokenCount(usage.usedTokens)) return null;
  return {
    usedTokens: usage.usedTokens,
    contextWindow: tokenCount(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null,
  };
}

/** The latest request describes context occupancy; cumulative totals do not. */
export function contextUsageFromNotification(value: unknown): ChatContextUsage | null {
  const usage = record(value);
  return normalizeChatContextUsage({
    usedTokens: record(usage?.last)?.totalTokens,
    contextWindow: usage?.modelContextWindow,
  });
}

export function contextUsageFromRollout(value: unknown): ChatContextUsage | null {
  const info = record(value);
  return normalizeChatContextUsage({
    usedTokens: record(info?.last_token_usage)?.total_tokens,
    contextWindow: info?.model_context_window,
  });
}

export function contextUsagePercent(usage: ChatContextUsage | null | undefined): number | null {
  if (!usage?.contextWindow) return null;
  return Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100));
}
