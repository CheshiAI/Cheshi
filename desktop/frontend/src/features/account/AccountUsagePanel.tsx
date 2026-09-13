import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { NeumorphicButton } from '../../shared/ui';
import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';
import { AccountProfileUsage } from './AccountProfileUsage';
import type { CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { normalizeCodexAccounts, requireCodexAccounts } from './accountsModel';
import styles from './AccountUsagePanel.module.css';

interface AccountUsagePanelProps {
  onInitialLoad?: () => void;
  onStatusChange?: (snapshot: CodexAccountsSnapshot | null, error: string | null) => void;
  onAddAccount?: () => void;
  selectionDisabledReason?: string | null;
  onBeforeSelect?: () => string | null;
  onSelectionFinished?: (changed: boolean, preserveConversation?: boolean) => void;
}

export function AccountUsagePanel({ onInitialLoad, onStatusChange, onAddAccount, selectionDisabledReason, onBeforeSelect, onSelectionFinished }: AccountUsagePanelProps = {}) {
  const [snapshot, setSnapshot] = useState<CodexAccountsSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const loggedOutProfile = useRef<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const api = desktopApi?.codexAccounts;

  const loadStatus = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const requestRevision = revision.current;
    try {
      if (!api) throw new Error('Codex accounts API is unavailable. Restart Cheshi.');
      const next = requireCodexAccounts(await api.list());
      if (mounted.current && requestRevision === revision.current) setSnapshot(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      if (mounted.current) { setPending(false); setInitialLoaded(true); }
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const removeListener = api?.onDidChange((value) => {
      const next = normalizeCodexAccounts(value);
      if (next) {
        revision.current += 1;
        if (next.profiles.some(profile => profile.id === loggedOutProfile.current
          && profile.usage.state === 'login_required' && profile.login.state === 'signed_out')) {
          loggedOutProfile.current = null;
        }
        setSnapshot(next);
      }
    });
    void loadStatus();
    return () => { mounted.current = false; removeListener?.(); };
  }, [api, loadStatus]);
  useEffect(() => { if (initialLoaded) onInitialLoad?.(); }, [initialLoaded, onInitialLoad]);
  useEffect(() => { onStatusChange?.(snapshot, error); }, [snapshot, error, onStatusChange]);

  const perform = async (action: 'login' | 'logout' | 'cancelLogin' | 'cancelRegistration' | 'select', id: string) => {
    if (!api || pendingRef.current) return;
    const selecting = action === 'select';
    const loggingOutActive = action === 'logout' && id === snapshot?.activeId;
    const guardsWorkspace = selecting || loggingOutActive || (action === 'login' && id === snapshot?.activeId);
    if (guardsWorkspace) {
      const reason = selectionDisabledReason ?? onBeforeSelect?.();
      if (reason) { setError(reason); return; }
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    loggedOutProfile.current = loggingOutActive ? id : null;
    let changed = false;
    try {
      const result = requireCodexAccounts(await api[action](id));
      changed = loggingOutActive || (selecting && result.activeId === id && result.activeId !== snapshot?.activeId);
      if (mounted.current) setSnapshot(result);
    } catch (cause) {
      // Credential removal may succeed before workspace cleanup reports an error.
      if (loggingOutActive && loggedOutProfile.current === null) changed = true;
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (guardsWorkspace) onSelectionFinished?.(changed, selecting && changed);
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="Account and usage" data-account-usage-panel="">
      <header className={styles.heading}>
        <span className={styles.headingLabel}>ACCOUNT &amp; USAGE</span>
        <div className={styles.headingActions}>
          <NeumorphicButton raised className={styles.refreshButton} aria-label="Add Codex account"
            title="Add account" disabled={pending || !api || !onAddAccount} onClick={onAddAccount}>
            <Plus aria-hidden="true" />
          </NeumorphicButton>
          <NeumorphicButton raised className={styles.refreshButton} aria-label="Refresh account usage"
            disabled={pending} onClick={() => void loadStatus()}>
            <RefreshCw className={pending ? styles.spinning : undefined} aria-hidden="true" />
          </NeumorphicButton>
        </div>
      </header>
      {snapshot?.profiles.map((profile) => <AccountProfileUsage key={profile.id} profile={profile}
        active={profile.id === snapshot.activeId} pending={pending}
        selectionDisabledReason={selectionDisabledReason}
        onLogin={() => void perform('login', profile.id)}
        onLogout={() => void perform('logout', profile.id)}
        onCancel={() => void perform(profile.id === snapshot.activeId ? 'cancelLogin' : 'cancelRegistration', profile.id)}
        onSelect={() => void perform('select', profile.id)} />)}
      {!initialLoaded && <p className={styles.status}>Loading accounts…</p>}
      {snapshot && snapshot.profiles.length > 1 && <p className={styles.status}>
        Conversations continue with the selected account on the next request. Sign-ins stay separate.
      </p>}
      {error && <p className={styles.status} role="alert">{error}</p>}
    </section>
  );
}
