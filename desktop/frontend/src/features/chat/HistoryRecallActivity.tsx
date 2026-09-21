import { createContext, useContext, useState } from 'react';
import { Search, ExternalLink, ChevronDown } from 'lucide-react';
import { sumRecallLunaUsage, type RecallMetrics, type RecallSource } from '../../../../shared/history-recall';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import type { ChatActivityItem, ChatTimelineItem } from './model';
import { MessageContent } from './MessageContent';
import styles from './HistoryRecallActivity.module.css';

export const HistoryRecallNavigation = createContext<{
  open(source: Pick<RecallSource, 'threadId' | 'itemId'>): Promise<boolean>;
  disabled: boolean;
} | null>(null);

export function formatRecallCost(metrics: RecallMetrics): string {
  if (metrics.estimatedCostUsd === null) return metrics.knownEstimatedCostUsd > 0
    ? `$${metrics.knownEstimatedCostUsd.toFixed(8)} known + unknown` : 'Unknown';
  return `$${metrics.estimatedCostUsd.toFixed(8)}`;
}

function RecallMetricsView({ metrics }: { metrics: RecallMetrics }) {
  return <div className={styles.metrics}>
    <span>Jev · {metrics.requests} requests</span>
    <span>Input: {metrics.inputTokens?.toLocaleString('en-US') ?? 'Unknown'}</span>
    <span>Output: {metrics.outputTokens?.toLocaleString('en-US') ?? 'Unknown'}</span>
    <span>Estimated USD: {formatRecallCost(metrics)}</span>
    <span>Total: {(metrics.totalMs / 1000).toFixed(2)}s · Jev: {(metrics.modelMs / 1000).toFixed(2)}s</span>
    {metrics.luna && <>
      <span>Luna low fallback · {metrics.luna.requests} requests · {(metrics.luna.modelMs / 1000).toFixed(2)}s</span>
      <span>Luna input: {metrics.luna.inputTokens?.toLocaleString('en-US') ?? 'Unknown'} · output: {metrics.luna.outputTokens?.toLocaleString('en-US') ?? 'Unknown'}</span>
      <span>Luna reasoning: {metrics.luna.reasoningOutputTokens?.toLocaleString('en-US') ?? 'Unknown'} · subscription usage cost: Unknown</span>
    </>}
    {metrics.cacheHits > 0 && <span>{metrics.cacheHits} cached assessments</span>}
    {metrics.unknownRequests > 0 && <span>{metrics.unknownRequests} requests with unknown cost</span>}
  </div>;
}

export function HistoryRecallActivity({ item }: { item: ChatActivityItem }) {
  const navigation = useContext(HistoryRecallNavigation);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recall = item.recall;
  if (!recall) return null;
  const open = async (source: RecallSource) => {
    if (!navigation || navigation.disabled || pending) return;
    setPending(true); setError(null);
    try { if (!await navigation.open(source)) setError('The source could not be opened. It may no longer be available.'); }
    catch { setError('The source could not be opened. Try again.'); }
    finally { setPending(false); }
  };
  return <LiquidGlassPanel as="article" className={styles.card} data-liquid-glass-backdrop="true">
    <div className={styles.heading}><Search aria-hidden="true" />
      <strong>{recall.operation === 'search' ? 'History search' : 'History source'}</strong>
      <span>{recall.status === 'error' ? 'Failed' : recall.partial ? 'Partial search' : recall.operation === 'read' ? 'Original message' : 'Searched selected scope'}</span>
    </div>
    {recall.query && <p>{recall.query}</p>}
    {recall.metrics && <RecallMetricsView metrics={recall.metrics} />}
    {recall.error && <p role="status">{recall.error}</p>}
    {recall.sources.length > 0 && <details>
      <summary className={styles.disclosureSummary}><ChevronDown className={styles.chevron} aria-hidden="true" />
        <span>{recall.sources.length} {recall.operation === 'search' ? 'candidate sources' : 'source'}</span>
      </summary>
      <div className={styles.sources}>{recall.sources.map(source => <div className={styles.source}
        key={`${source.threadId}:${source.turnId}:${source.itemId}`}>
        <strong>{source.title || 'Conversation'}</strong>
        <div className={styles.preview}><MessageContent text={source.text} /></div>
        <NeumorphicButton size="standard" disabled={!navigation || navigation.disabled || pending} onClick={() => void open(source)}>
          <ExternalLink aria-hidden="true" />Open original message
        </NeumorphicButton>
        <details className={styles.sourceIds}><summary className={styles.disclosureSummary}><ChevronDown className={styles.chevron} aria-hidden="true" />
          <span>Source IDs</span></summary><small>Session: {source.threadId}<br />Turn: {source.turnId}<br />Message: {source.itemId}</small></details>
      </div>)}</div>
    </details>}
    {error && <p role="status">{error}</p>}
  </LiquidGlassPanel>;
}

/** Sum each tool item once; saved history may contain repeated completion updates. */
export function sumRecallMetrics(items: ChatTimelineItem[]): RecallMetrics | null {
  const unique = new Map(items.filter((item): item is ChatActivityItem => item.kind === 'activity')
    .map(item => [item.id, item]));
  const values = [...unique.values()].flatMap(item => item.recall?.metrics ? [item.recall.metrics] : []);
  if (!values.length) return null;
  const sum = (field: Exclude<keyof RecallMetrics, 'luna'>) => values.reduce((total, value) => total + (value[field] ?? 0), 0);
  const nullableSum = (field: 'inputTokens' | 'outputTokens' | 'estimatedCostUsd') =>
    values.some(value => value[field] === null) ? null : sum(field);
  const luna = sumRecallLunaUsage(values.map(value => value.luna));
  return { ...(luna ? { luna } : {}), requests: sum('requests'), inputTokens: nullableSum('inputTokens'), outputTokens: nullableSum('outputTokens'),
    estimatedCostUsd: nullableSum('estimatedCostUsd'), knownEstimatedCostUsd: sum('knownEstimatedCostUsd'),
    unknownRequests: sum('unknownRequests'), modelMs: sum('modelMs'), totalMs: sum('totalMs'), cacheHits: sum('cacheHits') };
}

/** Keep usage attached to its own turn, including history without provider turn IDs. */
export function recallTurnMetrics(items: ChatTimelineItem[]): Map<string, RecallMetrics> {
  interface Turn { turnId?: string; items: ChatTimelineItem[]; lastItemId?: string }
  const turns = new Set<Turn>();
  const byId = new Map<string, Turn>();
  let current: Turn | undefined;
  for (const item of items) {
    if (item.kind === 'user' && (!item.turnId || !byId.has(item.turnId))) current = undefined;
    if (item.turnId) {
      const known = byId.get(item.turnId);
      if (known) current = known;
      else {
        if (!current || current.turnId) current = { items: [] };
        current.turnId = item.turnId;
        byId.set(item.turnId, current);
      }
    }
    current ??= { items: [] };
    turns.add(current);
    current.items.push(item);
    if (item.kind !== 'user') current.lastItemId = item.id;
  }
  const result = new Map<string, RecallMetrics>();
  for (const turn of turns) {
    const metrics = sumRecallMetrics(turn.items);
    if (metrics && turn.lastItemId) result.set(turn.lastItemId, metrics);
  }
  return result;
}

export function HistoryRecallTotals({ metrics }: { metrics: RecallMetrics | null | undefined }) {
  if (!metrics) return null;
  return <details className={styles.totals}>
    <summary className={styles.disclosureSummary}><ChevronDown className={styles.chevron} aria-hidden="true" />
      <span>History search · Jev estimated {formatRecallCost(metrics)} USD · {metrics.requests} requests</span>
    </summary>
    <RecallMetricsView metrics={metrics} />
    <p>Recorded calls in this turn only. Jev cost excludes Codex. Luna fallback tokens are listed separately when observed; subscription cost and unrecorded calls are unknown.
      {' '}Durations are summed per call, not wall-clock time.</p>
    <a href="https://docs.typesafe.ai/models" target="_blank" rel="noreferrer">Pricing verified 2026-09-19: $0.042 / 1M input tokens; output free.</a>
  </details>;
}
