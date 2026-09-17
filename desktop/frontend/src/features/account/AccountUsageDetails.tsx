import type { ReactNode } from 'react';
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

export function AccountUsageDetails({ profile, active, actions, children }: {
  profile: CodexAccountProfile; active: boolean; actions?: ReactNode; children?: ReactNode;
}) {
  const { usage, login } = profile;
  const loading = usage.state === 'starting' || login.state === 'checking';
  const message = login.state === 'signing_in' ? 'Finish signing in in your browser.'
    : login.error ?? usage.error ?? (usage.state === 'login_required' ? 'Sign in to view plan and usage.' : null);
  return (
    <section className={styles.profile} aria-label={profile.email ?? profile.label} data-active={active}>
      <header className={styles.profileHeading}>
        <strong title={profile.email ?? profile.label}>{profile.email ?? profile.label}</strong>
        <span className={styles.profilePlan}>{planLabel(usage.plan)}</span>
      </header>
      <div className={styles.metrics} aria-busy={loading}>
        <UsageMetric flat label="Weekly Usage" window={weeklyGeneralWindow(usage)} actions={actions} />
      </div>
      {children}
      {message && <p className={styles.status} aria-live="polite">{message}</p>}
    </section>
  );
}
