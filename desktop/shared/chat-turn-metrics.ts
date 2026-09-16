import { normalizeAgentTokenUsage, type AgentTokenUsage } from './chat-agent-details.ts';

export interface ChatTurnMetrics {
  turnId: string;
  itemIds: string[];
  agentName: string;
  model: string | null;
  reasoningEffort: string | null;
  usage: AgentTokenUsage | null;
  durationMs: number | null;
}

export interface ChatTurnMetricsResponse {
  threadId: string;
  turns: ChatTurnMetrics[];
}

export function normalizeTurnMetricsResponse(value: unknown, threadId: string): ChatTurnMetricsResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response statistics.');
  const response = value as Record<string, unknown>;
  if (response.threadId !== threadId || !Array.isArray(response.turns)) throw new Error('Response statistics belong to another conversation.');
  const turns = response.turns.map((value): ChatTurnMetrics => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid turn statistics.');
    const row = value as Record<string, unknown>;
    if (typeof row.turnId !== 'string' || !row.turnId || !Array.isArray(row.itemIds)
      || row.itemIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid turn identity.');
    return {
      turnId: row.turnId, itemIds: [...new Set(row.itemIds as string[])],
      agentName: typeof row.agentName === 'string' && row.agentName.trim() ? row.agentName : 'Main agent',
      model: typeof row.model === 'string' ? row.model : null,
      reasoningEffort: typeof row.reasoningEffort === 'string' ? row.reasoningEffort : null,
      usage: normalizeAgentTokenUsage(row.usage),
      durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
    };
  });
  return { threadId, turns };
}

/** End-to-end average, including tools and waits; reasoning is already part of output. */
export function averageTurnTps(metrics: Pick<ChatTurnMetrics, 'usage' | 'durationMs'>): number | null {
  if (!metrics.usage || metrics.durationMs === null || metrics.durationMs <= 0) return null;
  const tps = metrics.usage.outputTokens / (metrics.durationMs / 1000);
  return Number.isFinite(tps) ? tps : null;
}
