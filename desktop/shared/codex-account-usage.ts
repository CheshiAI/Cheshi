import type { CodexAccountsSnapshot, CodexAccountUsageStatus, CodexRateLimitWindow } from './codex-accounts.ts';

export function weeklyGeneralWindow(status: CodexAccountUsageStatus): CodexRateLimitWindow | null {
  const general = status.rateLimits.find(limit => limit.limitId.toLowerCase() === 'codex');
  return [general?.primary, general?.secondary].find(window => window?.windowDurationMins === 10_080) ?? null;
}

export function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function accountUsageTotals(snapshot: CodexAccountsSnapshot | null): {
  remaining: number; capacity: number; percent: number; accountCount: number;
} | null {
  const accounts = snapshot?.profiles.filter(({ usage, login }) =>
    usage.authenticated === true && usage.state !== 'login_required' && login.state !== 'signed_out') ?? [];
  if (accounts.length === 0) return null;
  let remaining = 0;
  for (const { usage, login } of accounts) {
    const weekly = weeklyGeneralWindow(usage);
    if (usage.state !== 'ready' || login.state !== 'signed_in' || login.error !== null
      || !weekly || !Number.isFinite(weekly.usedPercent)) return null;
    remaining += remainingPercent(weekly.usedPercent);
  }
  const capacity = accounts.length * 100;
  return { remaining: Math.round(remaining), capacity, percent: remaining / capacity * 100, accountCount: accounts.length };
}
