/** Bounded display projection. Provider credentials, request envelopes and arbitrary result fields never leave here. */
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
function metrics(value: unknown) {
  const raw = object(value), result: Record<string, unknown> = {};
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'estimatedCostUsd', 'knownEstimatedCostUsd', 'unknownRequests', 'modelMs', 'totalMs', 'cacheHits']) {
    result[key] = typeof raw[key] === 'number' && Number.isFinite(raw[key]) && Number(raw[key]) >= 0 ? raw[key] : null;
  }
  if (raw.luna) {
    const luna = object(raw.luna), usage: Record<string, unknown> = {};
    for (const key of ['requests', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'cachedInputTokens', 'modelMs']) {
      usage[key] = typeof luna[key] === 'number' && Number.isFinite(luna[key]) && Number(luna[key]) >= 0 ? luna[key] : null;
    }
    result.luna = usage;
  }
  return result;
}
export function inspectHistoryJob(job: { id: string; taskId: string; tool: string; args: unknown; status: string; result?: unknown }) {
  const raw = object(job.result), args = object(job.args);
  const candidates = job.tool === 'history_read' ? [raw] : [
    ...(Array.isArray(raw.originals) ? raw.originals : []), ...(Array.isArray(raw.matches) ? raw.matches : []),
  ];
  const seen = new Set<string>();
  const sources = candidates.flatMap(value => {
    const source = object(value), key = JSON.stringify([source.threadId, source.turnId, source.itemId]);
    if (seen.has(key) || !['threadId', 'turnId', 'itemId'].every(k => typeof source[k] === 'string')) return [];
    seen.add(key);
    return [{ threadId: text(source.threadId, 200), turnId: text(source.turnId, 200), itemId: text(source.itemId, 200),
      title: text(source.title, 200), text: text(source.text, 600) }];
  }).slice(0, 6);
  return { id: job.id, taskId: job.taskId, activity: {
    operation: job.tool === 'history_read' ? 'read' : 'search', status: text(raw.status, 80) || (job.status === 'pending' ? 'pending' : 'read'),
    partial: raw.partial === true, query: text(args.query, 500), error: text(raw.error, 300) || null,
    sources, metrics: raw.metrics ? metrics(raw.metrics) : null,
  } };
}
