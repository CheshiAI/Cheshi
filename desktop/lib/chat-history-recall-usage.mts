import { sumRecallLunaUsage, type RecallUsage } from '../shared/history-recall.ts';
import { recordValue } from './codex-service-utils.mts';

// https://docs.typesafe.ai/models — verified 2026-09-19. Unknown versions are not priced.
export const JEV_INPUT_USD_PER_MILLION = 0.042;
export const JEV_PRICING_DATE = '2026-09-19';
export const JEV_PRICING_URL = 'https://docs.typesafe.ai/models';

export function emptyRecallUsage(): RecallUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    knownEstimatedCostUsd: 0, unknownRequests: 0, modelMs: 0 };
}
function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function recallResponseUsage(value: unknown, modelMs: number): RecallUsage {
  const raw = recordValue(value), usage = recordValue(raw?.usage);
  const inputTokens = tokens(usage?.input_tokens), outputTokens = tokens(usage?.output_tokens);
  const estimatedCostUsd = raw?.model === 'jev-1.13.0' && inputTokens !== null
    ? inputTokens * JEV_INPUT_USD_PER_MILLION / 1_000_000 : null;
  return { requests: 1, inputTokens, outputTokens, estimatedCostUsd,
    knownEstimatedCostUsd: estimatedCostUsd ?? 0, unknownRequests: estimatedCostUsd === null ? 1 : 0, modelMs };
}
export function addRecallUsage(target: RecallUsage, value: RecallUsage): void {
  const luna = sumRecallLunaUsage([target.luna, value.luna]);
  if (luna) target.luna = luna;
  target.requests += value.requests;
  target.inputTokens = target.inputTokens === null || value.inputTokens === null ? null : target.inputTokens + value.inputTokens;
  target.outputTokens = target.outputTokens === null || value.outputTokens === null ? null : target.outputTokens + value.outputTokens;
  target.estimatedCostUsd = target.estimatedCostUsd === null || value.estimatedCostUsd === null
    ? null : target.estimatedCostUsd + value.estimatedCostUsd;
  target.knownEstimatedCostUsd += value.knownEstimatedCostUsd;
  target.unknownRequests += value.unknownRequests;
  target.modelMs += value.modelMs;
}
