import { ArrowRightLeft, Check, LogOut } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
import { AccountUsageDetails } from './AccountUsageDetails';
import type { CodexAccountProfile } from '../../../../shared/codex-accounts';
import styles from './AccountUsagePanel.module.css';

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
  return (
    <AccountUsageDetails profile={profile} active={active} actions={usage.authenticated && (
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
    )}>
      <div className={styles.profileActions}>
        {!signingIn && !usage.authenticated && <NeumorphicButton raised size="standard" disabled={pending || loading}
            title={active ? selectionDisabledReason ?? undefined : undefined} onClick={onLogin}>Sign in</NeumorphicButton>}
        {(signingIn || (!active && !usage.authenticated)) && <NeumorphicButton raised size="standard"
          disabled={pending} onClick={onCancel}>{active ? 'Cancel sign-in' : 'Cancel'}</NeumorphicButton>}
      </div>
    </AccountUsageDetails>
  );
}
