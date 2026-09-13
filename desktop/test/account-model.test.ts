import { describe, expect, test } from 'bun:test';
import { normalizeCodexAccounts } from '../frontend/src/features/account/accountsModel.ts';

import {
  EMPTY_CODEX_ACCOUNT_USAGE,
  normalizeCodexAccountUsage,
  weeklyGeneralWindow,
  type CodexAccountUsageStatus,
  type CodexRateLimit,
  type CodexRateLimitWindow,
} from '../frontend/src/features/account/model.ts';

const fiveHour: CodexRateLimitWindow = { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_787_179_860 };
const weekly: CodexRateLimitWindow = { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_787_894_940 };

function accountWithLimits(overrides: Partial<CodexRateLimit> = {}): CodexAccountUsageStatus {
  return {
    ...EMPTY_CODEX_ACCOUNT_USAGE,
    state: 'ready',
    authenticated: true,
    plan: 'pro',
    rateLimits: [{
      limitId: 'codex',
      limitName: null,
      plan: 'pro',
      primary: fiveHour,
      secondary: weekly,
      ...overrides,
    }],
  };
}

describe('account usage windows', () => {
  test('preserves rate limit windows and their separate reset times after normalization', () => {
    const status = normalizeCodexAccountUsage(accountWithLimits());
    if (!status) throw new Error('Expected a valid account status.');
    expect(status.rateLimits[0]?.primary).toEqual(fiveHour);
    expect(status.rateLimits[0]?.secondary).toEqual(weekly);
  });

  test('selects the general weekly window by duration when primary and secondary are reversed', () => {
    const status = accountWithLimits({ primary: weekly, secondary: fiveHour });
    expect(weeklyGeneralWindow(status)).toEqual(weekly);
  });

  test('selects the general weekly window without a five-hour limit', () => {
    expect(weeklyGeneralWindow(accountWithLimits({ primary: weekly, secondary: null }))).toEqual(weekly);
  });

  test('does not substitute a five-hour limit for a missing weekly limit', () => {
    expect(weeklyGeneralWindow(accountWithLimits({ secondary: null }))).toBeNull();
  });

  test('does not display a model-specific limit as general Codex usage', () => {
    const status = accountWithLimits({ limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark' });
    expect(weeklyGeneralWindow(status)).toBeNull();
  });

  test('does not label an unknown duration as a weekly limit', () => {
    const status = accountWithLimits({ primary: { ...fiveHour, windowDurationMins: null }, secondary: null });
    expect(weeklyGeneralWindow(status)).toBeNull();
  });
});

describe('account profiles', () => {
  const profile = { id: 'first', label: 'Account 1', email: 'first@example.test',
    usage: accountWithLimits(), login: { state: 'signed_in', error: null } };

  test('preserves distinct account usage and the selected account', () => {
    const other = { ...profile, id: 'second', email: 'second@example.test',
      usage: accountWithLimits({ secondary: { ...weekly, usedPercent: 98 } }) };
    const result = normalizeCodexAccounts({ activeId: 'second', profiles: [profile, other] });
    expect(result?.activeId).toBe('second');
    expect(result?.profiles.map((entry) => weeklyGeneralWindow(entry.usage)?.usedPercent)).toEqual([12, 98]);
  });

  test('rejects ambiguous ids and an active account missing from the list', () => {
    expect(normalizeCodexAccounts({ activeId: 'first', profiles: [profile, profile] })).toBeNull();
    expect(normalizeCodexAccounts({ activeId: 'missing', profiles: [profile] })).toBeNull();
  });

  test('rejects invalid login states and nonboolean authentication', () => {
    expect(normalizeCodexAccounts({ activeId: 'first', profiles: [{ ...profile, login: { state: 'ready', error: null } }] })).toBeNull();
    expect(normalizeCodexAccounts({ activeId: 'first', profiles: [{ ...profile, usage: { ...profile.usage, authenticated: 'true' } }] })).toBeNull();
  });
});
