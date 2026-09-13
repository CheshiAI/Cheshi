import { ArrowRightLeft, Check, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { NeumorphicButton } from '../../shared/ui';
import { weeklyGeneralWindow, type CodexRateLimitWindow } from './model';
import type { CodexAccountProfile } from '../../../../shared/codex-accounts';
import styles from './AccountUsagePanel.module.css';

const PLAN_LABELS: Record<string, string> = {
  free: 'Free plan',
  go: 'Go plan',
  plus: 'Plus plan',
  pro: 'Pro plan',
  prolite: 'Pro Lite plan',
  team: 'Team plan',
  self_serve_business_prolite: 'Business plan',
  self_serve_business_usage_based: 'Business plan',
  business: 'Business plan',
  ent26: 'Enterprise plan',
  enterprise_cbp_automation: 'Enterprise plan',
  enterprise_cbp_usage_based: 'Enterprise plan',
  enterprise: 'Enterprise plan',
  edu: 'Edu plan',
};

function planLabel(plan: string | null): string {
  const value = plan?.trim();
  if (!value || value === 'unknown') return 'Plan unavailable';
  const known = PLAN_LABELS[value.toLowerCase()];
  if (known) return known;
  const label = value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${label} plan`;
}

function remainingPercent(window: CodexRateLimitWindow): number {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

function resetDetails(resetsAt: number | null): { label: string; dateTime?: string } {
  if (resetsAt === null) return { label: 'Reset time unavailable' };
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return { label: 'Reset time unavailable' };
  return {
    label: `Resets ${new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)}`,
    dateTime: date.toISOString(),
  };
}

function UsageMetric({ label, window, flat = false, actions }: {
  label: string; window: CodexRateLimitWindow | null; flat?: boolean; actions?: ReactNode;
}) {
  const remaining = window ? remainingPercent(window) : null;
  const reset = resetDetails(window?.resetsAt ?? null);
  return (
    <section className={flat ? `${styles.metric} ${styles.flatMetric}` : styles.metric} data-account-usage-metric={label}>
      <div className={styles.metricHeading}>
        <span>{label}</span>
        <strong>{remaining === null ? 'Unavailable' : `${remaining}% remaining`}</strong>
      </div>
      {remaining !== null && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining}
          aria-valuetext={`${remaining}% remaining`}
        >
          <span style={{ width: `${remaining}%` }} />
        </div>
      )}
      <div className={styles.metricFooter}>
        <time dateTime={reset.dateTime}>{reset.label}</time>
        {actions}
      </div>
    </section>
  );
}

export function AccountProfileUsage({ profile, active, pending, selectionDisabledReason, onLogin, onLogout, onCancel, onSelect }: {
  profile: CodexAccountProfile;
  active: boolean;
  pending: boolean;
  selectionDisabledReason?: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onCancel: () => void;
  onSelect: () => void;
}) {
  const { usage, login } = profile;
  const signingIn = login.state === 'signing_in';
  const loading = usage.state === 'starting' || login.state === 'checking';
  const message = signingIn ? 'Finish signing in in your browser.'
    : login.error ?? usage.error ?? (usage.state === 'login_required' ? 'Sign in to view plan and usage.' : null);
  return (
    <section className={styles.profile} aria-label={profile.email ?? profile.label} data-active={active}>
      <header className={styles.profileHeading}>
        <strong title={profile.email ?? profile.label}>{profile.email ?? profile.label}</strong>
        <span className={styles.profilePlan}>{planLabel(usage.plan)}</span>
      </header>
      <div className={styles.metrics} aria-busy={loading}>
        <UsageMetric flat label="Weekly Usage" window={weeklyGeneralWindow(usage)} actions={usage.authenticated && (
          <div className={styles.footerActions}>
            <NeumorphicButton raised size="icon" className={styles.compactActionButton} aria-label="Log out"
              disabled={pending || signingIn || (active && Boolean(selectionDisabledReason))}
              title={active ? selectionDisabledReason ?? 'Log out of this account' : 'Log out of this account'}
              onClick={onLogout}><LogOut aria-hidden="true" /></NeumorphicButton>
            {active ? <NeumorphicButton raised active size="icon" className={`${styles.compactActionButton} ${styles.activeButton}`}
              disabled aria-label="Active" title="Currently in use"><Check aria-hidden="true" /></NeumorphicButton>
              : <NeumorphicButton raised size="icon" aria-label="Use account"
                disabled={pending || signingIn || usage.state !== 'ready' || Boolean(selectionDisabledReason)}
                title={selectionDisabledReason ?? usage.error ?? 'Use this account for a new chat'} onClick={onSelect}>
                <ArrowRightLeft aria-hidden="true" />
              </NeumorphicButton>}
          </div>
        )} />
      </div>
      <div className={styles.profileActions}>
        {!signingIn && !usage.authenticated && <NeumorphicButton raised size="standard" disabled={pending || loading}
            title={active ? selectionDisabledReason ?? undefined : undefined} onClick={onLogin}>Sign in</NeumorphicButton>}
        {(signingIn || (!active && !usage.authenticated)) && <NeumorphicButton raised size="standard"
          disabled={pending} onClick={onCancel}>{active ? 'Cancel sign-in' : 'Cancel'}</NeumorphicButton>}
      </div>
      {message && <p className={styles.status} aria-live="polite">{message}</p>}
    </section>
  );
}
