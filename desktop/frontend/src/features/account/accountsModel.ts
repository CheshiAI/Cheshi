import type { CodexAccountProfile, CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { normalizeCodexAccountUsage } from './model';

const LOGIN_STATES = new Set(['checking', 'signed_out', 'signing_in', 'signed_in', 'error']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function normalizeCodexAccounts(value: unknown): CodexAccountsSnapshot | null {
  const snapshot = record(value);
  if (!snapshot || typeof snapshot.activeId !== 'string' || !Array.isArray(snapshot.profiles)) return null;
  const profiles: CodexAccountProfile[] = [];
  const ids = new Set<string>();
  for (const value of snapshot.profiles) {
    const profile = record(value);
    const login = record(profile?.login);
    const usage = normalizeCodexAccountUsage(profile?.usage);
    if (!profile || typeof profile.id !== 'string' || !profile.id || ids.has(profile.id)
      || typeof profile.label !== 'string' || !profile.label
      || (profile.email !== null && typeof profile.email !== 'string')
      || !usage || !login || typeof login.state !== 'string' || !LOGIN_STATES.has(login.state)
      || (login.error !== null && typeof login.error !== 'string')) return null;
    ids.add(profile.id);
    profiles.push({ id: profile.id, label: profile.label, email: profile.email, usage,
      login: { state: login.state as CodexAccountProfile['login']['state'], error: login.error } });
  }
  return ids.has(snapshot.activeId) ? { activeId: snapshot.activeId, profiles } : null;
}

export function requireCodexAccounts(value: unknown): CodexAccountsSnapshot {
  const snapshot = normalizeCodexAccounts(value);
  if (!snapshot) throw new Error('The Codex accounts response format is invalid.');
  return snapshot;
}
