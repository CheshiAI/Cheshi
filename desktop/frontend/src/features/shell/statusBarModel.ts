import type { CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { weeklyGeneralWindow, remainingPercent } from '../../../../shared/codex-account-usage';
import { presentationAccountName } from '../../shared/presentation';
export { accountUsageTotals } from '../../../../shared/codex-account-usage';

export function accountStatusSummary(snapshot: CodexAccountsSnapshot | null, hideIdentity = false): {
  label: string; title: string; attention: boolean;
} {
  if (!snapshot) {
    return { label: 'Account · Checking…', title: 'Checking account status', attention: false };
  }
  const profile = snapshot.profiles.find((entry) => entry.id === snapshot.activeId);
  if (!profile) {
    return { label: 'Account · Sign in', title: 'Sign in to view account usage', attention: false };
  }
  const name = presentationAccountName(profile.email ?? profile.label, hideIdentity);
  const { usage, login } = profile;
  if (usage.state === 'error' || login.state === 'error' || login.error !== null) {
    return {
      label: `${name} · Unavailable`,
      title: `${name}: ${login.error ?? usage.error ?? 'Account status unavailable'}`,
      attention: true,
    };
  }
  if (login.state === 'signing_in') {
    return { label: `${name} · Signing in…`, title: `${name}: Finish signing in in your browser`, attention: false };
  }
  if (usage.state === 'starting' || login.state === 'checking') {
    return { label: `${name} · Checking…`, title: `${name}: Checking account usage`, attention: false };
  }
  if (usage.state === 'login_required') {
    return { label: `${name} · Sign in`, title: `${name}: Sign in to view usage`, attention: true };
  }
  if (usage.authenticated !== true) {
    return { label: `${name} · Sign in`, title: `${name}: Sign in to view usage`, attention: false };
  }
  const weekly = weeklyGeneralWindow(usage);
  if (usage.state !== 'ready' || !weekly || !Number.isFinite(weekly.usedPercent)) {
    return { label: `${name} · Unavailable`, title: `${name}: Weekly usage unavailable`, attention: false };
  }
  const remaining = Math.round(remainingPercent(weekly.usedPercent));
  return {
    label: name,
    title: `${name}: ${remaining}% weekly usage remaining`,
    attention: remaining <= 10,
  };
}
