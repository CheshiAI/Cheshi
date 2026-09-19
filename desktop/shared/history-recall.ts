/** Only validated recall metadata crosses the MCP / renderer boundary. */
export interface RecallUsage {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  knownEstimatedCostUsd: number;
  unknownRequests: number;
  modelMs: number;
}
export interface RecallMetrics extends RecallUsage {
  totalMs: number;
  cacheHits: number;
}
export interface RecallSource {
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  text: string;
}
export interface HistoryRecallActivity {
  operation: 'search' | 'read';
  status: string;
  partial: boolean;
  query: string;
  metrics: RecallMetrics | null;
  sources: RecallSource[];
  error: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function count(value: unknown): number | null {
  return number(value) !== null && Number.isSafeInteger(value) ? value as number : null;
}
function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}
export function normalizeRecallMetrics(value: unknown): RecallMetrics | null {
  const raw = record(value);
  if (!raw) return null;
  const requests = count(raw.requests), cacheHits = count(raw.cacheHits), unknownRequests = count(raw.unknownRequests);
  const totalMs = number(raw.totalMs), modelMs = number(raw.modelMs), knownEstimatedCostUsd = number(raw.knownEstimatedCostUsd);
  if (requests === null || cacheHits === null || unknownRequests === null || unknownRequests > requests
    || totalMs === null || modelMs === null || knownEstimatedCostUsd === null) return null;
  return { requests, cacheHits, unknownRequests, totalMs, modelMs, knownEstimatedCostUsd,
    inputTokens: count(raw.inputTokens), outputTokens: count(raw.outputTokens),
    estimatedCostUsd: unknownRequests ? null : number(raw.estimatedCostUsd) };
}
export function normalizeRecallSource(value: unknown): RecallSource | null {
  const raw = record(value);
  if (!raw) return null;
  const ids = [raw.threadId, raw.turnId, raw.itemId];
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) return null;
  return { threadId: raw.threadId as string, turnId: raw.turnId as string, itemId: raw.itemId as string,
    title: text(raw.title, 200), text: text(raw.text, 600) };
}
export function normalizeHistoryRecallActivity(value: unknown): HistoryRecallActivity | null {
  const raw = record(value);
  if (!raw || (raw.operation !== 'search' && raw.operation !== 'read') || !Array.isArray(raw.sources)) return null;
  const sources = raw.sources.slice(0, 12).map(normalizeRecallSource).filter((source): source is RecallSource => source !== null);
  const unique = new Map<string, RecallSource>();
  for (const source of sources) {
    const key = JSON.stringify([source.threadId, source.turnId, source.itemId]);
    if (!unique.has(key)) unique.set(key, source);
  }
  return { operation: raw.operation, status: text(raw.status, 80), partial: raw.partial === true,
    query: text(raw.query, 500), metrics: normalizeRecallMetrics(raw.metrics), error: text(raw.error, 300) || null,
    sources: [...unique.values()].slice(0, 6) };
}

export function historyRecallFromMcp(server: unknown, tool: unknown, result: unknown): HistoryRecallActivity | null {
  if (server !== 'cheshi_history' || (tool !== 'history_search' && tool !== 'history_read')) return null;
  const envelope = record(result);
  let raw = record(envelope?.structuredContent);
  if (raw?.historyRecallVersion !== 1 && Array.isArray(envelope?.content)) {
    for (const value of envelope.content) {
      const block = record(value);
      if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 200_000) continue;
      try { raw = record(JSON.parse(block.text)); } catch { continue; }
      if (raw?.historyRecallVersion === 1) break;
    }
  }
  if (raw?.historyRecallVersion !== 1) return null;
  return normalizeHistoryRecallActivity({ operation: tool === 'history_search' ? 'search' : 'read',
    status: raw.status ?? 'read', partial: raw.partial, query: raw.query, metrics: raw.metrics,
    sources: tool === 'history_read' ? [raw] : [
      ...(Array.isArray(raw.originals) ? raw.originals : []),
      ...(Array.isArray(raw.matches) ? raw.matches : []),
    ], error: raw.error });
}
