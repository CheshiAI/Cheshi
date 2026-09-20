import { historyRecallRules } from './chat-history-recall-rules.mts';
import { recordValue } from './codex-service-utils.mts';
import type { RecallUsage } from '../shared/history-recall.ts';
import { recallResponseUsage } from './chat-history-recall-usage.mts';

export interface RecallCandidate {
  id: string;
  text: string;
  before: string;
  after: string;
  kind?: string;
  title?: string;
}
export type RecallFetch = (input: string, init: RequestInit) => Promise<Response>;
export interface RecallJudgment { answer: number; related: number; direct: number }
export type RecallEvaluator = (query: string, candidates: RecallCandidate[], signal: AbortSignal,
  onUsage?: (usage: RecallUsage) => void) => Promise<RecallJudgment[]>;
export const RECALL_REQUEST_BYTES = 28_000;

function probability(value: unknown): number {
  const answer = recordValue(value);
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
    || answer.noul < 0 || answer.noul > 1) throw new Error('TypeSafe returned an invalid history assessment.');
  return answer.noul;
}

function requestBody(query: string, candidates: RecallCandidate[]): string {
  const questions = Object.fromEntries(candidates.flatMap(candidate =>
    Object.entries(historyRecallRules(candidate.id)).map(([field, instructions]) =>
      [`${candidate.id}_${field}`, { type: 'noul', instructions }])));
  return JSON.stringify({ model: 'jev-latest', state: { query,
    passages: candidates.map(({ id, text, before, after, kind, title }) => ({ id, text, before, after, kind, title })),
  }, questions });
}

/** Independent Noul scores can be compared across batches; Choice probabilities cannot. */
export function createHistoryRecallEvaluator(options: {
  getKey(): string | null;
  request?: RecallFetch;
  fallback?: RecallEvaluator;
}): RecallEvaluator {
  const primary: RecallEvaluator = async (query, candidates, signal, onUsage) => {
    signal.throwIfAborted();
    if (!candidates.length) return [];
    const key = options.getKey();
    if (!key) throw new Error('Register or unlock your TypeSafe API key in Settings to search history by meaning.');
    const results: RecallJudgment[] = [];
    let batch: RecallCandidate[] = [];
    const send = async () => {
      if (!batch.length) return;
      signal.throwIfAborted();
      let response: Response;
      const started = performance.now();
      let raw: unknown;
      try {
        try { response = await (options.request ?? fetch)('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: requestBody(query, batch),
        }); } catch {
          signal.throwIfAborted();
          throw new Error('Could not reach TypeSafe for history search. Retry the search.');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`TypeSafe history search failed (HTTP ${response.status}).`);
        }
        try { raw = await response.json(); }
        catch { throw new Error('TypeSafe returned an unreadable history assessment.'); }
      } finally { onUsage?.(recallResponseUsage(raw, performance.now() - started)); }
      signal.throwIfAborted();
      const answers = recordValue(recordValue(raw)?.answers);
      for (const candidate of batch) results.push({
        answer: probability(answers?.[`${candidate.id}_answer`]), related: probability(answers?.[`${candidate.id}_related`]),
        direct: probability(answers?.[`${candidate.id}_direct`]),
      });
      batch = [];
    };
    for (const candidate of candidates) {
      if (Buffer.byteLength(requestBody(query, [...batch, candidate])) > RECALL_REQUEST_BYTES) await send();
      if (Buffer.byteLength(requestBody(query, [candidate])) > RECALL_REQUEST_BYTES) {
        throw new Error('A history passage exceeds the TypeSafe request limit.');
      }
      batch.push(candidate);
    }
    await send();
    return results;
  };
  return async (query, candidates, signal, onUsage) => {
    try {
      const primarySignal = options.fallback ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : signal;
      return await primary(query, candidates, primarySignal, onUsage);
    }
    catch (error) {
      signal.throwIfAborted();
      if (!options.fallback) throw error;
      // Reassess the whole requested page, never mix partial Jev and Luna batches.
      return options.fallback(query, candidates, signal, onUsage);
    }
  };
}
