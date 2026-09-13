import type { CodexAccountProfile, CodexAccountsSnapshot, CodexRateLimitWindow } from '../shared/codex-accounts.ts';

export interface CodexAccountChoice {
  accountId: string | null;
  message: string | null;
  resetsAt: number | null;
}

type Availability = { state: 'available' | 'exhausted' | 'unknown'; resetsAt: number | null };

function validUsage(window: CodexRateLimitWindow): boolean {
  return Number.isFinite(window.usedPercent) && window.usedPercent >= 0;
}

function availability(profile: CodexAccountProfile, now: number): Availability {
  if (profile.usage.authenticated !== true || profile.usage.state !== 'ready') {
    return { state: 'unknown', resetsAt: null };
  }
  const windows = profile.usage.rateLimits.filter(limit => limit.limitId === 'codex')
    .flatMap(limit => [limit.primary, limit.secondary])
    .filter((window): window is CodexRateLimitWindow => window !== null);
  const exhausted = windows.filter(window => validUsage(window) && window.usedPercent >= 100);
  if (exhausted.length) {
    // Both a short and weekly limit must reset before this account is usable.
    const knownResets = exhausted.every(window => typeof window.resetsAt === 'number'
      && Number.isFinite(window.resetsAt) && window.resetsAt > now);
    return { state: 'exhausted', resetsAt: knownResets
      ? Math.max(...exhausted.map(window => window.resetsAt as number)) : null };
  }
  return { state: windows.length && windows.every(validUsage) ? 'available' : 'unknown', resetsAt: null };
}

/**
 * Call with refreshed usage. Unknown usage keeps the active account so its normal
 * request/authentication handling can run; only confirmed exhaustion switches it.
 * A past reset timestamp never establishes that quota has been replenished.
 */
export function chooseCodexAccount(snapshot: CodexAccountsSnapshot, now = Date.now() / 1_000): CodexAccountChoice {
  const active = snapshot.profiles.find(profile => profile.id === snapshot.activeId);
  if (!active) return { accountId: null, message: 'The active Codex account is unavailable.', resetsAt: null };
  const current = availability(active, now);
  if (current.state !== 'exhausted') {
    return { accountId: active.id, resetsAt: null, message: current.state === 'available' ? null
      : 'Could not confirm the active account usage. Automatic switching was skipped.' };
  }
  const others = snapshot.profiles.filter(profile => profile.id !== active.id)
    .map(profile => ({ profile, availability: availability(profile, now) }));
  const next = others.find(candidate => candidate.availability.state === 'available');
  if (next) return { accountId: next.profile.id, message: null, resetsAt: null };

  if (others.some(candidate => candidate.availability.state === 'unknown')) {
    return { accountId: null, resetsAt: null,
      message: 'The active account usage is exhausted. No other account has confirmed available usage. Refresh usage or sign in to another account.' };
  }
  const exhausted = [current, ...others.map(candidate => candidate.availability)];
  const resetsAt = exhausted.every(candidate => candidate.resetsAt !== null)
    ? Math.min(...exhausted.map(candidate => candidate.resetsAt as number)) : null;
  return { accountId: null, resetsAt, message: resetsAt === null
    ? 'All accounts have exhausted their usage. Reset time is unavailable; refresh usage to check again.'
    : `All accounts have exhausted their usage. Earliest reset: ${new Date(resetsAt * 1_000).toLocaleString()}.` };
}
