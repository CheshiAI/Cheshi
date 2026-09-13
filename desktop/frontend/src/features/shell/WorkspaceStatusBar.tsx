import { Activity, Gauge } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ComponentProps } from 'react';

import type { CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { LiquidGlassPanel } from '../../shared/ui';
import { AccountUsagePanel } from '../account/AccountUsagePanel';
import { AddAccountDialog } from '../account/AddAccountDialog';
import { CodeGraphIndexPanel, type CodeGraphIndexIndicator } from '../graph/CodeGraphIndexPanel';
import { accountStatusSummary, accountUsageTotals } from './statusBarModel';
import { WorkspaceStorageUsage } from './WorkspaceStorageUsage';
import styles from './WorkspaceStatusBar.module.css';

interface WorkspaceStatusBarProps extends Pick<NonNullable<ComponentProps<typeof AccountUsagePanel>>,
  'selectionDisabledReason' | 'onBeforeSelect' | 'onSelectionFinished'> {
  onAccountInitialLoad: () => void;
  onIndexInitialLoad: () => void;
}

export function WorkspaceStatusBar({ onAccountInitialLoad, onIndexInitialLoad, ...accountProps }: WorkspaceStatusBarProps) {
  const accountId = useId();
  const indexId = useId();
  const [accounts, setAccounts] = useState<CodexAccountsSnapshot | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [index, setIndex] = useState<CodeGraphIndexIndicator>({ label: 'CHECKING', attention: false, busy: true });
  const [accountOpen, setAccountOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const openAddAccount = () => {
    document.getElementById(accountId)?.hidePopover();
    setAddingAccount(true);
  };
  const restoreAccountFocus = () => {
    accountButton.current?.focus();
    return false;
  };
  const receiveAccountStatus = useCallback((snapshot: CodexAccountsSnapshot | null, error: string | null) => {
    setAccounts(snapshot);
    setAccountError(error);
  }, []);
  const account = accountStatusSummary(accounts);
  const activeProfile = accounts?.profiles.find((profile) => profile.id === accounts.activeId);
  const accountReady = accountError === null && activeProfile?.usage.authenticated === true
    && activeProfile.usage.state === 'ready' && activeProfile.login.state === 'signed_in'
    && activeProfile.login.error === null;
  const totals = accountError ? null : accountUsageTotals(accounts);
  const hasAuthenticatedAccount = accounts?.profiles.some((profile) => profile.usage.authenticated === true);
  const accountTitle = accountError ?? (totals
    ? `${account.title}. Total: ${totals.remaining}% of ${totals.capacity}% weekly allowance remaining across ${totals.accountCount} signed-in accounts.`
    : account.title);

  return (
    <footer className={styles.bar} aria-label="Workspace status">
      <WorkspaceStorageUsage />
      <button type="button" className={`${styles.item} ${styles.index}`} popoverTarget={indexId}
        aria-haspopup="dialog" aria-expanded={indexOpen} aria-controls={indexId}
        data-index-state={index.busy ? 'pending' : index.attention ? 'disabled' : 'ready'}
        data-attention={index.attention || undefined} title="CodeGraph index details">
        <Activity aria-hidden="true" />
        <span className={styles.label}>CodeGraph · {index.label}</span>
        {index.busy && <span className={styles.busy} aria-label="Loading" />}
      </button>
      <button ref={accountButton} type="button" className={`${styles.item} ${styles.account}`} popoverTarget={accountId}
        aria-haspopup="dialog" aria-expanded={accountOpen} aria-controls={accountId}
        data-account-state={accountReady ? 'ready' : 'disabled'}
        data-attention={Boolean(accountError) || account.attention || undefined}
        title={accountTitle} aria-label={`${accountTitle} Open account and usage details.`}>
        <Gauge aria-hidden="true" />
        <span className={styles.label}>{accountError ? 'Account · Unavailable' : account.label}</span>
        {totals ? <>
          <span className={styles.separator} aria-hidden="true">·</span>
          <span className={styles.usageTrack} aria-hidden="true">
            <span style={{ width: `${totals.percent}%` }} />
          </span>
          <span className={styles.separator} aria-hidden="true">·</span>
          <span className={styles.total}>{totals.remaining}%</span>
        </> : !accountError && hasAuthenticatedAccount && <span className={styles.total}>· Total unavailable</span>}
      </button>
      {/* Keep data subscriptions and startup readiness alive while the native popovers are closed. */}
      <LiquidGlassPanel id={indexId} popover="auto" role="dialog" aria-label="CodeGraph index details"
        tabIndex={-1} className={styles.popover} data-liquid-glass-backdrop="true"
        onToggle={(event) => setIndexOpen(event.newState === 'open')}>
        <CodeGraphIndexPanel onInitialLoad={onIndexInitialLoad} onStatusChange={setIndex} />
      </LiquidGlassPanel>
      <LiquidGlassPanel id={accountId} popover="auto" role="dialog" aria-label="Account and usage details"
        tabIndex={-1} className={styles.popover} data-liquid-glass-backdrop="true"
        onToggle={(event) => setAccountOpen(event.newState === 'open')}>
        <AccountUsagePanel {...accountProps} onInitialLoad={onAccountInitialLoad} onStatusChange={receiveAccountStatus}
          onAddAccount={openAddAccount} />
      </LiquidGlassPanel>
      {addingAccount && <AddAccountDialog onClose={() => setAddingAccount(false)} restoreFocus={restoreAccountFocus} />}
    </footer>
  );
}
