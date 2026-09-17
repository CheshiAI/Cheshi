import { expect, test } from 'bun:test';
import type { CodexAccountProfile, CodexAccountUsageStatus } from '../shared/codex-accounts';
import { accountStatusSummary, accountUsageTotals } from '../frontend/src/features/shell/statusBarModel';

function profile(usage: Partial<CodexAccountUsageStatus> = {}): CodexAccountProfile {
  return {
    id: 'active', label: 'Personal account', email: 'person@example.com',
    login: { state: 'signed_in', error: null },
    usage: { state: 'ready', authenticated: true, plan: 'pro', rateLimits: [], error: null, ...usage },
  };
}

function summary(account: CodexAccountProfile) {
  return accountStatusSummary({ activeId: account.id, profiles: [account] });
}

function weeklyProfile(usedPercent: number): CodexAccountProfile {
  return profile({ rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
    secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: null } }] });
}

test('hides the account email in presentation mode', () => {
  const account = weeklyProfile(6);
  expect(accountStatusSummary({ activeId: account.id, profiles: [account] }, true)).toEqual({
    label: 'Codex account', title: 'Codex account: 94% weekly usage remaining', attention: false,
  });
  expect(summary(account).label).toBe('person@example.com');
});

test('distinguishes the initial check from missing active accounts', () => {
  expect(accountStatusSummary(null)).toMatchObject({ label: 'Account · Checking…', attention: false });
  expect(accountStatusSummary({ activeId: 'missing', profiles: [] })).toMatchObject({ label: 'Account · Sign in' });
  expect(accountStatusSummary({ activeId: 'missing', profiles: [weeklyProfile(6)] }).label).toBe('Account · Sign in');
});

test('shows checking and signing in without interpreting absent usage as zero', () => {
  expect(summary(profile({ state: 'starting', authenticated: false })).label).toContain('Checking…');
  expect(summary({ ...profile(), login: { state: 'checking', error: null } }).label).toContain('Checking…');
  expect(summary({ ...profile(), login: { state: 'signing_in', error: null } }).label).toContain('Signing in…');
});

test('keeps missing or stopped usage unavailable', () => {
  expect(summary(profile())).toMatchObject({ label: 'person@example.com · Unavailable', attention: false });
  expect(summary({ ...weeklyProfile(6), usage: { ...weeklyProfile(6).usage, state: 'stopped' } }).label).toContain('Unavailable');
  expect(summary(weeklyProfile(Number.NaN)).label).toContain('Unavailable');
});

test('prioritizes an ongoing login over the previous login-required usage state', () => {
  const account = profile({ state: 'login_required', authenticated: false });
  expect(summary({ ...account, login: { state: 'signing_in', error: null } }))
    .toMatchObject({ label: 'person@example.com · Signing in…', attention: false });
  expect(summary({ ...account, login: { state: 'checking', error: null } }))
    .toMatchObject({ label: 'person@example.com · Checking…', attention: false });
});

test('shows remaining weekly usage for the selected account only', () => {
  const inactive = { ...weeklyProfile(100), id: 'inactive' };
  expect(accountStatusSummary({ activeId: 'active', profiles: [inactive, weeklyProfile(6)] })).toEqual({
    label: 'person@example.com',
    title: 'person@example.com: 94% weekly usage remaining', attention: false,
  });
});

test('clamps and rounds remaining usage and highlights the low usage boundary', () => {
  for (const [used, remaining, attention] of [[100, 0, true], [130, 0, true], [-20, 100, false],
    [90, 10, true], [89, 11, false], [6.4, 94, false]] as const) {
    expect(summary(weeklyProfile(used))).toMatchObject({ title: `person@example.com: ${remaining}% weekly usage remaining`, attention });
  }
});

test('uses the profile label when email is absent', () => {
  expect(summary({ ...weeklyProfile(6), email: null }).label).toBe('Personal account');
});

test('surfaces usage and login errors even when previous usage remains', () => {
  const account = weeklyProfile(6);
  expect(summary({ ...account, usage: { ...account.usage, state: 'error', error: 'Connection failed' } }))
    .toMatchObject({ label: 'person@example.com · Unavailable', title: 'person@example.com: Connection failed', attention: true });
  expect(summary({ ...account, login: { state: 'error', error: 'Login failed' } }))
    .toMatchObject({ title: 'person@example.com: Login failed', attention: true });
  expect(summary({ ...account, login: { state: 'signed_out', error: 'Login failed' } }).attention).toBe(true);
});

test('requests sign in when required and does not expose stale percentages', () => {
  const account = weeklyProfile(6);
  expect(summary({ ...account, usage: { ...account.usage, state: 'login_required' } }))
    .toMatchObject({ label: 'person@example.com · Sign in', attention: true });
  expect(summary({ ...account, usage: { ...account.usage, authenticated: false } }).label).toContain('Sign in');
});

function totals(...accounts: CodexAccountProfile[]) {
  return accountUsageTotals({ activeId: 'active', profiles: accounts });
}

test('aggregates weekly capacity from active and inactive authenticated accounts', () => {
  expect(totals(weeklyProfile(7), { ...weeklyProfile(0), id: 'inactive' })).toEqual({
    remaining: 193, capacity: 200, percent: 96.5, accountCount: 2,
  });
});

test('excludes signed-out and login-required accounts even with stale authentication', () => {
  const account = weeklyProfile(100);
  const signedOut = { ...account, id: 'signed-out', login: { ...account.login, state: 'signed_out' as const } };
  const loginRequired = { ...account, id: 'required', usage: { ...account.usage, state: 'login_required' as const } };
  const unauthenticated = { ...account, id: 'unauthenticated', usage: { ...account.usage, authenticated: false } };
  expect(totals(weeklyProfile(7), signedOut, loginRequired, unauthenticated)).toEqual({
    remaining: 93, capacity: 100, percent: 93, accountCount: 1,
  });
  expect(totals(signedOut, loginRequired, unauthenticated)).toBeNull();
});

test('keeps totals unavailable when there are no authenticated accounts', () => {
  expect(accountUsageTotals(null)).toBeNull();
  expect(totals()).toBeNull();
  expect(totals(profile({ authenticated: false }))).toBeNull();
});

test('does not report a partial total while an authenticated account has unavailable usage', () => {
  const valid = weeklyProfile(7);
  for (const incomplete of [profile(), profile({ state: 'starting' }), profile({ state: 'stopped' }),
    profile({ state: 'error', error: 'Unavailable' }), weeklyProfile(Number.NaN), weeklyProfile(Infinity)]) {
    expect(totals(valid, { ...incomplete, id: 'incomplete' })).toBeNull();
  }
});

test('does not report a partial total during login checks or errors', () => {
  const valid = weeklyProfile(7);
  for (const state of ['checking', 'signing_in', 'error'] as const) {
    expect(totals(valid, { ...weeklyProfile(0), id: 'pending', login: { state, error: null } })).toBeNull();
  }
  expect(totals({ ...valid, login: { state: 'signed_in', error: 'Login failed' } })).toBeNull();
});

test('clamps each account separately and preserves exhausted capacity', () => {
  expect(totals(weeklyProfile(-40), { ...weeklyProfile(150), id: 'other' })).toEqual({
    remaining: 100, capacity: 200, percent: 50, accountCount: 2,
  });
  expect(totals(weeklyProfile(100))).toEqual({ remaining: 0, capacity: 100, percent: 0, accountCount: 1 });
});

test('rounds the summed display value while keeping the meter based on raw remaining usage', () => {
  const total = totals(weeklyProfile(6.6), { ...weeklyProfile(6.6), id: 'other' });
  expect(total).toMatchObject({ remaining: 187, capacity: 200, accountCount: 2 });
  expect(total?.percent).toBeCloseTo(93.4);
});
