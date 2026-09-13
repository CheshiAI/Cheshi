import { UserRoundPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DEFAULT_CODEX_ACCOUNT_ID, type CodexAccountProfile, type CodexAccountsSnapshot } from '../../../../shared/codex-accounts';
import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import { normalizeCodexAccounts, requireCodexAccounts } from './accountsModel';
import styles from './AddAccountDialog.module.css';

function signedIn(profile: CodexAccountProfile | null): boolean {
  return profile?.usage.authenticated === true || profile?.login.state === 'signed_in';
}

function addedProfile(snapshot: CodexAccountsSnapshot): CodexAccountProfile {
  // The registry appends the newly created profile before returning this snapshot.
  const profile = snapshot.profiles.at(-1);
  if (!profile || profile.id === DEFAULT_CODEX_ACCOUNT_ID || signedIn(profile)) {
    throw new Error('Could not identify the new account. Refresh your accounts and try again.');
  }
  return profile;
}

export function AddAccountDialog({ onClose, restoreFocus }: { onClose: () => void; restoreFocus?: () => boolean }) {
  const api = desktopApi?.codexAccounts;
  const [profile, setProfile] = useState<CodexAccountProfile | null>(null);
  const [pending, setPending] = useState<'login' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentProfile = useRef<CodexAccountProfile | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const closed = useRef(false);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;

  const finish = () => {
    if (!mounted.current || closed.current) return;
    closed.current = true;
    closeCallback.current();
  };
  const receive = (snapshot: CodexAccountsSnapshot) => {
    const next = snapshot.profiles.find(entry => entry.id === currentProfile.current?.id);
    if (!next || !mounted.current) return;
    // Registration is complete once sign-in succeeds, even if an older response arrives later.
    if (signedIn(currentProfile.current) && !signedIn(next)) return;
    currentProfile.current = next;
    setProfile(next);
    if (!busy.current && signedIn(next)) finish();
  };

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api?.onDidChange(value => {
      const snapshot = normalizeCodexAccounts(value);
      if (snapshot) receive(snapshot);
    });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [api]);

  const signIn = async () => {
    if (!api || busy.current || closed.current || currentProfile.current?.login.state === 'signing_in') return;
    busy.current = true;
    setPending('login');
    setError(null);
    try {
      if (!currentProfile.current) {
        const created = addedProfile(requireCodexAccounts(await api.add()));
        if (!mounted.current) return;
        currentProfile.current = created;
        setProfile(created);
      }
      receive(requireCodexAccounts(await api.login(currentProfile.current.id)));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(null);
        if (signedIn(currentProfile.current)) finish();
      }
    }
  };

  const cancel = async () => {
    if (busy.current || closed.current) return;
    if (!currentProfile.current || signedIn(currentProfile.current)) { finish(); return; }
    if (!api) return;
    busy.current = true;
    setPending('cancel');
    setError(null);
    try {
      requireCodexAccounts(await api.cancelRegistration(currentProfile.current.id));
      finish();
    } catch (cause) {
      // A browser sign-in may finish just as cancellation reaches the registry.
      try { receive(requireCodexAccounts(await api.list())); } catch { /* Preserve the cancellation error. */ }
      if (signedIn(currentProfile.current)) finish();
      else if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const waiting = profile?.login.state === 'signing_in';
  const failure = error ?? profile?.login.error ?? (profile?.usage.state === 'error' ? profile.usage.error : null);
  return <Modal title="Add account" titleIcon={<UserRoundPlus aria-hidden="true" />} closeDisabled={pending !== null}
    onClose={() => { void cancel(); }} restoreFocus={restoreFocus}>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); return signIn(); }}>
      <p>{waiting ? 'Finish signing in in your browser.' : 'Sign in to add another Codex account.'}</p>
      <p className={styles.description}>Your current account stays selected. You can switch accounts after signing in.</p>
      {failure && <p role="alert">{failure}</p>}
      {pending && <LoadingState type="processing" className={styles.progress}
        label={pending === 'cancel' ? 'Cancelling sign-in…' : 'Opening sign-in…'} />}
      <div className={styles.actions}>
        <NeumorphicButton raised size="standard" type="button" disabled={pending !== null} onClick={cancel}>Cancel</NeumorphicButton>
        <NeumorphicButton raised size="standard" type="submit" autoFocus disabled={!api || pending !== null || waiting}>
          {waiting ? 'Waiting for sign-in…' : 'Sign in'}
        </NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
