export interface ChatAgentActivity {
  threadIds: string[];
  tool: string | null;
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentPath: string | null;
}

export interface AgentTokenUsage {
  inputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  totalTokens: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeAgentActivity(value: unknown): ChatAgentActivity | null {
  const data = record(value);
  if (!data) return null;
  const ids = Array.isArray(data.threadIds) ? data.threadIds : [];
  return {
    threadIds: [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))],
    tool: text(data.tool), prompt: text(data.prompt), model: text(data.model),
    reasoningEffort: text(data.reasoningEffort), agentPath: text(data.agentPath),
  };
}

export function agentActivityFromItem(value: Record<string, unknown>): ChatAgentActivity {
  const ids = Array.isArray(value.receiverThreadIds) ? value.receiverThreadIds : [];
  return normalizeAgentActivity({ ...value, threadIds: [...ids, value.agentThreadId, value.receiverThreadId, value.newThreadId] })!;
}

/** Missing optional counters stay unknown; zero is only shown for a reported zero. */
export function normalizeAgentTokenUsage(value: unknown): AgentTokenUsage | null {
  const data = record(value);
  if (!data) return null;
  const inputTokens = count(data.inputTokens);
  const outputTokens = count(data.outputTokens);
  const totalTokens = count(data.totalTokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  const cached = count(data.cachedInputTokens);
  const writes = count(data.cacheWriteInputTokens);
  const reasoning = count(data.reasoningOutputTokens);
  return {
    inputTokens, outputTokens, totalTokens,
    cachedInputTokens: cached !== null && cached <= inputTokens ? cached : null,
    cacheWriteInputTokens: writes !== null && writes <= inputTokens ? writes : null,
    reasoningOutputTokens: reasoning !== null && reasoning <= outputTokens ? reasoning : null,
  };
}

export function agentUsageFromRollout(value: unknown): AgentTokenUsage | null {
  const data = record(value);
  return data ? normalizeAgentTokenUsage({
    inputTokens: data.input_tokens, cachedInputTokens: data.cached_input_tokens,
    cacheWriteInputTokens: data.cache_write_input_tokens, outputTokens: data.output_tokens,
    reasoningOutputTokens: data.reasoning_output_tokens, totalTokens: data.total_tokens,
  }) : null;
}
