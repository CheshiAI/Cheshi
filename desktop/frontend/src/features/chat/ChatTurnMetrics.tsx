import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { averageTurnTps, normalizeTurnMetricsResponse, type ChatTurnMetrics as TurnMetrics } from '../../../../shared/chat-turn-metrics';
import { cheshiDesktop } from '../../cheshiDesktop';
import { Tooltip } from '../../shared/ui';
import styles from './ChatTurnMetrics.module.css';

const emptyMetrics: ReadonlyMap<string, TurnMetrics> = new Map();
const MetricsContext = createContext(emptyMetrics);

export function latestResponseItemId(items: ReadonlyArray<{ id: string; kind: string }>): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === 'assistant' || item.kind === 'plan') return item.id;
  }
  return undefined;
}

export function ChatTurnMetricsProvider({ threadId, contextId, active, streaming, expectedItemId, children }: {
  threadId: string | null; contextId?: string; active: boolean; streaming: boolean; expectedItemId?: string; children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; turns: Map<string, TurnMetrics> } | null>(null);
  useEffect(() => {
    const read = cheshiDesktop?.readCodexTurnMetrics;
    if (!threadId || !active || streaming || !read) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      try {
        const raw = await read(threadId, contextId);
        if (cancelled) return;
        const response = normalizeTurnMetricsResponse(raw, threadId);
        const turns = new Map(response.turns.flatMap(turn => turn.itemIds.map(id => [id, turn] as const)));
        setSnapshot({ threadId, turns });
        // Completion can arrive before the last usage record is flushed. Retry briefly, never poll indefinitely.
        const last = expectedItemId ? turns.get(expectedItemId) : response.turns.at(-1);
        if (attempt < 2 && (!last || !last.usage || last.durationMs === null)) timer = setTimeout(() => void load(attempt + 1), 750);
      } catch {
        if (!cancelled && attempt < 2) timer = setTimeout(() => void load(attempt + 1), 750);
      }
    };
    void load(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [threadId, contextId, active, streaming, expectedItemId]);
  return <MetricsContext.Provider value={snapshot?.threadId === threadId ? snapshot.turns : emptyMetrics}>{children}</MetricsContext.Provider>;
}

const unavailable = 'Not available';
const number = (value: number | null | undefined) => value == null ? unavailable : value.toLocaleString('en-US');

export function TurnMetricsSummary({ metrics }: { metrics?: TurnMetrics }) {
  const usage = metrics?.usage;
  const rate = usage && usage.cachedInputTokens !== null && usage.inputTokens > 0
    ? `${(usage.cachedInputTokens / usage.inputTokens * 100).toFixed(1)}%` : unavailable;
  const tps = metrics ? averageTurnTps(metrics) : null;
  return <div className={styles.root} aria-label="Response statistics">
    <div className={styles.row}><span>Agent: {metrics?.agentName ?? 'Main agent'}</span>
      <span>Model: {metrics?.model ?? unavailable}</span><span>Effort: {metrics?.reasoningEffort ?? unavailable}</span>
      <span>Duration: {metrics?.durationMs != null ? `${(metrics.durationMs / 1000).toFixed(1)}s` : unavailable}</span>
      <Tooltip content="Output tokens divided by total response time, including tool execution and waits. Reasoning tokens are included in output.">{props =>
        <span {...props} tabIndex={0}>Avg TPS: {tps === null ? unavailable : tps.toFixed(1)}</span>
      }</Tooltip>
    </div>
    <div className={styles.row}>
      <span>Input: {number(usage?.inputTokens)}</span><span>Cached input: {number(usage?.cachedInputTokens)}</span>
      <span>Cache reuse: {rate}</span><span>Cache write: {number(usage?.cacheWriteInputTokens)}</span>
      <span>Output: {number(usage?.outputTokens)}</span><span>Reasoning (within output): {number(usage?.reasoningOutputTokens)}</span>
    </div>
  </div>;
}

export function ChatTurnMetrics({ itemId }: { itemId: string }) {
  const metrics = useContext(MetricsContext);
  return <TurnMetricsSummary metrics={metrics.get(itemId)} />;
}
