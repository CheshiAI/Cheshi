import { expect, test } from 'bun:test';
import { chooseCodexAccount } from '../lib/codex-account-availability.mts';
import type { CodexAccountProfile, CodexAccountsSnapshot, CodexRateLimitWindow } from '../shared/codex-accounts.ts';

const NOW = 1_800_000_000;
function window(usedPercent: number, resetsAt: number | null = NOW + 60): CodexRateLimitWindow {
  return { usedPercent, resetsAt, windowDurationMins: 300 };
}
function profile(id: string, primary = window(10), secondary: CodexRateLimitWindow | null = null): CodexAccountProfile {
  return { id, label: id, email: null, login: { state: 'signed_in', error: null }, usage: {
    state: 'ready', authenticated: true, plan: 'pro', error: null,
    rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary, secondary }],
  } };
}
function choose(...profiles: CodexAccountProfile[]) {
  return chooseCodexAccount({ activeId: 'a', profiles }, NOW);
}

test('keeps an available active account and chooses the first confirmed alternative only on exhaustion', () => {
  expect(choose(profile('a'), profile('b')).accountId).toBe('a');
  expect(choose(profile('a', window(100)), profile('b'), profile('c')).accountId).toBe('b');
  expect(choose(profile('a', window(101)), profile('b')).accountId).toBe('b');
});

test('weekly and short usage limits independently prevent selection', () => {
  const weekly = { ...window(100), windowDurationMins: 10_080 };
  expect(choose(profile('a', window(1), weekly), profile('b', window(100)), profile('c')).accountId).toBe('c');
  expect(choose(profile('a', window(100)), profile('b', window(0), weekly)).accountId).toBeNull();
});

test('ignores Spark limits but does not treat a Spark-only account as general availability', () => {
  const a = profile('a');
  a.usage.rateLimits.push({ ...a.usage.rateLimits[0]!, limitId: 'codex_spark', primary: window(100) });
  expect(choose(a, profile('b')).accountId).toBe('a');
  a.usage.rateLimits = [{ ...a.usage.rateLimits[0]!, limitId: 'codex_spark', primary: window(0) }];
  expect(choose(profile('a', window(100)), { ...a, id: 'b' }).accountId).toBeNull();
});

test('unknown active usage and authentication failures never silently switch accounts', () => {
  for (const usage of [
    { rateLimits: [] }, { state: 'error' as const }, { authenticated: false },
    { rateLimits: [{ ...profile('a').usage.rateLimits[0]!, primary: window(NaN) }] },
  ]) {
    const a = profile('a', window(100));
    Object.assign(a.usage, usage);
    const choice = choose(a, profile('b'));
    expect(choice.accountId).toBe('a');
    expect(choice.message).toContain('Automatic switching was skipped');
  }
});

test('does not select unauthenticated, failed, starting, or malformed alternatives', () => {
  for (const usage of [
    { authenticated: false }, { state: 'error' as const }, { state: 'starting' as const },
    { rateLimits: [] }, { rateLimits: [{ ...profile('b').usage.rateLimits[0]!, primary: window(-1) }] },
  ]) {
    const b = profile('b');
    Object.assign(b.usage, usage);
    const choice = choose(profile('a', window(100)), b);
    expect(choice.accountId).toBeNull();
    expect(choice.message).toContain('No other account has confirmed available usage');
    expect(choice.message).not.toContain('All accounts');
  }
});

test('requires literal true at the external authentication boundary', () => {
  const b = profile('b');
  const malformed = { ...b, usage: { ...b.usage, authenticated: 'true' } } as unknown as CodexAccountProfile;
  expect(choose(profile('a', window(100)), malformed).accountId).toBeNull();
});

test('all exhausted uses the earliest account after all its exhausted windows reset', () => {
  const result = choose(profile('a', window(100, NOW + 20), window(100, NOW + 400)),
    profile('b', window(100, NOW + 200), window(50, NOW + 900)));
  expect(result.accountId).toBeNull();
  expect(result.resetsAt).toBe(NOW + 200);
  expect(result.message).toContain('All accounts have exhausted');
  expect(result.message).toContain('Earliest reset:');
});

test('missing or elapsed reset times do not promise availability or trigger a switch loop', () => {
  for (const reset of [null, NOW, NOW - 1, NaN, Infinity]) {
    const result = choose(profile('a', window(100, reset)), profile('b', window(100, NOW + 200)));
    expect(result.accountId).toBeNull();
    expect(result.resetsAt).toBeNull();
    expect(result.message).toContain('Reset time is unavailable');
  }
  expect(choose(profile('a', window(100, NOW - 1)), profile('b')).accountId).toBe('b');
});

test('a single exhausted account stops and a missing active account fails safely', () => {
  expect(choose(profile('a', window(100))).accountId).toBeNull();
  const empty: CodexAccountsSnapshot = { activeId: 'missing', profiles: [] };
  expect(chooseCodexAccount(empty, NOW)).toEqual({ accountId: null, resetsAt: null,
    message: 'The active Codex account is unavailable.' });
});
