import { FlashError, flashProviderDetails } from './client.mts';
import type { MemoryCandidate, RerankMemory } from './rerank.mts';

/** Keep each scope's local ordering without comparing scores from different corpora. */
export function interleaveCandidates(groups: MemoryCandidate[][]): MemoryCandidate[] {
  const result: MemoryCandidate[] = [];
  for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++) {
    for (const group of groups) if (group[i]) result.push(group[i]!);
  }
  return result;
}

export async function rankWithRecovery(query: string, candidates: MemoryCandidate[], signal: AbortSignal, rank?: RerankMemory, fallback = candidates) {
  signal.throwIfAborted();
  if (!rank) return { matches: candidates, ranking: 'source_order' as const };
  try { return { matches: await rank(query, candidates, signal), ranking: 'relevance' as const }; }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof FlashError) || !['model_unavailable', 'invalid_ranking', 'invalid_model_json'].includes(error.code)) throw error;
    return { matches: fallback, ranking: 'local_fallback' as const, degraded: true,
      ranking_error: error.code, ...flashProviderDetails(error, signal),
      notice: 'External reranking was unavailable. These are locally ranked candidates; relevance may be lower. Inspect the original excerpts before selecting records.' };
  }
}
