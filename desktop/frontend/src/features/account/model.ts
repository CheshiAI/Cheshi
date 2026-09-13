import type { CodexAccountUsageStatus, CodexRateLimit, CodexRateLimitWindow } from '../../../../shared/codex-accounts';
export type { CodexAccountUsageStatus, CodexRateLimit, CodexRateLimitWindow } from '../../../../shared/codex-accounts';
export { weeklyGeneralWindow } from '../../../../shared/codex-account-usage';

export const EMPTY_CODEX_ACCOUNT_USAGE: CodexAccountUsageStatus = {
  state: 'stopped',
  authenticated: false,
  plan: null,
  rateLimits: [],
  error: null,
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const record = recordValue(value);
  const usedPercent = finiteNumber(record?.usedPercent);
  if (!record || usedPercent === null) return null;
  const windowDurationMins = record.windowDurationMins === null ? null : finiteNumber(record.windowDurationMins);
  const resetsAt = record.resetsAt === null ? null : finiteNumber(record.resetsAt);
  if ((record.windowDurationMins !== null && windowDurationMins === null)
    || (record.resetsAt !== null && resetsAt === null)
    || (windowDurationMins !== null && windowDurationMins < 0)
    || (resetsAt !== null && resetsAt < 0)) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

function normalizeRateLimits(value: unknown): CodexRateLimit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CodexRateLimit[] => {
    const record = recordValue(entry);
    if (!record || typeof record.limitId !== 'string' || !record.limitId) return [];
    const primary = normalizeRateLimitWindow(record.primary);
    const secondary = normalizeRateLimitWindow(record.secondary);
    if (!primary && !secondary) return [];
    return [{
      limitId: record.limitId,
      limitName: typeof record.limitName === 'string' ? record.limitName : null,
      plan: typeof record.plan === 'string' ? record.plan : null,
      primary,
      secondary,
    }];
  });
}

export function normalizeCodexAccountUsage(value: unknown): CodexAccountUsageStatus | null {
  const record = recordValue(value);
  if (!record) return null;
  const state = record.state;
  if (state !== 'stopped' && state !== 'starting' && state !== 'ready'
    && state !== 'login_required' && state !== 'error') return null;
  if (typeof record.authenticated !== 'boolean') return null;
  if (record.plan !== null && typeof record.plan !== 'string') return null;
  if (record.error !== null && typeof record.error !== 'string') return null;
  return {
    state,
    authenticated: record.authenticated,
    plan: record.plan,
    rateLimits: normalizeRateLimits(record.rateLimits),
    error: record.error,
  };
}
