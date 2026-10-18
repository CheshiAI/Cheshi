import { Gauge } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { LiquidGlassPanel, RegionalBlur } from '../../shared/ui';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { AccountUsagePanel } from '../account/AccountUsagePanel';
import { AddAccountDialog } from '../account/AddAccountDialog';
import { AppUpdateIndicator } from '../updates/AppUpdateIndicator';
import { KeepAwakeStatus } from '../chrome/KeepAwakeStatus';
import { CodexUpdateIndicator } from '../updates/CodexUpdateIndicator';
import { accountStatusSummary, accountUsageTotals } from './statusBarModel';
import styles from './WorkspaceStatusBar.module.css';

interface WorkspaceStatusBarProps extends Pick<NonNullable<ComponentProps<typeof AccountUsagePanel>>,
  'selectionDisabledReason' | 'onBeforeSelect' | 'onSelectionFinished'> {
  onAccountInitialLoad: () => void;
  blurSourceRef: RefObject<HTMLElement | null>;
}

export function WorkspaceStatusBar({ onAccountInitialLoad, blurSourceRef, ...accountProps }: WorkspaceStatusBarProps) {
  const accountId = useId();
  const [accounts, setAccounts] = useState<CodexAccountsSnapshot | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
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
      <AppUpdateIndicator />
      <span className={styles.spacer} aria-hidden="true" />
      <CodexUpdateIndicator />
      <KeepAwakeStatus />
      <TooltipTarget content={accountTitle}>
        <button ref={accountButton} type="button" className={`${styles.item} ${styles.account}`} popoverTarget={accountId}
          aria-haspopup="dialog" aria-expanded={accountOpen} aria-controls={accountId}
          data-account-state={accountReady ? 'ready' : 'disabled'}
          data-attention={Boolean(accountError) || account.attention || undefined}
          aria-label={`${accountTitle} Open account and usage details.`}>
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
      </TooltipTarget>
      {/* Keep account subscriptions and startup readiness alive while the popover is closed. */}
      <RegionalBlur sourceRef={blurSourceRef} sourceMode="replace">
        {createPortal(<div id={accountId} popover="auto" role="dialog" aria-label="Account and usage details"
          tabIndex={-1} className={styles.popover}
          onToggle={(event) => setAccountOpen(event.newState === 'open')}>
          <LiquidGlassPanel className={styles.accountPopover} data-liquid-glass-backdrop="true">
            <AccountUsagePanel {...accountProps} onInitialLoad={onAccountInitialLoad} onStatusChange={receiveAccountStatus}
              onAddAccount={openAddAccount} />
          </LiquidGlassPanel>
        </div>, document.body)}
      </RegionalBlur>
      {addingAccount && <AddAccountDialog onClose={() => setAddingAccount(false)} restoreFocus={restoreAccountFocus} />}
    </footer>
  );
}
