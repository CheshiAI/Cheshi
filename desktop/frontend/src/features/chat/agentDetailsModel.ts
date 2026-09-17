import { normalizeAgentTokenUsage, type AgentTokenUsage } from '../../../../shared/chat-agent-details';
import { normalizeTimelineItem, type ChatTimelineItem } from './model';

export interface AgentDetails {
  id: string;
  title: string;
  status: string;
  model: string | null;
  reasoningEffort: string | null;
  usage: AgentTokenUsage | null;
  items: ChatTimelineItem[];
  omittedItems: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeAgentDetails(value: unknown, expectedIds: readonly string[]): AgentDetails[] {
  const response = record(value);
  if (!Array.isArray(response?.agents)) throw new Error('The agent details response is invalid.');
  const seen = new Set<string>();
  const agents = response.agents.map((raw): AgentDetails => {
    const agent = record(raw);
    if (!agent || typeof agent.id !== 'string' || !expectedIds.includes(agent.id) || seen.has(agent.id)
      || !Array.isArray(agent.items)) throw new Error('The agent details response does not match this card.');
    seen.add(agent.id);
    return {
      id: agent.id, title: typeof agent.title === 'string' ? agent.title : 'Agent',
      status: typeof agent.status === 'string' ? agent.status : 'unknown',
      model: typeof agent.model === 'string' ? agent.model : null,
      reasoningEffort: typeof agent.reasoningEffort === 'string' ? agent.reasoningEffort : null,
      usage: normalizeAgentTokenUsage(agent.usage),
      items: agent.items.map(normalizeTimelineItem).filter((item): item is ChatTimelineItem => item !== null),
      omittedItems: typeof agent.omittedItems === 'number' && Number.isSafeInteger(agent.omittedItems) && agent.omittedItems >= 0
        ? agent.omittedItems : 0,
    };
  });
  if (seen.size !== new Set(expectedIds).size) throw new Error('Some agent details are missing.');
  return agents;
}

/** A per-conversation cache shares reads across multiple cards for the same agents. */
export function createAgentDetailsLoader(read: (ids: string[]) => Promise<unknown>, now = Date.now) {
  const cache = new Map<string, { expires: number; result: Promise<AgentDetails[]> }>();
  return (ids: string[]): Promise<AgentDetails[]> => {
    const sorted = [...new Set(ids)].sort();
    const key = JSON.stringify(sorted);
    const existing = cache.get(key);
    if (existing && existing.expires > now()) return existing.result;
    const entry = { expires: Infinity, result: Promise.resolve().then(() => read(sorted))
      .then(raw => normalizeAgentDetails(raw, sorted)) };
    cache.set(key, entry);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    void entry.result.then(() => { entry.expires = now() + 2000; }, () => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return entry.result;
  };
}

export function agentCacheRate(usage: AgentTokenUsage): string {
  return usage.inputTokens > 0 && usage.cachedInputTokens !== null
    ? `${(usage.cachedInputTokens / usage.inputTokens * 100).toFixed(1)}%` : 'Not available';
}
